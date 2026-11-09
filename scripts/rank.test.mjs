/**
 * `node --test scripts/rank.test.mjs`.
 *
 * Two kinds of check, both hand-computed from the contract in INTERFACES.md and
 * from spec §8.2 rather than from this code's own output:
 *
 *   - the pure functions, on orthonormal 3-vectors whose cosines are exactly 1,
 *     0 or -1, so every expected number is arithmetic anyone can check by eye;
 *   - one end-to-end `runRank` on four papers with a stub embedder, a stub
 *     grader and an in-memory filesystem, which runs fetch → embed → centre →
 *     score → shortlist → read → grade → enrich → write with no socket, no
 *     clock and no disk.
 *
 * The three paths the contract calls out are each pinned: the happy path with a
 * background and a grader, the no-grader path (ship the shortlist, relevance
 * null, no crash) and the no-background path (z_ref collapses onto z_day, and it
 * says so).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  addDayZ, bandOfRelevance, orderShipped, pickShip, redundancy, runRank,
  scoreAxes, storeCandidates,
} from './rank.mjs';

const e1 = [1, 0, 0];
const e2 = [0, 1, 0];
const e3 = [0, 0, 1];
const diag = [Math.SQRT1_2, Math.SQRT1_2, 0];   // 45° between e1 and e2

/* ── scoreAxes ──────────────────────────────────────────────────────────── */

const AXIS_ROWS = {
  A: [
    { kind: 'touchstone', vector: e1, weight: 1, label: 'a-touch' },
    { kind: 'core', vector: e1, weight: 1, label: 'Xue 2022' },
  ],
  B: [
    { kind: 'touchstone', vector: e2, weight: 1, label: 'b-touch' },
    { kind: 'core', vector: e2, weight: 1, label: 'Knill 2008' },
  ],
};

test('mean_sim blends every row; max_sim and nearest name the closest seed', () => {
  // A: (cos 1 + cos 1) / 2 = 1, and the seed it is closest to is Xue 2022.
  assert.deepEqual(scoreAxes(e1, AXIS_ROWS), {
    A: { mean_sim: 1, max_sim: 1, nearest: 'Xue 2022' },
    B: { mean_sim: 0, max_sim: 0, nearest: 'Knill 2008' },
  });
  // Halfway between the axes: both of an axis' rows are the same vector here,
  // so the blend and the seed maximum are both that single cosine, 0.707.
  const half = scoreAxes(diag, AXIS_ROWS);
  assert.equal(half.A.mean_sim, Math.SQRT1_2);
  assert.equal(half.A.max_sim, Math.SQRT1_2);
  assert.equal(half.B.nearest, 'Knill 2008');
});

test('a touchstone is a phrase, not a paper: it never becomes the nearest seed', () => {
  /* The stone is e2. Only the touchstone matches it, and the seed is
     orthogonal — so the mean is dragged to 0.5 while the seed maximum stays 0.
     Letting the touchstone into maxSim would report a "closest paper" that is
     not a paper. */
  const rows = {
    A: [
      { kind: 'touchstone', vector: e2, weight: 1, label: 'a-touch' },
      { kind: 'core', vector: e1, weight: 1, label: 'Xue 2022' },
    ],
  };
  assert.deepEqual(scoreAxes(e2, rows), {
    A: { mean_sim: 0.5, max_sim: 0, nearest: 'Xue 2022' },
  });
});

test('an axis with no rows scores zero rather than throwing', () => {
  assert.deepEqual(scoreAxes(e1, { A: [] }), {
    A: { mean_sim: 0, max_sim: 0, nearest: null },
  });
  assert.deepEqual(scoreAxes(e1, undefined), {});
});

/* ── addDayZ ────────────────────────────────────────────────────────────── */

test('z_day is the day\'s own median/MAD z, per axis', () => {
  /* Means [0, 1, 2, 3] per axis: sorted median is 2, the deviations are
     [2, 1, 0, 1] whose median is 1. So z = (v - 2) / (1.4826 * 1). */
  const papers = [0, 1, 2, 3].map((v) => ({ id: `p${v}`, axes: { A: { mean_sim: v } } }));
  const z = (v) => addDayZ(papers).find((p) => p.id === `p${v}`).axes.A.z_day;
  assert.equal(z(2), 0);
  assert.equal(z(3), 1 / 1.4826);
  assert.equal(z(1), -1 / 1.4826);
  assert.equal(z(0), -2 / 1.4826);
});

