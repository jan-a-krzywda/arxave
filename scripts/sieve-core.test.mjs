/**
 * `node --test scripts/sieve-core.test.mjs`.
 *
 * Every expectation below is hand-computed from the Scoring section of
 * sieve2-spec.md (and from the formulas the page already uses), never from this
 * file's own output. Two fixtures keep the arithmetic readable by eye:
 *
 *   * 3-dim orthonormal vectors, so every cosine is exactly 1, 0 or -1;
 *   * a corpus whose `r` values give a weighted median of 0 and a MAD of 1, so
 *     s = 1.4826 and a fitZ written as a multiple of M is exactly that multiple.
 *
 * The scoring tests build their corpus object directly — the shape `loadCorpus`
 * returns — so a fixture can state the geometry it wants. `loadCorpus` itself
 * is tested against a real json + int8 buffer, built here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  centreUnit, loadCorpus, percentRank, prepare, rank, score, weightedMedian,
} from '../docs/assets/sieve-core.mjs';

/* 1.4826 x MAD, the constant that makes a MAD a sigma: a value of k * M over a
   reference of {m: 0, s: 1.4826} is a fitZ of exactly k. */
const M = 1.4826;

/** 1 / sqrt(2): the unit vector that a centred [0.5, 0.5, 0] normalises to. */
const R = Math.SQRT1_2;

/* A corpus object as loadCorpus builds it, for fixtures that only score. Rows
   as rows — or, for the big synthetic one, an already-flat Float32Array and its
   dim. */
function corpus({ vecs, dim: givenDim, pct, cluster, clusters, ids, titles }) {
  const flat = vecs instanceof Float32Array ? vecs : Float32Array.from(vecs.flat());
  const dim = givenDim ?? vecs[0].length;
  const n = flat.length / dim;
  return {
    n,
    dim,
    mean: new Float32Array(dim),
    vecs: flat,
    ids: ids ?? Array.from({ length: n }, (_, i) => `p${i}`),
    titles: titles ?? Array.from({ length: n }, (_, i) => `t${i}`),
    pct: Float32Array.from(pct),
    cluster: Int32Array.from(cluster ?? new Array(n).fill(0)),
    clusters: (clusters ?? [{ id: 0, label: 'all', size: n, centroid: vecs[0] }])
      .map((c) => ({ ...c, centroid: Float32Array.from(c.centroid) })),
  };
}

const stone = (id, vec) => ({ id, vec: Float32Array.from(vec) });

function close(got, want, eps = 1e-6) {
  assert.ok(Math.abs(got - want) < eps, `${got} is not within ${eps} of ${want}`);
}

const idsOf = (ranked) => ranked.map((r) => r.id);

/* ── weightedMedian ─────────────────────────────────────────────────────── */

test('weightedMedian is the first value whose cumulative weight reaches half', () => {
  // sorted [1,2,3], equal weights: total 3, half 1.5, cum 1 then 2 -> 2.
  assert.equal(weightedMedian([3, 1, 2], [1, 1, 1]), 2);
  // Unsorted input: the same answer, and the input is left alone.
  const values = [3, 1, 2];
  weightedMedian(values, [1, 1, 1]);
  assert.deepEqual(values, [3, 1, 2]);
  // Lopsided weights move it: half of 4 is 2, and one value at weight 3
  // reaches it on its own.
  assert.equal(weightedMedian([1, 2], [3, 1]), 1);
  assert.equal(weightedMedian([1, 2], [1, 3]), 2);
});

test('weightedMedian at the half-weight boundary takes the lower value', () => {
  // Two equal halves: total 2, half 1, and the first value already reaches it
  // (`>=`, not `>`). This is the spec's boundary, and the reason a corpus of
  // halves has a median of the lower half.
  assert.equal(weightedMedian([1, 2], [1, 1]), 1);
  // The same boundary among ties: sorted [1,1,2], total 2, half 1 -> 1.
  assert.equal(weightedMedian([2, 1, 1], [1, 1, 1]), 1);
  // One value, whatever its weight.
  assert.equal(weightedMedian([0.25], [0.5]), 0.25);
});

