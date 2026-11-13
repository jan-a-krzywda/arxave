/**
 * `cd scripts && node --test cave-stage-ranking.test.mjs`.
 *
 * Stage 5 is a list and a fetch, and neither is a thing a test should draw. What
 * it can hold is the arithmetic a reader would notice going wrong: the two
 * percentiles, the one order key `orderNight` builds from them, a row's one
 * meter and its escaping, picks that follow their paper, and the two lines the
 * stage says about itself. No DOM: `rowHtml` returns strings and `mount` — the
 * part that does touch the page — is not called.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as ranking from '../docs/assets/cave-stage-ranking.mjs';
import {
  PAGE, applyPicks, meters, orderNight, rowHtml, shortAuthors, shownLine, storySummary,
} from '../docs/assets/cave-stage-ranking.mjs';

/** One ranked row, as `caveScore` hands it over (only the fields read here). */
function item(id, fit, score, extra = {}) {
  return { id, title: 'Paper ' + id, fit, score, ...extra };
}

/* ── the meter ──────────────────────────────────────────────────────────── */

test('meters: both are percentiles over tonight — the share at or below', () => {
  /* Fits -1, 0, 0, 2 over four rows. By hand: -1 is at or below one of four
     (25%); each 0 is at or below three (75%); 2 is at or below all four (100%).
     Scores 0.9 / 0.5 / 0.25 / 1 → 75 / 50 / 25 / 100. */
  const ranked = [
    item('a', -1, 0.9),
    item('b', 0, 0.5),
    item('c', 0, 0.25),
    item('d', 2, 1),
  ];
  assert.deepEqual(meters(ranked), [
    { fitPct: 25, promisePct: 75 },
    { fitPct: 75, promisePct: 50 },
    { fitPct: 75, promisePct: 25 },
    { fitPct: 100, promisePct: 100 },
  ]);
});

test('meters: one row tops both bars, and junk reads zero, not NaN', () => {
  assert.deepEqual(meters([item('only', 3, 0.4)]), [{ fitPct: 100, promisePct: 100 }]);
  assert.deepEqual(meters([item('odd', NaN, -0.2)]), [{ fitPct: 100, promisePct: 100 }]);
  assert.deepEqual(meters([]), []);
  assert.deepEqual(meters(null), []);
});

/* ── the order ──────────────────────────────────────────────────────────── */

/* Three rows whose promise and fit disagree, so a weight has something to do.
   Promise percentiles: a 100, b 67, c 33. Fit percentiles: b 100, c 67, a 33. */
const NIGHT = [
  item('a', 0.1, 0.9),
  item('b', 0.9, 0.5),
  item('c', 0.5, 0.1),
];

const idsOf = (list) => list.map((row) => row.id);

test('orderNight at match 0 is pure promise', () => {
  const out = orderNight(NIGHT, 0);
  assert.deepEqual(idsOf(out), ['a', 'b', 'c']);
  assert.deepEqual(out.map((row) => row.rel), [100, 67, 33]);
});

test('orderNight at match 100 is pure fit', () => {
  const out = orderNight(NIGHT, 100);
  assert.deepEqual(idsOf(out), ['b', 'c', 'a']);
  assert.deepEqual(out.map((row) => row.rel), [100, 67, 33]);
});

test('orderNight at match 50 blends the two percentiles', () => {
  /* a: 0.5·100 + 0.5·33 = 67 (66.5 rounds up); b: 0.5·67 + 0.5·100 = 84;
     c: 0.5·33 + 0.5·67 = 50. */
  const out = orderNight(NIGHT, 50);
  assert.deepEqual(idsOf(out), ['b', 'a', 'c']);
  assert.deepEqual(out.map((row) => row.rel), [84, 67, 50]);
});

test('orderNight breaks a tie on the id, ascending', () => {
  const tied = [item('b', 1, 1), item('a', 1, 1), item('c', 0, 0)];
  assert.deepEqual(idsOf(orderNight(tied, 50)), ['a', 'b', 'c']);
  assert.deepEqual(orderNight(tied, 50).map((row) => row.rel), [100, 100, 33]);
});