test('each axis gets its own baseline, and the input is not mutated', () => {
  const papers = [
    { id: 'a', axes: { A: { mean_sim: 0 }, B: { mean_sim: 9 } } },
    { id: 'b', axes: { A: { mean_sim: 1 }, B: { mean_sim: 9 } } },
  ];
  const out = addDayZ(papers);
  assert.equal(out[0].axes.B.z_day, 0, 'B has no spread, so no claim is made');
  assert.notEqual(out[0].axes.A.z_day, 0);
  assert.equal(papers[0].axes.A.z_day, undefined, 'the caller\'s papers are untouched');
});

/* ── redundancy ─────────────────────────────────────────────────────────── */

test('redundancy is the largest cosine to a recent stone, 0 when there is none', () => {
  assert.equal(redundancy(e1, []), 0);
  assert.equal(redundancy(e1, undefined), 0);
  assert.equal(redundancy(e1, [e2]), 0);
  assert.equal(redundancy(e1, [e2, e1]), 1);
  assert.equal(redundancy(e1, [e1, e2]), 1, 'order does not matter, the max does');
  // Not clamped: an opposite vector is genuinely unlike everything shipped.
  assert.equal(redundancy(e1, [[-1, 0, 0]]), -1);
});

/* ── orderShipped ───────────────────────────────────────────────────────── */

test('order is relevance, then novelty, then z_ref, then id', () => {
  // Relevance decides first: 5 outranks 3 whatever the rest says.
  assert.deepEqual(
    orderShipped([{ id: 'a', relevance: 3 }, { id: 'b', relevance: 5 }]).map((i) => i.id),
    ['b', 'a']);
  // Then novelty.
  assert.deepEqual(
    orderShipped([
      { id: 'a', relevance: 4, novelty: 1 },
      { id: 'b', relevance: 4, novelty: 3 },
    ]).map((i) => i.id), ['b', 'a']);
  // Then the background z.
  assert.deepEqual(
    orderShipped([
      { id: 'a', relevance: 4, novelty: 2, z_ref: 1 },
      { id: 'b', relevance: 4, novelty: 2, z_ref: 3 },
    ]).map((i) => i.id), ['b', 'a']);
  // And only then the id, ascending, so input order cannot change the list.
  assert.deepEqual(
    orderShipped([
      { id: 'b', relevance: 4, novelty: 2, z_ref: 3 },
      { id: 'a', relevance: 4, novelty: 2, z_ref: 3 },
    ]).map((i) => i.id), ['a', 'b']);
});

test('an ungraded paper sorts below every graded one, and ties with its own kind', () => {
  assert.deepEqual(
    orderShipped([{ id: 'a', relevance: null }, { id: 'b', relevance: 1 }]).map((i) => i.id),
    ['b', 'a']);
  assert.deepEqual(
    orderShipped([{ id: 'b', relevance: null }, { id: 'a', relevance: null }]).map((i) => i.id),
    ['a', 'b'], 'all keys missing falls through to the id');
});

/* ── bandOfRelevance ────────────────────────────────────────────────────── */

test('the relevance bands are the reading decision, and below 3 is a long shot', () => {
  assert.equal(bandOfRelevance(5), 'Must read');
  assert.equal(bandOfRelevance(4), 'Read');
  assert.equal(bandOfRelevance(3), 'Skim');
  assert.equal(bandOfRelevance(2), 'Long shot');
  assert.equal(bandOfRelevance(null), 'Long shot', 'ungraded is not a recommendation');
});

/* ── pickShip ───────────────────────────────────────────────────────────── */

const SHIP = { ship: { relevance: 3, max: 8, longshots_on_empty: 2 } };

const GRADED = [
  { id: 'p1', relevance: 5, novelty: 1, z_ref: 1, z_day: 0.1 },
  { id: 'p2', relevance: 3, novelty: 5, z_ref: 2, z_day: 0.2 },
  { id: 'p3', relevance: 2, novelty: 5, z_ref: 9, z_day: 9 },
];

test('only papers at or above ship.relevance ship, ordered, and labelled', () => {
  const out = pickShip(GRADED, SHIP);
  assert.deepEqual(out.map((i) => i.id), ['p1', 'p2']);
  assert.deepEqual(out.map((i) => i.band), ['Must read', 'Skim']);
  assert.equal(out[0].relevance, 5, 'the score rides along for the card');
});

