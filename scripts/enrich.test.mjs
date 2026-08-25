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

import {
  cachedFields, DEEP_MAX, deepSet, enrichItems, parseResponse, promptFor,
  pruneCache, quotaReason, resolveFigure, retryDelayMs, SHAPE,
} from './enrich.mjs';

const wrap = (obj) => ({
  candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }],
});

const full = {
  verdict: 'read',
  kind: 'new result',
  result: 'Single-qubit gate fidelity 99.9995%. Isotopically purified Si.',
  question: 'How far can gate fidelity go once nuclear spins are removed?',
  prior: 'Was 99.95% on natural Si, same architecture (Yoneda 2018).',
  limits: 'One device, at 100 mK.',
  tools: ['spin-locking', 'parity readout'],
  figure: 'S3.F2',
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
    verdict: '', kind: '', result: '', question: '', prior: '', limits: '',
    tools: [], figure: '',
  })), null);
});

test('labels alone are not an enrichment', () => {
  // "Skim · incremental" over a bare abstract says nothing the abstract does
  // not, and costs the reader a line to find that out.
  assert.equal(parseResponse(wrap({ verdict: 'skim', kind: 'incremental' })), null);
});

test('a partial payload keeps what is there', () => {
  const got = parseResponse(wrap({ result: 'R.', tools: ['a'] }));
  assert.deepEqual(got, {
    verdict: '', kind: '', result: 'R.', question: '', prior: '', limits: '',
    tools: ['a'], figure: '',
  });
});

test('a missing limit is kept as absent, not as a sentence', () => {
  // Plenty of papers state no limitation. The feed omits the line; what it must
  // never do is print an invented one, so an empty string has to survive as an
  // empty string rather than being filled in downstream.
  const got = parseResponse(wrap({ ...full, limits: '' }));
  assert.equal(got.limits, '');
  assert.equal(got.result, full.result);
});

test('an unnamed baseline stays unnamed rather than being guessed at', () => {
  // `prior` is the field with the most room to be wrong: a plausible-sounding
  // "was around 99%" reads exactly like a measured comparison and is not one.
  // Abstract-tier items have no introduction to read and must simply omit it.
  const got = parseResponse(wrap({ ...full, prior: '' }));
  assert.equal(got.prior, '');
  assert.equal(got.result, full.result);
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


/* ── The two tiers ───────────────────────────────────────────────────────────
 *
 * The full-text pass is the expensive half of this file, so what it must not do
 * is run on papers it was not meant to, and what it must not fail to do is
 * re-run on a paper that has been promoted into the band since it was cached.
 * Both failures are silent: the first shows up as a bill, the second as a brief
 * that is quietly missing its two best fields.
 */

const paper = (id, band) => ({
  arxivId: id, title: 't', abstract: 'a', authors: '', band,
});

test('only the top band is read in full', () => {
  const ids = deepSet([paper('1', 'paydirt'), paper('2', 'worth'), paper('3', 'longshot')]);
  assert.deepEqual([...ids], ['1']);
});

test('the fuse holds on an unusually rich morning', () => {
  const many = Array.from({ length: DEEP_MAX + 5 }, (_, i) => paper(String(i), 'paydirt'));
  assert.equal(deepSet(many).size, DEEP_MAX);
});

test('a cached abstract-tier record is a miss once the paper is in the band', () => {
  // The promotion case. Serving the shallow record would leave the item without
  // `prior` and `limits` on exactly the day a reader is deciding to spend an
  // evening on it — and nothing anywhere would say why.
  const rec = { fields: { result: 'R.' }, shape: SHAPE, depth: 'abstract' };
  assert.ok(cachedFields(rec, false), 'still fine for the abstract tier');
  assert.equal(cachedFields(rec, true), null);
  assert.ok(cachedFields({ ...rec, depth: 'full' }, true));
});

test('an older field set is a miss at either tier', () => {
  const rec = { fields: { result: 'R.' }, shape: SHAPE - 1, depth: 'full' };
  assert.equal(cachedFields(rec, false), null);
  assert.equal(cachedFields(rec, true), null);
});

test('the model picks a figure by id; a hallucinated id falls back, not away', () => {
  const full = { figures: [{ id: 'S2.F1', src: 'a.png' }, { id: 'S4.F2', src: 'b.png' }] };
  assert.equal(resolveFigure(full, 'S4.F2').src, 'b.png');
  assert.equal(resolveFigure(full, 'S9.F9').src, 'a.png', 'falls back to the first');
  assert.equal(resolveFigure({ figures: [] }, 'S2.F1'), null);
  assert.equal(resolveFigure(null, ''), null);
});

test('the full text and the figure captions both reach the prompt', () => {
  const p = promptFor({ title: 'T', abstract: 'A', authors: 'X' }, {
    text: 'INTRODUCTION and CONCLUSION',
    figures: [{ id: 'S2.F1', caption: 'Figure 1: the overview' }],
  });
  assert.match(p, /Abstract: A/, 'the abstract stays in at the full tier');
  assert.match(p, /INTRODUCTION and CONCLUSION/);
  assert.match(p, /S2\.F1: Figure 1: the overview/);
});

test('without a full text the prompt is the abstract and no figure list', () => {
  const p = promptFor({ title: 'T', abstract: 'A', authors: '' });
  assert.match(p, /Abstract: A/);
  assert.doesNotMatch(p, /FULL TEXT/);
  assert.doesNotMatch(p, /FIGURES/);
});

/* End to end through enrichItems, with the network stood in for on both sides:
   `readFullText` is injected, and the Gemini call is stubbed by pointing the
   module at a fetch that answers with a canned candidate. */

function stubGemini(reply) {
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(reply) }] }}] }),
  });
  return () => { globalThis.fetch = real; };
}

