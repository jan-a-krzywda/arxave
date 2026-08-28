/**
 * `node --test scripts/preset-feed.test.mjs` (after `npm install` in this dir).
 *
 * These pin the one thing this script must not get wrong: **its blend has to be
 * the browser's blend.** `computeGrades()` in docs/assets/filter.js is the other
 * implementation, and a divergence does not throw — the feed just recommends
 * different papers than the page does for the same preset, forever, quietly.
 * So the expected values below are hand-computed from the formula as written
 * there, not from this file's output.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  archiveEntry, archiveIndex, bandOf, bestRow, center, CORPUS_CENTROID, cosine, 
  figureMirror, grade, itemDate, mergeMonth, newestOf, renderFeed, rowLabel,
  selectItems, tallyOf, xmlEscape,
} from './preset-feed.mjs';

/* Orthonormal basis vectors make the cosines exactly 1, 0 or -1, so every
   expectation below is arithmetic anyone can check by eye. */
const e1 = [1, 0, 0];
const e2 = [0, 1, 0];

test('a single row grades as its own cosine', () => {
  assert.equal(grade(e1, [{ vector: e1, weight: 1 }]), 1);
  assert.equal(grade(e1, [{ vector: e2, weight: 1 }]), 0);
});

test('rows blend as the weighted mean the page computes', () => {
  // num = 1*1 + 3*0 = 1 ; den = 1 + 3 = 4
  assert.equal(grade(e1, [{ vector: e1, weight: 1 }, { vector: e2, weight: 3 }]), 0.25);
});

test('a row with no vector leaves the denominator, rather than scoring zero', () => {
  // The distinction the page is explicit about: an unresolved core sample must
  // not drag a paper down. With it excluded the grade is 1, not 0.5.
  assert.equal(grade(e1, [{ vector: e1, weight: 1 }, { vector: null, weight: 1 }]), 1);
});

test('a zero or negative weight is skipped on both sides', () => {
  assert.equal(grade(e1, [{ vector: e1, weight: 1 }, { vector: e2, weight: 0 }]), 1);
  assert.equal(grade(e1, [{ vector: e1, weight: 1 }, { vector: e2, weight: -2 }]), 1);
});

test('nothing to score is zero, not NaN', () => {
  // den === 0 must not become 0/0 and poison the sort.
  assert.equal(grade(e1, []), 0);
  assert.equal(grade(e1, [{ vector: null, weight: 1 }]), 0);
});

test('a dimension mismatch throws instead of scoring silently', () => {
  assert.throws(() => cosine([1, 0], [1, 0, 0]), /dimension mismatch/);
});

test('ampersands escape before the escapes do', () => {
  // `&` last would turn `&lt;` into `&amp;lt;`. Physics titles carry both.
  assert.equal(xmlEscape('a & b < c'), 'a &amp; b &lt; c');
  assert.equal(xmlEscape('"q" & \'p\''), '&quot;q&quot; &amp; &apos;p&apos;');
});

test('the feed carries the grade in the body, not only in the order', () => {
  // Most readers re-sort by date, which destroys the ranking. The number has to
  // survive that.
  const xml = renderFeed({
    preset: { name: 'Spin qubits', blurb: 'b' },
    slug: 'spin-qubits',
    site: 'https://example.test/',
    builtOn: '2026-08-12',
    items: [{
      arxivId: '2608.00001', title: 'A & B', link: 'https://arxiv.org/abs/2608.00001',
      abstract: 'text', authors: 'X, Y', grade: 0.4321,
    }],
  });
  assert.match(xml, /Grade 0\.432/);
  assert.match(xml, /A &amp;(amp;)? B/);
  assert.match(xml, /<atom:link href="https:\/\/example\.test\/feeds\/spin-qubits\.xml"/);
});

test('the guid is stable per paper per day, so a rebuild is not a new item', () => {
  const of = (id) => renderFeed({
    preset: { name: 'P' }, slug: 's', site: 'https://e.test/', builtOn: '2026-08-12',
    items: [{ arxivId: id, title: 't', link: 'l', abstract: 'a', authors: '', grade: 0.1 }],
  }).match(/<guid[^>]*>([^<]+)</)[1];
  assert.equal(of('2608.00001'), 'arxave:s:2026-08-12:2608.00001');
  assert.notEqual(of('2608.00002'), of('2608.00001'));
});

/* Dates. The companion to the grade-in-the-body test above: that one keeps the
   ranking readable after a re-sort, these keep the sort itself honest. Every
   item used to carry the build timestamp, so a Friday paper and a Monday paper
   in the same lookback window claimed the same second. */