test('ship.max is a ceiling on a rich day, not a target', () => {
  const out = pickShip(GRADED, { ship: { relevance: 3, max: 1, longshots_on_empty: 2 } });
  assert.deepEqual(out.map((i) => i.id), ['p1']);
});

test('a day with nothing at the bar ships the top z_day as long shots', () => {
  /* No bar can be reached, so the fallback fires. p3 has the higher z_ref and
     would lead a shortlist; the fallback orders by the day's own z instead,
     which is what "the best of a quiet day" means. */
  const none = { ship: { relevance: 6, max: 8, longshots_on_empty: 1 } };
  const out = pickShip(GRADED, none);
  assert.deepEqual(out.map((i) => i.id), ['p3']);
  assert.equal(out[0].band, 'Long shot');
  const two = pickShip(GRADED, { ship: { relevance: 6, max: 8, longshots_on_empty: 2 } });
  assert.deepEqual(two.map((i) => i.id), ['p3', 'p2'], 'by z_day: 9, then 0.2');
});

test('a config with no ship block falls back to the documented defaults', () => {
  // bar 3, cap 8, and zero long shots when nothing clears the bar.
  assert.deepEqual(pickShip(GRADED, {}).map((i) => i.id), ['p1', 'p2']);
  assert.deepEqual(pickShip([{ id: 'x', relevance: 1, z_day: 1 }], {}), []);
});

/* ── storeCandidates ────────────────────────────────────────────────────── */

const STORE = { store: { relevance: 4, novelty: 4, novelty_min_relevance: 3 } };

test('store takes the clearly relevant and the surprising, and nothing else', () => {
  const graded = [
    { id: 'a', relevance: 5, novelty: 1 },   // rule 1: relevance >= 4
    { id: 'b', relevance: 3, novelty: 5 },   // rule 2: novel, and relevant enough
    { id: 'c', relevance: 2, novelty: 5 },   // novel but under novelty_min_relevance
    { id: 'd', relevance: 3, novelty: 3 },   // neither bar reached
    { id: 'e', relevance: null, novelty: null }, // never graded
  ];
  assert.deepEqual(storeCandidates(graded, STORE).map((i) => i.id), ['a', 'b']);
});

test('the novelty route still needs the relevance floor, and defaults apply', () => {
  assert.deepEqual(
    storeCandidates([{ id: 'x', relevance: 3, novelty: 4 }], {}).map((i) => i.id), ['x'],
    'defaults are 4 / 4 / 3');
  assert.deepEqual(storeCandidates([{ id: 'x', relevance: 2, novelty: 5 }], {}), []);
});


/* ── the pipeline, end to end ─────────────────────────────────────────────
 *
 * Four papers and two axes, all in 3-d so every cosine below is exact:
 *
 *   p1 = e1      A: mean 1.000, max 1.000, nearest Xue 2022
 *   p2 = e2      B: mean 1.000, max 1.000, nearest Knill 2008
 *   p3 = 45°     A and B: mean 0.707, max 0.707
 *   p4 = e3      nothing on either axis
 *
 * With a background of {median 0, mad 1}, z_ref = mean_sim / 1.4826, so the
 * pinned taus (tau_ref 0.5, tau_seed 0.7) shortlist p1 and p2 on z_ref and p3
 * on max_sim — three papers, one of which the grader scores below the ship bar.
 */

const PRESETS = {
  'qs-a': {
    preset: { axis: 'A', name: 'Axis A' },
    rows: [
      { kind: 'touchstone', text: 'a-touch', weight: 1 },
      { kind: 'core', text: 'a-seed', title: 'Xue 2022', weight: 1 },
    ],
  },
  'qs-b': {
    preset: { axis: 'B', name: 'Axis B' },
    rows: [
      { kind: 'touchstone', text: 'b-touch', weight: 1 },
      { kind: 'core', text: 'b-seed', title: 'Knill 2008', weight: 1 },
    ],
  },
};

const VECTORS = {
  abs1: e1, abs2: e2, abs3: diag, abs4: e3,
  'a-touch': e1, 'a-seed': e1, 'b-touch': e2, 'b-seed': e2,
};
const embedStub = async (texts) => texts.map((t) => VECTORS[t]);

const STONES = [1, 2, 3, 4].map((n) => ({
  arxivId: `p${n}`,
  title: `Paper ${n}`,
  authors: 'A. Author',
  abstract: `abs${n}`,
  link: `https://arxiv.org/abs/p${n}`,
  published: '2026-11-03',
}));

