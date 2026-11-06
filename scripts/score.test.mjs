/**
 * `node --test scripts/score.test.mjs`.
 *
 * Every expectation below is hand-computed from the contract in INTERFACES.md
 * and from the formula the page and the feed already use, never from this
 * file's own output. Two tricks keep the arithmetic checkable by eye:
 * orthonormal vectors, whose cosines are exactly 1 and 0, and a MAD of 1, which
 * makes a value written as a multiple of 1.4826 a z of exactly that multiple.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  maxSim, resolveTaus, robustStats, shortlist, thresholdForPassRate, zRef,
} from './score.mjs';

const e1 = [1, 0, 0];
const e2 = [0, 1, 0];

/* 1.4826 * 1, so `k * M` against {median: 0.5, mad: 1} is a z of exactly k. */
const M = 1.4826;

test('maxSim picks the row with the largest cosine, and returns that row', () => {
  const rows = [
    { vector: e2, weight: 1, label: 'orthogonal' },
    { vector: e1, weight: 1, label: 'identical' },
  ];
  const { max, row } = maxSim(e1, rows);
  assert.equal(max, 1);
  assert.equal(row, rows[1]); // the row itself: the caller wants its label
  assert.equal(row.label, 'identical');
});

test('a row without a vector is skipped rather than scored zero', () => {
  // Scored as 0 the unresolved row would win the argmax here, and the maximum
  // would be 0 instead of the real best match. It is skipped on both counts.
  const rows = [
    { vector: null, weight: 5, label: 'unresolved' },
    { vector: [-1], weight: 1, label: 'opposite' },
    { vector: [-0.5], weight: 1, label: 'askew' },
  ];
  const { max, row } = maxSim([1], rows);
  assert.equal(max, -0.5);
  assert.equal(row.label, 'askew');
  // Nothing scored at all: the same zero grade() returns, and no row.
  assert.deepEqual(maxSim(e1, [{ vector: null }, null]), { max: 0, row: null });
});

test('robustStats takes the middle element, on odd and on even counts alike', () => {
  // sorted [1,2,3,4,5]: median 3; deviations [2,1,0,1,2] -> sorted [0,1,1,2,2]
  // -> mad = devs[2] = 1.
  assert.deepEqual(robustStats([3, 1, 5, 2, 4]), { median: 3, mad: 1 });
  // sorted [1,2,3,10]: the even count takes sorted[2] = 3, not the 2.5 mean,
  // because that is the convention the browser gate and selectItems() use;
  // deviations [2,1,0,7] -> sorted [0,1,2,7] -> mad = devs[2] = 2.
  assert.deepEqual(robustStats([1, 2, 3, 10]), { median: 3, mad: 2 });
  assert.deepEqual(robustStats([4, 1, 3, 2]), { median: 3, mad: 1 });
});

test('robustStats sorts a copy, leaves the caller alone, and survives empty', () => {
  const values = [5, 1, 3];
  robustStats(values);
  assert.deepEqual(values, [5, 1, 3]);
  assert.deepEqual(robustStats([]), { median: 0, mad: 0 });
});

test('zRef is the value above the median over 1.4826 times the MAD', () => {
  // (0.5 + 2M - 0.5) / (1.4826 * 1) = 2M / M = 2, exactly.
  assert.equal(zRef(0.5 + 2 * M, { median: 0.5, mad: 1 }), 2);
  assert.equal(zRef(0.5 - 2 * M, { median: 0.5, mad: 1 }), -2);
  assert.equal(zRef(0.5, { median: 0.5, mad: 1 }), 0);
  // Twice the MAD halves the z: (0.5 + 2M - 0.5) / (1.4826 * 2) = 1.
  assert.equal(zRef(0.5 + 2 * M, { median: 0.5, mad: 2 }), 1);
});

test('zRef is 0 rather than NaN or Infinity when there is no spread', () => {
  assert.equal(zRef(5, { median: 1, mad: 0 }), 0);
  assert.equal(zRef(5, { median: 1 }), 0);
  // An axis a paper was never scored on has no z either.
  assert.equal(zRef(5, {}), 0);
  assert.equal(zRef(undefined, { median: 0, mad: 1 }), 0);
  assert.equal(zRef(NaN, { median: 0, mad: 1 }), 0);
});

test('thresholdForPassRate is the lowest bar that keeps the pass rate', () => {
  const hundred = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100, distinct
  // 1% of 100 = one value may clear it: the bar is the top value.
  assert.equal(thresholdForPassRate(hundred, 0.01), 100);
  // 50% = fifty may clear it: the bar is the 51st smallest, index 50.
  assert.equal(thresholdForPassRate(hundred, 0.5), 51);
  // 100% = everything clears it: the bar is the bottom value.
  assert.equal(thresholdForPassRate(hundred, 1), 1);
  // Out of order in, same answer out — the sort is internal. 50% of 5 is 2.5,
  // so at most two may pass and the bar is the 4th smallest.
  assert.equal(thresholdForPassRate([5, 1, 3, 2, 4], 0.5), 4);
});