test('weightedMedian copes with nothing to weigh', () => {
  // The "nothing scored" zero robustStats() returns, for the same reason.
  assert.equal(weightedMedian([], []), 0);
  // All-zero weights stop the walk at the first (smallest) value: nothing has
  // reached half of nothing. prepare() never lets this reach a fit statistic.
  assert.equal(weightedMedian([5, 7], [0, 0]), 5);
});

/* ── percentRank ────────────────────────────────────────────────────────── */

test('percentRank splits ties instead of ordering them', () => {
  // values [1,2,2,3]: P(1) = (0 + 0.5*1)/4; P(2) = (1 + 0.5*2)/4;
  // P(3) = (3 + 0.5*1)/4. Both 2s get the same rank, which is what keeps a
  // result independent of the order the candidates arrived in.
  const values = [1, 2, 2, 3];
  assert.equal(percentRank(values, 1), 0.125);
  assert.equal(percentRank(values, 2), 0.5);
  assert.equal(percentRank(values, 3), 0.875);
  // A value that is not in the set is ranked by the count below it.
  assert.equal(percentRank(values, 2.5), 0.75);
});

test('percentRank gives a lone value 0.5 — the spec\'s one-candidate case', () => {
  assert.equal(percentRank([0.7], 0.7), 0.5);
  // No distribution, no rank.
  assert.equal(percentRank([], 0.7), 0);
});

/* ── centreUnit ─────────────────────────────────────────────────────────── */

test('centreUnit subtracts the mean, normalises, and leaves zero at zero', () => {
  // [1,1,0] - [0.5,0.5,0] = [0.5,0.5,0], a unit vector only after the norm.
  const u = centreUnit([1, 1, 0], [0.5, 0.5, 0]);
  assert.ok(u instanceof Float32Array);
  close(u[0], R);
  close(u[1], R);
  assert.equal(u[2], 0);
  close(Math.hypot(...u), 1);

  // A vector sitting exactly on the mean centres to zero. Zero, not NaN: a zero
  // row scores 0 against everything, a NaN row poisons every cosine it touches.
  const zero = centreUnit([0.5, 0.5, 0], [0.5, 0.5, 0]);
  assert.deepEqual(Array.from(zero), [0, 0, 0]);

  // A wrong width is a bug at the call site, not a short row to be averaged.
  assert.throws(() => centreUnit([1, 0], [0.5, 0.5, 0]), /2 dims against a mean of 3/);
});

/* ── loadCorpus ─────────────────────────────────────────────────────────── */

/** The json + bin S2 writes, small enough to check by hand. */
const JSON_3 = {
  built_on: '2026-11-10',
  model: 'allenai/specter2_base',
  dim: 3,
  n: 3,
  scale: 1,
  window: { from: '2025-09-01', to: '2025-12-31' },
  mean: [0.5, 0.5, 0],
  ids: ['a', 'b', 'c'],
  titles: ['A', 'B', 'C'],
  cites: [9, 4, 1],
  pct: [1, 0.5, 0],
  cluster: [0, 1, 0],
  clusters: [
    { id: 0, label: 'x', size: 2, centroid: [1, 0, 0] },
    { id: 1, label: 'y', size: 1, centroid: [0, 1, 0] },
  ],
};

/* `q * scale / 127` with scale 1 is `q / 127`, so q = 127 dequantises to
   exactly 1 and the centred results are exact: [1,0,0] - mean = [0.5,-0.5,0],
   [0,1,0] - mean = [-0.5,0.5,0], and the all-zero row centres to [-0.5,-0.5,0],
   whose norm is sqrt(0.5) — R each way once normalised. */
const BIN_3 = Int8Array.from([127, 0, 0, 0, 127, 0, 0, 0, 0]);