test('an item is stamped with the day it was announced, not the day it was built', () => {
  assert.match(itemDate('2026-08-25', 0), /^Tue, 25 Aug 2026 /);
});

test('midnight ET, not midnight UTC, so no reader renders the previous day', () => {
  // 04:00 UTC is midnight in New York on the same date. At 00:00 UTC a reader
  // in ET would show a paper announced on the 25th as the 24th.
  assert.match(itemDate('2026-08-25', 0), / 04:59:00 GMT$/);
});

test('rank breaks the tie within a day, best first', () => {
  const at = (rank) => new Date(itemDate('2026-08-25', rank)).getTime();
  assert.ok(at(0) > at(1) && at(1) > at(2));
  // Deep ranks flatten rather than spilling into the next hour and the next day.
  assert.match(itemDate('2026-08-25', 500), /25 Aug 2026 04:00:00 GMT$/);
});

test('a stone with no date falls back to build time rather than to 1970', () => {
  const now = new Date('2026-08-25T09:00:00Z');
  assert.equal(itemDate(undefined, 0, now), now.toUTCString());
  assert.equal(itemDate('not a date', 0, now), now.toUTCString());
});

test('the channel is stamped with the newest paper, not the best one', () => {
  // Items are ordered by grade, so items[0] is regularly from an earlier day.
  assert.equal(newestOf([{ published: '2026-08-20' }, { published: '2026-08-25' }]), '2026-08-25');
  assert.equal(newestOf([{}, {}]), '');
  const xml = renderFeed({
    preset: { name: 'P' }, slug: 's', site: 'https://e.test/', builtOn: '2026-08-25',
    items: [
      { arxivId: '1', title: 't', link: 'l', abstract: 'a', authors: '', grade: 0.9, published: '2026-08-20' },
      { arxivId: '2', title: 'u', link: 'l', abstract: 'a', authors: '', grade: 0.1, published: '2026-08-25' },
    ],
  });
  assert.match(xml, /<pubDate>Tue, 25 Aug 2026 04:59:00 GMT<\/pubDate>/);
  // And the low-graded newer paper still sorts below the high-graded older one.
  const dates = [...xml.matchAll(/<pubDate>([^<]+)</g)].map((m) => m[1]);
  assert.equal(dates.length, 3);              // channel, then one per item
  assert.match(dates[1], /20 Aug 2026/);
  assert.match(dates[2], /25 Aug 2026/);
  // ISO alongside it, because the XSL is XSLT 1.0 and cannot parse RFC-822.
  assert.match(xml, /<arxave:announced>2026-08-20<\/arxave:announced>/);
});

test('an item with no date omits the announced element rather than emptying it', () => {
  const xml = renderFeed({
    preset: { name: 'P' }, slug: 's', site: 'https://e.test/', builtOn: '2026-08-25',
    items: [{ arxivId: '1', title: 't', link: 'l', abstract: 'a', authors: '', grade: 0.1 }],
  });
  assert.doesNotMatch(xml, /<arxave:announced>/);
});

test('the stylesheet reference is relative, so it survives another domain', () => {
  // Browsers refuse a cross-origin XSLT. An absolute href would keep working on
  // arxave.com and quietly stop transforming anywhere else the file is served.
  const xml = renderFeed({
    preset: { name: 'P' }, slug: 's', site: 'https://arxave.com/', builtOn: '2026-08-12',
    items: [],
  });
  assert.match(xml, /<\?xml-stylesheet type="text\/xsl" href="feed\.xsl"\?>/);
  assert.doesNotMatch(xml.split('\n')[1], /https?:/);
});

test('every link in the feed points at the site it was built for', () => {
  const xml = renderFeed({
    preset: { name: 'P' }, slug: 's', site: 'https://arxave.com/', builtOn: '2026-08-12',
    items: [{ arxivId: '1', title: 't', link: 'https://arxiv.org/abs/1', abstract: 'a', authors: '', grade: 0.1 }],
  });
  assert.doesNotMatch(xml, /github\.io/);
  assert.match(xml, /<link>https:\/\/arxave\.com\/\?preset=s<\/link>/);
});

/* Selection. The gate is a robust z-score, not an absolute grade: measured on
   2026-08-12, 94 abstracts scored 0.498–0.735 against spin-qubits with a median
   of 0.605, so "above 0.65" kept ten papers of which eight were off-topic. What
   separates is distance from the day's own baseline. */

const spread = [0.50, 0.55, 0.58, 0.60, 0.61, 0.62, 0.63, 0.65, 0.70, 0.90]
  .map((g, i) => ({ arxivId: String(i), grade: g }));

