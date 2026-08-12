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

import { cosine, grade, renderFeed, selectItems, xmlEscape } from './preset-feed.mjs';

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

test('a paper far above the day baseline is kept, the bulk is not', () => {
  const picked = selectItems(spread, { minZ: 2.0, maxItems: 15 });
  assert.deepEqual(picked.map((p) => p.grade), [0.90]);
});

test('lowering the gate lets the next tier in, in grade order', () => {
  // z here is 4.72 and 1.35; the next paper down (0.65) sits at 0.84 and stays
  // out, which is the point — the tiers are set by the spread, not by rank.
  const picked = selectItems(spread, { minZ: 1.0, maxItems: 15 });
  assert.deepEqual(picked.map((p) => p.grade), [0.90, 0.70]);
});

test('maxItems is a ceiling, never a target', () => {
  // The failure this prevents: padding a quiet day to a fixed ten, which is how
  // a feed teaches people to stop opening it.
  assert.equal(selectItems(spread, { minZ: 2.0, maxItems: 10 }).length, 1);
  assert.equal(selectItems(spread, { minZ: 0.5, maxItems: 2 }).length, 2);
});

test('a day where nothing stands out yields an empty feed, not a filled one', () => {
  const flat = [0.60, 0.601, 0.602, 0.599].map((g, i) => ({ arxivId: String(i), grade: g }));
  assert.equal(selectItems(flat, { minZ: 3.0, maxItems: 15 }).length, 0);
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
      enrichment: { research_question: 'Why?', tools: ['a', 'b'], summary: 'They did.' },
    }],
  });
  assert.match(xml, /xmlns:arxave="https:\/\/arxave\.com\/ns\/feed"/);
  assert.match(xml, /<arxave:question>Why\?<\/arxave:question>/);
  assert.match(xml, /<arxave:tools>a · b<\/arxave:tools>/);
  assert.match(xml, /<arxave:summary>They did\.<\/arxave:summary>/);
  assert.match(xml, /<arxave:abstract>the abstract<\/arxave:abstract>/);
  assert.match(xml, /<arxave:z>3\.5<\/arxave:z>/);
});

test('an unenriched item omits the generated elements rather than emptying them', () => {
  const xml = renderFeed({
    preset: { name: 'P' }, slug: 's', site: 'https://arxave.com/', builtOn: '2026-08-12',
    items: [{
      arxivId: '1', title: 't', link: 'l', abstract: 'a', authors: '', grade: 0.7, z: null,
      enrichment: null,
    }],
  });
  assert.doesNotMatch(xml, /arxave:question/);
  assert.doesNotMatch(xml, /arxave:z/);
  assert.match(xml, /<arxave:abstract>a<\/arxave:abstract>/);
});