test('loadCorpus dequantises int8 with the scale and centres and normalises', () => {
  const c = loadCorpus(JSON_3, BIN_3.buffer);
  assert.equal(c.n, 3);
  assert.equal(c.dim, 3);
  assert.deepEqual(Array.from(c.mean), [0.5, 0.5, 0]);

  const row = (i) => Array.from(c.vecs.subarray(i * 3, i * 3 + 3));
  close(row(0)[0], R); close(row(0)[1], -R); assert.equal(row(0)[2], 0);
  close(row(1)[0], -R); close(row(1)[1], R); assert.equal(row(1)[2], 0);
  close(row(2)[0], -R); close(row(2)[1], -R); assert.equal(row(2)[2], 0);
  for (let i = 0; i < 3; i++) close(Math.hypot(...row(i)), 1);

  assert.deepEqual(c.ids, ['a', 'b', 'c']);
  assert.deepEqual(c.titles, ['A', 'B', 'C']);
  assert.deepEqual(Array.from(c.pct), [1, 0.5, 0]);
  assert.deepEqual(Array.from(c.cluster), [0, 1, 0]);
  assert.ok(c.pct instanceof Float32Array && c.cluster instanceof Int32Array);
  assert.deepEqual(c.clusters.map((k) => k.label), ['x', 'y']);
  assert.ok(c.clusters[0].centroid instanceof Float32Array);
});

test('loadCorpus takes the bytes as an ArrayBuffer or as a Node Buffer', () => {
  // The browser hands over an ArrayBuffer and fs.readFile hands over a Buffer;
  // both must dequantise to one geometry.
  const fromBuffer = loadCorpus(JSON_3, Buffer.from(BIN_3));
  const fromArrayBuffer = loadCorpus(JSON_3, BIN_3.buffer);
  assert.deepEqual(Array.from(fromBuffer.vecs), Array.from(fromArrayBuffer.vecs));
});

test('loadCorpus refuses a file whose parts do not agree', () => {
  // One row short: read as-is, every row after it belongs to the wrong paper.
  assert.throws(() => loadCorpus(JSON_3, Int8Array.from([0, 0, 0]).buffer), /vec\.bin/);
  assert.throws(() => loadCorpus({ ...JSON_3, pct: [1, 0] }, BIN_3.buffer), /pct/);
  assert.throws(() => loadCorpus({ ...JSON_3, mean: [0.5, 0.5] }, BIN_3.buffer), /mean/);
  assert.throws(() => loadCorpus({ ...JSON_3, n: 0 }, BIN_3.buffer), /n is/);
  assert.throws(() => loadCorpus({ ...JSON_3, scale: 0 }, BIN_3.buffer), /scale/);
});

/* ── prepare: the fit statistics ────────────────────────────────────────── */

/* Six papers whose cosines against e1 are [1, 0, -1, 0, 1, -1]. Sorted
   [-1,-1,0,0,1,1] with total weight 3 -> half 1.5 -> the walk stops at the third
   value, so m = 0. The deviations [1,0,1,0,1,1] sort to [0,0,1,1,1,1], which
   stops at the third value too: MAD 1, s = 1.4826. */
const FIT = corpus({
  vecs: [[1, 0, 0], [0, 1, 0], [-1, 0, 0], [0, 0, 1], [1, 0, 0], [-1, 0, 0]],
  pct: [1, 0.8, 0.6, 0.4, 0.2, 0.1],
  clusters: [
    { id: 0, label: 'x', size: 6, centroid: [1, 0, 0] },
    { id: 1, label: 'y', size: 0, centroid: [0, 1, 0] },
  ],
});

/* `gate: -Infinity` below is on purpose: the gate is a slider, and a test that
   is not about the gate should not be fighting it. */