test('a paper far above the day baseline is pay dirt, the bulk is not shipped', () => {
  // z here is 4.72, 1.35 and 0.51 for the top three; the default ship line of
  // 1.5 takes the first and leaves the rest of the night alone.
  const picked = selectItems(spread, { minZ: 2.0, maxItems: 15, minItems: 0 });
  assert.deepEqual(picked.map((p) => p.grade), [0.90]);
  assert.deepEqual(picked.map((p) => p.band), ['paydirt']);
});

test('dropping the ship line lets the next tier in, labelled', () => {
  /* The failure this prevents: shipping a z-1.4 paper that reads like a z-3
     one. It travels — but wearing a chip that says what it is. */
  const picked = selectItems(spread, { minZ: 2.0, softZ: 1.0, maxItems: 15, minItems: 0 });
  assert.deepEqual(picked.map((p) => p.grade), [0.90, 0.70]);
  assert.deepEqual(picked.map((p) => p.band), ['paydirt', 'look']);
  assert.ok(picked.every((p) => p.band));
});

test('bands split on the pay-dirt line and the ship line', () => {
  const opts = { minZ: 2.0, softZ: 1.0 };
  assert.equal(bandOf(3.1, opts), 'paydirt');
  assert.equal(bandOf(2.0, opts), 'paydirt');
  assert.equal(bandOf(1.4, opts), 'look');
  assert.equal(bandOf(0.6, opts), 'longshot');
  // No spread means no baseline, so no confidence can be claimed.
  assert.equal(bandOf(null, opts), 'longshot');
});

test('a ship line above the pay-dirt line cannot open an unreachable band', () => {
  // minZ below softZ is a stricter feed, not a feed with a band nothing enters.
  const picked = selectItems(spread, { minZ: 0.6, softZ: 2.0, maxItems: 15, minItems: 0 });
  assert.ok(picked.every((p) => p.band === 'paydirt'));
});

test('the day says whether it had any pay dirt', () => {
  assert.equal(tallyOf([]), '');
  assert.equal(tallyOf([{ band: 'paydirt' }, { band: 'look' }, { band: 'look' }]),
    '1 pay dirt · 2 worth a look.');
  assert.equal(tallyOf([{ band: 'look' }, { band: 'longshot' }]),
    'No pay dirt today — 1 worth a look · 1 long shot.');
  assert.equal(tallyOf([{ band: 'longshot' }]), 'No pay dirt today — 1 long shot.');
});

test('lowering the gate lets the next tier in, in grade order', () => {
  // z here is 4.72 and 1.35; the next paper down (0.65) sits at 0.84 and stays
  // out, which is the point — the tiers are set by the spread, not by rank.
  const picked = selectItems(spread, { minZ: 1.0, maxItems: 15, minItems: 0 });
  assert.deepEqual(picked.map((p) => p.grade), [0.90, 0.70]);
});

test('maxItems is a ceiling, never a target', () => {
  // The failure this prevents: padding a quiet day to a fixed ten. Bands make
  // the bar lower, not absent — the ceiling is what keeps that from being ten.
  assert.equal(selectItems(spread, { minZ: 2.0, maxItems: 10, minItems: 0 }).length, 1);
  assert.equal(selectItems(spread, { minZ: 0.5, maxItems: 2, minItems: 0 }).length, 2);
});

test('a day where nothing stands out ships long shots, and says so', () => {
  /* The rule changed here deliberately. A gate that ships nothing is correct
     about the day and wrong about the reader: an empty file is what a
     prospective subscriber sees when they click the link, and it reads as a
     dead project rather than a quiet morning. The floor ships the floor's worth
     and every one of them wears a Long shot chip. */
  const flat = [0.60, 0.601, 0.602, 0.599].map((g, i) => ({ arxivId: String(i), grade: g }));
  const picked = selectItems(flat, { minZ: 3.0, maxItems: 15 });
  assert.ok(picked.length > 0 && picked.length <= 3, String(picked.length));
  assert.ok(picked.every((p) => p.band === 'longshot'));
  assert.match(tallyOf(picked), /^No pay dirt today/);
});

test('the floor can be shut off by pulling longZ up to the ship line', () => {
  // Someone who wants the old empty-or-nothing feed still has it, in one number.
  const flat = [0.60, 0.601, 0.602, 0.599].map((g, i) => ({ arxivId: String(i), grade: g }));
  assert.equal(selectItems(flat, { minZ: 3.0, softZ: 1.0, longZ: 1.0 }).length, 0);
});

/* The floor under the gate. Measured 2026-08-15: quantum-machine-learning
   matches half of quant-ph, so its own baseline and spread rise with it and the
   best paper of the day sat at z 1.37 — the feed shipped empty while the page
   showed those same papers at the top of the assay. */

