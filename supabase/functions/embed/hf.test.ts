/**
 * `deno test supabase/functions/embed/`
 *
 * The thing worth testing without a token: that both shapes HF can answer with
 * become the same vectors, and that a wrong one is loud rather than plausible.
 * A silent miss here does not throw anywhere downstream — it reorders someone's
 * papers and looks like a ranking opinion.
 */
import { assertEquals, assertThrows } from 'jsr:@std/assert@1';
import {
  DIM, MODEL, UPSTREAM_MAX_CHARS, clsRows, isTooLong, normalize, toVectors, warmingSeconds,
} from './hf.ts';

/** A dim-length vector whose first entry marks which row it is. */
function row(marker: number, fill = 0.5): number[] {
  const v = new Array(DIM).fill(fill);
  v[0] = marker;
  return v;
}

Deno.test('the model id is the one the cache is keyed on', () => {
  // Guards the four-way agreement named in hf.ts: this string also appears in
  // docs/assets/filter.js, scripts/warm-dig.mjs and tests/test_dig_cache.py.
  assertEquals(MODEL, 'allenai/specter2_base');
  assertEquals(DIM, 768);
});

Deno.test('pooled [n][dim] comes through as n vectors', () => {
  const out = toVectors([row(1), row(2)], 2);
  assertEquals(out.length, 2);
  assertEquals(out[0].length, DIM);
});

Deno.test('token grid [n][tokens][dim] pools on [CLS], not the mean', () => {
  /* Token 0 is [CLS] and the rest are deliberately different, so a mean-pool
     implementation cannot pass this: it would land between the two. */
  const cls = row(1, 0);
  cls[1] = 1;
  const other = row(0, 0);
  other[2] = 1;
  const out = toVectors([[cls, other, other]], 1);
  assertEquals(out.length, 1);
  // [CLS] was (1,1,0,…) → normalized (0.707,0.707,0,…). A mean would have put
  // weight on index 2, where [CLS] has none.
  assertEquals(out[0][2], 0);
  assertEquals(Math.round(out[0][0] * 1000) / 1000, 0.707);
});

Deno.test('a bare single vector is treated as one row', () => {
  const out = toVectors(row(1), 1);
  assertEquals(out.length, 1);
  assertEquals(out[0].length, DIM);
});

Deno.test('every returned vector is a unit vector', () => {
  const out = toVectors([row(3, 2), row(4, 7)], 2);
  for (const v of out) {
    let sum = 0;
    for (const x of v) sum += x * x;
    assertEquals(Math.round(Math.sqrt(sum) * 1e6) / 1e6, 1);
  }
});

Deno.test('a zero vector survives instead of becoming NaN', () => {
  // NaN would poison every cosine it touches; 0 merely scores 0.
  const zero = new Array(DIM).fill(0);
  assertEquals(toVectors([zero], 1)[0][0], 0);
});

Deno.test('a wrong count is an error, not a short answer', () => {
  assertThrows(() => toVectors([row(1)], 2), Error, 'returned 1 vectors for 2 texts');
});

Deno.test('a wrong dimension is an error, not a reshaped vector', () => {
  // The whole reason dim is in the cache key: 384 floats where 768 belong is
  // exactly the mix dig-spec §5.6 forbids.
  assertThrows(() => toVectors([new Array(384).fill(0.1)], 1), Error, 'expected 768');
});

Deno.test('a non-finite value is an error, not a quiet NaN', () => {
  const bad = row(1);
  bad[5] = NaN;
  assertThrows(() => toVectors([bad], 1), Error, 'non-finite');
});

Deno.test('a non-array answer is an error', () => {
  assertThrows(() => toVectors({ error: 'nope' }, 1), Error, 'expected an array');
});

Deno.test('normalize leaves an already-unit vector alone', () => {
  const v = normalize([0.6, 0.8]);
  assertEquals(Math.round(v[0] * 1000) / 1000, 0.6);
  assertEquals(Math.round(v[1] * 1000) / 1000, 0.8);
});

