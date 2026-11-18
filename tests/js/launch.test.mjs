/*
 * Launch links: the table of shared entry points, and the two URL forms that
 * name one. Run with `node --test tests/js/launch.test.mjs`.
 *
 * Most of this is parity, not behaviour. Every row is copied data from the
 * Opus proposal (docs/superpowers/plans/2026-11-18-launch-presets-proposal.md),
 * so the risk is a copy that drifts: a phrase typed by hand, a category list
 * that no longer starts with a code its field claims. The first code decides
 * tonight's pack (`cave-fields.mjs`), so a drifted row would quietly dig the
 * wrong corpus. The URL checks are the ones a reader feels: a typo must be a
 * plain 404, never a half-started Cave.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LAUNCHES,
  LAUNCH_FRESH_MS,
  LAUNCH_KEY,
  launchById,
  launchFromPath,
  launchFromSearch,
  resolveLaunch,
} from '../../docs/assets/cave-launch.mjs';
import { runningLaunch, seedLaunch } from '../../docs/assets/cave-launch-run.mjs';
import { FIELD_KEY, fieldById, fieldKey } from '../../docs/assets/cave-fields.mjs';
import { AUTODIG_KEY, FORM_KEY } from '../../docs/assets/cave-stage-dig.mjs';
import { STORE_KEY } from '../../docs/assets/cave-stage-priorities.mjs';
import { readStore } from '../../docs/assets/sieve-ui.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROPOSAL = fs.readFileSync(
  path.join(ROOT, 'docs/superpowers/plans/2026-11-18-launch-presets-proposal.md'), 'utf8');

/** The 12 ranked rows, read from the proposal's table so the copy is checked. */
function proposalRows() {
  return PROPOSAL.split('\n')
    .filter((line) => /^\| \d+ \|/.test(line))
    .map((line) => {
      const [, , slug, field, categories, nudge] = line.split('|').map((c) => c.trim());
      return {
        slug: slug.replace(/`/g, ''),
        field,
        categories: categories.replace(/`|⚠/g, '').split(',').map((c) => c.trim()),
        nudge: nudge.startsWith('none') ? null : nudge.replace(/`/g, '').split(' ')[0],
      };
    });
}

/** The "Embed phrases" bullets, one per slug. */
function proposalPhrases() {
  const phrases = new Map();
  for (const line of PROPOSAL.split('\n')) {
    const found = /^- ([a-z0-9-]+): "(.*)"$/.exec(line);
    if (found) phrases.set(found[1], found[2]);
  }
  return phrases;
}

test('launchFromPath reads a field/slug path, with or without the trailing slash', () => {
  const launch = launchFromPath('/quantum/spin-qubits');
  assert.equal(launch?.id, 'quantum/spin-qubits');
  assert.equal(launch.field, 'quantum');
  assert.equal(launchFromPath('/quantum/spin-qubits/'), launch);
});

test('anything else is not a launch', () => {
  for (const pathname of [
    '/quantum/nope', '/ai/', '/foo/spin-qubits', '/quantum/spin-qubits/extra', '/', '',
  ]) {
    assert.equal(launchFromPath(pathname), null, pathname);
  }
});

test('launchFromSearch reads ?launch=, and only that', () => {
  assert.equal(launchFromSearch('?launch=ai/llms')?.id, 'ai/llms');
  assert.equal(launchFromSearch('?launch=ai/llms&utm=x')?.id, 'ai/llms');
  assert.equal(launchFromSearch('?launch=ai/nope'), null);
  assert.equal(launchFromSearch('?field=ai'), null);
  assert.equal(launchFromSearch(''), null);
});

test('resolveLaunch reads the rewritten search first, the clean path second', () => {
  // `404.html` sends a reader to `/?launch=…`; the clean path is what
  // `cave.js` sees when the page is opened without the detour.
  assert.equal(resolveLaunch({ pathname: '/', search: '?launch=ai/llms' })?.id, 'ai/llms');
  assert.equal(resolveLaunch({ pathname: '/ai/llms', search: '' })?.id, 'ai/llms');
  assert.equal(resolveLaunch({ pathname: '/', search: '' }), null);
  assert.equal(resolveLaunch({ pathname: '/quantum/nope', search: '' }), null);
});

test('ids are unique, and launchById finds every row', () => {
  const ids = LAUNCHES.map((launch) => launch.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.equal(launchById(id)?.id, id);
  assert.equal(launchById('ai/reinforcement-learning')?.field, 'ai');
  assert.equal(launchById('ai/nope'), null);
});

test('every launch agrees with the field pack', () => {
  for (const launch of LAUNCHES) {
    const field = fieldById(launch.field);
    assert.ok(field, launch.id + ': unknown field');
    assert.equal(launch.id, launch.field + '/' + launch.slug);
    assert.match(launch.slug, /^[a-z0-9-]+$/);
    assert.ok(launch.categories.length, launch.id + ': no categories');
    // The first code is the one cave-fields reads to pick the pack.
    assert.ok(field.categories.includes(launch.categories[0]),
      launch.id + ': ' + launch.categories[0] + ' is not a ' + field.id + ' code');
    assert.equal(typeof launch.label, 'string');
    assert.ok(launch.label.length, launch.id + ': empty label');
    assert.ok(launch.nudge === null || typeof launch.nudge === 'string', launch.id + ': nudge');
    assert.ok(Object.isFrozen(launch) && Object.isFrozen(launch.categories), launch.id + ': not frozen');
  }
});

test('the table is the proposal, verbatim and in order', () => {
  const rows = proposalRows();
  const phrases = proposalPhrases();
  assert.equal(LAUNCHES.length, 12);
  assert.equal(rows.length, LAUNCHES.length);

  LAUNCHES.forEach((launch, i) => {
    assert.equal(launch.slug, rows[i].slug, 'row ' + (i + 1));
    assert.equal(launch.field, rows[i].field);
    assert.deepEqual(launch.categories, rows[i].categories);
    assert.equal(launch.nudge, rows[i].nudge);

    const phrase = phrases.get(launch.slug);
    assert.equal(launch.phrase, phrase, launch.id + ': phrase differs from the proposal');
    const words = phrase.trim().split(/\s+/).length;
    assert.ok(words >= 6 && words <= 40, launch.id + ': ' + words + ' words');
  });

  // The one launch the plan calls out: no hardware leaf, so nothing to prefer.
  assert.equal(launchById('quantum/spin-qubits')?.nudge, null);
});

test('the storage record has a key and a freshness window', () => {
  assert.equal(LAUNCH_KEY, 'arxave-cave-launch');
  // Five minutes: a cold, uncached category is about a minute before the embed,
  // and the run must not run out of road at the map on the way there.
  assert.equal(LAUNCH_FRESH_MS, 300000);
});

/*
 * Seeding is the launch's whole trick: nothing in the page knows a launch is
 * running, it just finds a dig asked for and a box already written. So these
 * check storage, not behaviour — a seeded key that Dig no longer reads, or a
 * launch whose categories did not switch the pack, would quietly dig the wrong
 * morning. A fake store is enough and needs no DOM.
 */
function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial).map(([key, value]) => [key, JSON.stringify(value)]));
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
  };
}

test('a launch seeds Dig for its own field, and asks for one day', () => {
  // The reader was last reading quantum: a launch must win, categories and all.
  const storage = fakeStorage({
    [FORM_KEY]: { categories: 'cond-mat.mes-hall, quant-ph', lookback: 3, maxResults: 40 },
    [FIELD_KEY]: 'quantum',
  });
  seedLaunch({ storage, launch: launchById('ai/llms'), now: 1700000000000 });

  const form = readStore(storage, FORM_KEY, null);
  assert.equal(form.categories, 'cs.AI, cs.CL');
  assert.equal(form.lookback, 1);
  assert.equal(form.maxResults, 40, 'the reader\'s own max results are kept');
  assert.equal(readStore(storage, FIELD_KEY, null), 'ai');
  assert.equal(readStore(storage, AUTODIG_KEY, 0), 1700000000000, 'Dig does not autorun');
  assert.deepEqual(readStore(storage, LAUNCH_KEY, null),
    { id: 'ai/llms', at: 1700000000000 });
});

test('a launch forgets the saved priorities, then prefers its own topic', () => {
  const ai = fieldById('ai');
  const aiPrefs = fieldKey(STORE_KEY, ai);
  const storage = fakeStorage({
    [aiPrefs]: { q: 'topics=rl:avoid&match=10&surprise=90&exp=-50', text: 'old words' },
  });
  seedLaunch({ storage, launch: launchById('ai/llms'), now: 1 });

  // ai/llms has no nudge: the sliders must come back at their defaults, which
  // means no stored prefs at all rather than a half-overwritten set.
  assert.equal(readStore(storage, aiPrefs, null), null);

  const nudged = fakeStorage();
  seedLaunch({ storage: nudged, launch: launchById('ai/reinforcement-learning'), now: 1 });
  assert.equal(readStore(nudged, aiPrefs, null)?.q, 'topics=rl:prefer');

  // A launch with no nudge writes nothing, so the box stays empty too.
  const quiet = fakeStorage();
  seedLaunch({ storage: quiet, launch: launchById('quantum/spin-qubits'), now: 1 });
  assert.equal(readStore(quiet, fieldKey(STORE_KEY, fieldById('quantum')), null), null);
});

test('seeding a launch with no storage is a no-op, not a crash', () => {
  // Private mode: null storage is the page's normal state, and a launch link
  // must still open rather than throw on the way to the dig.
  seedLaunch({ storage: null, launch: launchById('quantum/spin-qubits'), now: 1 });
  seedLaunch({ storage: null, launch: null, now: 1 });
});

test('runningLaunch is a launch only while the record is fresh', () => {
  const storage = fakeStorage({ [LAUNCH_KEY]: { id: 'quantum/spin-qubits', at: 1000 } });
  assert.equal(runningLaunch(storage, 1000)?.id, 'quantum/spin-qubits');
  assert.equal(runningLaunch(storage, 1000 + LAUNCH_FRESH_MS - 1)?.id, 'quantum/spin-qubits');
  // An hour later the reader is browsing, not following the link any more.
  assert.equal(runningLaunch(storage, 1000 + LAUNCH_FRESH_MS), null);
  assert.equal(runningLaunch(fakeStorage(), 1000), null);
  // A record naming a launch this build does not have is not one either.
  const ghost = fakeStorage({ [LAUNCH_KEY]: { id: 'ai/ghost', at: 1000 } });
  assert.equal(runningLaunch(ghost, 1000), null);
});

/*
 * The two files that do the wiring, checked as text: there is no DOM here, and
 * the failures these guard are silent ones. A 404 page that stops redirecting
 * looks like a working 404; a Cave that forgets to restore the address leaves
 * the reader on `/?launch=…` and every share of it grows a query string.
 */
test('404.html redirects a launch path, and only a launch path', () => {
  const html = fs.readFileSync(path.join(ROOT, 'docs/404.html'), 'utf8');
  assert.match(html, /\/\?launch=/, 'no redirect to /?launch=');
  assert.match(html, /location\.replace\(/, 'no location.replace');

  // The slugs are not copied into a static page: the script asks
  // cave-launch.mjs, so an unknown slug stays a plain 404 instead of opening
  // a half-started Cave.
  assert.match(html, /import\(/, '404.html does not load cave-launch.mjs');
  assert.match(html, /launchFromPath/, '404.html does not validate the path');
});

/*
 * The other half of that contract, as text: the 404 page loads `cave-launch.mjs`
 * ALONE, so that module must import nothing. One import line would put the
 * Dig/fields/Priorities chain — and any failure in it — between every shared
 * link and its redirect, and a 404 that silently stops redirecting looks like a
 * working 404. `cave-launch-run.mjs` is where the pieces that need the rest of
 * the Cave live.
 */
test('cave-launch.mjs stays loadable on its own: no import lines', () => {
  const js = fs.readFileSync(path.join(ROOT, 'docs/assets/cave-launch.mjs'), 'utf8');
  const imports = js.split('\n').filter((line) => /^\s*import\b/.test(line));
  assert.deepEqual(imports, [], 'cave-launch.mjs imports: ' + imports.join(' | '));
});

/*
 * Task 3's wiring, also as text: typing must stop costing a call. A warm cache
 * hides the regression — the embed timer fires, hits the cache and the network
 * tab stays quiet — so the guard is that no timer embeds at all.
 */
test('Priorities embeds on the button, not on typing', () => {
  const js = fs.readFileSync(path.join(ROOT, 'docs/assets/cave-stage-priorities.mjs'), 'utf8');
  assert.match(js, /cave-embed-btn/, 'no Embed & rank button');
  assert.match(js, /await embedNow\(\)/, 'the button does not call embedNow()');
  assert.doesNotMatch(js, /setTimeout\(embedWords/, 'still embeds on a typing timer');
});

test('cave.js resolves a launch and puts the clean address back', () => {
  const js = fs.readFileSync(path.join(ROOT, 'docs/assets/cave.js'), 'utf8');
  assert.match(js, /resolveLaunch\(window\.location\)/, 'cave.js does not resolve the URL');
  assert.match(js, /history\.replaceState\(null, '', '\/' \+ launch\.id\)/,
    'cave.js does not restore /<field>/<slug>');
});

/*
 * The autorun's wiring, again as text: a launch that seeds after `chooseField`
 * would load the other field's corpus and dig the other field's categories, and
 * a launch whose priorities stage never runs is a link that stops on a filled
 * box. Both fail silently, so both are pinned here.
 */
test('cave.js seeds the launch before it picks the field', () => {
  const js = fs.readFileSync(path.join(ROOT, 'docs/assets/cave.js'), 'utf8');
  const seed = js.indexOf('seedLaunch(');
  assert.ok(seed > 0, 'cave.js does not seed the launch');
  assert.ok(seed > js.indexOf('resolveLaunch(window.location)'), 'seeded before the URL was read');
  assert.ok(seed < js.indexOf('chooseField('), 'the field is picked before the launch is seeded');
  // A reload inside the window must not dig the same night again.
  assert.match(js, /runningLaunch\(/, 'no reload guard on the launch record');
});

test('the map passes its own card, so Priorities can open', () => {
  const js = fs.readFileSync(path.join(ROOT, 'docs/assets/cave-stage-map.mjs'), 'utf8');
  assert.match(js, /runningLaunch\(ctx\.storage\)/, 'the map never looks for a launch');
  assert.match(js, /continueBtn\.click\(\)/, 'the map does not press its own Continue');
});

test('Priorities runs a launch: phrase, embed, rank, whatever the embed says', () => {
  const js = fs.readFileSync(path.join(ROOT, 'docs/assets/cave-stage-priorities.mjs'), 'utf8');
  assert.match(js, /LAUNCH_KEY/, 'Priorities never reads the launch record');
  assert.match(js, /launch\.phrase/, 'the box is not given the launch phrase');
  assert.match(js, /addEventListener\('night'/, 'the autorun does not wait for the night');
  assert.match(js, /await embedNow\(\)/, 'the autorun does not embed');
  assert.match(js, /continueBtn\.click\(\)/, 'the autorun does not press Rank tonight');
  assert.match(js, /removeItem\(LAUNCH_KEY\)|removeItem\([a-zA-Z]+, LAUNCH_KEY\)/,
    'the one-shot record is never cleared');
});

test('a failed embed keeps its reason when Rank tonight is pressed', () => {
  const js = fs.readFileSync(path.join(ROOT, 'docs/assets/cave-stage-priorities.mjs'), 'utf8');
  const note = js.indexOf('Your words were not embedded');
  assert.ok(note > 0, 'no not-embedded note');
  // The button must look at the note before writing over it: `embedNow` puts
  // the embed service's own failure there (is-error), and that is the reason
  // the reader needs, not "your words were not embedded".
  const guard = js.lastIndexOf("classList.contains('is-error')", note);
  assert.ok(guard > 0 && guard < note, 'the not-embedded note overwrites an embed error');
});