test('a day with a clear top tier but no outlier fills to minItems', () => {
  // Nothing reaches z 2.0; the top three still clear softZ, so three ship.
  const dense = [0.60, 0.61, 0.62, 0.63, 0.64, 0.65, 0.70, 0.71, 0.72]
    .map((g, i) => ({ arxivId: String(i), grade: g }));
  const picked = selectItems(dense, { minZ: 2.0, minItems: 3, softZ: 1.0, maxItems: 15 });
  assert.deepEqual(picked.map((p) => p.grade), [0.72, 0.71, 0.70]);
  assert.ok(picked.every((p) => p.z < 2.0 && p.z >= 1.0));
});

test('the floor never reaches below longZ', () => {
  const flat = [0.60, 0.601, 0.602, 0.599].map((g, i) => ({ arxivId: String(i), grade: g }));
  const picked = selectItems(flat, { minZ: 2.0, minItems: 3, softZ: 1.0, longZ: 0.5 });
  assert.ok(picked.every((p) => p.z >= 0.5), JSON.stringify(picked.map((p) => p.z)));
});

test('the floor tops up only what is missing, and never past maxItems', () => {
  // Two clear softZ, minItems asks for three: two ship, not three padded.
  const two = [0.50, 0.55, 0.58, 0.60, 0.61, 0.62, 0.63, 0.70, 0.90]
    .map((g, i) => ({ arxivId: String(i), grade: g }));
  assert.equal(selectItems(two, { minZ: 2.0, minItems: 3, softZ: 1.0 }).length, 2);
  assert.equal(selectItems(two, { minZ: 2.0, minItems: 3, softZ: 1.0, maxItems: 1 }).length, 1);
});

test('papers that clear the real gate are never displaced by the floor', () => {
  // Four above z 2.0 and minItems 3: all four ship — the floor is a floor.
  const many = [0.50, 0.52, 0.54, 0.56, 0.57, 0.58, 0.90, 0.91, 0.92, 0.93]
    .map((g, i) => ({ arxivId: String(i), grade: g }));
  const picked = selectItems(many, { minZ: 2.0, minItems: 3, maxItems: 15 });
  assert.equal(picked.length, 4);
  assert.ok(picked.every((p) => p.z >= 2.0));
});

test('an identical spread falls back to top-N rather than dividing by zero', () => {
  // MAD === 0 has no baseline to be above; z would be NaN and filter everything.
  const same = [0.6, 0.6, 0.6].map((g, i) => ({ arxivId: String(i), grade: g }));
  const picked = selectItems(same, { minZ: 2.0, maxItems: 2 });
  assert.equal(picked.length, 2);
  assert.equal(picked[0].z, null);
});

test('no papers at all is empty, not an error', () => {
  assert.deepEqual(selectItems([], {}), []);
});

test('items carry structured fields, not only escaped HTML', () => {
  /* Browsers do not implement XSLT's disable-output-escaping, so the stylesheet
     cannot turn the HTML inside <description> back into markup — it printed the
     tags on screen. Readers still want that HTML, so both shapes ship: escaped
     HTML for readers, arxave:* elements for the stylesheet. */
  const xml = renderFeed({
    preset: { name: 'P' }, slug: 's', site: 'https://arxave.com/', builtOn: '2026-08-12',
    items: [{
      arxivId: '1', title: 't', link: 'https://arxiv.org/abs/1', abstract: 'the abstract',
      authors: 'A. Author', grade: 0.7, z: 3.5,
      matched: { label: 'valley splitting in silicon quantum dots', cosine: 0.71 },
      enrichment: {
        kind: 'new result', result: 'T2* of 3.4 ms.',
        question: 'How long can a Si spin hold phase?',
        prior: 'Was 1.1 ms, same device (Smith 2024).',
        limits: 'One device, at 10 mK.',
        tools: ['a', 'b'], code: 'https://github.com/x/y',
        figure: 'S3.F2', figure_url: 'https://arxiv.org/html/1v1/f2.png',
        figure_caption: 'Figure 2: Ramsey decay.',
        figure_gloss: 'Phase coherence against wait time; the decay is ten times slower than the earlier device.',
      },
    }],
  });
  assert.match(xml, /xmlns:arxave="https:\/\/arxave\.com\/ns\/feed"/);
  assert.match(xml, /<arxave:kind>new result<\/arxave:kind>/);
  assert.match(xml, /<arxave:result>T2\* of 3\.4 ms\.<\/arxave:result>/);
  assert.match(xml, /<arxave:question>How long can a Si spin hold phase\?<\/arxave:question>/);
  assert.match(xml, /<arxave:prior>Was 1\.1 ms, same device \(Smith 2024\)\.<\/arxave:prior>/);
  assert.match(xml, /<arxave:limits>One device, at 10 mK\.<\/arxave:limits>/);
  assert.match(xml, /<arxave:code>https:\/\/github\.com\/x\/y<\/arxave:code>/);
  assert.match(xml, /<arxave:figure>https:\/\/arxiv\.org\/html\/1v1\/f2\.png<\/arxave:figure>/);
  // The gloss, not the paper's own caption: the card is read by someone who
  // has not opened the paper, and "Figure 2: Ramsey decay." tells them nothing.
  assert.match(xml, /<arxave:figurecaption>Phase coherence against wait time/);
  assert.doesNotMatch(xml, /Figure 2: Ramsey decay/);
  assert.match(xml, /<arxave:tools>a · b<\/arxave:tools>/);
  assert.match(xml, /<arxave:matched>valley splitting in silicon quantum dots<\/arxave:matched>/);
  assert.match(xml, /<arxave:abstract>the abstract<\/arxave:abstract>/);
  assert.match(xml, /<arxave:z>3\.5<\/arxave:z>/);
});

