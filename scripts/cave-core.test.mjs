/**
 * `node --test scripts/cave-core.test.mjs`.
 *
 * Cave v3's core: the topic tree's weights, the secondary-at-half paper weight,
 * and the three-slider score. Every expectation below is hand-computed from
 * "sieve-core additions" in cave-v3-interfaces.md (and the topic rules in
 * cave-v3-spec.md), never from this file's own output.
 *
 * Three fixtures keep the arithmetic readable by eye:
 *
 *   * 3-dim orthonormal centroids, so every cosine is exactly 1, 0 or -1;
 *   * two parents and three leaves — enough for parent-together, leaf override
 *     and off, and small enough to write the whole weight array out;
 *   * axis weights of ln 3, so the sigmoid is exactly 3/4 or 1/2 and the
 *     Experiment↔Theory nudge lands on 0.125, not on a number nobody can check.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assignTopics, caveScore, defaultSetting, loadAxes, loadTopics, paperTopicWeight, topicWeights,
} from '../docs/assets/sieve-core.mjs';

/* 1.4826 x MAD, the constant that makes a MAD a sigma (see sieve-core). */
const M = 1.4826;

/* The tree: Computing's two leaves and Matter's one, on the three axes. */
const TOPICS_JSON = {
  version: 1,
  dim: 3,
  parents: [
    { id: 'computing', label: 'Computing', default: 'prefer' },
    { id: 'matter', label: 'Matter', default: 'equal' },
  ],
  leaves: [
    { id: 'opt-qalgo', parent: 'computing', label: 'Optimisation & quantum algorithms', centroid: [1, 0, 0] },
    { id: 'qml', parent: 'computing', label: 'Quantum machine learning', centroid: [0, 1, 0] },
    { id: 'many-body', parent: 'matter', label: 'Many-body physics', centroid: [0, 0, 1] },
  ],
  tags: [{ id: 'ml4q', label: 'ML for quantum' }],
};
const TOPICS = loadTopics(TOPICS_JSON);

/* sigmoid(w . x) is 3/4 on the e1 axis and 1/2 on e2, exactly. */
const AXES_JSON = {
  version: 1,
  dim: 3,
  exp_theory: { w: [Math.log(3), 0, 0], b: 0, heldout_acc: 0.9, n_train: 1, n_test: 1, ship: true },
  ml4q: { w: [0, Math.log(3), 0], b: 0, heldout_acc: 0.9, n_train: 1, n_test: 1, ship: true },
};

/* Equal weights on both parents: the fixture the corpus arithmetic below uses,
   so every paper weighs 1 unless a test says otherwise. */
const ALL_EQUAL = { computing: 'equal', matter: 'equal' };

/* A corpus object as loadCorpus builds it, for fixtures that only score. */
function corpus({ vecs, pct, ids, titles }) {
  const flat = vecs instanceof Float32Array ? vecs : Float32Array.from(vecs.flat());
  const dim = vecs[0].length;
  const n = flat.length / dim;
  return {
    n,
    dim,
    mean: new Float32Array(dim),
    vecs: flat,
    ids: ids ?? Array.from({ length: n }, (_, i) => `p${i}`),
    titles: titles ?? Array.from({ length: n }, (_, i) => `t${i}`),
    pct: Float32Array.from(pct),
    cluster: new Int32Array(n),
    clusters: [{ id: 0, label: 'all', size: n, centroid: Float32Array.from(vecs[0]) }],
  };
}

/** The unit vector at cosine `c` to e1, with the rest of its length on e2. */
const unit = (c) => Float32Array.from([c, Math.sqrt(1 - c * c), 0]);

function close(got, want, eps = 1e-6) {
  assert.ok(Math.abs(got - want) < eps, `${got} is not within ${eps} of ${want}`);
}

const idsOf = (ranked) => ranked.map((r) => r.id);
const sortedIds = (ranked) => idsOf(ranked).sort();

/* ── loadTopics / loadAxes ──────────────────────────────────────────────── */

test('loadTopics indexes the leaves, their parents and their centroids', () => {
  assert.equal(TOPICS.leaves.length, 3);
  // opt-qalgo and qml are Computing (parent 0), many-body is Matter (parent 1).
  assert.deepEqual(Array.from(TOPICS.parentOf), [0, 0, 1]);
  assert.equal(TOPICS.leafIndex.get('qml'), 1);
  assert.equal(TOPICS.leafIndex.get('many-body'), 2);
  assert.deepEqual(Array.from(TOPICS.leaves[0].centroid), [1, 0, 0]);
  // The parents keep their own default: that is where defaultSetting reads it.
  assert.equal(TOPICS.parents[0].default, 'prefer');
  assert.equal(TOPICS.parents[1].default, 'equal');
});

