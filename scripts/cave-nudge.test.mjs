/**
 * `cd scripts && node --test cave-nudge.test.mjs`.
 *
 * The nudge is arithmetic a reader notices when it is wrong: the two lists, the
 * cosine penalty and the new order. Every expected number below is worked out
 * on paper, with 3-D unit vectors, so a change in the formula shows up as a
 * wrong digit rather than a shrug. No DOM — `shortTitle` and `nudgeChips` are
 * string builders, and `applyLess` takes the night's own Float32Arrays.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LESS_WEIGHT, applyLess, applyNudge, vecsFor } from '../docs/assets/cave-nudge.mjs';
import { nudgeChips, shortTitle } from '../docs/assets/cave-stage-priorities.mjs';

/* The vectors are Float32Arrays, as the night's are, so a hand number lands
   within float32 noise (0.6 reads 0.60000002); 1e-6 is far tighter than any
   formula mistake would leave. */
const near = (actual, expected) => assert.ok(
  Math.abs(actual - expected) < 1e-6,
  `${actual} should be ${expected}`,
);

/* ── the two lists ──────────────────────────────────────────────────────── */

test('applyNudge adds a paper to one list and only that list', () => {
  const prefs = { text: 'keep me', more: [], less: [] };
  const more = applyNudge(prefs, { id: 'a', sign: 1 });
  assert.deepEqual(more.more, ['a']);
  assert.deepEqual(more.less, []);
  assert.equal(more.text, 'keep me', 'other prefs fields ride through');

  const less = applyNudge(prefs, { id: 'b', sign: -1 });
  assert.deepEqual(less.more, []);
  assert.deepEqual(less.less, ['b']);
});

test('applyNudge switching sides moves the paper, never copies it', () => {
  const fromMore = applyNudge({ more: ['a', 'b'], less: [] }, { id: 'a', sign: -1 });
  assert.deepEqual(fromMore.more, ['b']);
  assert.deepEqual(fromMore.less, ['a']);

  const fromLess = applyNudge({ more: [], less: ['a', 'b'] }, { id: 'b', sign: 1 });
  assert.deepEqual(fromLess.more, ['b']);
  assert.deepEqual(fromLess.less, ['a']);
});

test('applyNudge clears with sign 0, and the same press twice is a no-op', () => {
  const once = applyNudge({ more: ['a'], less: ['b'] }, { id: 'a', sign: 0 });
  assert.deepEqual(once.more, []);
  assert.deepEqual(once.less, ['b']);

  const twice = applyNudge({ more: ['a'], less: ['b'] }, { id: 'a', sign: 1 });
  const idempotent = applyNudge(twice, { id: 'a', sign: 1 });
  assert.deepEqual(idempotent, twice, 'pressing more twice does not duplicate');

  const clearedTwice = applyNudge(applyNudge({ more: ['a'], less: [] }, { id: 'a', sign: 0 }),
    { id: 'a', sign: 0 });
  assert.deepEqual(clearedTwice.more, []);
  assert.deepEqual(clearedTwice.less, []);
});

test('applyNudge does not mutate its argument, and survives a bare prefs', () => {
  const prefs = { more: ['a'], less: ['b'] };
  applyNudge(prefs, { id: 'a', sign: -1 });
  assert.deepEqual(prefs, { more: ['a'], less: ['b'] }, 'the argument is untouched');

  assert.deepEqual(applyNudge(null, { id: 'x', sign: 1 }).more, ['x']);
  assert.deepEqual(applyNudge({}, { id: '', sign: 1 }).more, []);
  assert.deepEqual(applyNudge({ more: 'not a list' }, { id: 'x', sign: 1 }).more, ['x']);
});

/* ── ids → tonight's vectors ────────────────────────────────────────────── */

test('vecsFor follows the ids, skips unknown ones, and keeps the order asked', () => {
  const night = {
    stones: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    vecs: [Float32Array.from([1, 0, 0]), Float32Array.from([0, 1, 0])],
  };
  const got = vecsFor(['b', 'ghost', 'a', 'c'], night);
  assert.equal(got.length, 2, 'ghost and the vectorless stone are skipped');
  assert.equal(got[0], night.vecs[1]);
  assert.equal(got[1], night.vecs[0]);

  assert.deepEqual(vecsFor(['a'], null), []);
  assert.deepEqual(vecsFor([], night), []);
  assert.deepEqual(vecsFor('a', night), []);
});

/* ── less like this ─────────────────────────────────────────────────────── */

const item = (id, vec, score) => ({ id, title: 'Paper ' + id, vec, score });