test('the finding leads the body, and everything under it is folded', () => {
  /* Most readers truncate an item to its first line in the list view, so
     whatever leads is the whole item for a large share of subscribers. If the
     grade line or the abstract drifts back above the finding, that share sees a
     number instead of a result, and nothing throws.

     The folds are the other half of the shape: six drawers in a fixed order,
     none of them open, so a reader's list stays a list. */
  const xml = renderFeed({
    preset: { name: 'P' }, slug: 's', site: 'https://arxave.com/', builtOn: '2026-08-12',
    items: [{
      arxivId: '1', title: 't', link: 'l', abstract: 'the abstract', authors: '',
      grade: 0.7, z: 3.5,
      enrichment: {
        kind: 'new method', result: 'T2* of 3.4 ms.',
        question: 'Q.', prior: 'P.', limits: 'C.', tools: ['a'],
        figure_url: 'f.png', figure_gloss: 'G.',
      },
    }],
  });
  // The item's description, not the channel's — the channel has one too, and it
  // is the first match in the file.
  const body = xml.match(/<item>[\s\S]*?<description>([\s\S]*?)<\/description>/)[1];
  const at = (label) => body.indexOf(`&lt;summary&gt;${label}&lt;/summary&gt;`);
  assert.ok(body.indexOf('T2* of 3.4 ms.') < body.indexOf('Grade 0.700'), 'finding before grade');
  assert.ok(body.indexOf('Grade 0.700') < at('Figure'), 'grade before the drawers');
  assert.ok(at('Figure') < at('Asks'), 'figure first');
  assert.ok(at('Asks') < at('Before'), 'question before baseline');
  assert.ok(at('Before') < at('But'), 'baseline before the limit');
  assert.ok(at('But') < at('Tools'), 'the limit before the jargon');
  assert.ok(at('Tools') < at('Abstract'), 'abstract last');
  assert.doesNotMatch(body, /&lt;details[^&]*open/, 'nothing is open at rest');
  assert.match(body, /new method.*T2\* of 3\.4 ms\./);
});

test('the author\'s TeX is rendered, not printed at the reader', () => {
  /* Every field on a card comes from arXiv's own TeX or from a model told to
     copy the paper's terms exactly. Raw, that is backslashes on the page — in
     the browser and in a feed reader, which is why it is fixed in the file. */
  const xml = renderFeed({
    preset: { name: 'P' }, slug: 's', site: 'https://arxave.com/', builtOn: '2026-08-12',
    items: [{
      arxivId: '1',
      title: 'Fault-tolerant $|\\sqrt{ \\mathrm{T} }\\rangle$ state preparation',
      link: 'l', abstract: 'Coherence $T_{2}^{*}$ at $p=5*10^{-4}$.',
      authors: 'M. M\\"uller', grade: 0.7, z: null,
      enrichment: {
        kind: 'new result', result: 'Under 12% at $p_{\\rm CNOT}=5*10^{-4}$.',
        question: '', prior: '', limits: '', tools: ['$\\ket{\\psi}$ injection'],
      },
    }],
  });
  assert.match(xml, /Fault-tolerant \|√T⟩ state preparation/);
  assert.match(xml, /Under 12% at p_CNOT=5\*10⁻⁴\./);
  assert.match(xml, /M\. Müller/);
  assert.match(xml, /T₂\^\* at p=5\*10⁻⁴/);
  assert.match(xml, /\|ψ⟩ injection/);
  assert.doesNotMatch(xml, /\\rangle|\\mathrm|\\rm /);
});