test('fit raw over touchstones is max cos, and fitZ is its z against the corpus', () => {
  const prep = prepare({ corpus: FIT, weights: {}, touchstones: [[1, 0, 0]] });
  assert.equal(prep.m, 0);
  assert.equal(prep.s, M);

  const ranked = rank(prep, [stone('near', [1, 0, 0]), stone('far', [-1, 0, 0])], { gate: -Infinity });
  const byId = Object.fromEntries(ranked.map((r) => [r.id, r]));
  // r(near) = cos = 1, so fitZ = 1 / 1.4826; r(far) = -1, so fitZ = -0.6745.
  close(byId.near.fit, 1 / M);
  close(byId.near.fitZ, 1 / M);
  assert.equal(byId.near.fit, byId.near.fitZ);   // the spec's fit IS fitZ
  close(byId.far.fitZ, -1 / M);
  assert.ok(byId.far.fitZ < 0);                   // below the corpus median
});

test('fit raw with no touchstones is the weighted mean over cluster centroids', () => {
  // Centroids e1 (slider 1) and e2 (no slider -> 0.5): r(x) = (cos(x,e1) +
  // 0.5 cos(x,e2)) / 1.5 over the six rows gives [2/3, 1/3, -2/3, 0, 2/3, -2/3],
  // sorted [-2/3,-2/3,0,1/3,2/3,2/3] with total weight 3 -> m = 0 at the third
  // value. Deviations sort to [0,1/3,2/3,2/3,2/3,2/3] -> MAD 2/3, so s is
  // 2/3 * 1.4826.
  const prep = prepare({ corpus: FIT, weights: { 0: 1 } });
  close(prep.m, 0);
  close(prep.s, (2 / 3) * M);

  const ranked = rank(prep, [stone('e1', [1, 0, 0]), stone('away', [-1, 0, 0])], { gate: -Infinity });
  const byId = Object.fromEntries(ranked.map((r) => [r.id, r]));
  // (2/3) / ((2/3) * 1.4826) = 1 / 1.4826 — the same figure the touchstone mode
  // gives a paper sitting on the weighted centroid, and its mirror image.
  close(byId.e1.fitZ, 1 / M);
  close(byId.away.fitZ, -1 / M);
});

test('all-zero topic weights fall back to unit weights for every paper', () => {
  // Four papers, a touchstone along e1: r = [1, 0, -1, 0]. With weights {0: 0}
  // every p_i would be 0, and the weighted median's walk would stop at the
  // smallest value, -1. The fallback makes them all 1: sorted [-1,0,0,1] with
  // total 4 stops at the second value, m = 0.
  const c = corpus({ vecs: [[1, 0, 0], [0, 1, 0], [-1, 0, 0], [0, 0, 1]], pct: [1, 0.5, 0.2, 0.1] });
  const prep = prepare({ corpus: c, weights: { 0: 0 }, touchstones: [[1, 0, 0]] });
  assert.deepEqual(Array.from(prep.p), [1, 1, 1, 1]);
  assert.equal(prep.m, 0);

  // Deviations [1,0,1,0] give a MAD of 0, so s is 0 and the fitZ denominator is
  // the 1e-6 floor: a flat corpus must not divide by zero.
  assert.equal(prep.s, 0);
  const [A] = rank(prep, [stone('A', [1, 0, 0])], { gate: -Infinity });
  assert.ok(A.fitZ > 1e5);
});

/* ── rank: the gate, impact, novelty, landmarks ─────────────────────────── */

test('the gate drops candidates below fitZ, and nothing else', () => {
  const prep = prepare({ corpus: FIT, weights: {}, touchstones: [[1, 0, 0]] });
  const near = stone('near', [1, 0, 0]);   // fitZ = 1 / 1.4826 = 0.6745
  const flat = stone('flat', [0, 1, 0]);   // r = 0 -> fitZ = 0

  assert.deepEqual(idsOf(rank(prep, [near, flat], { gate: 0.5 })), ['near']);
  assert.deepEqual(idsOf(rank(prep, [near, flat], { gate: 0.7 })), []);
  // `>=`, so a paper sitting exactly on the median survives a gate of 0.
  assert.deepEqual(idsOf(rank(prep, [near, flat], { gate: 0 })).sort(), ['flat', 'near']);
  assert.deepEqual(rank(prep, [], { gate: 0 }), []);
});