test('a top-band paper is read in full and keeps the figure it was briefed on', async () => {
  const restore = stubGemini({ ...full, figure: 'S4.F2' });
  try {
    const read = async () => ({
      text: 'body',
      figures: [{ id: 'S2.F1', src: 'a.png', caption: 'c1' }, { id: 'S4.F2', src: 'b.png', caption: 'c2' }],
      code: ['https://github.com/x/y'],
    });
    const [it] = await enrichItems([paper('1', 'paydirt')], { apiKey: 'k', readFullText: read });
    assert.equal(it.enrichment.prior, full.prior);
    // Resolved off the paper, not generated — and carried on the record so a
    // cache hit tomorrow renders the same picture without re-fetching the HTML.
    assert.equal(it.enrichment.figure_url, 'b.png');
    assert.equal(it.enrichment.figure_caption, 'c2');
    assert.equal(it.enrichment.code, 'https://github.com/x/y');
  } finally { restore(); }
});

test('a lower-band paper is never fetched', async () => {
  const restore = stubGemini(full);
  try {
    let fetched = 0;
    const read = async () => { fetched++; return null; };
    await enrichItems([paper('2', 'worth')], { apiKey: 'k', readFullText: read });
    assert.equal(fetched, 0);
  } finally { restore(); }
});

test('a paper with no HTML degrades one step, to its abstract, not to nothing', async () => {
  const restore = stubGemini(full);
  try {
    const read = async () => null;
    const [it] = await enrichItems([paper('1', 'paydirt')], { apiKey: 'k', readFullText: read });
    assert.equal(it.enrichment.result, full.result);
    assert.equal(it.enrichment.figure_url, '');
  } finally { restore(); }
});

test('a fetch that throws still leaves the item briefed from its abstract', async () => {
  // One degradation step, never two: the fetch lives inside the same try as the
  // call precisely so a malformed HTML page cannot cost the whole brief.
  const restore = stubGemini(full);
  try {
    const read = async () => { throw new Error('ECONNRESET'); };
    const [it] = await enrichItems([paper('1', 'paydirt')], { apiKey: 'k', readFullText: read });
    assert.equal(it.enrichment.result, full.result, 'briefed from the abstract instead');
    assert.equal(it.enrichment.figure_url, '');
  } finally { restore(); }
});


/* ── Rate limits ─────────────────────────────────────────────────────────────
 *
 * MEASURED 2026-08-25: the SHAPE bump invalidated every cached record at once,
 * so a morning that normally makes a handful of calls made twenty-four back to
 * back and was rate limited after six. Two thirds of the feed shipped
 * unenriched, and the log could not say why, because the error body was
 * truncated before the part that names the quota.
 */

const quota429 = (id, delay) => ({
  error: {
    code: 429,
    message: 'You exceeded your current quota.',
    details: [
      { '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
        violations: [{ quotaId: id, quotaMetric: 'generate_content_free_tier_requests' }] },
      ...(delay ? [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: delay }] : []),
    ],
  },
});

test('the quota that was hit is named, because 429 alone does not say', () => {
  // Per-minute clears on its own; per-day does not. Same status code.
  assert.match(quotaReason(quota429('GenerateRequestsPerMinutePerProjectPerModel-FreeTier')),
    /PerMinute/);
  assert.equal(quotaReason({ error: { code: 429 } }), '');
  assert.equal(quotaReason(null), '');
});

test('the delay the API asks for is read, in ms', () => {
  assert.equal(retryDelayMs(quota429('q', '27s')), 27_000);
  assert.equal(retryDelayMs(quota429('q', '1.5s')), 1_500);
  assert.equal(retryDelayMs(quota429('q')), null, 'no RetryInfo is not zero');
  assert.equal(retryDelayMs(null), null);
});

test('a rate limit is waited out and the call retried', async () => {
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) {
      return { ok: false, status: 429, text: async () => JSON.stringify(quota429('perMinute', '3s')) };
    }
    return {
      ok: true, status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(full) }] } }] }),
    };
  };
  try {
    const [it] = await enrichItems([paper('1', 'worth')], { apiKey: 'k' });
    assert.equal(calls, 2, 'retried once');
    assert.equal(it.enrichment.result, full.result);
  } finally { globalThis.fetch = real; }
});

test('a spent daily allowance is refused by name, not by how long it asks for', async () => {
  // MEASURED 2026-08-25: a daily quota asked for 13s and then 53s — well inside
  // the retry cap — so every item burned two pointless waits and a three-minute
  // job took ten. The quota's own name is the only dependable signal.
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return {
      ok: false, status: 429,
      text: async () => JSON.stringify(quota429('GenerateRequestsPerDayPerProjectPerModel-FreeTier', '13s')),
    };
  };
  try {
    const started = Date.now();
    const [it] = await enrichItems([paper('1', 'worth')], { apiKey: 'k' });
    assert.equal(calls, 1, 'not retried, despite a delay well inside the cap');
    assert.ok(Date.now() - started < 2_000, 'and not waited on');
    assert.equal(it.enrichment, null, 'the item ships unenriched, and the feed still builds');
  } finally { globalThis.fetch = real; }
});
