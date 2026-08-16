/**
 * The model, and the arithmetic that turns HF's answer into vectors the page
 * can use. In its own module so it can be tested without a token or a network
 * (`deno test supabase/functions/embed/`).
 *
 * ONE MODEL SERVES EVERYTHING, and that is the whole point of the hosted pick.
 * A haul builds one cosine matrix out of stone vectors, core samples and
 * touchstones together (docs/dig-spec.md §5.6). Vectors from two models are
 * not comparable even at equal dimension — the scores come back plausible and
 * wrong, with nothing to throw. So `MODEL` and `DIM` here are the same two
 * strings that key the cache in `dig-cache`, that `scripts/warm-dig.mjs`
 * writes under, and that `docs/assets/filter.js` reads with. Change one and
 * you must change all four, and the old rows go cold rather than stale.
 *
 * WHY SPECTER2 AND NOT A GENERAL-PURPOSE EMBEDDER: it is trained on the
 * citation graph — the objective is literally "papers that cite each other
 * land near each other" — which is the question the coupling map asks. The
 * previous pick (`bge-small-en-v1.5`) was a general text embedder that had
 * never seen a reference list.
 */

/** The cache key's model half. Must match filter.js and warm-dig.mjs exactly. */
export const MODEL = 'allenai/specter2_base';

/** The cache key's dimension half. BERT-base hidden size. */
export const DIM = 768;

/**
 * `allenai/specter2_base` is the *proximity* encoder — the plain checkpoint,
 * not one of the `allenai/specter2_*` adapters. That distinction cost an hour:
 * the adapters are `adapter-transformers` repos that no inference server
 * serves, while the base is a `transformers` BertModel tagged
 * `text-embeddings-inference`, which is why this URL answers at all.
 */
export const UPSTREAM =
  `https://router.huggingface.co/hf-inference/models/${MODEL}/pipeline/feature-extraction`;

/**
 * How many texts ride in one upstream call.
 *
 * Not a documented cap — HF bills compute time, not requests, so the only
 * thing a bigger batch buys is fewer round trips, and the only thing it risks
 * is a gateway timeout on a slow cold model. 32 keeps a batch well inside the
 * 60 s budget below even at cold-start speeds.
 */
export const UPSTREAM_BATCH = 32;

/** Raised when the model is loading upstream. Distinct because it is not a
 *  failure — it is a wait, and the page says so rather than showing an error. */
export class ModelWarmingError extends Error {
  readonly retryAfter: number;
  constructor(seconds: number) {
    super(
      `The embedding model is loading upstream (~${Math.ceil(seconds)}s). ` +
      `This happens on the first call after an idle period. Try again shortly.`,
    );
    this.name = 'ModelWarmingError';
    this.retryAfter = seconds;
  }
}

/** L2-normalize in place, and return it. */
export function normalize(v: number[]): number[] {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  const norm = Math.sqrt(sum);
  // A zero vector cannot be normalized; leave it alone rather than produce NaN,
  // which would poison every cosine it touches instead of just scoring 0.
  if (norm === 0 || !isFinite(norm)) return v;
  for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}

/**
 * HF's answer → one unit vector per input text.
 *
 * TWO SHAPES ARRIVE AND BOTH ARE CORRECT, which is the reason this function
 * exists rather than an inline `.map`. A model served through
 * text-embeddings-inference pools server-side and returns `[n][dim]`. The same
 * endpoint backed by a plain transformers pipeline returns the token grid,
 * `[n][tokens][dim]`, and leaves the pooling to the caller. Which one you get
 * is a property of HF's serving stack on the day, not of the request — so
 * depending on one of them is a bet that silently loses when it flips.
 *
 * WHEN IT IS THE TOKEN GRID, POOL ON [CLS] — token 0 — NOT ON THE MEAN. This
 * is the single easiest way to get SPECTER wrong: mean-pooling a checkpoint
 * trained with a CLS objective returns a 768-dim vector of the right shape and
 * the wrong geometry, so the dimension guard passes, nothing throws, and the
 * rankings are quietly worse. The old bge pick *was* mean-pooled, which is why
 * this reads as a change rather than a fix.
 */
export function toVectors(raw: unknown, n: number, dim: number = DIM): number[][] {
  if (!Array.isArray(raw)) {
    throw new Error(`embedding upstream returned ${typeof raw}, expected an array`);
  }

  // A single-string request can come back unwrapped; wrap it so the loop below
  // sees the same shape either way.
  let rows = raw as unknown[];
  if (rows.length > 0 && typeof rows[0] === 'number') rows = [rows];

  if (rows.length !== n) {
    throw new Error(`embedding upstream returned ${rows.length} vectors for ${n} texts`);
  }

  return rows.map((row, i) => {
    if (!Array.isArray(row)) {
      throw new Error(`embedding upstream returned a non-array at index ${i}`);
    }
    // [n][tokens][dim] — take [CLS], see above.
    const flat: unknown[] = Array.isArray(row[0]) ? (row[0] as unknown[]) : row;
    if (flat.length !== dim) {
      throw new Error(
        `embedding upstream returned ${flat.length} dims at index ${i}, expected ${dim}`,
      );
    }
    const out = new Array<number>(dim);
    for (let k = 0; k < dim; k++) {
      const x = flat[k];
      if (typeof x !== 'number' || !isFinite(x)) {
        throw new Error(`embedding upstream returned a non-finite value at index ${i}`);
      }
      out[k] = x;
    }
    /* The page treats every vector as a unit vector and its cosine leans on it.
       TEI normalizes, a raw pipeline does not, and the difference is invisible
       until scores drift — so normalize here regardless, where it is cheap and
       certain. */
    return normalize(out);
  });
}

/**
 * How long HF says the model needs, from a 503 body. HF answers
 * `{"error": "Model … is currently loading", "estimated_time": 20.0}`.
 * Absent or nonsense means "some seconds": 20 is HF's own typical figure and a
 * better guess than 0, which would have the page retry into the same wait.
 */
export function warmingSeconds(body: unknown): number {
  const t = (body as { estimated_time?: unknown } | null)?.estimated_time;
  return typeof t === 'number' && isFinite(t) && t > 0 ? t : 20;
}
