import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  LEAVES, PARENTS, assign, centroidsFromSeeds, leaveOneOut,
} from './cave-topics.mjs';
import { loadCorpus } from '../docs/assets/sieve-core.mjs';

const CORPUS = new URL('../docs/assets/corpus/', import.meta.url);
const SEEDS = new URL('./cave-seeds/topics.json', import.meta.url);

const corpusJson = JSON.parse(readFileSync(new URL('corpus.json', CORPUS), 'utf8'));
const topicsJson = JSON.parse(readFileSync(new URL('topics.json', CORPUS), 'utf8'));
const seeds = JSON.parse(readFileSync(SEEDS, 'utf8'));
const seedsByLeaf = seeds.leaves;
const corpus = loadCorpus(corpusJson, readFileSync(new URL('corpus.vec.bin', CORPUS)));

/* ── the 3-D oracle ─────────────────────────────────────────────────────── */

/* Three unit centroids on the axes, so every cosine below is a component of
   the vector being assigned and the 0.03 rule can be checked by hand. */
const AXES = [
  Float32Array.from([1, 0, 0]),
  Float32Array.from([0, 1, 0]),
  Float32Array.from([0, 0, 1]),
];

const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

test('a hand-built 3-D fixture: nearest centroid, and the 0.03 runner-up', () => {
  // Straight down an axis: a mile clear of the others, so no secondary.
  assert.deepEqual(assign(Float32Array.from([1, 0, 0]), AXES), { topic: 0, topic2: -1 });
  assert.deepEqual(assign(Float32Array.from([0, 0, 1]), AXES), { topic: 2, topic2: -1 });

  // On the x=y diagonal both cosines are 1/√2 = 0.7071: a tie, which goes to
  // the lower index, and the runner-up is 0 apart — well inside 0.03.
  const diagonal = Float32Array.from([1, 1, 0]);
  assert.deepEqual(assign(diagonal, AXES), { topic: 0, topic2: 1 });

  // (1, 0.97, 0): cos to x = 0.71779, to y = 0.69626, gap 0.02153 < 0.03.
  const close = Float32Array.from([1, 0.97, 0]);
  assert.ok(near(1 / Math.hypot(1, 0.97), 0.717792, 1e-5));
  assert.ok(near(0.97 / Math.hypot(1, 0.97), 0.696259, 1e-5));
  assert.deepEqual(assign(close, AXES), { topic: 0, topic2: 1 });

  // (1, 0.9, 0): cos 0.74330 vs 0.66897, gap 0.07433 > 0.03 — no secondary.
  assert.deepEqual(assign(Float32Array.from([1, 0.9, 0]), AXES), { topic: 0, topic2: -1 });

  // The boundary itself. cos 0.97 is exactly 0.03 below 1, so a centroid at
  // angle acos(0.97) from x is "within 0.03" and gets the secondary...
  const atBoundary = [Float32Array.from([1, 0, 0]), Float32Array.from([0.97, Math.sqrt(1 - 0.97 ** 2), 0])];
  assert.deepEqual(assign(Float32Array.from([1, 0, 0]), atBoundary), { topic: 0, topic2: 1 });
  // ...and a hair further out is not.
  const justOut = [Float32Array.from([1, 0, 0]), Float32Array.from([0.9699, Math.sqrt(1 - 0.9699 ** 2), 0])];
  assert.deepEqual(assign(Float32Array.from([1, 0, 0]), justOut), { topic: 0, topic2: -1 });

  // A single centroid has no runner-up at all.
  assert.deepEqual(assign(Float32Array.from([0, 1, 0]), [AXES[1]]), { topic: 0, topic2: -1 });
});

test('a centroid is the mean of its seeds, re-normalised', () => {
  // Rows the fixture passes in are unit already, as loadCorpus hands them over.
  const vecs = {
    n: 3,
    dim: 3,
    ids: ['a', 'b', 'c'],
    vecs: Float32Array.from([1, 0, 0, 1 / Math.SQRT2, 1 / Math.SQRT2, 0, 0, 0, 1]),
  };
  const { leafIds, dim, centroids } = centroidsFromSeeds(vecs, { first: ['a', 'b'], second: [{ id: 'c' }] });
  assert.deepEqual(leafIds, ['first', 'second']);
  assert.equal(dim, 3);
  // (1,0,0) + (0.7071,0.7071,0) = (1.7071,0.7071,0), |·| = 1.8478 → (0.9239,0.3827,0).
  assert.ok(near(centroids[0][0], (1 + Math.SQRT1_2) / Math.hypot(1 + Math.SQRT1_2, Math.SQRT1_2), 1e-6));
  assert.ok(near(centroids[0][1], Math.SQRT1_2 / Math.hypot(1 + Math.SQRT1_2, Math.SQRT1_2), 1e-6));
  assert.ok(near(centroids[0][2], 0, 1e-6));
  assert.deepEqual(Array.from(centroids[1]), [0, 0, 1]);
});

