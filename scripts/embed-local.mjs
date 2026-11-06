/**
 * embed-local — SPECTER2 on the runner, so a spent inference credit cannot stop
 * the nightly warm.
 *
 * WHY THIS EXISTS. `warm-dig.mjs` calls the hosted `embed` function, and that
 * function holds the inference credits. When they run out it answers 402
 * (reported as 502) and the whole warm fails. Running the same model here, on
 * the runner's CPU, keeps the shared cache warm without the credit; the page
 * still talks to the hosted function and nothing else changes.
 *
 * THE ONE PROPERTY THAT MATTERS: the vectors. `embedChunk` (warm-dig.mjs), this
 * module and the browser all file rows into one shared cache keyed by `MODEL`
 * and a hash of the text, and a ranking mixes warmed rows with fresh ones in a
 * single cosine matrix. A local encoder that disagrees with the hosted one by a
 * hair does not throw — it files a second geometry under the same key, and
 * every later reader trusts it. So this is a drop-in for `embedChunk`: same
 * text in, the same 768-dim unit vector out. The arithmetic is the hosted
 * function's (`toVectors` in supabase/functions/embed/hf.ts): take `[CLS]`
 * from the token grid, then L2-normalise.
 *
 * WHY CLS POOLING, NOT THE MEAN. SPECTER2 is trained with a CLS objective: the
 * sentence representation is token 0, `[CLS]`. Averaging the token axis
 * instead returns a vector of the right shape and the wrong geometry — nothing
 * throws, the dimension guard passes, and every cosine taken against a warmed
 * row is quietly off. `toVectors` takes token 0, so this does too; the mean
 * would file a second geometry under the one shared cache key.
 *
 * WHY THE DEPENDENCY IS OPTIONAL. `@huggingface/transformers` is a 32 MB native
 * pull, and the test suite has to run without it: the tests inject a
 * `pipelineFactory`, and nothing here imports the package until a run actually
 * asks for a local embedding.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DIM, MODEL } from './warm-dig.mjs';

/* Texts per pipeline call. One batch is one forward pass, and the grid it
   returns is `batch × tokens × 768` floats, so a larger batch costs memory
   rather than time — the same trade the hosted pick makes, at the same number
   so a local run and a hosted run walk the corpus in the same steps. */
const BATCH = 64;

/* Park the model outside node_modules. transformers.js defaults its Node cache
   under the package, which `npm install` recreates on every CI run, so the pull
   could never be cached there. A stable sibling directory can be. */
const CACHE_DIR = process.env.HF_CACHE_DIR ||
  path.join(path.dirname(fileURLToPath(import.meta.url)), '.model-cache');

let pipelinePromise = null;

/**
 * The real `pipelineFactory`: load SPECTER2 once, hand back the extractor.
 *
 * Imported lazily so a checkout without the optional dependency still runs the
 * suite. `dtype` is left at full precision on purpose: the hosted pick runs the
 * model in fp32, and the `q8` the browser used to run went with the browser's
 * own encoder — a quantized local copy would be a second geometry under one key.
 */
export async function defaultPipelineFactory() {
  pipelinePromise ??= (async () => {
    const { env, pipeline } = await import('@huggingface/transformers');
    env.cacheDir = CACHE_DIR;
    return pipeline('feature-extraction', MODEL, { dtype: 'fp32' });
  })();
  return pipelinePromise;
}

/**
 * A token grid → one vector: token 0, `[CLS]`, L2-normalised. The row the
 * hosted `toVectors` takes, for the reason in the header.
 *
 * A wrong dimension throws rather than filing a short row — the cache is keyed
 * on `DIM`, and a 512-wide vector under a 768-wide key poisons every read. A
 * `[CLS]` of all zeros is left at zero rather than NaN, which would poison
 * every cosine it touched instead of scoring 0.
 */
export function clsPool(tokens) {
  const cls = tokens[0];
  if (!cls) throw new Error(`the model returned no tokens, expected ${DIM} dims`);
  if (cls.length !== DIM) {
    throw new Error(`the model returned ${cls.length} dims, expected ${DIM}`);
  }
  const out = new Float32Array(cls);
  let sum = 0;
  for (let k = 0; k < DIM; k++) sum += out[k] * out[k];
  const norm = Math.sqrt(sum);
  if (norm > 0 && Number.isFinite(norm)) for (let k = 0; k < DIM; k++) out[k] /= norm;
  return out;
}

/**
 * `texts` → one 768-dim unit vector each, in order, from SPECTER2 on this
 * machine. The drop-in for `embedChunk` that `--embed-local` selects.
 *
 * `pipelineFactory` returns an extractor shaped like transformers.js's:
 * `await extractor(texts, { pooling: 'none' })` answers with an object whose
 * `.tolist()` is the token grid `[n][tokens][768]`. It is injected so the tests
 * can pin the pooling and the normalisation without the model — and so a run
 * with nothing to embed never pays the 32 MB pull.
 */
export async function embedLocal(texts, { pipelineFactory = defaultPipelineFactory } = {}) {
  if (!texts.length) return [];
  const extractor = await pipelineFactory();
  const out = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const chunk = texts.slice(i, i + BATCH);
    const grid = (await extractor(chunk, { pooling: 'none' })).tolist();
    if (grid.length !== chunk.length) {
      throw new Error(`the model returned ${grid.length} rows for ${chunk.length} texts`);
    }
    for (const tokens of grid) out.push(clsPool(tokens));
  }
  return out;
}

/**
 * Which embedder a run uses: SPECTER2 on this machine (`--embed-local`) or the
 * hosted pick. Returns a `(texts) => Promise<Float32Array[]>` either way, so
 * the call site never branches on the flag.
 *
 * The hosted embedder is a parameter rather than an import so a test can assert
 * the flag's choice with a stub, without a network.
 */
export function chooseEmbedder(flags = {}, { embedChunk, embedUrl, pipelineFactory } = {}) {
  return flags.embedLocal
    ? (texts) => embedLocal(texts, { pipelineFactory })
    : (texts) => embedChunk(texts, embedUrl);
}
