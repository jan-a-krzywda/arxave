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

import { cosine, grade, renderFeed, xmlEscape } from './preset-feed.mjs';

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