/* A background sample of one value per axis, median 0 and mad 1, so
   z_ref(mean_sim) = mean_sim / 1.4826 exactly. */
const BACKGROUND = {
  built_on: '2026-10-01',
  n: 1,
  axes: Object.fromEntries(['A', 'B'].map((axis) => [axis, {
    mean: { median: 0, mad: 1, values: [0] },
    max: { median: 0, mad: 1, values: [0] },
  }])),
};

const CONFIG = {
  criterion: 'quantum-systems',
  shortlist: { max: 20, min: 0, sensitivity: 'normal', tau_ref: 0.5, tau_seed: 0.7 },
  llm: { base_url: 'https://llm.invalid/v1', model: 'm', api_key_env: 'SAIL_KEY', grade_chars: 8000 },
  ship: { relevance: 3, max: 8, longshots_on_empty: 2 },
  store: { relevance: 4, novelty: 4, novelty_min_relevance: 3 },
  axes: { A: 1.0, B: 1.0 },
};

const PACK = {
  rubric: 'RUBRIC TEXT',
  requirements: new Map([['Req_45', 'automated re-calibration for drift']]),
  axes: { A: { name: 'Axis A' }, B: { name: 'Axis B' } },
};

const GRADES = {
  p1: {
    relevance: 5, novelty: 4, axis: 'A', refs: ['Req_45'], why: 'why one', kind: 'device',
    actions: [{ type: 'code', title: 'Try it', body: 'https://example.invalid/x' }],
  },
  p2: { relevance: 3, novelty: 5, axis: 'B', refs: [], why: 'why two', kind: 'benchmark', actions: [] },
  p3: { relevance: 2, novelty: 5, axis: 'A', refs: [], why: 'why three', kind: 'algorithm', actions: [] },
};

function memFs(files = {}) {
  const disk = { ...files };
  return {
    disk,
    readFile: async (p) => {
      if (!(p in disk)) {
        const err = new Error(`ENOENT: no such file or directory, open '${p}'`);
        err.code = 'ENOENT';
        throw err;
      }
      return disk[p];
    },
    writeFile: async (p, data) => { disk[p] = data; },
    mkdir: async () => {},
  };
}