test('bad seeds are errors, not a quietly wrong centroid', () => {
  const vecs = { n: 2, dim: 3, ids: ['a', 'b'], vecs: Float32Array.from([1, 0, 0, 0, 1, 0]) };
  assert.throws(() => centroidsFromSeeds(vecs, { only: ['nope'] }), /not in the corpus/);
  assert.throws(() => centroidsFromSeeds(vecs, { one: ['a'], two: ['a', 'b'] }), /both one and two/);
  assert.throws(() => centroidsFromSeeds(vecs, { one: [] }), /has no seeds/);
  assert.throws(() => leaveOneOut(vecs, { one: ['a'], two: ['b'] }), /needs two seeds/);
});

test('leave-one-out recall on the fixture is exact for well-separated leaves', () => {
  // Each leaf owns an axis; the held-out seed can only land back in its own.
  const vecs = {
    n: 6,
    dim: 3,
    ids: ['a1', 'a2', 'b1', 'b2', 'c1', 'c2'],
    vecs: Float32Array.from([
      1, 0, 0, 0.99, 0.05, 0,
      0, 1, 0, 0.05, 0.99, 0,
      0, 0, 1, 0, 0.05, 0.99,
    ]),
  };
  assert.equal(leaveOneOut(vecs, { x: ['a1', 'a2'], y: ['b1', 'b2'], z: ['c1', 'c2'] }), 1);
});

/* ── the shipped tree ───────────────────────────────────────────────────── */

/* cave-v3-interfaces.md says "Leaf ids (fixed, 14)" and then lists twelve:
   four under Computing and two under each of the other four parents. The
   twelve enumerated ids are the only definition in the repo, so they are what
   ships; a thirteenth would have no id any other card could refer to. */
const CONTRACT_LEAVES = [
  ['opt-qalgo', 'computing'], ['qml', 'computing'],
  ['qec', 'computing'], ['ft-roadmaps', 'computing'],
  ['tomo-metro', 'measurement'], ['sensing', 'measurement'],
  ['many-body', 'matter'], ['materials', 'matter'],
  ['cold-atoms', 'light-atoms'], ['cavity-qed', 'light-atoms'],
  ['foundations', 'foundations'], ['gravity', 'foundations'],
];

const PARENT_ROWS = [
  ['computing', 'Computing', 'prefer'],
  ['measurement', 'Measurement', 'equal'],
  ['matter', 'Matter', 'equal'],
  ['light-atoms', 'Light & atoms', 'equal'],
  ['foundations', 'Foundations & gravity', 'equal'],
];

test('topics.json: five parents, the contract preferred one, the enumerated leaves', () => {
  assert.equal(topicsJson.version, 1);
  assert.equal(topicsJson.dim, corpus.dim);

  assert.equal(topicsJson.parents.length, 5);
  assert.deepEqual(
    topicsJson.parents.map((p) => [p.id, p.label, p.default]),
    PARENT_ROWS,
  );
  // "Only Computing is preferred by default."
  assert.deepEqual(topicsJson.parents.filter((p) => p.default === 'prefer').map((p) => p.id), ['computing']);
  assert.deepEqual(topicsJson.parents.filter((p) => !['prefer', 'equal'].includes(p.default)), []);

  assert.deepEqual(
    topicsJson.leaves.map((l) => [l.id, l.parent]),
    CONTRACT_LEAVES,
  );
  assert.deepEqual(LEAVES.map((l) => [l.id, l.parent]), CONTRACT_LEAVES);
  assert.deepEqual(PARENTS.map((p) => [p.id, p.label, p.default]), PARENT_ROWS);
  const labels = topicsJson.leaves.map((l) => l.label);
  assert.ok(labels.every((l) => typeof l === 'string' && l.trim().length > 2), 'every leaf is labelled');

  assert.deepEqual(topicsJson.tags, [{ id: 'ml4q', label: 'ML for quantum' }]);
});

