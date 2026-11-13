import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadCorpus } from '../docs/assets/sieve-core.mjs';
import {
  DIM, SHIP_ACC, SPLIT_SEED, TEST_FRAC,
  accuracy, fitLogistic, mulberry32, pickSeeds, predict, round5, stratifiedSplit,
} from './cave-axes.mjs';

/* The files under test are the ones the card ships, not fixtures: axes.json
   and the seed lists live in the repo, and these tests are the oracle on them. */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = path.join(HERE, '..', 'docs', 'assets', 'corpus');
const corpusJson = JSON.parse(readFileSync(path.join(CORPUS_DIR, 'corpus.json'), 'utf8'));
const axesJson = JSON.parse(readFileSync(path.join(CORPUS_DIR, 'axes.json'), 'utf8'));
const seedsOf = (file) => JSON.parse(readFileSync(path.join(HERE, 'cave-seeds', file), 'utf8'));

/* Box–Muller on mulberry32: a Gaussian fixture that is the same 200 points on
   every run, so a failure here is the fit and not the dice. */
function gaussian(n, mean, sd, next) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const u = Math.max(next(), 1e-12);
    const v = next();
    const r = Math.sqrt(-2 * Math.log(u));
    out.push([mean + sd * r * Math.cos(2 * Math.PI * v), sd * r * Math.sin(2 * Math.PI * v)]);
  }
  return out;
}

/* ── the fit ────────────────────────────────────────────────────────────── */

test('fitLogistic separates a hand-built 2-class Gaussian fixture', () => {
  /* Two blobs at ±3σ on x, same spread on y: a straight line through the
     origin is the right model, so 95% is a floor and not a hope. */
  const next = mulberry32(7);
  const X = [...gaussian(100, -3, 1, next), ...gaussian(100, 3, 1, next)];
  const y = [...Array(100).fill(0), ...Array(100).fill(1)];

  const { w, b } = fitLogistic(X, y, { l2: 1e-3, iters: 4000 });
  const acc = accuracy(w, b, X, y);
  assert.ok(acc >= 0.95, `accuracy on the fixture is ${acc}, wanted >= 0.95`);

  /* The learned boundary is the y axis, so w points along +x and the bias is
     near zero — an accuracy that passed with the sign flipped would be a fit
     to noise, and this pins the class order the contract fixes. */
  const norm = Math.hypot(w[0], w[1]);
  assert.ok(w[0] / norm > 0.95, `w leans along +x: ${w[0] / norm}`);
  assert.ok(Math.abs(b) < 0.5, `b is ${b}, wanted near 0`);

  /* No Math.random anywhere: a second fit is the same fit, float for float. */
  const again = fitLogistic(X, y, { l2: 1e-3, iters: 4000 });
  assert.deepEqual(again.w, w);
  assert.equal(again.b, b);
});

test('a bigger l2 shrinks w, as the regulariser says it should', () => {
  const next = mulberry32(11);
  const X = [...gaussian(40, -1.5, 1, next), ...gaussian(40, 1.5, 1, next)];
  const y = [...Array(40).fill(0), ...Array(40).fill(1)];
  const soft = fitLogistic(X, y, { l2: 0.5, iters: 4000 });
  const hard = fitLogistic(X, y, { l2: 1e-4, iters: 4000 });
  assert.ok(Math.hypot(...soft.w) < Math.hypot(...hard.w));
});

test('fitLogistic refuses rows it cannot fit', () => {
  assert.throws(() => fitLogistic([], []), /no rows/);
  assert.throws(() => fitLogistic([[1, 2], [1, 2, 3]], [0, 1]), /dims/);
  assert.throws(() => fitLogistic([[1, 2], [3, 4]], [0, 2]), /label 1 is 2/);
});

/* ── the score ──────────────────────────────────────────────────────────── */

test('predict matches a hand-computed sigmoid', () => {
  /* z = 0.25 + 1·0.5 − 2·0.25 + 0.5·(−1) = −0.25, p = 1/(1+e^0.25). */
  const p = predict([1, -2, 0.5], 0.25, [0.5, 0.25, -1]);
  assert.ok(Math.abs(p - 0.4378234991142019) < 1e-15, `p is ${p}`);

  // z = 0 is the boundary itself.
  assert.equal(predict([1], 0, [0]), 0.5);

  // The tails saturate rather than producing NaN: a huge |z| is 0 or 1.
  assert.equal(predict([1, 0], 0, [1000, 7]), 1);
  assert.equal(predict([1, 0], 0, [-1000, 7]), 0);
  assert.equal(predict([0, 0], 0, [3, 4]), 0.5);
});

test('accuracy breaks the 0.5 tie on the positive side', () => {
  const w = [1];
  const X = [[0], [1], [-1]];
  // p = 0.5, 0.731, 0.269 → 1, 1, 0
  assert.equal(accuracy(w, 0, X, [1, 1, 0]), 1);
  assert.equal(accuracy(w, 0, X, [0, 1, 0]), 2 / 3);
  assert.throws(() => accuracy(w, 0, [], []), /no rows/);
});

/* ── the split ──────────────────────────────────────────────────────────── */

