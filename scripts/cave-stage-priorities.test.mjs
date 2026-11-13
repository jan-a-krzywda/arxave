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
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  ART_HREF, CHOICES, clearSetting, chipsFromSetting, defaultPrefs, parsePrefs, prefsSummary,
  removeChip, serialisePrefs, treeCounts, wagonsForLeaf, weightOf,
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

/* ── the campfire it opens with ─────────────────────────────────────────── */

test('the campfire art beside the stage is a file that ships', () => {
  assert.ok(ART_HREF.endsWith('/assets/cave-art/campfire.svg'), ART_HREF);
  assert.ok(existsSync(fileURLToPath(ART_HREF)), 'campfire.svg is not beside the stage module');
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
    sliders: { match: 73, surprise: 41, expTheory: -60 },
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
  assert.deepEqual(empty.sliders, { match: 50, surprise: 50, expTheory: 0 });
  assert.equal(empty.ml4q, false);

  const junk = parsePrefs(TOPICS, 'topics=nope:sideways,qml:loud&match=900&surprise=-4&exp=nope');
  assert.deepEqual(junk.setting, defaultSetting(TOPICS));
  assert.deepEqual(junk.sliders, { match: 100, surprise: 0, expTheory: 0 });

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

test('prefsSummary names the applied topics and Surprise', () => {
  assert.equal(prefsSummary(TOPICS, defaultPrefs(TOPICS)), 'Computing preferred · surprise 50');

  const changed = {
    ...defaultPrefs(TOPICS),
    setting: { computing: 'prefer', matter: 'avoid', leaves: {} },
    sliders: { match: 50, surprise: 41, expTheory: 0 },
  };
  assert.equal(prefsSummary(TOPICS, changed), 'Computing preferred · Matter avoided · surprise 41');

  const cleared = { ...defaultPrefs(TOPICS), setting: clearSetting(TOPICS) };
  assert.equal(prefsSummary(TOPICS, cleared), 'topics equal · surprise 50');
});

