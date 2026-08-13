/**
 * `node --test scripts/enrich.test.mjs`.
 *
 * The enricher's contract is that it can fail in every way an external model
 * can fail and the feed still ships. These pin the parsing side of that: every
 * malformed shape must come back as null — "no enrichment for this paper" —
 * rather than as a throw that takes the morning's feed down with it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cachedFields, parseResponse, promptFor, pruneCache, SHAPE } from './enrich.mjs';

const wrap = (obj) => ({
  candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }],
});

const full = {
  verdict: 'read',
  kind: 'new result',
  headline: 'Single-qubit gate fidelity of 99.9995% in isotopically purified Si.',
  so_what: 'Puts single-qubit control well below the surface-code threshold.',
  caveat: 'One device, at 100 mK.',
  tools: ['spin-locking', 'parity readout'],
};

test('a well-formed response becomes the fields verbatim', () => {
  assert.deepEqual(parseResponse(wrap(full)), full);
});

test('a truncated or blocked response is null, not a throw', () => {
  // finishReason MAX_TOKENS and a safety block both arrive as a candidate with
  // no usable parts. Neither may take the feed down.
  assert.equal(parseResponse({ candidates: [{ finishReason: 'MAX_TOKENS' }] }), null);
  assert.equal(parseResponse({ candidates: [] }), null);
  assert.equal(parseResponse({}), null);
  assert.equal(parseResponse(null), null);
});

test('text that is not JSON is null, not a throw', () => {
  assert.equal(parseResponse({
    candidates: [{ content: { parts: [{ text: 'I cannot help with that.' }] } }],
  }), null);
});

test('an all-empty payload is null rather than a row of blank headings', () => {
  assert.equal(parseResponse(wrap({
    verdict: '', kind: '', headline: '', so_what: '', caveat: '', tools: [],
  })), null);
});

test('labels alone are not an enrichment', () => {
  // "Skim · incremental" over a bare abstract says nothing the abstract does
  // not, and costs the reader a line to find that out.
  assert.equal(parseResponse(wrap({ verdict: 'skim', kind: 'incremental' })), null);
});

test('a partial payload keeps what is there', () => {
  const got = parseResponse(wrap({ headline: 'H.', tools: ['a'] }));
  assert.deepEqual(got, {
    verdict: '', kind: '', headline: 'H.', so_what: '', caveat: '', tools: ['a'],
  });
});

test('a missing caveat is kept as absent, not as a sentence', () => {
  // Plenty of abstracts state no limitation. The feed omits the line; what it
  // must never do is print an invented one, so an empty string has to survive
  // as an empty string rather than being filled in downstream.
  const got = parseResponse(wrap({ ...full, caveat: '' }));
  assert.equal(got.caveat, '');
  assert.equal(got.headline, full.headline);
});

test('a verdict outside the enum is dropped rather than passed through', () => {
  // The schema is enforced server-side, but a model that answers "worth a
  // skim" must not reach the stylesheet, which switches on the exact string.
  assert.equal(parseResponse(wrap({ ...full, verdict: 'worth a skim' })).verdict, '');
  assert.equal(parseResponse(wrap({ ...full, verdict: 'READ' })).verdict, 'read');
  assert.equal(parseResponse(wrap({ ...full, kind: 'groundbreaking' })).kind, '');
});

test('tools that are not an array do not become one', () => {
  const got = parseResponse(wrap({ ...full, tools: 'a string' }));
  assert.deepEqual(got.tools, []);
});

test('a cached record from an older field set is a miss, not a half-item', () => {
  // The 2026-08 cache holds {research_question, tools, summary}. Serving those
  // would render a card with no verdict next to cards that have one, and
  // nothing in the feed would say why.
  assert.equal(cachedFields({ fields: { research_question: 'Q?' }, seen: '2026-08-12' }), null);
  assert.equal(cachedFields({ fields: full, seen: '2026-08-12', shape: SHAPE }), full);
  assert.equal(cachedFields({ seen: '2026-08-12', shape: SHAPE }), null);
  assert.equal(cachedFields(null), null);
});

test('the prompt carries title and abstract, and survives a missing author list', () => {
  const p = promptFor({ title: 'T', abstract: 'A', authors: '' });
  assert.match(p, /Title: T/);
  assert.match(p, /Abstract: A/);
  assert.doesNotMatch(p, /Authors:/);
});

test('the cache drops what nobody has seen in a month', () => {
  const cache = {
    fresh: { fields: {}, seen: '2026-08-12' },
    edge: { fields: {}, seen: '2026-07-13' },
    stale: { fields: {}, seen: '2026-06-01' },
    broken: {},
  };
  assert.deepEqual(Object.keys(pruneCache(cache, '2026-08-12')).sort(), ['edge', 'fresh']);
});
