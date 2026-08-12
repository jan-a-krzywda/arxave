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

import { parseResponse, promptFor, pruneCache } from './enrich.mjs';

const wrap = (obj) => ({
  candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }],
});

test('a well-formed response becomes the three fields', () => {
  const got = parseResponse(wrap({
    research_question: 'What limits gate fidelity?',
    tools: ['spin-locking', 'parity readout'],
    summary: 'They measured it.',
  }));
  assert.deepEqual(got, {
    research_question: 'What limits gate fidelity?',
    tools: ['spin-locking', 'parity readout'],
    summary: 'They measured it.',
  });
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

test('an all-empty payload is null rather than three blank fields', () => {
  // Rendering "Question. Tools. Summary." with nothing after them is worse than
  // rendering the abstract alone.
  assert.equal(parseResponse(wrap({ research_question: '', tools: [], summary: '' })), null);
});

test('a partial payload keeps what is there', () => {
  const got = parseResponse(wrap({ research_question: 'Q?', summary: '' }));
  assert.deepEqual(got, { research_question: 'Q?', tools: [], summary: '' });
});

test('tools that are not an array do not become one', () => {
  const got = parseResponse(wrap({ research_question: 'Q?', tools: 'a string', summary: 'S' }));
  assert.deepEqual(got.tools, []);
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
