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
} from '../../docs/assets/cave-launch.mjs';
import { fieldById } from '../../docs/assets/cave-fields.mjs';

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
  assert.equal(LAUNCH_FRESH_MS, 120000);
});
