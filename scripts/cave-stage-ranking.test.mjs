/**
 * `cd scripts && node --test cave-stage-ranking.test.mjs`.
 *
 * Stage 6 is a list and a fetch, and neither is a thing a test should draw. What
 * it can hold is the arithmetic a reader would notice going wrong: the two
 * meters (checked here against a four-row fixture worked out by hand), a row's
 * escaping and its both-meter contract, picks that follow their paper through a
 * re-rank, and the bar's one line. No DOM: `rowHtml` returns strings and
 * `mount` — the part that does touch the page — is not called.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PAGE, applyPicks, meters, rankingSummary, rowHtml, shortAuthors,
} from '../docs/assets/cave-stage-ranking.mjs';

/** One ranked row, as `caveScore` hands it over (only the fields read here). */
function item(id, fit, score, extra = {}) {
  return { id, title: 'Paper ' + id, fit, score, ...extra };
}

/* ── the meters ─────────────────────────────────────────────────────────── */

test('meters: Fit is the fit percentile, Promise is the score as a percent', () => {
  /* Fits -1, 0, 0, 2 over four rows. By hand: -1 is at or below one of four
     (25%); each 0 is at or below three (75%); 2 is at or below all four (100%).
     Scores 0.9 / 0.5 / 0.25 / 1 → 90 / 50 / 25 / 100. */
  const ranked = [
    item('a', -1, 0.9),
    item('b', 0, 0.5),
    item('c', 0, 0.25),
    item('d', 2, 1),
  ];
  assert.deepEqual(meters(ranked), [
    { fitPct: 25, promisePct: 90 },
    { fitPct: 75, promisePct: 50 },
    { fitPct: 75, promisePct: 25 },
    { fitPct: 100, promisePct: 100 },
  ]);
});

test('meters: one row tops both bars, and a score outside 0..1 is clamped', () => {
  assert.deepEqual(meters([item('only', 3, 1.4)]), [{ fitPct: 100, promisePct: 100 }]);
  assert.deepEqual(meters([item('odd', 0, -0.2)]), [{ fitPct: 100, promisePct: 0 }]);
  assert.deepEqual(meters([]), []);
  assert.deepEqual(meters(null), []);
});

/* ── the row ────────────────────────────────────────────────────────────── */

const ROW_ITEM = {
  id: '2608.00001',
  title: 'A <script> & "quoted" title',
  fit: 1,
  score: 0.5,
  link: 'https://arxiv.org/abs/2608.00001',
  authors: ['Ada Lovelace', 'Alan Turing', 'Grace Hopper', 'Edsger Dijkstra'],
  abstract: 'We <show> & tell.',
  landmarks: [{ title: 'Proven <thing>', pct: 0.96 }],
};

const ROW_PARTS = {
  rank: 3,
  meters: { fitPct: 75, promisePct: 50 },
  topic: 'Quantum <ml>',
  wagon: 'Wagon 2',
  picked: true,
  open: true,
};

test('rowHtml escapes every arXiv string and links the title to arXiv', () => {
  const html = rowHtml(ROW_ITEM, ROW_PARTS);
  assert.ok(html.includes('A &lt;script&gt; &amp; &quot;quoted&quot; title'), 'title is escaped');
  assert.ok(!html.includes('<script>'), 'no raw markup from the title');
  assert.ok(html.includes('href="https://arxiv.org/abs/2608.00001"'));
  assert.ok(html.includes('Quantum &lt;ml&gt;'), 'the topic chip is escaped');
  assert.ok(html.includes('We &lt;show&gt; &amp; tell.'), 'the abstract is escaped');
  assert.ok(html.includes('Proven &lt;thing&gt;'), 'the landmark is escaped');
  assert.equal(html.match(/data-id="2608\.00001"/g).length, 2, 'row and pick box carry the id');
});

