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
 * THE BINDING CONSTRAINT IS THE ISOLATE'S MEMORY, NOT TIME, and it took a
 * measurement to see why. This endpoint answers with the **token grid** —
 * `[n][tokens][768]` — and leaves the pooling to us (see `toVectors`). So one
 * upstream response is `batch × tokens × 768` floats, and it is *text length*
 * that decides whether it fits, not text count.
 *
 * Measured 2026-08-16 against the deployed function, ~1.5 kB abstracts:
 *
 *     batch 32, short texts (~440 B)   ok
 *     batch 32, real abstracts         546 WORKER_RESOURCE_LIMIT, in 8 s
 *
 * Failing in 8 s is the tell: a timeout would have taken 60. At 512 tokens —
 * SPECTER2's ceiling — a batch of 32 is ~12.6M floats before it is pooled down
 * to 24k, and the isolate dies parsing it.
 *
 * 8 keeps the worst case (8 × 512 × 768) inside the budget with room for the
 * response JSON. It costs more round trips, and that is close to free: HF bills
 * compute time, not requests, and the pooled result the caller accumulates is
 * small no matter how it was chunked.
 */
export const UPSTREAM_BATCH = 8;

/**
 * Characters kept from each text before it is sent upstream.
 *
 * SPECTER2's positional embeddings stop at 512 tokens and the upstream does not
 * truncate for us — measured 2026-08-17, a real quant-ph abstract tokenized to
 * 545 and took its whole batch down with
 * `The size of tensor a (545) must match the size of tensor b (512)`. One long
 * paper stopping a 962-abstract warm is not a proportionate failure.
 *
 * Asking for truncation is not enough on its own: the flag's spelling depends
 * on which serving stack is behind the route, and getting it wrong is silent
 * until a long text arrives. So the text is also clipped here, where the
 * arithmetic is ours.
 *
 * THE CHARS-PER-TOKEN RATIO IS THE TRAP, and it cost a second failed warm.
 * 2000 chars was picked as ~500 tokens at the usual ~4 chars/token for English
 * prose, and a 3396-char prose test passed at exactly that. Real physics
 * abstracts are denser — LaTeX, subscripts, chemical formulas, units — and
 * measured 2026-08-17 the same 2000 chars came back as **545 tokens**, or
 * 3.67 chars/token, failing identically to before the clip existed.
 *
 * So 1400, which is 2.7 chars/token at the 512 ceiling and leaves room for
 * text denser still. A typical arXiv abstract is ~1.2-1.5 kB, so this rarely
 * bites, and when it does it discards only what SPECTER2 could not have
 * attended to anyway.
 *
 * A fixed number is still a guess about someone else's tokenizer, so it is a
 * first line and not the only one — `embedChunk` retries a batch that trips the
 * ceiling with a harder clip. No single pathological paper should be able to
 * stop a 962-abstract warm.
 *
 * THIS DOES NOT TOUCH THE CACHE KEY. Callers hash the *full* text before they
 * ever get here (`cacheKeyText` in filter.js and warm-dig.mjs), so clipping is
 * invisible to the key and cannot cause a miss.
 */
export const UPSTREAM_MAX_CHARS = 1_400;

/** Does this upstream 400 mean "the text was longer than the model's window"?
 *  The message is the only signal — there is no code for it. */
export function isTooLong(detail: string): boolean {
  return /size of tensor|sequence length|maximum context|too long/i.test(detail);
}

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
 * HF's answer, read as a byte stream, keeping only what `toVectors` uses:
 * token 0 of each row of a `[n][tokens][dim]` grid, or every value of a
 * pooled `[n][dim]` (or a bare `[dim]`). The result is `[rows][dim]`, which
 * `toVectors` then checks and normalizes as before.
 *
 * WHY NOT `resp.json()`. A batch of 8 abstracts comes back as up to 8 x 512 x
 * 768 = 3.1M numbers — tens of megabytes of JSON text, and as much again once
 * parsed into nested arrays — to keep 8 x 768 of them. Two of those alive at
 * once (one parsed, the next arriving before the GC ran) is what took the
 * isolate down with 546 WORKER_RESOURCE_LIMIT. Here the peak is one network
 * chunk plus the [CLS] rows.
 *
 * THE SCANNER. Depth goes up at `[` and down at `]`; `at[d]` counts the commas
 * seen at depth d since that array opened, so it is the index of the current
 * element there. A number lives at the innermost depth, which names the shape:
 * depth 3 is the grid (row `at[1]`, kept only when token `at[2]` is 0), depth 2
 * is pooled (row `at[1]`), depth 1 a single vector. A number is bytes up to the
 * next `,` `]` or space, parsed only when kept. Anything that is not an array
 * at the top — an error object at status 200 — is read whole and parsed, so
 * `toVectors` can say what it was.
 */
export async function clsRows(body: ReadableStream<Uint8Array> | null): Promise<unknown> {
  if (!body) throw new Error('embedding upstream returned an empty body');
  const reader = body.getReader();
  const rows: number[][] = [];
  const at = [0, 0, 0, 0];
  let depth = 0;
  let started = false;
  let notArray: Uint8Array[] | null = null;
  let token: number[] = [];   // the bytes of the number being read, when kept
  let inNumber = false;
  let keep = false;

  const finishNumber = () => {
    if (inNumber && keep) {
      const row = depth === 1 ? 0 : at[1];
      (rows[row] ??= []).push(Number(String.fromCharCode(...token)));
    }
    inNumber = false;
    token = [];
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (notArray) {
      notArray.push(value);
      continue;
    }
    for (let i = 0; i < value.length; i++) {
      const b = value[i];
      if (!started) {
        if (b === 32 || b === 10 || b === 13 || b === 9) continue;
        started = true;
        if (b !== 91) {
          notArray = [value.subarray(i)];
          break;
        }
      }
      if (b === 91) {            // [
        depth += 1;
        if (depth < at.length) at[depth] = 0;
      } else if (b === 93) {     // ]
        finishNumber();
        depth -= 1;
      } else if (b === 44) {     // ,
        finishNumber();
        if (depth < at.length) at[depth] += 1;
      } else if (b === 32 || b === 10 || b === 13 || b === 9) {
        finishNumber();
      } else {
        if (!inNumber) {
          inNumber = true;
          keep = depth === 1 || depth === 2 || (depth === 3 && at[2] === 0);
        }
        if (keep) token.push(b);
      }
    }
  }

  if (notArray) {
    const decoder = new TextDecoder();
    const text = notArray.map((part, k) => decoder.decode(part, { stream: k < notArray!.length - 1 }))
      .join('');
    return JSON.parse(text);
  }
  /* A bare [dim] lands as one row, which is what toVectors makes of it too. */
  return rows;
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