test('loadTopics rejects a broken tree instead of mis-weighting it', () => {
  assert.throws(() => loadTopics({ parents: [{ id: 'p' }], leaves: [] }), /no leaves/);
  assert.throws(() => loadTopics({ parents: [], leaves: [] }), /no parents/);
  assert.throws(
    () => loadTopics({ parents: [{ id: 'p' }], leaves: [{ id: 'a', parent: 'nope', centroid: [1] }] }),
    /unknown parent/,
  );
  assert.throws(
    () => loadTopics({
      parents: [{ id: 'p' }],
      leaves: [{ id: 'a', parent: 'p', centroid: [1] }, { id: 'a', parent: 'p', centroid: [1] }],
    }),
    /duplicate/,
  );
  assert.throws(
    () => loadTopics({
      parents: [{ id: 'p' }],
      leaves: [{ id: 'a', parent: 'p', centroid: [1, 0] }, { id: 'b', parent: 'p', centroid: [1] }],
    }),
    /expected 2/,
  );
});

test('loadAxes renames exp_theory, and a missing axis is ship:false', () => {
  const axes = loadAxes(AXES_JSON);
  assert.ok(axes.expTheory.w instanceof Float32Array);
  // Float32Array holds ln 3 to float precision; the sigmoid below is unaffected.
  close(axes.expTheory.w[0], Math.log(3));
  assert.equal(axes.expTheory.w[1], 0);
  assert.equal(axes.expTheory.w[2], 0);
  assert.equal(axes.expTheory.b, 0);
  assert.equal(axes.expTheory.ship, true);
  close(axes.ml4q.w[1], Math.log(3));
  assert.equal(axes.ml4q.w[0], 0);
  assert.equal(axes.ml4q.ship, true);

  // Nothing fitted: no axis, no slider. Not a zero direction that scores 0.5.
  const bare = loadAxes({ version: 1, dim: 3 });
  assert.equal(bare.expTheory.ship, false);
  assert.equal(bare.expTheory.w.length, 0);
  assert.equal(bare.ml4q.ship, false);
  assert.equal(loadAxes({ exp_theory: { w: [1], b: 0, ship: false } }).expTheory.ship, false);
});

/* ── topicWeights / defaultSetting ──────────────────────────────────────── */

test('topicWeights: equal 1, prefer 1.5, avoid 0.5, off 0 — leaf overrides parent', () => {
  const w = (setting) => Array.from(topicWeights(TOPICS, setting));

  assert.deepEqual(w({ computing: 'equal', matter: 'equal' }), [1, 1, 1]);
  assert.deepEqual(w({ computing: 'prefer', matter: 'equal' }), [1.5, 1.5, 1]);
  assert.deepEqual(w({ computing: 'avoid', matter: 'equal' }), [0.5, 0.5, 1]);
  assert.deepEqual(w({ computing: 'off', matter: 'equal' }), [0, 0, 1]);

  // One leaf out of step with its parent — off under a prefer parent, prefer
  // under an off parent: the parent's "set all children" is not final.
  assert.deepEqual(w({ computing: 'prefer', matter: 'equal', leaves: { qml: 'off' } }), [1.5, 0, 1]);
  assert.deepEqual(w({ computing: 'off', matter: 'equal', leaves: { qml: 'prefer' } }), [0, 1.5, 1]);
  assert.deepEqual(w({ computing: 'prefer', matter: 'equal', leaves: { 'many-body': 'avoid' } }), [1.5, 1.5, 0.5]);

  // An unmentioned parent and an unknown setting string both mean equal: a
  // typo in a stored setting must not delete a topic.
  assert.deepEqual(w({}), [1, 1, 1]);
  assert.deepEqual(w({ computing: 'nonsense' }), [1, 1, 1]);
});

test('defaultSetting prefers only Computing, and overrides no leaf', () => {
  assert.deepEqual(defaultSetting(TOPICS), { computing: 'prefer', matter: 'equal', leaves: {} });
  assert.deepEqual(Array.from(topicWeights(TOPICS, defaultSetting(TOPICS))), [1.5, 1.5, 1]);
});