test('orderNight leaves the input alone and every rel is an integer 0..100', () => {
  const out = orderNight(NIGHT, 40);
  assert.deepEqual(idsOf(NIGHT), ['a', 'b', 'c'], 'input order untouched');
  assert.equal(NIGHT[0].rel, undefined, 'no rel written back to the caller\'s list');
  for (const row of out) {
    assert.equal(Number.isInteger(row.rel), true, 'rel is an integer: ' + row.rel);
    assert.ok(row.rel >= 0 && row.rel <= 100, 'rel stays on the bar: ' + row.rel);
  }
  assert.deepEqual(orderNight(null, 0), []);
});

test('a match outside 0..100 is clamped, not extrapolated', () => {
  assert.deepEqual(idsOf(orderNight(NIGHT, 500)), idsOf(orderNight(NIGHT, 100)));
  assert.deepEqual(idsOf(orderNight(NIGHT, -20)), idsOf(orderNight(NIGHT, 0)));
  assert.deepEqual(orderNight(NIGHT), orderNight(NIGHT, 50), 'the slider default is 50');
});

/* ── the row ────────────────────────────────────────────────────────────── */

const ROW_ITEM = {
  id: '2608.00001',
  title: 'A <script> & "quoted" title',
  rel: 87,
  picked: true,
  authors: ['Ada Lovelace', 'Alan Turing', 'Grace Hopper', 'Edsger Dijkstra'],
  abstract: 'We <show> & tell.',
  landmarks: [{ title: 'Proven <thing>', pct: 0.96 }],
};

const ROW_PARTS = {
  rank: 3,
  total: 12,
  topic: 'Quantum <ml>',
  wagon: 'Wagon 2',
  open: true,
  repo: 'jan-a-krzywda/arxave',
  thread: { url: 'https://github.com/o/r/discussions/4' },
};

test('rowHtml escapes every arXiv string', () => {
  const html = rowHtml(ROW_ITEM, ROW_PARTS);
  assert.ok(html.includes('A &lt;script&gt; &amp; &quot;quoted&quot; title'), 'title is escaped');
  assert.ok(!html.includes('<script>'), 'no raw markup from the title');
  assert.ok(html.includes('Quantum &lt;ml&gt;'), 'the topic chip is escaped');
  assert.ok(html.includes('We &lt;show&gt; &amp; tell.'), 'the abstract is escaped');
  assert.ok(html.includes('Proven &lt;thing&gt;'), 'the landmark is escaped');
});

test('rowHtml carries ONE meter: Promise, titled against tonight\'s size', () => {
  const html = rowHtml(ROW_ITEM, ROW_PARTS);
  assert.equal(html.match(/role="meter"/g).length, 1, 'one meter, not two');
  assert.ok(!html.includes('>Fit<'), 'the fit meter is gone');
  assert.ok(html.includes('>Promise<'));
  assert.ok(html.includes('title="relative to tonight&#39;s 12 papers"'));
  assert.ok(html.includes('role="meter" aria-label="Promise" aria-valuemin="0"'
    + ' aria-valuemax="100" aria-valuenow="87"'));
  assert.ok(html.includes('width:87%'));
  assert.ok(html.includes('>87<'), 'the number is beside the bar');
});

test('rowHtml opens in place: the abstract, its landmarks, the action bar', () => {
  const open = rowHtml(ROW_ITEM, ROW_PARTS);
  assert.ok(open.includes('class="rk-row is-open'), 'the open row says so');
  assert.ok(open.includes('aria-expanded="true"'));
  assert.ok(open.includes('We &lt;show&gt; &amp; tell.'), 'detail is drawn when open');
  assert.ok(open.includes('Looks like'));
  assert.ok(open.includes('https://github.com/o/r/discussions/4'), 'the thread link is there');
  assert.ok(open.includes('data-act="summarize"'));
  assert.ok(open.includes('Story'));

  const closed = rowHtml(ROW_ITEM, { ...ROW_PARTS, open: false });
  assert.ok(closed.includes('<div class="rk-detail" hidden>'));
  assert.ok(!closed.includes('We &lt;show&gt; &amp; tell.'), 'nothing is drawn closed');
});