test('the grade line names the row that earned the grade', () => {
  // A bare 0.612 tells a reader nothing about why this paper is in their feed,
  // and gives them nothing to edit when the feed drifts.
  const xml = renderFeed({
    preset: { name: 'P' }, slug: 's', site: 'https://arxave.com/', builtOn: '2026-08-12',
    items: [{
      arxivId: '1', title: 't', link: 'l', abstract: 'a', authors: '', grade: 0.612, z: 2.1,
      matched: { label: 'charge noise and dephasing in Si/SiGe', cosine: 0.7 },
    }],
  });
  assert.match(xml, /matched .*charge noise and dephasing in Si\/SiGe/);
});

test('an unenriched item omits the generated elements rather than emptying them', () => {
  const xml = renderFeed({
    preset: { name: 'P' }, slug: 's', site: 'https://arxave.com/', builtOn: '2026-08-12',
    items: [{
      arxivId: '1', title: 't', link: 'l', abstract: 'a', authors: '', grade: 0.7, z: null,
      enrichment: null, matched: null,
    }],
  });
  assert.doesNotMatch(xml, /arxave:kind/);
  assert.doesNotMatch(xml, /arxave:result/);
  assert.doesNotMatch(xml, /arxave:matched/);
  assert.doesNotMatch(xml, /arxave:z/);
  assert.match(xml, /<arxave:abstract>a<\/arxave:abstract>/);
});

test('a paper with no stated limit drops the line instead of printing an empty one', () => {
  const xml = renderFeed({
    preset: { name: 'P' }, slug: 's', site: 'https://arxave.com/', builtOn: '2026-08-12',
    items: [{
      arxivId: '1', title: 't', link: 'l', abstract: 'a', authors: '', grade: 0.7, z: null,
      enrichment: { kind: '', result: 'R.', question: '', prior: '', limits: '', tools: [] },
    }],
  });
  assert.doesNotMatch(xml, /arxave:limits/);
  assert.doesNotMatch(xml, /arxave:prior/);
  // Not an empty drawer either: a fold that promises a caveat and opens on
  // nothing is worse than one fewer drawer.
  assert.doesNotMatch(xml, /summary&gt;But/);
  assert.match(xml, /<arxave:result>R\.<\/arxave:result>/);
});

/* The matched row. Not part of grade(), which mirrors the browser verbatim. */

test('the matched row is the highest cosine among the weighted rows', () => {
  const rows = [
    { vector: e1, weight: 1, label: 'exchange gates' },
    { vector: e2, weight: 1, label: 'valley splitting' },
  ];
  assert.equal(bestRow(e1, rows).label, 'exchange gates');
  assert.equal(bestRow(e2, rows).label, 'valley splitting');
});

test('a row that could not be embedded, or is switched off, cannot be the match', () => {
  assert.equal(bestRow(e1, [{ vector: null, weight: 1, label: 'unresolved' }]), null);
  assert.equal(bestRow(e1, [{ vector: e1, weight: 0, label: 'off' }]), null);
  assert.equal(bestRow(e1, []), null);
});

test('weight ranks the blend but not the match', () => {
  /* The match answers "which of my rows does this paper look like", which is a
     question about similarity alone. Letting weight in would name the row the
     reader cares most about rather than the one the paper actually resembles. */
  const rows = [
    { vector: e1, weight: 0.1, label: 'exchange gates' },
    { vector: e2, weight: 9, label: 'valley splitting' },
  ];
  assert.equal(bestRow(e1, rows).label, 'exchange gates');
});

test('a core sample is labelled by its title, not by the head of its embed text', () => {
  // A core's embed text is title and abstract run together on one line, so
  // slicing a label out of it prints half a title and the start of an abstract.
  const core = {
    kind: 'core',
    title: 'Coherent Manipulation of Coupled Electron Spins in Semiconductor Quantum Dots',
    text: 'Coherent Manipulation of Coupled Electron Spins in Semiconductor Quantum Dots ' +
          'We demonstrated coherent control of a two-electron spin state...',
  };
  assert.equal(rowLabel(core), core.title);
  assert.equal(rowLabel({ text: 'double quantum dot exchange gates' }),
    'double quantum dot exchange gates');
  assert.equal(rowLabel({}), '');
});

test('a label too long for one line is cut, not wrapped into the grade line', () => {
  const long = { text: 'x'.repeat(200) };
  assert.equal(rowLabel(long).length, 80);
  assert.ok(rowLabel(long).endsWith('…'));
});