/* ── paperTopicWeight: primary + secondary at half ──────────────────────── */

test('paperTopicWeight counts the secondary at half, over the weights it covered', () => {
  const prefer = topicWeights(TOPICS, { computing: 'prefer', matter: 'equal' });   // [1.5, 1.5, 1]
  const avoid = topicWeights(TOPICS, { computing: 'avoid', matter: 'equal' });     // [0.5, 0.5, 1]
  const off = topicWeights(TOPICS, { computing: 'off', matter: 'equal' });         // [0, 0, 1]
  const paper = (topic, topic2 = -1) => ({ topic: [topic], topic2: [topic2] });

  // Primary alone: its weight, denominator 1.
  assert.equal(paperTopicWeight(paper(0), 0, prefer), 1.5);
  assert.equal(paperTopicWeight(paper(2), 0, prefer), 1);

  // Primary 1.5, secondary 1: (1.5 + 0.5 * 1) / 1.5 = 4/3.
  close(paperTopicWeight(paper(0, 2), 0, prefer), 4 / 3);
  // Primary 1, secondary 1.5: (1 + 0.75) / 1.5 = 7/6 — the half vote can lift a
  // paper without replacing its primary.
  close(paperTopicWeight(paper(2, 0), 0, prefer), 7 / 6);
  // Avoid on both sides: (0.5 + 0.5 * 1) / 1.5 = 2/3.
  close(paperTopicWeight(paper(0, 2), 0, avoid), 2 / 3);
  // Off primary, on secondary: the formula still reads (0 + 1/2) / 1.5 = 1/3.
  close(paperTopicWeight(paper(0, 2), 0, off), 1 / 3);

  // No topic at all is no vote; the row index picks the paper, not its id.
  assert.equal(paperTopicWeight({ topic: [-1], topic2: [-1] }, 0, prefer), 0);
  assert.equal(paperTopicWeight({ topic: [2, 0], topic2: [-1, -1] }, 1, prefer), 1.5);
});

/* ── assignTopics ──────────────────────────────────────────────────────── */

test('assignTopics takes the runner-up as secondary only within 0.03 cosine', () => {
  assert.deepEqual(assignTopics(Float32Array.from([1, 0, 0]), TOPICS), { topic: 0, topic2: -1 });
  assert.deepEqual(assignTopics(Float32Array.from([0, 0, 1]), TOPICS), { topic: 2, topic2: -1 });

  // cos(e1) - cos(e2) = (1 - 0.98) / sqrt(1 + 0.98^2) = 0.0143, inside the
  // window: opt-qalgo wins, qml is close enough to be half a vote.
  const len = Math.sqrt(1 + 0.98 * 0.98);
  assert.ok((1 - 0.98) / len < 0.03);
  assert.deepEqual(assignTopics(Float32Array.from([1 / len, 0.98 / len, 0]), TOPICS), { topic: 0, topic2: 1 });

  // 0.6 / 0.8: 0.2 apart is a different field, not a runner-up.
  assert.deepEqual(assignTopics(Float32Array.from([0.6, 0.8, 0]), TOPICS), { topic: 1, topic2: -1 });

  assert.throws(() => assignTopics(Float32Array.from([1, 0]), TOPICS), /2 dims/);
});

/* ── caveScore: topic match ────────────────────────────────────────────── */

/* Six corpus papers just off e1: cosine to e1 of [0.72 .. 0.80]. With every
   paper at weight 1 the weighted median of r is the middle row, 0.76, and the
   deviations [0.04, 0.02, 0, 0, 0.02, 0.04] walk to 0.02 — so s = 0.02 * M and
   a candidate at cosine c has fitZ = (c - 0.76) / (0.02 * M). */
const GATE = corpus({
  vecs: [0.72, 0.74, 0.76, 0.76, 0.78, 0.80].map((c) => [c, Math.sqrt(1 - c * c), 0]),
  pct: [0.9, 0.8, 0.7, 0.6, 0.5, 0.4],
});