test('the bar holds the rate at or under the ask, ties included', () => {
  const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
  for (const rate of [0.01, 0.5, 1]) {
    const t = thresholdForPassRate(hundred, rate);
    assert.ok(hundred.filter((v) => v >= t).length / 100 <= rate, `rate ${rate} overran`);
  }
  // A tie at the top counts as passing, so the bar rises with it: no value can
  // let 10% of three identical values through, hence the Infinity sentinel.
  assert.equal(thresholdForPassRate([5, 5, 5], 0.1), Infinity);
  // count(1) = 3 > 1.5, count(2) = 1 <= 1.5.
  assert.equal(thresholdForPassRate([1, 1, 2], 0.5), 2);
  assert.equal(thresholdForPassRate([], 0.01), 0);
});

/* Two axes, five background papers each. Axis A's mean_sim has mad 1 and a
   spread of M, axis B's has mad 2 and a spread of 2M: different scales, but the
   same z on both, [-2,-1,0,1,2], which is the point of scoring the pool in z —
   pooling the raw values instead would put the bar at 6.43, and using axis A's
   mad for axis B would put it at 4. The max_sim side pools raw 0.1..0.5, twice
   over, since a single close seed is the signal there. */
const background = {
  built_on: '2026-11-01',
  n: 10,
  axes: {
    A: {
      mean: { median: 0.5, mad: 1, values: [0.5 - 2 * M, 0.5 - M, 0.5, 0.5 + M, 0.5 + 2 * M] },
      max: { median: 0.3, mad: 0.1, values: [0.1, 0.2, 0.3, 0.4, 0.5] },
    },
    B: {
      mean: { median: 0.5, mad: 2, values: [0.5 - 4 * M, 0.5 - 2 * M, 0.5, 0.5 + 2 * M, 0.5 + 4 * M] },
      max: { median: 0.3, mad: 0.1, values: [0.1, 0.2, 0.3, 0.4, 0.5] },
    },
  },
};

const config = {
  shortlist: { max: 20, min: 3, sensitivity: 'normal', tau_ref: null, tau_seed: null },
  sensitivity_presets: {
    strict: { background_pass: 0.05 },
    normal: { background_pass: 0.2 },
    broad: { background_pass: 0.4 },
  },
};

test('the sensitivity word sets both bars off the pooled background', () => {
  // 20% of the ten pooled z values is two, so the bar is z = 2 — the top of
  // both axes. The same budget on the pooled raw max_sim is 0.5.
  assert.deepEqual(resolveTaus(config, background), { tau_ref: 2, tau_seed: 0.5 });
  // 40% is four -> the bar drops to z = 1, and to max_sim 0.4.
  const broad = { ...config, shortlist: { ...config.shortlist, sensitivity: 'broad' } };
  assert.deepEqual(resolveTaus(broad, background), { tau_ref: 1, tau_seed: 0.4 });
});

test('an explicit tau wins over the sensitivity, key by key', () => {
  const pinnedRef = { ...config, shortlist: { ...config.shortlist, tau_ref: 7 } };
  assert.deepEqual(resolveTaus(pinnedRef, background), { tau_ref: 7, tau_seed: 0.5 });
  const pinnedBoth = { ...config, shortlist: { ...config.shortlist, tau_ref: 7, tau_seed: 9 } };
  assert.deepEqual(resolveTaus(pinnedBoth, background), { tau_ref: 7, tau_seed: 9 });
  // Both pinned means the background is never consulted, even if it is absent.
  assert.deepEqual(resolveTaus(pinnedBoth, null), { tau_ref: 7, tau_seed: 9 });
});

/* One axis' worth of scores, in the shape shortlist() reads. */
const on = (z_ref, max_sim, z_day = 0) => ({ z_ref, max_sim, z_day });

test('a paper passes on z_ref, and says which axis carried it', () => {
  const papers = [
    { id: '2601.00002', axes: { A: on(3, 0.2, 0.5) } },
    { id: '2601.00001', axes: { A: on(5, 0.2, 0.1) } },
    { id: '2601.00003', axes: { A: on(0, 0.2, 2) } }, // below both bars
  ];
  const out = shortlist(papers, { tauRef: 2, tauSeed: 1, max: 20, min: 0, axisWeights: { A: 1 } });
  assert.deepEqual(out, {
    papers: [
      { id: '2601.00001', passed_by: 'z_ref', best_axis: 'A' }, // z_ref 5
      { id: '2601.00002', passed_by: 'z_ref', best_axis: 'A' }, // z_ref 3
    ],
    filled: 0,
  });
});