test('impact is the pct of the k nearest, clamped at 0 and weighted by p + 0.05', () => {
  // k = 4: the four nearest are p0 (cos 1), p1 (cos 1), then p2 and p3 (cos 0,
  // the earlier index first on a tie). p is 0.5 everywhere, so the two that
  // count carry 1 x 0.55 each and the two at cos 0 carry nothing:
  // impact = (0.55 * 1.0 + 0.55 * 0.5) / 1.1 = 0.75.
  const c = corpus({
    vecs: [[1, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], [-1, 0, 0]],
    pct: [1, 0.5, 0.9, 0.3, 0.8],
  });
  const prep = prepare({ corpus: c, weights: {} });
  const [A] = rank(prep, [stone('A', [1, 0, 0])], { gate: -Infinity, k: 4 });
  close(A.impact, 0.75);
  // p4 (cos -1, the best pct in the corpus) never makes the top 4.
  assert.deepEqual(A.landmarks.map((l) => l.id), ['p0', 'p1', 'p2']);
});

test('impact weights neighbours by p, so a slider moves a neighbour\'s vote', () => {
  // Two papers at cos 1, one in a cluster weighted 1 (p = 1) and one in a
  // cluster weighted 0 (p = 0): a0 = 1.05 and a1 = 0.05, so the proven paper's
  // pct of 1 is almost the whole answer: (1.05 * 1 + 0.05 * 0) / 1.1 = 21/22.
  const c = corpus({
    vecs: [[1, 0, 0], [1, 0, 0]],
    pct: [1, 0],
    cluster: [0, 1],
    clusters: [
      { id: 0, label: 'mine', size: 1, centroid: [1, 0, 0] },
      { id: 1, label: 'not mine', size: 1, centroid: [1, 0, 0] },
    ],
  });
  const prep = prepare({ corpus: c, weights: { 0: 1, 1: 0 } });
  assert.deepEqual(Array.from(prep.p), [1, 0]);
  const [A] = rank(prep, [stone('A', [1, 0, 0])], { gate: -Infinity, k: 2 });
  close(A.impact, 21 / 22);
});

test('novelty looks only at papers with pct at or above topQ', () => {
  const c = corpus({ vecs: [[1, 0, 0], [0, 1, 0], [-1, 0, 0]], pct: [0.5, 0.9, 0.8] });
  const prep = prepare({ corpus: c, weights: {} });

  // p0 is the closest paper by a mile, but it is not proven: at topQ 0.75 the
  // only evidence is p1 (cos 0) and p2 (cos -1), so max cos 0 and novelty 1.
  const [hi] = rank(prep, [stone('A', [1, 0, 0])], { gate: -Infinity, topQ: 0.75 });
  assert.equal(hi.novelty, 1);
  // At topQ 0.4 p0 counts too, max cos 1, and the paper is not novel at all.
  const [lo] = rank(prep, [stone('A', [1, 0, 0])], { gate: -Infinity, topQ: 0.4 });
  assert.equal(lo.novelty, 0);
  // A corpus with nothing proven has nothing to be similar to.
  const [none] = rank(prep, [stone('A', [1, 0, 0])], { gate: -Infinity, topQ: 1.5 });
  assert.equal(none.novelty, 1);
});

test('landmarks are the three nearest corpus papers, with the evidence attached', () => {
  const c = corpus({
    vecs: [[1, 0, 0], [0.6, 0.8, 0], [0, 1, 0], [-0.6, 0.8, 0], [-1, 0, 0], [0.8, 0.6, 0]],
    pct: [0.9, 0.5, 0.7, 0.3, 0.1, 0.2],
    ids: ['a', 'b', 'c', 'd', 'e', 'f'],
    titles: ['Ta', 'Tb', 'Tc', 'Td', 'Te', 'Tf'],
  });
  const prep = prepare({ corpus: c, weights: {} });
  const [A] = rank(prep, [stone('A', [1, 0, 0])], { gate: -Infinity });

  // Cosines: 1 (a), 0.6 (b), 0 (c), -0.6 (d), -1 (e), 0.8 (f) -> a, f, b.
  assert.deepEqual(A.landmarks.map((l) => l.id), ['a', 'f', 'b']);
  assert.deepEqual(A.landmarks.map((l) => l.title), ['Ta', 'Tf', 'Tb']);
  close(A.landmarks[0].sim, 1);
  close(A.landmarks[1].sim, 0.8);
  close(A.landmarks[2].sim, 0.6);
  close(A.landmarks[0].pct, 0.9);
  close(A.landmarks[1].pct, 0.2);
  close(A.landmarks[2].pct, 0.5);
});