test('topic match 0 gates nothing, 50 gates, and 100 gates more than 50', () => {
  const run = (match) => caveScore({
    corpus: GATE,
    topics: TOPICS,
    setting: ALL_EQUAL,
    sliders: { match, surprise: 50 },
    touchstones: [[1, 0, 0]],
    candidates: [0.78, 0.80, 0.86, 0.95].map((c) => ({ id: `c${c}`, vec: unit(c) })),
  });

  // gate = 2 * match / 100 -> 0, 1.0, 2.0. fitZ of the four candidates:
  // 0.67, 1.35, 3.37, 6.41 — one on each side of both gates, so neither
  // boundary is decided by a float32 rounding.
  const none = run(0);
  const half = run(50);
  const full = run(100);

  // Match 0 is gate 0: nothing above the corpus median is dropped. The corpus
  // rows are float32, so the cosines (and the fit they produce) are float32-exact
  // at best — 1e-4 is the precision of the fixture, not of the arithmetic.
  assert.equal(none.length, 4);
  const byId = Object.fromEntries(none.map((r) => [r.id, r]));
  for (const c of [0.78, 0.80, 0.86, 0.95]) close(byId[`c${c}`].fit, (c - 0.76) / (0.02 * M), 1e-4);

  assert.deepEqual(sortedIds(half), ['c0.8', 'c0.86', 'c0.95']);
  assert.deepEqual(sortedIds(full), ['c0.86', 'c0.95']);
  assert.ok(full.every((r) => half.some((h) => h.id === r.id)));
});

/* ── caveScore: off topics are excluded ────────────────────────────────── */

test('an off topic is excluded outright — not a candidate, not a neighbour', () => {
  const c = corpus({
    vecs: [[1, 0, 0], [0, 0, 1], [0.8, 0.6, 0]],
    pct: [1, 1, 0.5],
    ids: ['near', 'off', 'tilt'],
  });
  const ranked = caveScore({
    corpus: c,
    topics: TOPICS,
    setting: { computing: 'equal', matter: 'off' },
    sliders: { match: 0, surprise: 50 },
    touchstones: [[1, 0, 0]],
    candidates: [
      { id: 'mine', vec: Float32Array.from([1, 0, 0]) },
      { id: 'theirs', vec: Float32Array.from([0, 0, 1]) },
    ],
  });

  // `theirs` is a many-body paper and Matter is off; the corpus' `off` row is
  // not evidence for anything, so it is not a landmark either (nearest is
  // `near` at cosine 1, then `tilt` at 0.8).
  assert.deepEqual(idsOf(ranked), ['mine']);
  assert.deepEqual(ranked[0].landmarks.map((l) => l.id), ['near', 'tilt']);
});

/* ── caveScore: surprise ───────────────────────────────────────────────── */

/* Two corpus papers on two axes: `A` looks exactly like the proven one
   (pct 1), `B` like the unproven one (pct 0.2). Both candidates sit at or above
   the corpus median, so match 0 keeps them and only Surprise decides the order. */
const PAIR = corpus({ vecs: [[1, 0, 0], [0, 1, 0]], pct: [1, 0.2] });
const PAIR_CANDS = [
  { id: 'A', vec: Float32Array.from([1, 0, 0]) },
  { id: 'B', vec: Float32Array.from([0, 1, 0]) },
];

test('surprise 0 orders by impact, 100 by novelty', () => {
  const run = (surprise) => caveScore({
    corpus: PAIR,
    topics: TOPICS,
    setting: ALL_EQUAL,
    sliders: { match: 0, surprise },
    touchstones: [[1, 0, 0]],
    candidates: PAIR_CANDS,
  });

  // Two gated candidates: P is 0.75 for the higher of a pair, 0.25 for the
  // lower. A is impact 1 / novelty 0, B is the mirror image.
  const proven = run(0);
  assert.deepEqual(idsOf(proven), ['A', 'B']);
  close(proven[0].impact, 1);
  close(proven[0].novelty, 0);
  close(proven[0].score, 0.75);
  close(proven[1].score, 0.25);

  const novel = run(100);
  assert.deepEqual(idsOf(novel), ['B', 'A']);
  close(novel[0].novelty, 1);
  close(novel[0].score, 0.75);
  close(novel[1].score, 0.25);
});

/* ── caveScore: Experiment ↔ Theory ────────────────────────────────────── */