test('rowHtml carries both meters, each with a named aria-valuenow', () => {
  const html = rowHtml(ROW_ITEM, ROW_PARTS);
  assert.ok(html.includes('>Fit<'), 'the Fit label');
  assert.ok(html.includes('>Promise<'), 'the Promise label');
  assert.ok(html.includes('role="meter" aria-label="Fit" aria-valuemin="0" aria-valuemax="100"'
    + ' aria-valuenow="75"'), 'the Fit meter, at 75%');
  assert.ok(html.includes('role="meter" aria-label="Promise" aria-valuemin="0" aria-valuemax="100"'
    + ' aria-valuenow="50"'), 'the Promise meter, at 50%');
  assert.ok(html.includes('width:75%') && html.includes('width:50%'), 'bars draw the values');
});

test('rowHtml opens in place: the abstract and landmarks only when open', () => {
  const open = rowHtml(ROW_ITEM, ROW_PARTS);
  assert.ok(open.includes('class="rk-detail"'));
  assert.ok(open.includes('Looks like'));
  assert.ok(open.includes('(96th pct)'), 'the landmark keeps its citation percentile');
  assert.ok(open.includes('Refine with AI'));
  assert.ok(open.includes('aria-expanded="true"'));

  const closed = rowHtml(ROW_ITEM, { ...ROW_PARTS, open: false });
  assert.ok(!closed.includes('We &lt;show&gt;'), 'a closed row holds no abstract');
  assert.ok(closed.includes('class="rk-detail" hidden'));
  assert.ok(closed.includes('aria-expanded="false"'));
});

test('rowHtml shows the pick state, the rank and the short author line', () => {
  const html = rowHtml(ROW_ITEM, ROW_PARTS);
  assert.ok(html.includes('checked'), 'a picked paper comes back ticked');
  assert.ok(html.includes('>3</span>'), 'the rank number');
  assert.ok(html.includes('Ada Lovelace, Alan Turing, Grace Hopper et al.'));
  assert.ok(html.includes('rk-chip-wagon'), 'the wagon chip');
});

test('rowHtml survives a bare item: no link, no authors, no landmarks', () => {
  const html = rowHtml({ id: 'x', title: 'Bare' }, { rank: 1 });
  assert.ok(html.includes('Bare'));
  assert.ok(!html.includes('rk-link'));
  assert.ok(html.includes('aria-valuenow="0"'), 'missing meters read zero, not NaN');
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
  assert.deepEqual(first.map((r) => [r.id, r.picked]), [
    ['a', true], ['b', false], ['c', true],
  ]);

  /* The same papers, rescored and reordered — the ticks follow the ids. */
  const reranked = applyPicks([item('c', 2, 1), item('a', 0.5, 0.4), item('b', 0, 0.1)], picks);
  assert.deepEqual(reranked.map((r) => [r.id, r.picked]), [
    ['c', true], ['a', true], ['b', false],
  ]);
});

test('applyPicks does not reorder, drop or mutate the list it is given', () => {
  const ranked = [item('b', 0, 0.5), item('a', 1, 0.9)];
  const out = applyPicks(ranked, new Set(['a']));
  assert.deepEqual(out.map((r) => r.id), ['b', 'a']);
  assert.deepEqual(ranked.map((r) => r.id), ['b', 'a'], 'input order untouched');
  assert.equal(ranked[0].picked, undefined, 'input items untouched');
  assert.deepEqual(applyPicks(ranked, null).map((r) => r.picked), [false, false]);
});

/* ── the bar ────────────────────────────────────────────────────────────── */

test('rankingSummary is the one line above the list', () => {
  assert.equal(rankingSummary(12, 3), '12 ranked · 3 picked');
  assert.equal(rankingSummary(0, 0), '0 ranked · 0 picked');
  assert.equal(rankingSummary('7', '2'), '7 ranked · 2 picked');
  assert.equal(rankingSummary(1, 0), '1 ranked · 0 picked');
});

test('PAGE is 25, the first paint and what Show more adds', () => {
  assert.equal(PAGE, 25);
});