test('stratifiedSplit is seeded, 80/20, and keeps the class balance', () => {
  const y = [...Array(60).fill(0), ...Array(60).fill(1)];
  const a = stratifiedSplit(y, { seed: 1 });
  const b = stratifiedSplit(y, { seed: 1 });
  assert.deepEqual(a, b, 'same seed, same split');

  assert.equal(a.test.length, 24);
  assert.equal(a.train.length, 96);
  const inClass = (list, v) => list.filter((i) => y[i] === v).length;
  assert.equal(inClass(a.test, 0), 12);
  assert.equal(inClass(a.test, 1), 12);

  const all = [...a.train, ...a.test].sort((p, q) => p - q);
  assert.deepEqual(all, [...Array(120).keys()], 'every seed is in exactly one half');

  assert.notDeepEqual(stratifiedSplit(y, { seed: 2 }).test, a.test, 'the seed is doing something');
  assert.throws(() => stratifiedSplit([0, 2]), /label 1 is 2/);
});

/* ── the shipped seeds ──────────────────────────────────────────────────── */

test('the seed files are corpus ids, both classes, each with a why', () => {
  const corpusIds = new Set(corpusJson.ids);
  const expTheory = seedsOf('exp-theory.json');
  const ml4q = seedsOf('ml4q.json');

  const count = (seeds, label) => seeds.filter((s) => s.label === label).length;
  assert.equal(expTheory.length, 120);
  assert.equal(count(expTheory, 'experiment'), 60);
  assert.equal(count(expTheory, 'theory'), 60);
  assert.equal(ml4q.length, 120);
  assert.equal(count(ml4q, 'ml4q'), 40);
  assert.equal(count(ml4q, 'other'), 80);

  for (const seeds of [expTheory, ml4q]) {
    const seen = new Set();
    for (const seed of seeds) {
      assert.ok(corpusIds.has(seed.id), `${seed.id} is not a corpus id`);
      assert.equal(seen.has(seed.id), false, `${seed.id} is listed twice`);
      seen.add(seed.id);
      assert.equal(typeof seed.why, 'string');
      assert.ok(seed.why.length > 10, `${seed.id} has no why`);
    }
  }
});

test('pickSeeds drops a title that could be either side', () => {
  /* "demonstration" (experiment) and "no-go"(/"theorem") (theory) in one
     title: guessing a side would put a label into the fit that the title does
     not support, so the paper is dropped instead. */
  const corpus = {
    ids: ['amb', 'exp', 'theo'],
    titles: [
      'A demonstration that no-go theorems cannot be circumvented',
      'Experimental demonstration of a trapped-ion quantum processor',
      'A theorem on the entanglement entropy of black holes',
    ],
  };
  const seeds = pickSeeds('exp_theory', corpus);
  const byId = new Map(seeds.map((s) => [s.id, s]));
  assert.equal(byId.has('amb'), false, 'the ambiguous title is not a seed');
  assert.equal(byId.get('exp').label, 'experiment');
  assert.equal(byId.get('theo').label, 'theory');
});

/* ── the shipped axes.json ──────────────────────────────────────────────── */

test('axes.json matches the contract', () => {
  assert.deepEqual(Object.keys(axesJson), ['version', 'dim', 'exp_theory', 'ml4q']);
  assert.equal(axesJson.version, 1);
  assert.equal(axesJson.dim, DIM);

  for (const name of ['exp_theory', 'ml4q']) {
    const axis = axesJson[name];
    assert.deepEqual(Object.keys(axis), ['w', 'b', 'heldout_acc', 'n_train', 'n_test', 'ship']);
    assert.equal(axis.w.length, DIM, `${name}.w is not ${DIM} floats`);
    assert.ok(axis.w.every((v) => Number.isFinite(v)), `${name}.w holds a non-finite value`);
    assert.ok(axis.w.some((v) => v !== 0), `${name}.w is all zeros`);
    assert.deepEqual(axis.w.map(round5), axis.w, `${name}.w is not at 5 decimals`);
    assert.equal(axis.b, round5(axis.b), `${name}.b is not at 5 decimals`);
    assert.ok(axis.n_train > 0 && axis.n_test > 0);
    assert.ok(axis.heldout_acc >= 0 && axis.heldout_acc <= 1);
    assert.equal(axis.ship, axis.heldout_acc >= SHIP_ACC, `${name}.ship disagrees with 0.80`);
  }
});

test('heldout_acc recomputes from the written w, b on the test split', () => {
  const corpus = loadCorpus(corpusJson, readFileSync(path.join(CORPUS_DIR, 'corpus.vec.bin')));
  const rowOf = new Map(corpus.ids.map((id, i) => [id, i]));

  const cases = [['exp_theory', 'exp-theory.json', 'theory'], ['ml4q', 'ml4q.json', 'ml4q']];
  for (const [name, file, positive] of cases) {
    const seeds = seedsOf(file);
    const y = seeds.map((s) => (s.label === positive ? 1 : 0));
    const { test } = stratifiedSplit(y, { seed: SPLIT_SEED, testFrac: TEST_FRAC });

    const X = test.map((k) => {
      const i = rowOf.get(seeds[k].id);
      return corpus.vecs.subarray(i * DIM, (i + 1) * DIM);
    });

    const axis = axesJson[name];
    assert.equal(test.length, axis.n_test, `${name}: test half is not what axes.json says`);
    assert.equal(accuracy(axis.w, axis.b, X, test.map((k) => y[k])), axis.heldout_acc);
  }
});

