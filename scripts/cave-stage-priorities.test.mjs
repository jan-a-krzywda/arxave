/**
 * `cd scripts && node --test cave-stage-priorities.test.mjs`.
 *
 * Stage 5 is mostly DOM and one network call, which a test cannot hold. What
 * is left is the arithmetic that fails silently: tonight's counts per topic,
 * which wagons belong under a leaf, the four weights, the applied-topic chips,
 * the prefs codec and the one-line summary. Each is checked against a
 * hand-built night — eight papers, three leaves, two parents, one with no
 * topic at all — rather than a live arXiv.
 *
 * The tree is the contract's shape in miniature: Computing defaults to
 * `prefer`, Matter to `equal`, and one leaf sits under each parent, so
 * "a parent sets its children" and "a leaf overrides" both have room.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHOICES, ML4Q_PARENT, SLIDERS, ml4qCount, sliderValue, clearSetting, chipsFromSetting, defaultPrefs, parsePrefs,
  prefsSummary, removeChip, serialisePrefs, treeCounts, wagonsForLeaf, weightOf,
} from '../docs/assets/cave-stage-priorities.mjs';
import { defaultSetting, loadTopics } from '../docs/assets/sieve-core.mjs';

const TOPICS = loadTopics({
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
});

const NIGHT = {
  stones: Array.from({ length: 8 }, (_, i) => ({ id: '2608.0000' + i })),
  /* Primary topics only: five computing (three opt-qalgo, two qml), two
     many-body, one with nothing. topic2 must not add a second vote. */
  topic: Int32Array.from([0, 0, 1, 2, -1, 1, 0, 2]),
  topic2: Int32Array.from([1, 2, 2, 0, -1, 2, 1, 0]),
  components: [
    { indices: [0, 1, 6] },
    { indices: [2, 5] },
    { indices: [3, 7] },
    { indices: [4] },
  ],
  names: [null, 'Quantum learning', null, null],
};

/* ── counts ─────────────────────────────────────────────────────────────── */

test('treeCounts counts each paper once, by its primary topic, per parent and leaf', () => {
  const counts = treeCounts(NIGHT, TOPICS);
  assert.deepEqual(counts.parents, { computing: 5, matter: 2 });
  assert.deepEqual(counts.leaves, { 'opt-qalgo': 3, qml: 2, 'many-body': 2 });
});

test('treeCounts keeps zeros, ignores topic2, and survives no night', () => {
  assert.deepEqual(treeCounts(null, TOPICS), {
    parents: { computing: 0, matter: 0 },
    leaves: { 'opt-qalgo': 0, qml: 0, 'many-body': 0 },
  });

  /* topic2 says qml and many-body; only the primary is counted. */
  const one = { stones: [{ id: 'a' }], topic: Int32Array.from([0]), topic2: Int32Array.from([2]) };
  assert.deepEqual(treeCounts(one, TOPICS).parents, { computing: 1, matter: 0 });

  assert.deepEqual(treeCounts(NIGHT, null), { parents: {}, leaves: {} });
});

/* ── leaf → wagons ──────────────────────────────────────────────────────── */

test('wagonsForLeaf picks the wagons whose most common leaf it is', () => {
  assert.deepEqual(wagonsForLeaf(NIGHT, TOPICS, 'opt-qalgo'), [
    { index: 0, name: 'Wagon 1', size: 3 },
  ]);
  /* A named wagon keeps its name; the size is the whole wagon. */
  assert.deepEqual(wagonsForLeaf(NIGHT, TOPICS, 'qml'), [
    { index: 1, name: 'Quantum learning', size: 2 },
  ]);
  assert.deepEqual(wagonsForLeaf(NIGHT, TOPICS, 'many-body'), [
    { index: 2, name: 'Wagon 3', size: 2 },
  ]);
  assert.deepEqual(wagonsForLeaf(NIGHT, TOPICS, 'ghost'), []);
  assert.deepEqual(wagonsForLeaf(null, TOPICS, 'qml'), []);
});