test('surprise 0 orders by impact, surprise 1 by novelty, and in between by both', () => {
  // p0 is proven (pct 1.0) and looks exactly like A; p1 is unproven (pct 0.2)
  // and looks exactly like B. So A is impact 1 / novelty 0 and B is the other
  // way round. Two gated candidates: P is 0.75 for the higher of a pair and
  // 0.25 for the lower, and score = (1 - surprise) * P(impact) + surprise * P(novelty).
  const c = corpus({ vecs: [[1, 0, 0], [0, 1, 0]], pct: [1, 0.2] });
  const prep = prepare({ corpus: c, weights: {} });
  const cands = [stone('A', [1, 0, 0]), stone('B', [0, 1, 0])];

  const impacts = rank(prep, cands, { gate: 0, surprise: 0 });
  assert.deepEqual(idsOf(impacts), ['A', 'B']);
  close(impacts[0].impact, 1);
  close(impacts[1].impact, 0.2);

  const novelties = rank(prep, cands, { gate: 0, surprise: 1 });
  assert.deepEqual(idsOf(novelties), ['B', 'A']);
  close(novelties[0].novelty, 1);
  close(novelties[1].novelty, 0);

  // In between: 0.6 * 0.75 + 0.4 * 0.25 = 0.55, and the mirror image 0.45.
  const both = rank(prep, cands, { gate: 0, surprise: 0.4 });
  const byId = Object.fromEntries(both.map((r) => [r.id, r]));
  close(byId.A.score, 0.55);
  close(byId.B.score, 0.45);
});

/* ── the shape of a result, and the two-call API ────────────────────────── */

test('a result carries the candidate\'s own fields, its topic, and its evidence', () => {
  const c = corpus({
    vecs: [[1, 0, 0], [0, 1, 0]],
    pct: [0.9, 0.1],
    clusters: [
      { id: 0, label: 'Superconducting qubits', size: 1, centroid: [1, 0, 0] },
      { id: 1, label: 'Spintronics', size: 1, centroid: [0, 1, 0] },
    ],
  });
  const prep = prepare({ corpus: c, weights: {} });
  const [A, B] = rank(prep, [
    { id: '2509.1', vec: Float32Array.from([1, 0, 0]), title: 'Tonight', cat: 'quant-ph' },
    { id: '2509.2', vec: Float32Array.from([0.6, 0.8, 0]) },
  ], { gate: -Infinity });

  // The page's own fields survive the spread untouched.
  assert.equal(A.title, 'Tonight');
  assert.equal(A.cat, 'quant-ph');
  // `cluster` is the nearest centroid: cos 1 vs 0 for the first paper, and
  // cos 0.6 vs 0.8 for the second.
  assert.equal(A.cluster, 0);
  assert.equal(B.cluster, 1);
  for (const r of [A, B]) {
    for (const key of ['fit', 'fitZ', 'impact', 'novelty', 'score', 'cluster', 'landmarks']) {
      assert.ok(key in r, `result is missing ${key}`);
    }
    assert.ok(r.fit >= r.fitZ - 1e-12 && r.fit <= r.fitZ + 1e-12);
    assert.ok(r.score >= 0 && r.score <= 1);
  }
});