Deno.test('warming time falls back rather than retrying instantly', () => {
  assertEquals(warmingSeconds({ estimated_time: 12.5 }), 12.5);
  assertEquals(warmingSeconds({}), 20);
  assertEquals(warmingSeconds(null), 20);
  assertEquals(warmingSeconds({ estimated_time: -1 }), 20);
});

Deno.test('the length error is recognised however the upstream phrases it', () => {
  /* There is no status code for "your text was longer than my window" — the
     message is the only signal, and a batch that trips it fails whole. Missing
     it is what turned one dense abstract into a stopped 962-abstract warm. */
  assertEquals(isTooLong('The size of tensor a (545) must match the size of tensor b (512)'), true);
  assertEquals(isTooLong('sequence length is longer than the specified maximum'), true);
  assertEquals(isTooLong('input is too long for this model'), true);
  assertEquals(isTooLong('maximum context length exceeded'), true);
});

Deno.test('an ordinary failure is not mistaken for a length problem', () => {
  // Retrying these at a smaller clip would just fail again, three times over.
  assertEquals(isTooLong('Model is currently loading'), false);
  assertEquals(isTooLong('rate limit exceeded'), false);
  assertEquals(isTooLong('Unauthorized access'), false);
});

Deno.test('the clip leaves room for text far denser than prose', () => {
  /* 2000 chars was ~500 tokens of prose and 545 tokens of physics. The margin,
     not the average, is what this constant has to survive. */
  assertEquals(UPSTREAM_MAX_CHARS, 1_400);
  const worstCaseCharsPerToken = UPSTREAM_MAX_CHARS / 512;
  assertEquals(worstCaseCharsPerToken < 3.0, true);
});

/* ── clsRows: the streamed reader ──────────────────────────────────────── */

/** A JSON text as a stream cut into small, uneven chunks — numbers split too. */
function streamOf(text: string, size = 7): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (at >= bytes.length) return controller.close();
      controller.enqueue(bytes.subarray(at, at + size));
      at += size;
    },
  });
}

Deno.test('clsRows keeps token 0 of each row of the grid, and only that', async () => {
  const grid = [
    [[1.5, -2e-3, 3], [9, 9, 9], [8, 8, 8]],
    [[-4, 5.25, 6E1], [7, 7, 7]],
  ];
  assertEquals(await clsRows(streamOf(JSON.stringify(grid))), [[1.5, -2e-3, 3], [-4, 5.25, 60]]);
  /* spaced and newlined JSON reads the same */
  assertEquals(await clsRows(streamOf(JSON.stringify(grid, null, 2), 3)),
    [[1.5, -2e-3, 3], [-4, 5.25, 60]]);
});

Deno.test('clsRows reads a pooled [n][dim] and a bare [dim] whole', async () => {
  assertEquals(await clsRows(streamOf('[[1,2,3],[4,5,6]]')), [[1, 2, 3], [4, 5, 6]]);
  assertEquals(await clsRows(streamOf('[1,2,3]')), [[1, 2, 3]]);
});

Deno.test('clsRows hands an error object to toVectors, which says so', async () => {
  const got = await clsRows(streamOf('{"error":"boom"}'));
  assertEquals(got, { error: 'boom' });
  assertThrows(() => toVectors(got, 1, 3), Error, 'expected an array');
});

Deno.test('clsRows + toVectors equals toVectors on the parsed grid', async () => {
  const row = (seed: number) => Array.from({ length: DIM }, (_, k) => Math.sin(seed * 31 + k));
  const grid = [0, 1, 2].map((r) => [row(r), row(r + 10), row(r + 20)]);
  const text = JSON.stringify(grid);
  assertEquals(toVectors(await clsRows(streamOf(text, 4096)), 3), toVectors(JSON.parse(text), 3));
});

Deno.test('clsRows skips non-[CLS] rows across chunk edges and still counts rows', async () => {
  const token = (k: number) => Array.from({ length: 6 }, (_, j) => k + j / 10);
  const grid = [0, 1, 2].map((r) => [0, 1, 2, 3].map((t) => token(r * 10 + t)));
  for (const size of [1, 3, 7, 50, 4096]) {
    assertEquals(await clsRows(streamOf(JSON.stringify(grid), size)), [token(0), token(10), token(20)]);
  }
});