test('topics.json centroids are 768 4-decimal floats, unit, and the seeds mean', () => {
  const ordered = {};
  for (const [id] of CONTRACT_LEAVES) ordered[id] = seedsByLeaf[id].map((s) => s.id);
  const { centroids } = centroidsFromSeeds(corpus, ordered);

  topicsJson.leaves.forEach((leaf, i) => {
    assert.equal(leaf.centroid.length, corpus.dim, `${leaf.id} centroid dim`);
    let norm = 0;
    for (const x of leaf.centroid) {
      assert.ok(Number.isFinite(x), `${leaf.id} centroid is numeric`);
      assert.ok(Math.abs(x * 1e4 - Math.round(x * 1e4)) < 1e-9, `${leaf.id} centroid is 4-decimal (${x})`);
      norm += x * x;
    }
    assert.ok(Math.abs(Math.sqrt(norm) - 1) < 2e-3, `${leaf.id} centroid is unit (|c|=${Math.sqrt(norm)})`);

    // The shipped numbers must be this run's arithmetic: same seeds, same mean.
    const want = centroids.find((_, j) => LEAVES[j].id === leaf.id);
    let worst = 0;
    for (let k = 0; k < corpus.dim; k++) worst = Math.max(worst, Math.abs(leaf.centroid[k] - want[k]));
    assert.ok(worst <= 5e-5, `${leaf.id} centroid is the seed mean (worst ${worst})`);
  });
});

test('the seeds file: every leaf, ~25 corpus papers, no paper in two leaves', () => {
  assert.deepEqual(Object.keys(seedsByLeaf).sort(), CONTRACT_LEAVES.map(([id]) => id).sort());
  const ids = new Set(corpus.ids);
  const seen = new Map();
  let total = 0;
  for (const [leaf] of CONTRACT_LEAVES) {
    const list = seedsByLeaf[leaf];
    assert.ok(list.length >= 20 && list.length <= 30, `${leaf} has ${list.length} seeds, expected about 25`);
    for (const seed of list) {
      assert.equal(typeof seed.id, 'string');
      assert.ok(ids.has(seed.id), `seed ${seed.id} of ${leaf} is in the corpus`);
      assert.equal(typeof seed.why, 'string');
      assert.ok(seed.why.trim().length > 5, `seed ${seed.id} of ${leaf} has a why`);
      assert.equal(seen.get(seed.id), undefined, `${seed.id} is in both ${seen.get(seed.id)} and ${leaf}`);
      seen.set(seed.id, leaf);
      total++;
    }
  }
  assert.ok(total >= 250, `the seeds are hand-labelled per leaf, got ${total}`);
});

test('every corpus paper has a primary topic in 0..13 and a secondary or -1', () => {
  const { topic, topic2 } = corpusJson;
  assert.equal(topic.length, corpus.n);
  assert.equal(topic2.length, corpus.n);
  const leaves = topicsJson.leaves.length;
  for (let i = 0; i < corpus.n; i++) {
    assert.ok(Number.isInteger(topic[i]), `topic[${i}] is an integer`);
    assert.ok(topic[i] >= 0 && topic[i] <= 13, `topic[${i}] = ${topic[i]}`);
    assert.ok(topic[i] < leaves, `topic[${i}] = ${topic[i]} indexes topics.json`);
    assert.ok(Number.isInteger(topic2[i]) && (topic2[i] === -1 || (topic2[i] >= 0 && topic2[i] < leaves)),
      `topic2[${i}] = ${topic2[i]}`);
    assert.notEqual(topic2[i], topic[i], `topic2[${i}] is the runner-up, not the winner`);
  }
  // "Always present" is the point: not one paper left without a home.
  assert.equal(topic.filter((t) => t === undefined || t === null).length, 0);
});

test('the shipped topic arrays are this module\'s assignment of the shipped centroids', () => {
  const centroids = topicsJson.leaves.map((l) => Float32Array.from(l.centroid));
  let off = 0;
  const counts = new Array(centroids.length).fill(0);
  for (let i = 0; i < corpus.n; i++, off += corpus.dim) {
    const a = assign(corpus.vecs.subarray(off, off + corpus.dim), centroids);
    assert.equal(a.topic, corpusJson.topic[i], `paper ${corpus.ids[i]} primary`);
    assert.equal(a.topic2, corpusJson.topic2[i], `paper ${corpus.ids[i]} secondary`);
    counts[a.topic]++;
  }
  assert.equal(counts.reduce((x, y) => x + y, 0), corpus.n);
  console.log(`papers per leaf: ${topicsJson.leaves.map((l, i) => `${l.id}=${counts[i]}`).join(' ')}`);
});

test('leave-one-out seed recall is at least 0.90', () => {
  const ordered = {};
  for (const [id] of CONTRACT_LEAVES) ordered[id] = seedsByLeaf[id];
  const recall = leaveOneOut(corpus, ordered);
  console.log(`leave-one-out seed recall: ${recall.toFixed(4)} over `
    + `${CONTRACT_LEAVES.reduce((n, [id]) => n + seedsByLeaf[id].length, 0)} seeds`);
  assert.ok(recall >= 0.9, `recall ${recall.toFixed(4)} < 0.90`);
});
