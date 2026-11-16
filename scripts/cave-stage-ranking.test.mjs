/**
 * `cd scripts && node --test cave-stage-ranking.test.mjs`.
 *
 * Stage 5 is a list and a fetch, and neither is a thing a test should draw. What
 * it can hold is the arithmetic a reader would notice going wrong: the two
 * background-referenced meters, the one order key `orderNight` builds from them, a row's one
 * meter and its escaping, picks that follow their paper, and the two lines the
 * stage says about itself. No DOM: `rowHtml` returns strings and `mount` — the
 * part that does touch the page — is not called.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as ranking from '../docs/assets/cave-stage-ranking.mjs';
import {
  AI_MAX, PAGE, SOLO_MAX, TRACE_KEEP, absUrl, applyPicks, authorCount, gradesHtml, mergeTraces,
  meters, orderNight, pickedLine, rowHtml, sameLabel, shortAuthors, shownLine, storySummary,
} from '../docs/assets/cave-stage-ranking.mjs';

/** Only the two meters the order key reads. */
const two = (list) => list.map(({ fitPct, promisePct }) => ({ fitPct, promisePct }));

/** One ranked row, as `caveScore` hands it over (only the fields read here). */
function item(id, fit, score, extra = {}) {
  return { id, title: 'Paper ' + id, fit, score, ...extra };
}

/* ── the meter ──────────────────────────────────────────────────────────── */

test('meters: both read against the background corpus, not tonight', () => {
  /* Promise is score × 100. Fit is the corpus z-score through the normal CDF:
     z -1 → 16, 0 → 50, 1 → 84, 2 → 98. */
  const ranked = [
    item('a', -1, 0.9),
    item('b', 0, 0.5),
    item('c', 1, 0.25),
    item('d', 2, 1),
  ];
  assert.deepEqual(two(meters(ranked)), [
    { fitPct: 16, promisePct: 90 },
    { fitPct: 50, promisePct: 50 },
    { fitPct: 84, promisePct: 25 },
    { fitPct: 98, promisePct: 100 },
  ]);
});

test('meters: a weak night reads weak — its best paper is not 100', () => {
  const weak = meters([item('x', -0.5, 0.3), item('y', -1, 0.2)]);
  assert.ok(weak.every((m) => m.promisePct < 50 && m.fitPct < 50), JSON.stringify(weak));
  assert.deepEqual(two(meters([item('odd', NaN, -0.2)])), [{ fitPct: 50, promisePct: 0 }], 'junk is not NaN');
  assert.deepEqual(meters([]), []);
  assert.deepEqual(meters(null), []);
});

test('meters: Surprise is novelty against the corpus spread; the lean only when known', () => {
  const ref = { novelty: { mean: 0.15, sd: 0.05 } };
  const [mid, far, bare] = meters([
    item('m', 0, 0.5, { novelty: 0.15, theory: 0.8 }),
    item('f', 0, 0.5, { novelty: 0.25, theory: 0.1 }),
    item('b', 0, 0.5),
  ], ref);
  assert.equal(mid.surprisePct, 50);
  assert.equal(far.surprisePct, 98);              // two sd out
  assert.equal(mid.theoryPct, 80);
  assert.equal(far.theoryPct, 10);
  assert.equal(bare.theoryPct, null);
});

/* ── the order ──────────────────────────────────────────────────────────── */

/* Three rows whose promise and fit disagree, so a weight has something to do.
   Promise: a 90, b 50, c 10. Fit (z 1 / 2 / 0): a 84, b 98, c 50. */
const NIGHT = [
  item('a', 1, 0.9),
  item('b', 2, 0.5),
  item('c', 0, 0.1),
];

const idsOf = (list) => list.map((row) => row.id);

test('orderNight at match 0 is pure promise', () => {
  const out = orderNight(NIGHT, 0);
  assert.deepEqual(idsOf(out), ['a', 'b', 'c']);
  assert.deepEqual(out.map((row) => row.rel), [90, 50, 10]);
});

test('orderNight at match 100 is pure fit', () => {
  const out = orderNight(NIGHT, 100);
  assert.deepEqual(idsOf(out), ['b', 'a', 'c']);
  assert.deepEqual(out.map((row) => row.rel), [98, 84, 50]);
});

test('orderNight at match 50 blends the two', () => {
  /* a: (90 + 84) / 2 = 87; b: (50 + 98) / 2 = 74; c: (10 + 50) / 2 = 30. */
  const out = orderNight(NIGHT, 50);
  assert.deepEqual(idsOf(out), ['a', 'b', 'c']);
  assert.deepEqual(out.map((row) => row.rel), [87, 74, 30]);
});