test('a tie for the most common leaf goes to the lower leaf index', () => {
  const tie = {
    stones: [{ id: 'a' }, { id: 'b' }],
    topic: Int32Array.from([0, 1]),
    components: [{ indices: [0, 1] }],
  };
  assert.deepEqual(wagonsForLeaf(tie, TOPICS, 'opt-qalgo').map((w) => w.name), ['Wagon 1']);
  assert.deepEqual(wagonsForLeaf(tie, TOPICS, 'qml'), []);
});

/* ── ML for quantum, a row of Computing ──────────────────────────────────── */

test('ml4qCount: tonight\'s papers the axis reads at 0.5 or above', () => {
  assert.equal(ML4Q_PARENT, 'computing');
  const axis = { w: [1, 0], b: 0 };
  const night = { vecs: [[2, 0], [-2, 0], [0, 1], [0.5, 0]] };   // 0.88, 0.12, 0.5, 0.62
  assert.equal(ml4qCount(night, axis), 3);
  assert.equal(ml4qCount(null, axis), 0, 'no night is 0');
  assert.equal(ml4qCount(night, null), 0, 'no axis is 0');
  assert.equal(ml4qCount({ vecs: [[1, 1, 1]] }, axis), 1, 'a mis-shaped axis reads 0.5, as in scoring');
});

/* ── weights ────────────────────────────────────────────────────────────── */

test('weightOf is the contract: equal 1, prefer 1.5, avoid 0.5, off 0', () => {
  assert.deepEqual(CHOICES.map((choice) => weightOf(choice)), [1, 1.5, 0.5, 0]);
  assert.equal(weightOf('sideways'), 1);         // unknown is equal, not deleted
  assert.equal(weightOf(undefined), 1);
});

/* ── chips ──────────────────────────────────────────────────────────────── */

test('the default setting derives exactly one chip: Computing prefer', () => {
  assert.deepEqual(chipsFromSetting(TOPICS, defaultSetting(TOPICS)), [
    { scope: 'parent', id: 'computing', label: 'Computing', choice: 'prefer' },
  ]);
});

test('a parent change shows a chip; a leaf override adds one of its own', () => {
  const chips = chipsFromSetting(TOPICS, { computing: 'prefer', matter: 'avoid', leaves: { qml: 'off' } });
  assert.deepEqual(chips.map((c) => `${c.scope}:${c.id}:${c.choice}`), [
    'parent:computing:prefer',
    'parent:matter:avoid',
    'leaf:qml:off',
  ]);

  /* A leaf repeating its parent changes nothing and earns no chip. */
  const same = chipsFromSetting(TOPICS, { computing: 'prefer', matter: 'equal', leaves: { qml: 'prefer' } });
  assert.deepEqual(same.map((c) => c.id), ['computing']);
});

test('clear leaves no chips; removing a chip undoes exactly that choice', () => {
  assert.deepEqual(chipsFromSetting(TOPICS, clearSetting(TOPICS)), []);

  const setting = { computing: 'prefer', matter: 'avoid', leaves: { qml: 'off' } };
  const noLeaf = removeChip(TOPICS, setting, { scope: 'leaf', id: 'qml' });
  assert.equal('qml' in noLeaf.leaves, false);
  assert.equal(noLeaf.matter, 'avoid');
  assert.equal(setting.leaves.qml, 'off');       // the argument was not mutated

  const noParent = removeChip(TOPICS, setting, { scope: 'parent', id: 'matter' });
  assert.equal(noParent.matter, 'equal');
  assert.equal(noParent.computing, 'prefer');
});

/* ── the codec ──────────────────────────────────────────────────────────── */

test('serialise → parse round-trips a whole prefs object', () => {
  const prefs = {
    setting: { computing: 'prefer', matter: 'avoid', leaves: { qml: 'off', 'many-body': 'prefer' } },
    sliders: { match: 73, surprise: 41, expTheory: -60, solo: 35, ai: 80, senior: 25 },
    touchstones: [],
    text: '',
    ml4q: true,
  };
  assert.deepEqual(parsePrefs(TOPICS, serialisePrefs(TOPICS, prefs)), prefs);
});

test('the default prefs serialise short and parse back to themselves', () => {
  const prefs = defaultPrefs(TOPICS);
  const code = serialisePrefs(TOPICS, prefs);
  assert.match(code, /topics=&/);                 // nothing differs from the default
  assert.deepEqual(parsePrefs(TOPICS, code), prefs);
});

