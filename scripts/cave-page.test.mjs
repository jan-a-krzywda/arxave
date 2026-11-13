/**
 * `node --test scripts/cave-page.test.mjs`.
 *
 * Cave v3's page has two halves that fail differently. The pure half — the
 * setting codec, the chip row, the parent counts — fails silently and only in
 * the browser, so it is tested here against hand-built fixtures. The markup
 * half fails loudly but late (a `getElementById` on an id renamed in cave.md),
 * so the last three tests read the two files and hold them together: every id
 * the page needs is in the page, and /sieve/ still redirects to /cave/.
 *
 * The fixture tree is the contract's shape in miniature: three dimensions, two
 * parents, three leaves, Computing preferred — enough to exercise "a parent sets
 * its children", "a child overrides" and "off is a setting, not a weight".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  chipsFromSetting, clearSetting, defaultState, parentCounts, parseSettings, removeChip,
  serialiseSettings,
} from '../docs/assets/cave.js';
import { defaultSetting, loadTopics } from '../docs/assets/sieve-core.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(ROOT, file), 'utf8');

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

/* ── chips ──────────────────────────────────────────────────────────────── */

test('the default setting derives exactly one chip: Computing prefer', () => {
  const chips = chipsFromSetting(TOPICS, defaultSetting(TOPICS));
  assert.deepEqual(chips, [
    { scope: 'parent', id: 'computing', label: 'Computing', choice: 'prefer' },
  ]);
});

test('a parent change shows its chip, and a leaf override adds one of its own', () => {
  const setting = { computing: 'prefer', matter: 'avoid', leaves: { qml: 'off' } };
  const chips = chipsFromSetting(TOPICS, setting);
  assert.deepEqual(chips.map((c) => `${c.scope}:${c.id}:${c.choice}`), [
    'parent:computing:prefer',
    'parent:matter:avoid',
    'leaf:qml:off',
  ]);
});

test('a leaf that repeats its parent changes nothing, so it earns no chip', () => {
  /* Computing is already prefer: saying qml is prefer too is not a difference. */
  const chips = chipsFromSetting(TOPICS, { computing: 'prefer', matter: 'equal', leaves: { qml: 'prefer' } });
  assert.deepEqual(chips.map((c) => c.id), ['computing']);

  /* An off parent with an off child is the same story. */
  const off = chipsFromSetting(TOPICS, { computing: 'off', matter: 'equal', leaves: { qml: 'off' } });
  assert.deepEqual(off.map((c) => c.id), ['computing']);
});

test('clear filters leaves no chips; Reset restores defaultSetting', () => {
  assert.deepEqual(chipsFromSetting(TOPICS, clearSetting(TOPICS)), []);

  /* Reset is the default setting again, whether built fresh or parsed back out
     of a URL that held something else. */
  const changed = { ...defaultState(TOPICS), setting: { computing: 'off', matter: 'avoid', leaves: { qml: 'prefer' } } };
  const reset = { ...changed, setting: defaultSetting(TOPICS) };
  assert.deepEqual(parseSettings(TOPICS, serialiseSettings(TOPICS, reset)).setting, defaultSetting(TOPICS));
  assert.deepEqual(defaultState(TOPICS).setting, defaultSetting(TOPICS));
  assert.equal(defaultState(TOPICS).match, 50);
  assert.equal(defaultState(TOPICS).surprise, 50);
  assert.equal(defaultState(TOPICS).expTheory, 0);
});

test('dropping a chip undoes exactly that choice', () => {
  const setting = { computing: 'prefer', matter: 'avoid', leaves: { qml: 'off' } };

  const noLeaf = removeChip(TOPICS, setting, { scope: 'leaf', id: 'qml' });
  assert.equal('qml' in noLeaf.leaves, false);
  assert.equal(noLeaf.matter, 'avoid');            // the rest is untouched
  assert.equal(setting.leaves.qml, 'off');         // and the argument was not mutated

  const noParent = removeChip(TOPICS, setting, { scope: 'parent', id: 'matter' });
  assert.equal(noParent.matter, 'equal');
  assert.equal(noParent.computing, 'prefer');
});

/* ── serialisation ──────────────────────────────────────────────────────── */

