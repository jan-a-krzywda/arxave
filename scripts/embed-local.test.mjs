/**
 * `node --test scripts/embed-local.test.mjs` — runs without the model, and
 * without `@huggingface/transformers` installed at all.
 *
 * These defend the one property the local encoder has to keep: **its vectors
 * have to be the hosted pick's vectors.** `embedChunk` (warm-dig.mjs), this
 * module and the browser file rows into one shared cache keyed by `MODEL` and
 * a hash of the text, and a ranking mixes them in a single cosine matrix. A
 * local encoder that disagrees by a hair does not throw — it files a second
 * geometry under the same key, and every later reader trusts it. So the
 * expected values below are hand-computed from the arithmetic the hosted
 * function runs (mean over the token grid, then L2), not read back from this
 * module's output.
 *
 * The model is never loaded: a fake `pipelineFactory` hands back a token grid
 * the test already knows, so what is under test is this module's pooling and
 * normalisation rather than the model's.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DIM, MODEL } from './warm-dig.mjs';
import { chooseEmbedder, embedLocal, meanPool } from './embed-local.mjs';

/** A token: DIM wide, with `values` laid into the leading indices. */
function token(...values) {
  const v = new Float32Array(DIM);
  for (let i = 0; i < values.length; i++) v[i] = values[i];
  return v;
}

/** A token pointing along axis `k`, so a mix-up between rows is visible. */
function unitAt(k) {
  const v = new Float32Array(DIM);
  v[k] = 1;
  return v;
}

/**
 * A stand-in for transformers.js. `table` maps a text to its token grid, and
 * the extractor hands back exactly the grid it was asked for — so the pooling
 * and the normalisation under test are this module's, never the fake's.
 */
function fakePipeline(table) {
  const calls = [];
  const extractor = async (texts, opts) => {
    calls.push({ texts: [...texts], opts });
    return { tolist: () => texts.map((t) => table[t]) };
  };
  return { pipelineFactory: async () => extractor, calls };
}

/* ── The arithmetic ─────────────────────────────────────────────────────── */

test('a stone is the mean over its tokens', () => {
  // (e0 + e1) / 2 = (0.5, 0.5, 0, …), unit-normalised → 1/√2 on each.
  const v = meanPool([token(1, 0), token(0, 1)]);
  assert.equal(v.length, DIM);
  assert.ok(Math.abs(v[0] - Math.SQRT1_2) < 1e-6);
  assert.ok(Math.abs(v[1] - Math.SQRT1_2) < 1e-6);
  assert.equal(v[2], 0);
});

test('a single-token row is that token, normalised', () => {
  // (3, 4, 0, …) → (0.6, 0.8, 0, …).
  const v = meanPool([token(3, 4)]);
  assert.ok(Math.abs(v[0] - 0.6) < 1e-6);
  assert.ok(Math.abs(v[1] - 0.8) < 1e-6);
});

test('every stone is a unit vector, whatever the token magnitudes', () => {
  for (const tokens of [[token(3, 4)], [token(1), token(2)], [token(5, 0), token(0, 12)]]) {
    const v = meanPool(tokens);
    let sum = 0;
    for (const x of v) sum += x * x;
    assert.ok(Math.abs(Math.sqrt(sum) - 1) < 1e-6);
  }
});

test('a grid that pools to zero stays zero rather than NaN', () => {
  // A zero vector cannot be normalised; NaN would poison every cosine it
  // touched instead of scoring 0.
  const v = meanPool([token(0), token(0)]);
  assert.ok(v.every(Number.isFinite));
  assert.equal(v[0], 0);
});

test('a token of the wrong width is refused, not filed under the cache key', () => {
  // A 512-wide row under a 768-wide key poisons every read, silently.
  assert.throws(() => meanPool([[1, 0, 0]]), /expected 768/);
});

/* ── embedLocal ─────────────────────────────────────────────────────────── */

test('one DIM-long unit vector per text, in order', async () => {
  const { pipelineFactory } = fakePipeline({
    a: [unitAt(0), unitAt(1)],
    b: [unitAt(5)],
  });
  const out = await embedLocal(['a', 'b'], { pipelineFactory });
  assert.equal(out.length, 2);
  for (const v of out) {
    assert.ok(v instanceof Float32Array);
    assert.equal(v.length, DIM);
  }
  assert.ok(Math.abs(out[0][0] - Math.SQRT1_2) < 1e-6);   // a: mean of e0, e1
  assert.ok(Math.abs(out[0][1] - Math.SQRT1_2) < 1e-6);
  assert.equal(out[1][5], 1);                              // b: e5
});