/* ── The centroid, and the two files that carry it ────────────────────────
 *
 * `center()` is the same class of hazard as `grade()` and worse: the page and
 * the feed each hold their own copy of a 768-float constant, and a divergence
 * between them is invisible from either side. Both would keep producing unit
 * vectors, both would keep producing plausible cosines, and the feed would
 * simply be reading a different space than the page — the failure mode this
 * file's header exists for, one layer further down.
 */
test('the browser carries byte-identical centroid bytes', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const js = fs.readFileSync(path.join(here, '..', 'docs', 'assets', 'filter.js'), 'utf8');
  const mine = fs.readFileSync(path.join(here, 'preset-feed.mjs'), 'utf8');

  /* Read the literal out of each file rather than importing it: the point is
     that the *source* agrees, and a getter could paper over a difference. */
  const literal = (src, where) => {
    const at = src.indexOf('const CORPUS_CENTROID_B64 =');
    assert.ok(at > 0, `CORPUS_CENTROID_B64 not found in ${where}`);
    const end = src.indexOf(';', at);
    return src.slice(at, end).match(/'([A-Za-z0-9+/=]+)'/g).join('');
  };
  assert.equal(literal(js, 'filter.js'), literal(mine, 'preset-feed.mjs'));
});

test('centering leaves a unit vector, and is not the identity', () => {
  const v = Array.from({ length: 768 }, (_, i) => Math.sin(i));
  const c = center(v);
  const norm = Math.sqrt(c.reduce((s, x) => s + x * x, 0));
  assert.ok(Math.abs(norm - 1) < 1e-9, `centred vector has norm ${norm}`);

  /* The whole point is that it moves things. A centroid of zeros — the shape a
     botched decode would produce — would leave every cosine exactly as it was
     and this branch would be a no-op nobody noticed. */
  const before = cosine(normalizeForTest(v), normalizeForTest(Array.from({ length: 768 }, (_, i) => Math.cos(i))));
  const after = cosine(c, center(Array.from({ length: 768 }, (_, i) => Math.cos(i))));
  assert.ok(Math.abs(before - after) > 1e-6, 'centering changed nothing');
});

function normalizeForTest(v) {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / n);
}

/* The constant is a measurement, and a measurement can be truncated in a bad
   paste. 768 floats, none of them NaN, and a norm near the 0.913 the script
   reported — anything else means the literal is not what was measured. */
test('the centroid decodes to a plausible measured direction', () => {
  const norm = Math.sqrt(CORPUS_CENTROID.reduce((s, x) => s + x * x, 0));
  assert.equal(CORPUS_CENTROID.length, 768);
  assert.ok(CORPUS_CENTROID.every(Number.isFinite), 'centroid has a non-finite component');
  assert.ok(norm > 0.85 && norm < 0.98, `centroid norm ${norm} is not the measured 0.913`);
});

test('an archive entry is the whole card, abstract included', () => {
  // The stockpile is where a paper is read once it has left the feed, so it
  // holds everything the card held — including the abstract, which used to be
  // dropped for size and is the one field a browsing page cannot go without.
  const items = [{
    arxivId: '1', title: 't', link: 'l', authors: 'A', grade: 0.612, z: 2.1,
    band: 'paydirt', matched: { label: 'row label' },
    enrichment: {
      kind: 'new method', result: 'R.', question: 'Q.', prior: 'P.', limits: 'C.',
      tools: ['a', 'b'], code: 'https://github.com/x/y',
      figure_url: 'f.png', figure_caption: 'Figure 2: Ramsey decay.',
      figure_gloss: 'G.',
    },
    published: '2026-08-11',
    abstract: 'long prose nobody browses from a stockpile',
  }];
  const entry = archiveEntry(items);
  assert.equal(entry.length, 1);
  assert.equal(entry[0].id, '1');
  assert.equal(entry[0].grade, 0.612);
  assert.equal(entry[0].z, 2.1);
  assert.equal(entry[0].matched, 'row label');
  assert.equal(entry[0].abstract, 'long prose nobody browses from a stockpile');
  assert.equal(entry[0].tools, 'a · b');
  assert.equal(entry[0].code, 'https://github.com/x/y');
  assert.equal(entry[0].figure, 'f.png');
  assert.equal(entry[0].caption, 'G.', 'the gloss, not the paper\'s own caption');
  assert.ok(!('enrichment' in entry[0]), 'raw enrichment is not kept');
  assert.ok(!('verdict' in entry[0]), 'read/skim is gone from the record too');
  assert.equal(entry[0].prior, 'P.');
  assert.equal(entry[0].announced, '2026-08-11');
});

