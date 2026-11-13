/**
 * `cd scripts && node --test cave-stages-dig-map.test.mjs`.
 *
 * Stages 1–3 are mostly network and DOM, which is exactly the part a test
 * cannot hold. What is left is the arithmetic the page cannot get wrong
 * silently: the fold summary, the topic bar's counts, a wagon's fallback label,
 * the rail's three states, and the mean tonight's vectors are centred against
 * when there is no corpus. Each of those is a small pure function, so each is
 * checked here against a hand-built night — four papers, three leaves, two
 * parents — rather than against a live arXiv.
 *
 * The fixture tree is the contract's shape in miniature: two parents, three
 * leaves, one undefined topic (-1) so "no topic" cannot pass as "topic 0".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_CATEGORIES, ARXIV_CATEGORIES, digSummary, meanVector,
} from '../docs/assets/cave-stage-dig.mjs';
import { fallbackWagonName, topicBar } from '../docs/assets/cave-stage-map.mjs';
import { STAGE_NAMES, stageRailHtml } from '../docs/assets/cave.js';
import { STAGES } from '../docs/assets/cave-flow.mjs';

const TOPICS = {
  parents: [
    { id: 'computing', label: 'Computing' },
    { id: 'matter', label: 'Matter' },
  ],
  leaves: [
    { id: 'opt-qalgo', parent: 'computing', label: 'Optimisation & quantum algorithms' },
    { id: 'qml', parent: 'computing', label: 'Quantum machine learning' },
    { id: 'many-body', parent: 'matter', label: 'Many-body physics' },
  ],
};

function nightWith(topic) {
  return {
    stones: topic.map((_, i) => ({ id: '2608.0000' + i, title: 'Paper ' + i })),
    topic: Int32Array.from(topic),
  };
}

/* ── dig ────────────────────────────────────────────────────────────────── */

test('digSummary writes the archives and the window, singular or plural', () => {
  assert.equal(digSummary('cond-mat.mes-hall, quant-ph', 1),
    'cond-mat.mes-hall, quant-ph · last 1 day');
  assert.equal(digSummary(['quant-ph', 'cs.LG'], 3), 'quant-ph, cs.LG · last 3 days');
  /* A junk value is one day, not "NaN days": the field is a number input but
     its value is a string the reader can blank. */
  assert.equal(digSummary('quant-ph', ''), 'quant-ph · last 1 day');
  assert.equal(digSummary('quant-ph', '0'), 'quant-ph · last 1 day');
});

test('the picker carries Dig\'s default categories and its popular list', () => {
  const flat = ARXIV_CATEGORIES.flatMap(([, rows]) => rows.map(([code]) => code));
  for (const code of DEFAULT_CATEGORIES.split(',').map((c) => c.trim())) {
    assert.ok(flat.includes(code), `the picker has no ${code}`);
  }
  assert.equal(DEFAULT_CATEGORIES, 'cond-mat.mes-hall, quant-ph');
  assert.ok(ARXIV_CATEGORIES.length > 3, 'the grouped picker is the whole list, not a stub');
});

test('meanVector averages each dimension, and survives an empty night', () => {
  const mean = meanVector([
    Float32Array.from([1, 0, -1]),
    Float32Array.from([0, 2, 1]),
  ]);
  assert.deepEqual([...mean], [0.5, 1, 0]);
  assert.equal(meanVector([]).length, 0);
});

/* ── the topic bar ──────────────────────────────────────────────────────── */

test('topicBar counts each paper once, per its primary topic\'s parent', () => {
  const night = nightWith([0, 1, 0, 2]);      // three computing, one matter
  const bar = topicBar(night, TOPICS);

  assert.deepEqual(bar.map((row) => [row.parent, row.count]), [
    ['computing', 3],
    ['matter', 1],
  ]);
  assert.deepEqual(bar[0].leaves.map((leaf) => [leaf.id, leaf.count]), [
    ['opt-qalgo', 2],
    ['qml', 1],
  ]);
  assert.deepEqual(bar[1].leaves.map((leaf) => [leaf.id, leaf.count]), [['many-body', 1]]);
});