test('the Experiment to Theory slider nudges the score, and ship:false ignores it', () => {
  const axes = loadAxes(AXES_JSON);
  const run = (sliders, a = axes) => caveScore({
    corpus: PAIR,
    topics: TOPICS,
    axes: a,
    setting: ALL_EQUAL,
    sliders: { match: 0, surprise: 50, ...sliders },
    touchstones: [[1, 0, 0]],
    candidates: [
      { id: 'theo', vec: Float32Array.from([1, 0, 0]) },
      { id: 'expt', vec: Float32Array.from([0, 1, 0]) },
    ],
  });

  /* w = [ln 3, 0, 0]: theo is sigmoid(ln 3) = 3/4 theory, expt is 1/2. The two
     base scores are equal (0.5 * 0.75 + 0.5 * 0.25 each), so the only thing
     that can order them is the slider — and at 0, the id tie-break does. */
  const zero = run({ expTheory: 0 });
  assert.deepEqual(idsOf(zero), ['expt', 'theo']);
  close(zero[0].score, 0.5);
  close(zero[1].score, 0.5);
  close(zero.find((r) => r.id === 'theo').theory, 0.75);
  assert.equal(zero.find((r) => r.id === 'theo').ml4q, 0.5);
  close(zero.find((r) => r.id === 'expt').theory, 0.5);
  close(zero.find((r) => r.id === 'expt').ml4q, 0.75);

  // +100, the theory side: (0.75 - 0.5) * 2 * 0.25 = +0.125 for theo, and
  // expt sits at the middle so it does not move.
  const up = run({ expTheory: 100 });
  assert.deepEqual(idsOf(up), ['theo', 'expt']);
  close(up[0].score, 0.625);
  close(up[1].score, 0.5);

  // -100 is the mirror image.
  const down = run({ expTheory: -100 });
  assert.deepEqual(idsOf(down), ['expt', 'theo']);
  close(down[0].score, 0.5);
  close(down[1].score, 0.375);

  // ship:false — never fitted, so the slider is ignored outright and the run is
  // byte-for-byte the 0 run.
  const unsold = loadAxes({ ...AXES_JSON, exp_theory: { ...AXES_JSON.exp_theory, ship: false } });
  assert.equal(unsold.expTheory.ship, false);
  assert.deepEqual(run({ expTheory: 100 }, unsold), run({ expTheory: 0 }, unsold));

  // No axes at all: theory is the neutral 0.5 and nothing is nudged.
  const none = run({ expTheory: 100 }, null);
  assert.deepEqual(none.map((r) => r.theory), [0.5, 0.5]);
  close(none[0].score, 0.5);
});

/* ── caveScore: topics for tonight's papers, and the result shape ───────── */

test('a candidate with no stored topic gets one; a stored topic is kept', () => {
  const ranked = caveScore({
    corpus: PAIR,
    topics: TOPICS,
    setting: defaultSetting(TOPICS),
    sliders: { match: 0, surprise: 50 },
    touchstones: [[1, 0, 0]],
    candidates: [
      { id: 'new', vec: Float32Array.from([0, 0, 1]) },
      { id: 'stored', vec: Float32Array.from([0, 0, 1]), topic: 0 },
    ],
  });
  const byId = Object.fromEntries(ranked.map((r) => [r.id, r]));

  assert.equal(byId.new.topic, 2);        // nearest centroid is many-body
  assert.equal(byId.new.topic2, -1);
  assert.equal(byId.stored.topic, 0);     // a stored topic wins over the centroid
  assert.equal(byId.stored.topic2, -1);

  for (const key of ['id', 'vec', 'topic', 'topic2', 'fit', 'impact', 'novelty', 'theory', 'ml4q', 'score', 'landmarks']) {
    assert.ok(key in byId.new, `result is missing ${key}`);
  }
  // The internal cluster remap does not leak out as a number that means nothing.
  assert.ok(!('cluster' in byId.new));
});

test('two runs over the same night agree, and nothing is written back', () => {
  const cands = [{ id: 'a', vec: unit(0.9) }, { id: 'b', vec: unit(0.88) }];
  const args = {
    corpus: GATE,
    topics: TOPICS,
    setting: ALL_EQUAL,
    sliders: { match: 0, surprise: 40 },
    touchstones: [[1, 0, 0]],
    candidates: cands,
  };
  const first = caveScore(args);
  assert.deepEqual(caveScore(args), first);
  assert.equal('topic' in cands[0], false);   // the assignment stays internal
  // pct is a Float32Array, so compare it at the precision it stores.
  assert.deepEqual(Array.from(GATE.pct, (v) => Math.round(v * 100) / 100), [0.9, 0.8, 0.7, 0.6, 0.5, 0.4]);

  assert.throws(
    () => caveScore({ corpus: GATE, topics: TOPICS, setting: ALL_EQUAL, candidates: [{ id: 'x', vec: [1, 0] }] }),
    /2 dims/,
  );
});


