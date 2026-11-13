/**
 * `cd scripts && node --test cave-flow.test.mjs`.
 *
 * The page's whole progress lives in here: which card is open, what each done
 * card remembers, and the localStorage entry a reload resumes from. None of it
 * draws anything, so the tests are plain state assertions plus a fake storage —
 * no DOM, no jsdom.
 *
 * The storage cases matter more than they look. `localStorage` in a private
 * window throws on `setItem`, Safari throws on `getItem` after seven days of no
 * use, and the key is shared with every earlier build of this page. A night
 * that cannot be saved must still run.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { STAGES, createFlow, foldOnComplete } from '../docs/assets/cave-flow.mjs';

/** The two methods of localStorage this file uses, over a Map. */
function fakeStorage(initial) {
  const map = new Map(Object.entries(initial ?? {}));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
  };
}

test('the eight stages are fixed and in order', () => {
  assert.deepEqual(
    [...STAGES],
    ['dig', 'train', 'map', 'fire', 'priorities', 'ranking', 'act', 'story'],
  );
});

test('a fresh night: dig open, everything else locked, dig expanded', () => {
  const flow = createFlow();
  assert.equal(flow.status('dig'), 'open');
  for (const id of STAGES.slice(1)) assert.equal(flow.status(id), 'locked', id);
  assert.equal(flow.current(), 'dig');
  assert.equal(flow.expanded('dig'), true);
  assert.equal(flow.expanded('train'), false);
  assert.equal(flow.summary('dig'), null);
});

test('completing in order unlocks exactly the next stage', () => {
  const flow = createFlow();
  for (let i = 0; i < STAGES.length; i += 1) {
    const id = STAGES[i];
    assert.equal(flow.status(id), 'open', `${id} should be open`);
    flow.complete(id, `${i} done`);
    assert.equal(flow.status(id), 'done');
    assert.equal(flow.summary(id), `${i} done`);
    const next = STAGES[i + 1];
    for (const later of STAGES.slice(i + 1)) {
      assert.equal(flow.status(later), later === next ? 'open' : 'locked', later);
    }
  }
  assert.equal(flow.current(), null);
});

test('completing a locked stage throws and changes nothing', () => {
  const flow = createFlow();
  assert.throws(() => flow.complete('map', 'nightly'), /locked/);
  assert.equal(flow.status('map'), 'locked');
  assert.equal(flow.current(), 'dig');
  assert.deepEqual(flow.snapshot(), { done: {}, expanded: ['dig'] });
});

test('completing is idempotent for an already-done stage', () => {
  const flow = createFlow();
  flow.complete('dig', 'first');
  flow.complete('dig', 'second');
  assert.equal(flow.summary('dig'), 'second');
});

test('a summary is one line and trimmed', () => {
  const flow = createFlow();
  flow.complete('dig', '312 papers ·\n  14 wagons ');
  assert.equal(flow.summary('dig'), '312 papers · 14 wagons');
});

test('a done stage folds and the newly open one unfolds', () => {
  const flow = createFlow();
  flow.complete('dig', '312 papers');
  assert.equal(flow.expanded('dig'), false);
  assert.equal(flow.expanded('train'), true);
});

test('toggle flips one stage without touching the others', () => {
  const flow = createFlow();
  flow.complete('dig', '312 papers');
  flow.toggle('dig');
  assert.equal(flow.expanded('dig'), true);
  assert.equal(flow.expanded('train'), true);
  flow.toggle('dig');
  assert.equal(flow.expanded('dig'), false);
  assert.deepEqual(flow.snapshot().expanded, ['train']);
});

test('invalidating from map keeps dig and train and reopens map', () => {
  const flow = createFlow();
  for (const id of ['dig', 'train', 'map', 'fire']) flow.complete(id, `${id} · ok`);

  flow.invalidateFrom('map');

  assert.equal(flow.status('dig'), 'done');
  assert.equal(flow.status('train'), 'done');
  assert.equal(flow.status('map'), 'open');
  assert.equal(flow.status('fire'), 'locked');
  assert.equal(flow.summary('dig'), 'dig · ok');
  assert.equal(flow.summary('train'), 'train · ok');
  assert.equal(flow.summary('map'), null);
  assert.equal(flow.summary('fire'), null);
  assert.equal(flow.current(), 'map');
  assert.equal(flow.expanded('map'), true);
  assert.equal(flow.expanded('fire'), false);
  assert.deepEqual(flow.snapshot(), {
    done: { dig: 'dig · ok', train: 'train · ok' },
    expanded: ['map'],
  });
});

test('onChange fires with a snapshot after every mutation and unsubscribes', () => {
  const flow = createFlow();
  const seen = [];
  const off = flow.onChange((snap) => seen.push(snap));

  flow.complete('dig', '312 papers');
  flow.toggle('dig');
  flow.invalidateFrom('dig');
  assert.equal(seen.length, 3);
  assert.deepEqual(seen[0], { done: { dig: '312 papers' }, expanded: ['train'] });
  assert.deepEqual(seen[2], { done: {}, expanded: ['dig'] });

  off();
  flow.complete('dig', 'again');
  assert.equal(seen.length, 3);

  // A throwing listener must not stop the next one (or the mutation).
  flow.onChange(() => { throw new Error('renderer broke'); });
  let heard = 0;
  flow.onChange(() => { heard += 1; });
  flow.complete('train', '14 wagons');
  assert.equal(heard, 1);
});