test('junk, missing and out-of-range values fall back instead of throwing', () => {
  const empty = parsePrefs(TOPICS, '');
  assert.deepEqual(empty.setting, defaultSetting(TOPICS));
  assert.deepEqual(empty.sliders, { match: 50, surprise: 50, expTheory: 0, solo: 0, ai: 0, senior: 50 });
  assert.equal(empty.ml4q, false);

  const junk = parsePrefs(TOPICS, 'topics=nope:sideways,qml:loud&match=900&surprise=-4&exp=nope&solo=500&ai=x');
  assert.deepEqual(junk.setting, defaultSetting(TOPICS));
  assert.deepEqual(junk.sliders, { match: 100, surprise: 0, expTheory: 0, solo: 100, ai: 0, senior: 50 });

  /* An unknown leaf id is dropped, a known one is kept. */
  const mixed = parsePrefs(TOPICS, 'topics=ghost:off,qml:avoid');
  assert.deepEqual(mixed.setting.leaves, { qml: 'avoid' });
});

test('a reset setting is defaultSetting again, through the codec', () => {
  const changed = { ...defaultPrefs(TOPICS), setting: { computing: 'off', matter: 'avoid', leaves: { qml: 'prefer' } } };
  const reset = { ...changed, setting: defaultSetting(TOPICS) };
  assert.deepEqual(parsePrefs(TOPICS, serialisePrefs(TOPICS, reset)).setting, defaultSetting(TOPICS));
});

/* ── the summary ────────────────────────────────────────────────────────── */

test('prefsSummary names the applied topics and whether there are words', () => {
  assert.equal(prefsSummary(TOPICS, defaultPrefs(TOPICS)), 'Computing preferred');

  const changed = {
    ...defaultPrefs(TOPICS),
    setting: { computing: 'prefer', matter: 'avoid', leaves: {} },
    text: 'spin qubits',
  };
  assert.equal(prefsSummary(TOPICS, changed), 'Computing preferred · Matter avoided · your words');

  const cleared = { ...defaultPrefs(TOPICS), setting: clearSetting(TOPICS) };
  assert.equal(prefsSummary(TOPICS, cleared), 'topics equal');
});

test('the senior boost is mirrored like a penalty: default 50, on the URL only when moved', () => {
  assert.equal(SLIDERS.senior.min, 0);
  assert.equal(SLIDERS.senior.max, 100);
  assert.equal(SLIDERS.senior.value, 50);
  assert.equal(defaultPrefs(TOPICS).sliders.senior, 50);

  /* The default string stays the short one, so no `senior=50` noise. */
  assert.doesNotMatch(serialisePrefs(TOPICS, defaultPrefs(TOPICS)), /senior=/);

  const moved = { ...defaultPrefs(TOPICS), sliders: { ...defaultPrefs(TOPICS).sliders, senior: 80 } };
  assert.match(serialisePrefs(TOPICS, moved), /(^|&)senior=80(&|$)/);
  assert.equal(parsePrefs(TOPICS, serialisePrefs(TOPICS, moved)).sliders.senior, 80);

  /* Stored by a build from before the boost: no param, so it reads as 50. */
  assert.equal(parsePrefs(TOPICS, 'topics=&match=50&surprise=50&exp=0&solo=0&ai=0').sliders.senior, 50);
  assert.equal(parsePrefs(TOPICS, 'senior=900').sliders.senior, 100, 'clamped like every slider');
  assert.equal(parsePrefs(TOPICS, 'senior=x').sliders.senior, 50, 'junk falls back to the default');
});

test('sliderValue clamps a known slider and refuses an unknown one', () => {
  assert.equal(sliderValue('solo', 140), 100);
  assert.equal(sliderValue('ai', ''), 0);
  assert.equal(sliderValue('senior', ''), 50);
  assert.equal(sliderValue('senior', -20), 0);
  assert.equal(sliderValue('expTheory', -300), -100);
  assert.equal(sliderValue('nope', 5), undefined);
  assert.equal(sliderValue('toString', 5), undefined);
});