test('rank re-reads a prepared corpus without recomputing or mutating it', () => {
  const prep = prepare({ corpus: FIT, weights: { 0: 1 }, touchstones: [[1, 0, 0]] });
  const before = { p: Array.from(prep.p), m: prep.m, s: prep.s };
  const cands = [stone('near', [1, 0, 0]), stone('flat', [0, 1, 0]), stone('far', [-1, 0, 0])];

  const first = rank(prep, cands, { gate: 0, surprise: 0.4 });
  assert.deepEqual(rank(prep, cands, { gate: 0, surprise: 0.4 }), first);  // no state, no clock, no dice
  // Strictness only moves the gate: same statistics, fewer papers. near is the
  // one candidate above the corpus median, at fitZ = 0.6745.
  assert.deepEqual(idsOf(rank(prep, cands, { gate: 0.5, surprise: 0.4 })), ['near']);
  assert.deepEqual({ p: Array.from(prep.p), m: prep.m, s: prep.s }, before);

  // score() is exactly the two halves in one call.
  assert.deepEqual(score({
    corpus: FIT,
    weights: { 0: 1 },
    touchstones: [[1, 0, 0]],
    candidates: cands,
    opts: { gate: 0, surprise: 0.4 },
  }), first);
});

test('a vector of the wrong width throws instead of scoring against a prefix', () => {
  const prep = prepare({ corpus: FIT, weights: {} });
  assert.throws(() => rank(prep, [{ id: 'x', vec: [1, 0] }], { gate: -Infinity }), /2 dims/);
  assert.throws(() => prepare({ corpus: FIT, weights: {}, touchstones: [[1, 0]] }), /2 dims/);
});

/* ── the performance budget ─────────────────────────────────────────────── */

/* A deterministic corpus: a small LCG, unit rows. The point is not the vectors
   but the shape — 6000 x 768 is what S2 writes and what the page has to rank. */
function synthetic(n, dim, centroids) {
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const vecs = new Float32Array(n * dim);
  for (let r = 0; r < n; r++) {
    let s = 0;
    for (let k = 0; k < dim; k++) {
      const v = rnd() * 2 - 1;
      vecs[r * dim + k] = v;
      s += v * v;
    }
    const inv = 1 / Math.sqrt(s);
    for (let k = 0; k < dim; k++) vecs[r * dim + k] *= inv;
  }
  return corpus({
    vecs,
    dim,
    pct: Array.from({ length: n }, () => rnd()),
    cluster: Array.from({ length: n }, (_, r) => r % centroids),
    clusters: Array.from({ length: centroids }, (_, k) => ({
      id: k,
      label: `topic ${k}`,
      size: 0,
      centroid: vecs.subarray(k * 37 * dim, (k * 37 + 1) * dim),
    })),
  });
}

test('6000 x 768 scores 200 candidates inside the card\'s 1.5 s budget', () => {
  const c = synthetic(6000, 768, 20);
  const other = synthetic(6000, 768, 20);   // candidates that are not corpus rows
  /* The heavier path: topic sliders and no touchstone, so `prepare` takes 20
     centroid dots per corpus paper and the fit statistics are a weighted median
     over 6000 values. */
  const weights = Object.fromEntries(Array.from({ length: 20 }, (_, k) => [k, 0.5 + (k % 3) * 0.25]));
  const candidates = Array.from({ length: 200 }, (_, i) => ({
    id: `c${i}`,
    vec: other.vecs.subarray(i * 768, (i + 1) * 768),
  }));

  /* Best of three: the first run also JITs the hot loop, and this suite runs on
     whatever else the machine is doing. The budget is the card's, not a
     softened one. */
  let ms = Infinity;
  let ranked = [];
  for (let run = 0; run < 3; run++) {
    const t0 = performance.now();
    const prep = prepare({ corpus: c, weights });
    ranked = rank(prep, candidates, { gate: 0, surprise: 0.4 });
    ms = Math.min(ms, performance.now() - t0);
  }

  assert.ok(ranked.length > 0, 'the gate kept nothing');
  assert.ok(ms < 1500, `200 candidates took ${ms.toFixed(0)} ms`);
});