test('serialise → parse round-trips a whole state', () => {
  const state = {
    setting: { computing: 'prefer', matter: 'avoid', leaves: { qml: 'off', 'many-body': 'prefer' } },
    match: 73,
    surprise: 41,
    expTheory: -60,
    lookback: 3,
    ml4q: true,
  };
  assert.deepEqual(parseSettings(TOPICS, serialiseSettings(TOPICS, state)), state);
});

test('the default state serialises short and parses back to itself', () => {
  const state = defaultState(TOPICS);
  const code = serialiseSettings(TOPICS, state);
  assert.match(code, /topics=&/);                  // nothing differs from the default
  assert.deepEqual(parseSettings(TOPICS, code), state);
});

test('junk, missing and out-of-range values fall back instead of throwing', () => {
  const empty = parseSettings(TOPICS, '');
  assert.deepEqual(empty.setting, defaultSetting(TOPICS));
  assert.equal(empty.match, 50);
  assert.equal(empty.lookback, 1);
  assert.equal(empty.ml4q, false);

  const junk = parseSettings(TOPICS, 'topics=nope:sideways,qml:loud&match=900&surprise=-4&exp=nope&lookback=99');
  assert.deepEqual(junk.setting, defaultSetting(TOPICS));
  assert.equal(junk.match, 100);
  assert.equal(junk.surprise, 0);
  assert.equal(junk.expTheory, 0);
  assert.equal(junk.lookback, 3);

  /* An unknown leaf id is dropped, a known one is kept. */
  const mixed = parseSettings(TOPICS, 'topics=ghost:off,qml:avoid');
  assert.deepEqual(mixed.setting.leaves, { qml: 'avoid' });
  assert.equal('ghost' in mixed.setting.leaves, false);
});

/* ── parent counts ──────────────────────────────────────────────────────── */

test('a parent counts a paper once, primary or secondary, and 0 is a count', () => {
  const counts = parentCounts([
    { topic: 0, topic2: -1 },   // opt-qalgo → computing
    { topic: 0, topic2: 2 },    // computing + many-body → one for each
    { topic: 2, topic2: 2 },    // many-body on both sides: still one
    { topic: -1, topic2: -1 },  // no topic at all → nowhere
  ], TOPICS);
  assert.deepEqual(counts, { computing: 2, matter: 2 });

  assert.deepEqual(parentCounts([], TOPICS), { computing: 0, matter: 0 });
});

/* ── the page and the redirect ──────────────────────────────────────────── */

/* The contract's DOM hooks (cave-v3-interfaces.md, "Page"). If one of these is
   renamed in cave.md, cave.js stops wiring and the page is a dead form. */
const CONTRACT_IDS = [
  'cv-app', 'cv-text', 'cv-match', 'cv-surprise', 'cv-exptheory', 'cv-tree',
  'cv-chips', 'cv-results', 'cv-advanced', 'cv-topics-btn', 'cv-sheet',
];

test('docs/cave.md carries every contract id', () => {
  const page = read('docs/cave.md');
  const ids = new Set([...page.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  for (const id of CONTRACT_IDS) assert.ok(ids.has(id), `cave.md is missing #${id}`);
  assert.match(page, /^permalink: \/cave\/$/m);
});

test('every id cave.js asks the document for exists in cave.md', () => {
  const page = read('docs/cave.md');
  const java = read('docs/assets/cave.js');
  const ids = new Set([...page.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

  const used = new Set([
    ...[...java.matchAll(/\bbyId\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]),
    ...[...java.matchAll(/querySelector(?:All)?\(\s*'#([A-Za-z0-9_-]+)/g)].map((m) => m[1]),
  ]);

  assert.ok(used.size >= CONTRACT_IDS.length, `only ${used.size} ids found in cave.js`);
  for (const id of used) assert.ok(ids.has(id), `cave.js wants #${id}, cave.md does not have it`);
});

test('/sieve/ redirects to /cave/', () => {
  const stub = read('docs/sieve.md');
  assert.match(stub, /^permalink: \/sieve\/$/m);
  assert.match(stub, /http-equiv="refresh" content="0; url=\{\{ '\/cave\/' \| relative_url \}\}"/);
  assert.match(stub, /href="\{\{ '\/cave\/' \| relative_url \}\}"/);
});