test('snapshots are plain JSON and not shared with the machine', () => {
  const flow = createFlow();
  flow.complete('dig', '312 papers');
  const snap = flow.snapshot();
  assert.equal(JSON.stringify(snap), '{"done":{"dig":"312 papers"},"expanded":["train"]}');
  snap.done.dig = 'tampered';
  snap.expanded.push('story');
  assert.equal(flow.summary('dig'), '312 papers');
  assert.equal(flow.expanded('story'), false);
});

test('persistence round trip through fake storage', () => {
  const storage = fakeStorage();
  const flow = createFlow({ storage, key: 'k' });
  flow.complete('dig', '312 papers');

  const raw = JSON.parse(storage.map.get('k'));
  assert.deepEqual(raw, { done: { dig: '312 papers' }, expanded: ['train'] });

  const restored = createFlow({ storage, key: 'k' });
  assert.equal(restored.status('dig'), 'done');
  assert.equal(restored.status('train'), 'open');
  assert.equal(restored.current(), 'train');
  assert.equal(restored.expanded('train'), true);

  restored.invalidateFrom('train');
  const again = createFlow({ storage, key: 'k' });
  assert.equal(again.status('dig'), 'done');
  assert.equal(again.status('train'), 'open');
  assert.equal(again.summary('train'), null);

  // A reader who folded the only open card shut stays folded after a reload.
  const shut = createFlow({ storage, key: 'k2' });
  shut.toggle('dig');
  assert.deepEqual(JSON.parse(storage.map.get('k2')).expanded, []);
  assert.equal(createFlow({ storage, key: 'k2' }).expanded('dig'), false);
});

test('a fresh flow writes nothing until something changes', () => {
  const storage = fakeStorage();
  createFlow({ storage, key: 'k' });
  assert.equal(storage.map.has('k'), false);
});

test('corrupt or unknown stored values are ignored: fresh start', () => {
  const cases = {
    'invalid json': '{not json',
    'not an object': '[1,2,3]',
    'no done map': '{"expanded":["dig"]}',
    'done not an object': '{"done":"dig","expanded":[]}',
    'summary not a string': '{"done":{"dig":7},"expanded":[]}',
    'unknown stage': '{"done":{"quarry":"dug"},"expanded":["quarry"]}',
    'expanded not an array': '{"done":{"dig":"ok"},"expanded":"dig"}',
    'empty string': '',
  };
  for (const [label, raw] of Object.entries(cases)) {
    const flow = createFlow({ storage: fakeStorage({ 'arxave-cave-v4-flow': raw }) });
    assert.equal(flow.status('dig'), 'open', label);
    assert.equal(flow.status('train'), 'locked', label);
    assert.equal(flow.summary('dig'), null, label);
    assert.deepEqual(flow.snapshot(), { done: {}, expanded: ['dig'] }, label);
  }
});

test('a throwing storage never throws: not on load, not on save', () => {
  const throwing = {
    getItem() { throw new Error('SecurityError: localStorage is denied'); },
    setItem() { throw new Error('QuotaExceededError'); },
  };
  const flow = createFlow({ storage: throwing });
  assert.equal(flow.status('dig'), 'open');
  flow.complete('dig', '312 papers');
  flow.toggle('dig');
  flow.invalidateFrom('dig');
  assert.equal(flow.status('dig'), 'open');
  assert.equal(flow.current(), 'dig');
});

test('unknown stage ids are a programming error, not a locked card', () => {
  const flow = createFlow();
  assert.throws(() => flow.status('quarry'), TypeError);
  assert.throws(() => flow.summary('quarry'), TypeError);
  assert.throws(() => flow.complete('quarry', 'x'), TypeError);
  assert.throws(() => flow.invalidateFrom('quarry'), TypeError);
  assert.throws(() => flow.toggle('quarry'), TypeError);
});

test('a custom stage list is honoured', () => {
  const flow = createFlow({ stages: ['dig', 'map'] });
  assert.equal(flow.status('map'), 'locked');
  flow.complete('dig', 'ok');
  assert.equal(flow.status('map'), 'open');
  assert.equal(flow.current(), 'map');
});

/* ── the fold rule ──────────────────────────────────────────────────────── */

test('every stage folds on complete except the story', () => {
  assert.equal(foldOnComplete('story'), false);
  for (const id of STAGES.slice(0, -1)) assert.equal(foldOnComplete(id), true, id);

  /* The whole night, in order: the story is the last card, so nothing after it
     opens, and the narrative stays expanded where the reader left it. */
  const flow = createFlow();
  for (const id of STAGES) flow.complete(id, id + ' done');
  assert.equal(flow.status('story'), 'done');
  assert.equal(flow.expanded('story'), true, 'the story folded away what it just wrote');
  assert.deepEqual(flow.snapshot().expanded, ['story']);

  /* `complete` on a stage that has folded still folds it — only 'story' is
     exempt from the default, not every already-done card. */
  const other = createFlow();
  other.complete('dig', 'dug');
  other.toggle('dig');
  other.complete('dig', 'dug again');
  assert.equal(other.expanded('dig'), false);
});