test('the archive stores rendered text, not the raw TeX', () => {
  // The stockpile has no build step of its own: whatever is in the file is what
  // the page prints.
  const [entry] = archiveEntry([{
    arxivId: '1', title: '$\\ket{\\psi}$ injection', link: 'l', authors: 'M\\"uller',
    grade: 0.5, z: null, band: 'look', matched: null, published: '2026-08-11',
    abstract: 'At $10^{-4}$.',
    enrichment: { kind: '', result: 'Was $\\mu$s.', question: '', prior: '', limits: '', tools: [] },
  }]);
  assert.equal(entry.title, '|ψ⟩ injection');
  assert.equal(entry.authors, 'Müller');
  assert.equal(entry.abstract, 'At 10⁻⁴.');
  assert.equal(entry.result, 'Was μs.');
});

test('merge month replaces old date, keeps others', () => {
  const prior = { month: '2026-08', days: {
    '2026-08-19': { 'sq1': { items: [1, 2, 3] } },
    '2026-08-20': { 'sq1': { items: [4, 5] } },
  }};
  const feeds = { 'sq1': { items: [6, 7, 8, 9] } };
  const merged = mergeMonth(prior, '2026-08-20', feeds);
  assert.equal(merged.month, '2026-08');
  assert.equal(Object.keys(merged.days).length, 2);
  assert.deepEqual(merged.days['2026-08-20'], feeds);
  assert.deepEqual(merged.days['2026-08-19'], prior.days['2026-08-19']);
});

test('archive index gathers months, reverses them, counts by band', () => {
  const months = {
    '2026-08': {
      '2026-08-20': { 'sq1': { items: [{ band: 'paydirt' }, { band: 'look' }] } },
      '2026-08-19': { 'sq1': { items: [{ band: 'paydirt' }] } },
    },
  };
  const idx = archiveIndex(months);
  assert.equal(idx.months.length, 1);
  assert.equal(idx.months[0].month, '2026-08');
  assert.equal(idx.months[0].days.length, 2);
  assert.equal(idx.months[0].days[0].date, '2026-08-20');
  assert.equal(idx.months[0].days[0].feeds['sq1'].items, 2);
  assert.equal(idx.months[0].days[0].feeds['sq1'].paydirt, 1);
});

test('the archive keeps the maths typeset beside the flat field', () => {
  // Both renderings of the same sentence: the flat one every consumer has read
  // since the archive existed, and the MathML the stockpile prints. A record
  // that carried only the second would blank a page that has not been updated.
  const [entry] = archiveEntry([{
    arxivId: '1', title: 't', link: 'l', authors: 'a',
    grade: 0.5, z: null, band: 'look', matched: null, published: '2026-08-28',
    abstract: 'x',
    enrichment: {
      kind: 'theory', result: 'Needs $C_{\\min}(K,S,\\epsilon)$ gates.',
      question: '', prior: '', limits: 'Below $\\delta_{GV}$.', tools: [],
    },
  }]);
  assert.equal(entry.result, 'Needs C_min(K,S,ε) gates.');
  assert.match(entry.html.result, /^Needs <math/);
  assert.match(entry.html.limits, /<msub><mi>δ<\/mi>/);
  assert.ok(!('question' in entry.html), 'a field with no maths grows nothing');
});

test('a brief with no maths in it grows no second copy of itself', () => {
  const [entry] = archiveEntry([{
    arxivId: '1', title: 't', link: 'l', authors: 'a',
    grade: 0.5, z: null, band: 'look', matched: null, published: '2026-08-28',
    abstract: 'x',
    enrichment: { kind: '', result: 'Was 1.1 ms. Now 3.4 ms.', question: '', prior: '', limits: '', tools: [] },
  }]);
  assert.ok(!('html' in entry));
});

const FIGS = path.join(os.tmpdir(), 'arxave-figure-test');

test('a mirrored figure is named for the paper and the figure', async () => {
  // The name is the idempotence: re-running a day overwrites the same file
  // rather than growing a second copy of the same picture.
  const written = [];
  const mirror = figureMirror({
    dir: FIGS, site: 'https://arxave.com/',
    write: async (file, body) => { written.push([file, body]); },
  });
  const url = await mirror('2608.26272', { id: 'S0.F1', svg: '<svg viewBox="0 0 1 1"/>' });
  assert.equal(url, 'https://arxave.com/figures/2608.26272-S0.F1.svg');
  assert.equal(written[0][0], path.join(FIGS, '2608.26272-S0.F1.svg'));
  assert.match(written[0][1], /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
});

test('an id that looks like a path cannot become one', () => {
  return figureMirror({
    dir: FIGS, site: 'https://arxave.com/',
    write: async (file) => {
      assert.equal(file, path.join(FIGS, '-etc-passwd-S1.F1.svg'));
    },
  })('../etc/passwd', { id: 'S1.F1', svg: '<svg/>' });
});