test('the extractor is asked for the token grid, not a pooled answer', async () => {
  // If the pipeline pooled, this module would be normalising someone else's
  // arithmetic and the fixtures above would be pinning the model, not us.
  const { pipelineFactory, calls } = fakePipeline({ a: [unitAt(0)] });
  await embedLocal(['a'], { pipelineFactory });
  assert.deepEqual(calls[0].opts, { pooling: 'none' });
});

test('the grid may be plain arrays, as tolist() returns', async () => {
  const { pipelineFactory } = fakePipeline({
    a: [Array.from(token(1, 0)), Array.from(token(0, 1))],
  });
  const [v] = await embedLocal(['a'], { pipelineFactory });
  assert.ok(Math.abs(v[0] - Math.SQRT1_2) < 1e-6);
  assert.ok(Math.abs(v[1] - Math.SQRT1_2) < 1e-6);
});

test('a run longer than one batch is chunked, and the rows stay in order', async () => {
  const texts = Array.from({ length: 70 }, (_, i) => 't' + i);
  const table = Object.fromEntries(texts.map((t, i) => [t, [unitAt(i)]]));
  const { pipelineFactory, calls } = fakePipeline(table);
  const out = await embedLocal(texts, { pipelineFactory });
  assert.deepEqual(calls.map((c) => c.texts.length), [64, 6]);
  assert.equal(out.length, 70);
  for (let i = 0; i < 70; i++) assert.equal(out[i][i], 1, 'row ' + i);
});

test('a short answer from the model is an error, not a short batch', async () => {
  const extractor = async () => ({ tolist: () => [] });
  await assert.rejects(
    () => embedLocal(['a'], { pipelineFactory: async () => extractor }),
    /0 rows for 1 texts/,
  );
});

test('nothing to embed loads no model', async () => {
  let asked = false;
  const out = await embedLocal([], {
    pipelineFactory: async () => { asked = true; },
  });
  assert.deepEqual(out, []);
  assert.equal(asked, false);
});

/* ── The flag ───────────────────────────────────────────────────────────── */

test('--embed-local picks the local encoder, and the hosted pick otherwise', async () => {
  const seen = [];
  const embedChunk = async (texts, url) => { seen.push(url); return texts.map(() => 'hosted'); };
  const { pipelineFactory } = fakePipeline({ a: [unitAt(0)] });

  const local = chooseEmbedder(
    { embedLocal: true }, { embedChunk, embedUrl: 'http://pick', pipelineFactory });
  const mine = await local(['a']);
  assert.ok(mine[0] instanceof Float32Array, 'embedLocal ran');
  assert.deepEqual(seen, [], 'the hosted pick must not be called with --embed-local');

  const hosted = chooseEmbedder({}, { embedChunk, embedUrl: 'http://pick' });
  assert.deepEqual(await hosted(['a', 'b']), ['hosted', 'hosted']);
  assert.deepEqual(seen, ['http://pick']);
});

test('an explicit false is the hosted pick too', async () => {
  const hosted = chooseEmbedder(
    { embedLocal: false },
    { embedChunk: async () => ['hosted'], embedUrl: 'http://pick' });
  assert.deepEqual(await hosted(['x']), ['hosted']);
});

test('the shared cache key is the model the hosted pick uses', () => {
  // Both halves are imported from warm-dig.mjs, so a local run files rows the
  // page will look up — change the model here and every warmed row goes cold.
  assert.equal(MODEL, 'allenai/specter2_base');
  assert.equal(DIM, 768);
});

test('both entry points wire --embed-local through chooseEmbedder', () => {
  /* The flag is only real if the call sites branch on it, and that branch is
     one line inside a main() that takes the network. Pinned as a source check,
     like warm-dig's weekend-lookback ordering. */
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const file of ['warm-dig.mjs', 'preset-feed.mjs']) {
    const src = fs.readFileSync(path.join(here, file), 'utf8');
    assert.match(src, /--embed-local/, file);
    assert.match(src, /chooseEmbedder\(/, file);
  }
});