test('one very close seed is a pass on its own, and z_ref wins when both hold', () => {
  const papers = [
    { id: 'a', axes: { B: on(1, 0.9) } }, // z_ref below the bar, max_sim above
    { id: 'b', axes: { B: on(1, 0.5) } }, // neither
    { id: 'c', axes: { B: on(3, 0.9) } }, // both -> the stronger claim is z_ref
  ];
  const out = shortlist(papers, { tauRef: 2, tauSeed: 0.8, max: 20, min: 0, axisWeights: { B: 1 } });
  assert.deepEqual(out, {
    papers: [
      { id: 'c', passed_by: 'z_ref', best_axis: 'B' },
      { id: 'a', passed_by: 'max_sim', best_axis: 'B' },
    ],
    filled: 0,
  });
});

test('an axis weighted 0 is switched off, for passing and for the best axis', () => {
  const paper = { id: 'a', axes: { A: on(99, 0.99, 9), B: on(1, 0.2) } };
  const off = shortlist([paper], { tauRef: 2, tauSeed: 0.8, max: 20, min: 0, axisWeights: { A: 0, B: 1 } });
  assert.deepEqual(off, { papers: [], filled: 0 });
  const both = shortlist([paper], { tauRef: 2, tauSeed: 0.8, max: 20, min: 0, axisWeights: { A: 1, B: 1 } });
  assert.deepEqual(both.papers, [{ id: 'a', passed_by: 'z_ref', best_axis: 'A' }]);
});

test('the best axis is the strongest one that is switched on', () => {
  const paper = { id: 'a', axes: { A: on(1, 0.1), B: on(4, 0.2), C: on(9, 0.3) } };
  const out = shortlist([paper], { tauRef: 2, tauSeed: 1, max: 20, min: 0, axisWeights: { A: 1, B: 1, C: 0 } });
  assert.deepEqual(out.papers, [{ id: 'a', passed_by: 'z_ref', best_axis: 'B' }]);
});

test('a thin day is filled from the top z_day and labelled as such', () => {
  const papers = [
    { id: 'p1', axes: { A: on(3, 0.1, 0.1) } }, // the only paper above a bar
    { id: 'p2', axes: { A: on(-1, 0.1, 5) } },
    { id: 'p3', axes: { A: on(-2, 0.1, 7) } },
  ];
  const opts = { tauRef: 2, tauSeed: 1, max: 20, axisWeights: { A: 1 } };
  // Enough already: the floor does not fire and nothing is duplicated.
  assert.deepEqual(shortlist(papers, { ...opts, min: 1 }), {
    papers: [{ id: 'p1', passed_by: 'z_ref', best_axis: 'A' }],
    filled: 0,
  });
  // One short: p3's z_day 7 beats p2's 5, and the fill is marked as a fill.
  assert.deepEqual(shortlist(papers, { ...opts, min: 2 }), {
    papers: [
      { id: 'p1', passed_by: 'z_ref', best_axis: 'A' },
      { id: 'p3', passed_by: 'z_day', best_axis: 'A' },
    ],
    filled: 1,
  });
  // Two short: both, ordered by the z_ref the whole list is ordered by.
  assert.deepEqual(shortlist(papers, { ...opts, min: 3 }), {
    papers: [
      { id: 'p1', passed_by: 'z_ref', best_axis: 'A' },
      { id: 'p2', passed_by: 'z_day', best_axis: 'A' }, // z_ref -1
      { id: 'p3', passed_by: 'z_day', best_axis: 'A' }, // z_ref -2
    ],
    filled: 2,
  });
});

test('the list is capped at max, the richest first', () => {
  const papers = ['a', 'b', 'c', 'd'].map((id, i) => ({ id, axes: { A: on(4 - i, 0.1) } }));
  const out = shortlist(papers, { tauRef: 0, tauSeed: 1, max: 2, min: 0, axisWeights: { A: 1 } });
  assert.deepEqual(out, {
    papers: [
      { id: 'a', passed_by: 'z_ref', best_axis: 'A' }, // z_ref 4
      { id: 'b', passed_by: 'z_ref', best_axis: 'A' }, // z_ref 3
    ],
    filled: 0,
  });
});

test('a tie on z_ref is broken by id, so input order cannot change the list', () => {
  const papers = ['c', 'a', 'b'].map((id) => ({ id, axes: { A: on(3, 0.1) } }));
  const out = shortlist(papers, { tauRef: 2, tauSeed: 1, max: 20, min: 0, axisWeights: { A: 1 } });
  assert.deepEqual(out.papers.map((p) => p.id), ['a', 'b', 'c']);
});