test('the whole pipeline runs on four papers, with no socket and no disk', async () => {
  const disk = memFs({ '/out/background.json': JSON.stringify(BACKGROUND) });
  const warns = [];
  const asked = [];
  const enrichedIds = [];
  const gradeStub = async (args) => { asked.push(args); return GRADES[args.paper.id]; };

  const out = await runRank({
    config: CONFIG,
    pack: PACK,
    presets: PRESETS,
    stones: STONES,
    embed: embedStub,
    center: (v) => v,                      // 3-d fixture: the real centroid is 768-d
    backgroundPath: '/out/background.json',
    /* Only p1 has an HTML rendering; the rest must fall back to the abstract. */
    readPaper: async (id) => (id === 'p1' ? { text: 'intro of p1' } : null),
    grade: gradeStub,
    summarize: async () => 'Two papers worth reading.',
    enrich: async (items) => {
      enrichedIds.push(...items.map((it) => it.id));
      return items.map((it) => ({ ...it, enrichment: { kind: 'new result', result: 'R.', tools: [] } }));
    },
    recentStones: [e2],                    // p2 is a repeat of something shipped
    fs: disk,
    env: { SAIL_KEY: 'test' },
    log: { log() {}, warn: (...a) => warns.push(a.join(' ')) },
    site: 'https://arxave.com/',
    outDir: '/out',
    now: new Date('2026-11-04T06:00:00Z'),
  });

  /* What was decided. */
  assert.deepEqual(out.shortlisted, ['p1', 'p2', 'p3']);
  assert.deepEqual(out.shipped.map((i) => i.id), ['p1', 'p2']);
  assert.deepEqual(out.shipped.map((i) => i.band), ['Must read', 'Skim']);
  assert.deepEqual(out.shipped.map((i) => i.relevance), [5, 3]);
  assert.deepEqual(out.shipped.map((i) => i.best_axis), ['A', 'B']);
  assert.deepEqual(out.shipped.map((i) => i.redundancy), [0, 1]);
  assert.deepEqual(out.stored, ['p1', 'p2'], 'p3 is neither relevant nor novel enough');
  assert.deepEqual(warns, [], 'a clean run says nothing');

  /* What the grader was shown: the head of the paper when arXiv has one. */
  assert.deepEqual(asked.map((a) => a.paper.id), ['p1', 'p2', 'p3']);
  assert.equal(asked[0].rubric, 'RUBRIC TEXT');
  assert.equal(asked[0].requirements, PACK.requirements);
  assert.equal(asked[0].paper.intro, 'intro of p1');
  assert.equal(asked[1].paper.intro, undefined, 'no HTML → graded from the abstract');

  /* Only the shipped papers that cleared the bar were enriched. */
  assert.deepEqual(enrichedIds, ['p1', 'p2']);
  assert.equal(out.summary, 'Two papers worth reading.');

  /* The feeds, one per axis preset, partitioned by the best axis. */
  assert.deepEqual(out.feeds, { 'qs-a': ['p1'], 'qs-b': ['p2'] });
  const a = disk.disk['/out/qs-a.xml'];
  assert.match(a, /<arxave:relevance>5<\/arxave:relevance>/);
  assert.match(a, /<arxave:novelty>4<\/arxave:novelty>/);
  assert.match(a, /<arxave:axis>A<\/arxave:axis>/);
  assert.match(a, /<arxave:ref>Req_45<\/arxave:ref>/);
  assert.match(a, /<arxave:nearestseed>Xue 2022<\/arxave:nearestseed>/);
  assert.match(a, /<arxave:zref>0\.7<\/arxave:zref>/, 'z_ref is mean_sim / 1.4826');
  assert.match(a, /<arxave:redundancy>0\.00<\/arxave:redundancy>/);
  assert.match(a, /<arxave:band>must-read<\/arxave:band>/);
  assert.match(a, /<arxave:bandname>Must read<\/arxave:bandname>/);
  assert.match(a, /<arxave:action type="code" title="Try it">https:\/\/example\.invalid\/x<\/arxave:action>/);
  assert.match(a, /<arxave:summary>Two papers worth reading\.<\/arxave:summary>/);
  assert.doesNotMatch(a, /<arxave:relevance>3</, 'p2 belongs to the other axis feed');

  const b = disk.disk['/out/qs-b.xml'];
  assert.match(b, /<arxave:relevance>3<\/arxave:relevance>/);
  assert.match(b, /<arxave:band>skim<\/arxave:band>/);
  assert.match(b, /<arxave:redundancy>1\.00<\/arxave:redundancy>/);

  /* The stockpile: the day, its summary, and the item fields. */
  const day = JSON.parse(disk.disk['/out/archive/2026-11.json']).days['2026-11-04'];
  assert.equal(day.summary, 'Two papers worth reading.');
  assert.equal(day['qs-a'].tally, '1 must read.');
  assert.equal(day['qs-b'].tally, 'No pay dirt today — 1 to skim.');
  const entry = day['qs-a'].items[0];
  assert.equal(entry.id, 'p1');
  assert.equal(entry.relevance, 5);
  assert.equal(entry.novelty, 4);
  assert.equal(entry.axis, 'A');
  assert.equal(entry.band, 'Must read');
  assert.equal(entry.nearest_seed, 'Xue 2022');
  assert.deepEqual(entry.refs, ['Req_45']);
  assert.equal(entry.actions[0].type, 'code');
  assert.equal(entry.redundancy, 0);
  assert.ok(Math.abs(entry.z_ref - 1 / 1.4826) < 1e-9);
  assert.ok(out.written.includes('/out/qs-a.xml'));
  assert.ok(out.written.includes('/out/archive/2026-11.json'));
});


test('without a grader key the shortlist ships, ungraded, and nothing crashes', async () => {
  const disk = memFs({ '/out/background.json': JSON.stringify(BACKGROUND) });
  let summarized = 0;
  const out = await runRank({
    config: CONFIG,
    pack: PACK,
    presets: PRESETS,
    stones: STONES,
    embed: embedStub,
    center: (v) => v,
    backgroundPath: '/out/background.json',
    readPaper: async () => null,
    summarize: async () => { summarized++; return 'x'; },
    /* The real gradePaper is the default and answers `{error:'no-key'}` with no
       env key — no socket, no throw. Enriching must not be reached at all. */
    enrich: async () => { throw new Error('enrich must not run without a grade'); },
    fs: disk,
    env: {},
    log: { log() {}, warn() {} },
    outDir: '/out',
    now: new Date('2026-11-04T06:00:00Z'),
  });

  assert.deepEqual(out.shipped.map((i) => i.id), ['p1', 'p2', 'p3'], 'shortlist order');
  assert.deepEqual(out.shipped.map((i) => i.relevance), [null, null, null]);
  assert.deepEqual(out.shipped.map((i) => i.band), ['Long shot', 'Long shot', 'Long shot']);
  assert.deepEqual(out.stored, [], 'nothing can be judged, so nothing is stored');
  assert.equal(out.summary, '', 'no grader, no summary');
  assert.equal(summarized, 0);
});