test('applyLess drops the dislike and reorders by cosine to it', () => {
  /* One dislike pointing at +x. By hand, weight 0.25:
       a [1,0,0]  is the paper itself        → dropped
       b [√½,√½,0] cos .7071 → .90 − .17678 = .72322
       c [0,1,0]   cos 0     → .80
       d [-1,0,0]  cos −1    → max 0, stays .60
     So b and c swap: c .80, b .72322, d .60. */
  const less = [Float32Array.from([1, 0, 0])];
  const ranked = [
    item('a', Float32Array.from([1, 0, 0]), 0.95),
    item('b', Float32Array.from([Math.SQRT1_2, Math.SQRT1_2, 0]), 0.9),
    item('c', Float32Array.from([0, 1, 0]), 0.8),
    item('d', Float32Array.from([-1, 0, 0]), 0.6),
  ];

  const out = applyLess(ranked, less, { weight: 0.25 });
  assert.deepEqual(out.map((row) => row.id), ['c', 'b', 'd']);
  near(out[0].score, 0.8);
  near(out[1].score, 0.9 - 0.25 * Math.SQRT1_2);
  near(out[2].score, 0.6);

  assert.equal(ranked.length, 4, 'the input list is not mutated');
  assert.equal(ranked[0].score, 0.95, 'the input scores are not mutated');
  assert.equal(LESS_WEIGHT, 0.25, 'the card weight is the module default');
});

test('applyLess takes the nearest of several dislikes, at the weight asked', () => {
  /* Dislikes +x and +y. f = [.6,.8,0] is unit and sits .6 from +x, .8 from +y,
     so .8 is the cosine that counts: .5 − .5 × .8 = .1 at weight .5. g has no
     x/y component and keeps .35; e is the +y dislike itself and leaves. */
  const less = [Float32Array.from([1, 0, 0]), Float32Array.from([0, 1, 0])];
  const ranked = [
    item('e', Float32Array.from([0, 1, 0]), 0.9),
    item('f', Float32Array.from([0.6, 0.8, 0]), 0.5),
    item('g', Float32Array.from([0, 0, 1]), 0.35),
  ];

  const out = applyLess(ranked, less, { weight: 0.5 });
  assert.deepEqual(out.map((row) => row.id), ['g', 'f']);
  near(out[0].score, 0.35);
  near(out[1].score, 0.1);
});

test('applyLess is stable on a tie and harmless with nothing to dislike', () => {
  const less = [Float32Array.from([1, 0, 0])];
  const ranked = [
    item('i', Float32Array.from([0.6, 0.8, 0]), 0.5),
    item('h', Float32Array.from([0.6, 0.8, 0]), 0.5),
  ];
  const tied = applyLess(ranked, less, { weight: 0.25 });
  assert.deepEqual(tied.map((row) => row.id), ['i', 'h'], 'equal scores keep the incoming order');
  near(tied[0].score, 0.5 - 0.25 * 0.6);

  const plain = applyLess(ranked, [], { weight: 0.25 });
  assert.deepEqual(plain.map((row) => row.id), ['i', 'h']);
  assert.equal(plain[0].score, 0.5, 'no dislikes, no change');

  /* A zero vector points nowhere: no NaN, no penalty. */
  const zero = applyLess([item('z', Float32Array.from([0, 0, 0]), 0.4)], less);
  near(zero[0].score, 0.4);
});

/* ── the chips ──────────────────────────────────────────────────────────── */

test('shortTitle clips at a word, and leaves a title that fits alone', () => {
  assert.equal(shortTitle('Tiny title'), 'Tiny title');
  assert.equal(shortTitle('  A\n long\tgap  '), 'A long gap');
  assert.equal(shortTitle(''), '');
  /* 19 chars of cut, the last space at 13 → keep "A fairly long". */
  assert.equal(shortTitle('A fairly long paper title that will not fit in a chip', 20), 'A fairly long…');
  assert.equal(shortTitle('A fairly long paper title', 12), 'A fairly…');
  assert.equal(shortTitle('Supercalifragilisticexpialidocious', 10), 'Supercali…');
});

test('nudgeChips lists more first, then less, with the id as a fallback title', () => {
  const titles = { '2608.1': 'First paper', '2608.3': 'Third paper' };
  const chips = nudgeChips(
    { more: ['2608.1', '2608.2'], less: ['2608.3'] },
    (id) => titles[id] || '',
  );
  assert.deepEqual(chips, [
    { sign: 1, id: '2608.1', label: 'more like', title: 'First paper' },
    { sign: 1, id: '2608.2', label: 'more like', title: '2608.2' },
    { sign: -1, id: '2608.3', label: 'less like', title: 'Third paper' },
  ]);

  assert.deepEqual(nudgeChips({}, () => 'anything'), []);
  assert.deepEqual(nudgeChips(null, null), []);
});