test('orderNight breaks a tie on the id, ascending', () => {
  const tied = [item('b', 1, 1), item('a', 1, 1), item('c', 0, 0)];
  assert.deepEqual(idsOf(orderNight(tied, 50)), ['a', 'b', 'c']);
  assert.deepEqual(orderNight(tied, 50).map((row) => row.rel), [92, 92, 25]);
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

test('rowHtml carries ONE meter: the Score, with its parts as grades', () => {
  const html = rowHtml(ROW_ITEM, ROW_PARTS);
  assert.equal(html.match(/role="meter"/g).length, 1, 'one meter, not two');
  assert.ok(!html.includes('>Fit<'), 'the fit meter is gone');
  assert.ok(html.includes('>Score<'));
  assert.ok(html.includes('(12 papers tonight)'));
  assert.ok(html.includes('role="meter" aria-label="Score" aria-valuemin="0"'
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
  assert.ok(open.includes('> Pick</label>'));

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
  assert.ok(html.includes('(0 papers tonight)'));
  assert.ok(!html.includes('Looks like'));
});

test('the title links to the paper on arXiv', () => {
  const html = rowHtml({ id: '2401.00001v2', title: 'T' }, { rank: 1 });
  assert.ok(html.includes('<a class="rk-title-link" href="https://arxiv.org/abs/2401.00001"'));
  assert.ok(html.includes('target="_blank" rel="noopener"'));
  assert.equal(absUrl('2401.00001'), 'https://arxiv.org/abs/2401.00001');
});

test('gradesHtml: the parts, the lean named by side, AI only once traced, 1 author', () => {
  const graded = {
    id: 'a',
    authors: ['Solo Person'],
    grades: { promisePct: 70, fitPct: 40, surprisePct: 55, theoryPct: 20 },
  };
  const html = gradesHtml(graded, { p: 72, why: 'stock <phrases>' });
  for (const bit of ['>Promise<', '>70<', '>Match<', '>40<', '>Surprise<', '>55<', '>Exp.<', '>80<', '>AI<', '>72%<', '1 author']) {
    assert.ok(html.includes(bit), bit);
  }
  assert.ok(html.includes('stock &lt;phrases&gt;'), 'the reason is escaped');
  assert.ok(html.includes('is-warn'));
  const plain = gradesHtml({ ...graded, authors: ['A', 'B'] }, null);
  assert.ok(!plain.includes('>AI<') && !plain.includes('1 author'));
  assert.equal(authorCount({ authors: [] }), 0, 'no list is not solo');
});

test('orderNight: the penalties sink a solo paper and a traced one, scaled by their sliders', () => {
  const night = [
    item('solo', 0, 0.8, { authors: ['One'] }),
    item('team', 0, 0.7, { authors: ['A', 'B'] }),
    item('bot', 0, 0.75, { authors: ['A', 'B'] }),
  ];
  const base = orderNight(night, { match: 0 });
  assert.deepEqual(base.map((r) => r.id), ['solo', 'bot', 'team']);
  assert.ok(base[0].grades, 'each row carries its grades');

  const sunk = orderNight(night, { match: 0, solo: 100, ai: 100, traces: { bot: { p: 50 } } });
  const rel = Object.fromEntries(sunk.map((r) => [r.id, r.rel]));
  assert.equal(rel.solo, 80 - SOLO_MAX);
  assert.equal(rel.bot, 75 - AI_MAX / 2);
  assert.equal(rel.team, 70);
  assert.equal(sunk[0].id, 'team');

  /* A bare number is still the match weight. */
  assert.deepEqual(orderNight(night, 0).map((r) => r.rel), base.map((r) => r.rel));
});

test('mergeTraces keeps the newest TRACE_KEEP, a re-ask moves to the end', () => {
  const merged = mergeTraces({ a: { p: 1 }, b: { p: 2 } }, { a: { p: 9 }, c: { p: 3 } }, 2);
  assert.deepEqual(Object.keys(merged), ['a', 'c']);
  assert.equal(merged.a.p, 9);
  assert.ok(TRACE_KEEP >= 100);
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




test('sameLabel: a wagon that repeats the topic is the same label', () => {
  assert.equal(sameLabel('Fault-tolerant computing & roadmaps', 'Fault-tolerant computing and roadmaps'), true);
  assert.equal(sameLabel('FT computing roadmaps', 'Fault-tolerant computing & roadmaps'), true);
  assert.equal(sameLabel('Cavity QED', 'Cavity QED and circuit QED'), true);
  assert.equal(sameLabel('Quantum sensing', 'Quantum materials'), false);
  assert.equal(sameLabel('Magic state distillation', 'Fault-tolerant computing & roadmaps'), false);
  assert.equal(sameLabel('', 'x'), false);
});

test('rowHtml: the wagon chip is dropped when it only repeats the topic', () => {
  const twice = rowHtml({ id: '1', title: 't' },
    { topic: 'Fault-tolerant computing & roadmaps', wagon: 'FT computing and roadmaps' });
  assert.ok(twice.includes('rk-chip-topic'));
  assert.ok(!twice.includes('rk-chip-wagon'));
  const both = rowHtml({ id: '1', title: 't' }, { topic: 'Quantum sensing', wagon: 'NV magnetometry' });
  assert.ok(both.includes('rk-chip-wagon'));
});

test('pickedLine counts the picks the foot acts on, and is empty at none', () => {
  assert.equal(pickedLine(0), '');
  assert.equal(pickedLine(3), '3 picked');
});
