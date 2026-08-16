/**
 * `deno test supabase/functions/embed/`
 *
 * The thing worth testing without a token: that both shapes HF can answer with
 * become the same vectors, and that a wrong one is loud rather than plausible.
 * A silent miss here does not throw anywhere downstream — it reorders someone's
 * papers and looks like a ranking opinion.
 */
import { assertEquals, assertThrows } from 'jsr:@std/assert@1';
import { DIM, MODEL, normalize, toVectors, warmingSeconds } from './hf.ts';

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