test('rowHtml marks a ticked row, and tolerates a bare item', () => {
  assert.ok(rowHtml(ROW_ITEM, ROW_PARTS).includes('rk-row is-open is-picked'));
  assert.ok(!rowHtml({ id: 'x', title: 'Bare' }, { rank: 1 }).includes('is-picked'));

  const html = rowHtml({ id: 'x', title: 'Bare' }, { rank: 1 });
  assert.ok(html.includes('Bare'));
  assert.ok(html.includes('aria-valuenow="0"'), 'a missing rel reads zero, not NaN');
  assert.ok(html.includes("relative to tonight&#39;s 0 papers"));
  assert.ok(!html.includes('Looks like'));
});

test('shortAuthors keeps three names, then says et al.', () => {
  assert.equal(shortAuthors(['A One', 'B Two']), 'A One, B Two');
  assert.equal(shortAuthors(['A One', 'B Two', 'C Three', 'D Four']), 'A One, B Two, C Three et al.');
  assert.equal(shortAuthors([]), '');
  assert.equal(shortAuthors(undefined), '');
});

/* ── picks ──────────────────────────────────────────────────────────────── */

test('applyPicks keeps every pick on its paper across a re-rank', () => {
  const picks = new Set(['a', 'c']);
  const first = applyPicks([item('a', 1, 0.9), item('b', 0, 0.5), item('c', -1, 0.2)], picks);
  assert.deepEqual(first.map((row) => [row.id, row.picked]), [
    ['a', true], ['b', false], ['c', true],
  ]);

  const reranked = applyPicks([item('c', 2, 1), item('a', 0.5, 0.4), item('b', 0, 0.1)], picks);
  assert.deepEqual(reranked.map((row) => [row.id, row.picked]), [
    ['c', true], ['a', true], ['b', false],
  ]);
});

test('applyPicks does not reorder, drop or mutate the list it is given', () => {
  const ranked = [item('b', 0, 0.5), item('a', 1, 0.9)];
  const out = applyPicks(ranked, new Set(['a']));
  assert.deepEqual(out.map((row) => row.id), ['b', 'a']);
  assert.deepEqual(ranked.map((row) => row.id), ['b', 'a'], 'input order untouched');
  assert.equal(ranked[0].picked, undefined, 'input items untouched');
  assert.deepEqual(applyPicks(ranked, null).map((row) => row.picked), [false, false]);
});

/* ── the stage's own lines ──────────────────────────────────────────────── */

test('shownLine says where the reader is in tonight', () => {
  assert.equal(shownLine(5, 12), '5 of 12 tonight');
  assert.equal(shownLine(5, 3), '3 of 3 tonight', 'never more shown than there are');
  assert.equal(shownLine(0, 0), '0 of 0 tonight');
  assert.equal(shownLine('5', '9'), '5 of 9 tonight');
});

test('storySummary is "<k> for the story"', () => {
  assert.equal(storySummary(3), '3 for the story');
  assert.equal(storySummary(0), '0 for the story');
  assert.equal(storySummary('2'), '2 for the story');
});

/* ── the gate is gone ───────────────────────────────────────────────────── */

test('PAGE is 5 — the first paint, and what Show 5 more adds', () => {
  assert.equal(PAGE, 5);
});

test('no exported string says "Nothing passes", and NO_GATE is gone', () => {
  assert.equal(ranking.NO_GATE, undefined, 'the gate message is deleted, not renamed');
  for (const [name, value] of Object.entries(ranking)) {
    if (typeof value !== 'string') continue;
    assert.ok(!/Nothing passes/i.test(value), name + ' still carries the gate sentence');
    assert.ok(!/Closest anyway/i.test(value), name + ' still carries the fallback heading');
  }
  assert.equal(ranking.closestAnyway, undefined, 'the nearest-five fallback is deleted');
});