test('topicBar leaves out empty leaves and keeps a zero-count parent last', () => {
  const night = nightWith([2, 2, -1]);        // matter only; -1 belongs nowhere
  const bar = topicBar(night, TOPICS);

  assert.deepEqual(bar.map((row) => row.count), [2, 0]);
  assert.deepEqual(bar[0].leaves.map((leaf) => leaf.id), ['many-body']);
  assert.deepEqual(bar[1].leaves, [], 'a parent with no papers lists none of its leaves');
});

test('topicBar is empty without a night, a topics tree or any topics at all', () => {
  assert.deepEqual(topicBar(null, TOPICS), []);
  assert.deepEqual(topicBar(nightWith([0]), null), []);
  assert.deepEqual(topicBar(nightWith([0]), { parents: TOPICS.parents, leaves: [] }), []);
});


/* ── the fallback wagon name ────────────────────────────────────────────── */

test('an unnamed wagon is labelled with its most common leaf', () => {
  const night = nightWith([0, 0, 1, 2]);
  assert.equal(fallbackWagonName([0, 1, 3], night, TOPICS),
    'Optimisation & quantum algorithms');
  assert.equal(fallbackWagonName([2], night, TOPICS), 'Quantum machine learning');
});

test('a tie keeps the first label reached, and no topic means no label', () => {
  const night = nightWith([1, 0]);            // one of each, equal counts
  assert.equal(fallbackWagonName([0, 1], night, TOPICS), 'Quantum machine learning');

  assert.equal(fallbackWagonName([0, 1], nightWith([-1, -1]), TOPICS), '');
  assert.equal(fallbackWagonName([], night, TOPICS), '');
  assert.equal(fallbackWagonName([0], null, TOPICS), '');
  assert.equal(fallbackWagonName([0], night, null), '');
});

/* ── the rail ───────────────────────────────────────────────────────────── */

const STATES = (html) => [...html.matchAll(/class="cave-rail-step is-(\w+)"/g)].map((m) => m[1]);

test('stageRailHtml has one step per stage, in order, with the three states', () => {
  const html = stageRailHtml({ done: { dig: 'quant-ph · last 1 day' } }, STAGES);

  assert.deepEqual(STATES(html), ['done', 'open', ...STAGES.slice(2).map(() => 'locked')]);
  /* The words come from the head's own table, so the rail and the cards can
     never drift apart. */
  for (const name of Object.values(STAGE_NAMES)) {
    assert.ok(html.includes('>' + name + '<'), `the rail is missing ${name}`);
  }
  /* The stage order is the page's order, top to bottom. */
  const hrefs = [...html.matchAll(/href="#stage-(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(hrefs, STAGES);
});

test('a done step carries its summary; the open one is aria-current', () => {
  const html = stageRailHtml({ done: { dig: 'quant-ph · last 1 day', train: '312 papers' } }, STAGES);

  assert.match(html, /class="cave-rail-summary">quant-ph · last 1 day</);
  assert.match(html, /class="cave-rail-summary">312 papers</);
  assert.equal((html.match(/aria-current="step"/g) || []).length, 1);
  assert.match(html, /is-open">/);
  assert.match(html, /is-locked/);

  /* A whole night has no open step left, and nothing claims to be current. */
  const allDone = Object.fromEntries(STAGES.map((id) => [id, 'done']));
  assert.equal((stageRailHtml({ done: allDone }, STAGES).match(/is-open/g) || []).length, 0);
  assert.equal((stageRailHtml({ done: allDone }, STAGES).match(/aria-current/g) || []).length, 0);
});

test('the rail escapes what a summary carries and copes with a bare snapshot', () => {
  const html = stageRailHtml({ done: { dig: '<b>&"quotes"</b>' } }, STAGES);
  assert.ok(!html.includes('<b>'), 'a raw tag got through the summary');
  assert.ok(html.includes('&lt;b&gt;&amp;&quot;quotes&quot;&lt;/b&gt;'));

  assert.deepEqual(STATES(stageRailHtml(null, STAGES)),
    ['open', ...STAGES.slice(1).map(() => 'locked')]);
  assert.deepEqual(STATES(stageRailHtml({}, STAGES)), STATES(stageRailHtml(null, STAGES)));
});