test('without a background the day is its own reference, and the run says so', async () => {
  const disk = memFs();   // no background.json on this filesystem
  const warns = [];
  const out = await runRank({
    config: CONFIG,
    pack: PACK,
    presets: PRESETS,
    stones: STONES,
    embed: embedStub,
    center: (v) => v,
    backgroundPath: '/out/background.json',
    readPaper: async () => null,
    grade: async (args) => GRADES[args.paper.id],
    summarize: async () => 's',
    enrich: async (items) => items,
    fs: disk,
    env: { SAIL_KEY: 'test' },
    log: { log() {}, warn: (...a) => warns.push(a.join(' ')) },
    outDir: '/out',
    now: new Date('2026-11-04T06:00:00Z'),
  });

  assert.ok(warns.some((w) => /no background at \/out\/background\.json/.test(w)));
  assert.deepEqual(out.shortlisted, ['p1', 'p2', 'p3']);
  assert.deepEqual(out.shipped.map((i) => i.id), ['p1', 'p2'], 'the grader still decides');
  // z_ref is the day's own z here: p1 sits 0.279 above it, which rounds to 0.3.
  assert.match(disk.disk['/out/qs-a.xml'], /<arxave:zref>0\.3<\/arxave:zref>/);
});

test('a dry run decides everything and writes nothing', async () => {
  const disk = memFs({ '/out/background.json': JSON.stringify(BACKGROUND) });
  const out = await runRank({
    config: CONFIG, pack: PACK, presets: PRESETS, stones: STONES,
    embed: embedStub, center: (v) => v, backgroundPath: '/out/background.json',
    readPaper: async () => null,
    grade: async (args) => GRADES[args.paper.id],
    summarize: async () => 's',
    enrich: async (items) => items,
    fs: disk, env: { SAIL_KEY: 'test' }, log: { log() {}, warn() {} },
    outDir: '/out', now: new Date('2026-11-04T06:00:00Z'), dryRun: true,
  });
  assert.deepEqual(out.shipped.map((i) => i.id), ['p1', 'p2']);
  assert.deepEqual(out.written, []);
  assert.deepEqual(disk.disk, { '/out/background.json': JSON.stringify(BACKGROUND) });
});


test('presets from loadPresets (a Map) rank the same as a plain object', async () => {
  /* warm-dig's loadPresets returns `bySlug` as a Map. Object.entries(Map) is [],
     so rank once found no axes, wrote no feed, and exited 0. */
  const run = (presets) => runRank({
    config: CONFIG, pack: PACK, presets, stones: STONES, embed: embedStub,
    center: (v) => v, background: BACKGROUND,
    grade: async (args) => GRADES[args.paper.id],
    summarize: async () => '', enrich: async (items) => items,
    fs: memFs(), env: { SAIL_KEY: 'test' }, log: { log() {}, warn() {} },
    site: 'https://arxave.com/', outDir: '/out', now: new Date('2026-11-04T06:00:00Z'),
  });
  const fromObject = await run(PRESETS);
  const fromMap = await run(new Map(Object.entries(PRESETS)));
  assert.ok(Object.keys(fromObject.feeds).length > 0, 'the fixture must produce feeds');
  assert.deepEqual(fromMap.feeds, fromObject.feeds);
  assert.deepEqual(fromMap.shipped, fromObject.shipped);
});

test('a run with no axis presets throws instead of ending green with nothing written', async () => {
  await assert.rejects(
    runRank({
      config: CONFIG, pack: PACK, presets: new Map(), stones: STONES, embed: embedStub,
      center: (v) => v, background: BACKGROUND, fs: memFs(), env: {},
      log: { log() {}, warn() {} }, site: 'https://arxave.com/', outDir: '/out',
      now: new Date('2026-11-04T06:00:00Z'),
    }),
    /no axis presets loaded/,
  );
});
