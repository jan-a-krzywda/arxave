/**
 * `node --test scripts/sieve-ui.test.mjs`.
 *
 * sieve-ui is the Sieve page's glue — the RSS/Atom readers, the cache key, the
 * embed and cache calls, the localStorage wrapper, the card strings — so this is
 * where a silent failure would live: a title read with the wrong tag, a vector
 * attached to the wrong abstract, a key built from a different string than the
 * warmer used, a slider position that cannot be read back.
 *
 * Nothing here touches the network or the DOM: every fetch is a plain function,
 * and the fixtures are hand-written XML shaped like arXiv's two feeds (measured
 * against rss.arxiv.org and export.arxiv.org). The one test that uses the real
 * scoring code goes through sieve-core unchanged, because the point of it is
 * that the page's own corpus shape works with the real ranker.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CorpusMissing, bareArxivId, cacheKeyText, cacheLookup, cardHtml, createRelay, cutoffDate,
  decodeEntities, demoCandidates, demoCorpus, embedCandidates, embedTexts, escapeHtml,
  fetchAnnouncement, joinUrl, loadCorpusFrom, paperEmbedText, parseAnnouncementRSS,
  parseAtomEntries, readStore, refineHtml, refineResultFrom, relayUrl, writeStore,
} from '../docs/assets/sieve-ui.mjs';
import { loadCorpus, prepare, rank } from '../docs/assets/sieve-core.mjs';

/* ── fetch doubles ──────────────────────────────────────────────────────── */

const header = { get: () => null };
const ok = (body) => ({ ok: true, status: 200, headers: header, json: async () => body, text: async () => JSON.stringify(body) });
const missing = () => ({ ok: false, status: 404, headers: header, json: async () => ({}), text: async () => 'Not Found' });
const text = (body, opts = {}) => ({ ok: opts.status ? opts.status < 400 : true, status: opts.status || 200, headers: header, text: async () => body });

/* ── fixtures ───────────────────────────────────────────────────────────── */

/* One announcement feed: a new paper, a cross-list, and a replacement that the
   reader must never see. The description carries arXiv's boilerplate header and
   an escaped tag, exactly as the real feed does. */
const FEED = `<?xml version="1.0" encoding="utf-8"?>
<rdf:RDF xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/"
         xmlns:arxiv="http://arxiv.org/schemas/atom">
  <item rdf:about="https://arxiv.org/abs/2511.00001">
    <title>Critical Li\\&quot;uders $\\Omega$ bound in a transmon</title>
    <link>https://arxiv.org/abs/2511.00001</link>
    <description>arXiv:2511.00001v1 Announce Type: new
Abstract: We measure &lt;b&gt;the bound&lt;/b&gt; at 1{\\deg}.</description>
    <dc:creator>Ada Lovelace, Alan Turing</dc:creator>
    <category>quant-ph</category>
    <arxiv:announce_type>new</arxiv:announce_type>
    <pubDate>Mon, 09 Nov 2026 00:00:00 -0500</pubDate>
  </item>
  <item rdf:about="https://arxiv.org/abs/2511.00002">
    <title>Hall response in a twisted bilayer</title>
    <link>https://arxiv.org/abs/2511.00002v2</link>
    <description>arXiv:2511.00002v2 Announce Type: cross
Abstract: A cross-list into cond-mat.</description>
    <dc:creator>Grace Hopper</dc:creator>
    <category>cond-mat.mes-hall</category>
    <arxiv:announce_type>cross</arxiv:announce_type>
    <pubDate>Mon, 09 Nov 2026 00:00:00 -0500</pubDate>
  </item>
  <item rdf:about="https://arxiv.org/abs/2501.09999">
    <title>An older paper with a second version</title>
    <link>https://arxiv.org/abs/2501.09999</link>
    <description>arXiv:2501.09999v3 Announce Type: replace
Abstract: Not tonight's haul.</description>
    <dc:creator>Someone Else</dc:creator>
    <category>quant-ph</category>
    <arxiv:announce_type>replace</arxiv:announce_type>
    <pubDate>Mon, 09 Nov 2026 00:00:00 -0500</pubDate>
  </item>
</rdf:RDF>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2511.00003v1</id>
    <title>A quantum advantage  for  sampling</title>
    <summary>Dated, and read back as the tenth of November.</summary>
    <author><name>Rosalind Franklin</name></author>
    <published>2026-11-10T01:02:03Z</published>
    <category term="quant-ph"/>
  </entry>
</feed>`;

/* ── text ───────────────────────────────────────────────────────────────── */

test('cacheKeyText collapses whitespace exactly as the warmer does', () => {
  assert.equal(cacheKeyText('  a\n b\t\tc  '), 'a b c');
  assert.equal(cacheKeyText(''), '');
  assert.equal(cacheKeyText(undefined), '');
});

test('paperEmbedText is the string corpus-build embeds under', () => {
  /* Title, a space, abstract — and the title twice when there is no abstract,
     which is what scripts/warm-dig.mjs coreEmbedText does. */
  assert.equal(paperEmbedText('A  title', ' an  abstract '), 'A title an abstract');
  assert.equal(paperEmbedText('A title', ''), 'A title A title');
});

test('bareArxivId strips the version, the URL and the arxiv: prefix', () => {
  assert.equal(bareArxivId('https://arxiv.org/abs/2508.12345v2'), '2508.12345');
  assert.equal(bareArxivId('arxiv:2508.12345'), '2508.12345');
  assert.equal(bareArxivId(' 2508.12345 '), '2508.12345');
});

test('escapeHtml closes the markup a title could open', () => {
  assert.equal(escapeHtml('<img src=x onerror="a&b">'), '&lt;img src=x onerror=&quot;a&amp;b&quot;&gt;');
  assert.equal(escapeHtml(''), '');
  assert.equal(escapeHtml(undefined), '');
});

test('decodeEntities handles named, decimal and hex entities and leaves the rest', () => {
  assert.equal(decodeEntities('&amp;&lt;&#39;&#x27;&nbsp;&unknown;'), "&<'' &unknown;");
});

/* ── the two feeds ──────────────────────────────────────────────────────── */

test('parseAnnouncementRSS reads new and cross items and drops replacements', () => {
  const papers = parseAnnouncementRSS(FEED, 'quant-ph');
  assert.equal(papers.length, 2);
  assert.deepEqual(papers.map((p) => p.id), ['2511.00001', '2511.00002']);

  const [first, cross] = papers;
  assert.equal(first.title, 'Critical Li\\"uders $\\Omega$ bound in a transmon');
  /* The boilerplate header is cut, entities decoded, and TeX escapes deliberately
     left alone (see the note at the top of sieve-ui.mjs). */
  assert.equal(first.abstract, 'We measure <b>the bound</b> at 1{\\deg}.');
  assert.deepEqual(first.authors, ['Ada Lovelace', 'Alan Turing']);
  assert.equal(first.primary_category, 'quant-ph');
  assert.equal(first.published, '2026-11-09');
  assert.equal(first.abs_url, 'https://arxiv.org/abs/2511.00001');
  assert.equal(cross.published, '2026-11-09');
});

test('parseAnnouncementRSS falls back to the scouted category and survives junk', () => {
  assert.deepEqual(parseAnnouncementRSS('not xml at all', 'quant-ph'), []);
  const bare = '<item><link>https://arxiv.org/abs/2511.00009</link><title>No type tag</title></item>';
  const [paper] = parseAnnouncementRSS(bare, 'cond-mat.mes-hall');
  assert.equal(paper.primary_category, 'cond-mat.mes-hall');
  assert.equal(paper.abstract, '');
});

test('parseAtomEntries reads the search API feed', () => {
  const [paper] = parseAtomEntries(ATOM);
  assert.equal(paper.id, '2511.00003');
  assert.equal(paper.title, 'A quantum advantage for sampling');
  assert.equal(paper.abstract, 'Dated, and read back as the tenth of November.');
  assert.deepEqual(paper.authors, ['Rosalind Franklin']);
  assert.equal(paper.primary_category, 'quant-ph');
  assert.equal(paper.published, '2026-11-10');
});

test('cutoffDate counts weekdays back, not calendar days', () => {
  /* 2026-11-09 is a Monday; three announcements back is the Wednesday before. */
  const monday = new Date('2026-11-09T00:00:00Z');
  assert.equal(monday.getUTCDay(), 1);
  assert.equal(cutoffDate(monday, 1), '2026-11-06');   // Friday
  assert.equal(cutoffDate(monday, 3), '2026-11-04');
  assert.equal(cutoffDate(monday, 7), '2026-10-29');
});

/* ── the relay ──────────────────────────────────────────────────────────── */

test('relayUrl appends the target to a bare or query-carrying base', () => {
  assert.equal(relayUrl('https://relay.example/', 'https://a/b c'), 'https://relay.example/?url=https%3A%2F%2Fa%2Fb%20c');
  assert.equal(relayUrl('https://relay.example/?key=1', 'https://a'), 'https://relay.example/?key=1&url=https%3A%2F%2Fa');
  assert.equal(relayUrl('https://relay.example/?url=', 'https://a'), 'https://relay.example/?url=https%3A%2F%2Fa');
});

test('createRelay retries a retryable status and gives up on a verdict', async () => {
  const slept = [];
  let calls = 0;
  const fetchViaRelay = createRelay({
    relayBase: 'r/',
    gap: 3000,
    sleep: async (ms) => { slept.push(ms); },
    fetchImpl: async () => {
      calls++;
      return calls < 3 ? { ok: false, status: 503, headers: header } : ok({});
    },
  });
  const resp = await fetchViaRelay('https://a');
  assert.equal(resp.ok, true);
  assert.equal(calls, 3);
  /* Two backoffs, starting above the 3 s arXiv asks for. */
  assert.deepEqual(slept, [3000, 6000]);

  const verdict = createRelay({
    relayBase: 'r/', sleep: async () => {}, fetchImpl: async () => ({ ok: false, status: 404, headers: header }),
  });
  assert.equal((await verdict('https://a')).status, 404);
});

test('createRelay paces the next upstream call and skips a cached one', async () => {
  const slept = [];
  const queue = [
    { ok: true, status: 200, headers: { get: () => null } },      // went upstream
    { ok: true, status: 200, headers: { get: () => 'hit' } },     // cost nothing
  ];
  const fetchViaRelay = createRelay({
    relayBase: 'r/', gap: 3000, sleep: async (ms) => { slept.push(ms); }, fetchImpl: async () => queue.shift(),
  });
  await fetchViaRelay('https://a');
  assert.deepEqual(slept, [], 'the first call has nothing to wait for');
  await fetchViaRelay('https://b');
  assert.equal(slept.length, 1, 'the second waits');
  assert.ok(slept[0] <= 3000 && slept[0] > 0);
});

test('fetchAnnouncement dedupes across categories and survives one bad feed', async () => {
  const { candidates, failures } = await fetchAnnouncement({
    categories: ['quant-ph', 'cond-mat.mes-hall'],
    lookback: 1,
    fetchViaRelay: async (url) => (url.includes('quant-ph') ? text(FEED) : text('gone', { status: 404 })),
  });
  assert.deepEqual(candidates.map((c) => c.id), ['2511.00001', '2511.00002']);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /^cond-mat\.mes-hall → HTTP 404/);
});

test('fetchAnnouncement adds the search API only for a lookback past tonight', async () => {
  const asked = [];
  const fetchViaRelay = async (url) => {
    asked.push(url);
    return url.includes('rss.arxiv.org') ? text(FEED) : text(ATOM);
  };
  const short = await fetchAnnouncement({ categories: ['quant-ph'], lookback: 1, fetchViaRelay });
  assert.equal(asked.length, 1);
  assert.equal(short.candidates.length, 2);

  /* The Atom entry is dated 2026-11-10, inside a three-day window from the ninth. */
  const long = await fetchAnnouncement({
    categories: ['quant-ph'],
    lookback: 3,
    now: new Date('2026-11-09T00:00:00Z'),
    fetchViaRelay: async (url) => (url.includes('api/query') ? text(ATOM) : text(FEED)),
  });
  assert.deepEqual(long.candidates.map((c) => c.id), ['2511.00001', '2511.00002', '2511.00003']);
});

test('fetchAnnouncement throws only when every source failed', async () => {
  await assert.rejects(
    () => fetchAnnouncement({ categories: ['quant-ph'], fetchViaRelay: async () => text('no', { status: 500 }) }),
    /arXiv scout failed/,
  );
});

/* ── the corpus ─────────────────────────────────────────────────────────── */

test('joinUrl keeps exactly one slash', () => {
  assert.equal(joinUrl('/assets/corpus/', 'corpus.json'), '/assets/corpus/corpus.json');
  assert.equal(joinUrl('/assets/corpus', 'corpus.json'), '/assets/corpus/corpus.json');
  assert.equal(joinUrl('', 'corpus.json'), 'corpus.json');
});

test('loadCorpusFrom reports a missing corpus as CorpusMissing', async () => {
  await assert.rejects(
    () => loadCorpusFrom('/assets/corpus/', { fetchImpl: async () => missing() }),
    (err) => err instanceof CorpusMissing && /HTTP 404/.test(err.message),
  );

  const { json, bin } = await loadCorpusFrom('/c/', {
    fetchImpl: async (url) => (url.endsWith('corpus.json')
      ? ok({ n: 1 })
      : { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) }),
  });
  assert.equal(json.n, 1);
  assert.equal(bin.byteLength, 8);
});

test('the demo corpus is one the real ranker can load and rank', () => {
  const { json, bin } = demoCorpus();
  const corpus = loadCorpus(json, bin);
  assert.equal(corpus.n, 40);
  assert.equal(corpus.dim, 768);
  assert.equal(corpus.clusters.length, 4);
  assert.equal(corpus.mean.length, 768);

  const candidates = demoCandidates(corpus, 6);
  assert.equal(candidates.length, 6);
  /* Already centred and unit, which is what rank() requires. */
  const norm = Math.hypot(...candidates[0].vec);
  assert.ok(Math.abs(norm - 1) < 1e-3, `demo candidate is unit, got ${norm}`);

  const ranked = rank(prepare({ corpus, weights: {}, touchstones: [] }), candidates, { gate: -2 });
  assert.equal(ranked.length, 6);
  for (let i = 1; i < ranked.length; i++) assert.ok(ranked[i - 1].score >= ranked[i].score);
  assert.equal(ranked[0].landmarks.length, 3);

  /* Strictness gates, and a single-topic weighting pulls that topic to the top:
     the generator put candidates 1 and 5 in topic 0. */
  const strict = rank(prepare({ corpus, weights: {} }), candidates, { gate: 2 });
  assert.ok(strict.length < 6);
  const weights = { 0: 1, 1: 0, 2: 0, 3: 0 };
  const topic0 = rank(prepare({ corpus, weights, touchstones: [] }), candidates, { gate: -2 });
  assert.ok(['demo.0001', 'demo.0005'].includes(topic0[0].id), `topic 0 wins, got ${topic0[0].id}`);
});

/* ── embedding and the cache ────────────────────────────────────────────── */

test('embedTexts puts vectors back in the order they were asked for', async () => {
  const vectors = await embedTexts({
    texts: ['a', 'b'],
    embedUrl: 'embed',
    dim: 4,
    fetchImpl: async (url, opts) => {
      assert.deepEqual(JSON.parse(opts.body).input, ['a', 'b']);
      return ok({
        model: 'allenai/specter2_base',
        dim: 4,
        /* Out of order, which an OpenAI-shaped reply is allowed to be. */
        data: [{ index: 1, embedding: [0, 2, 0, 0] }, { index: 0, embedding: [5, 0, 0, 0] }],
      });
    },
  });
  assert.deepEqual([...vectors[0]], [1, 0, 0, 0]);
  assert.deepEqual([...vectors[1]], [0, 1, 0, 0]);
});

test('embedTexts refuses a reply it cannot trust', async () => {
  const reply = (body) => async () => ok(body);
  const args = (data) => ({ texts: ['a'], embedUrl: 'e', dim: 4, fetchImpl: reply(data) });
  await assert.rejects(() => embedTexts(args({ model: 'other/model', dim: 4, data: [] })), /running other\/model/);
  await assert.rejects(() => embedTexts(args({ dim: 4, data: [] })), /0 vectors for 1 texts/);
  await assert.rejects(
    () => embedTexts(args({ dim: 4, data: [{ index: 7, embedding: [1, 0, 0, 0] }] })),
    /bad index/,
  );
  const offline = { ...args({ dim: 4, data: [] }), fetchImpl: async () => { throw new Error('offline'); } };
  await assert.rejects(() => embedTexts(offline), /Could not reach the pick/);
});

test('cacheLookup normalises a hit and treats every failure as a miss', async () => {
  const vector = new Float32Array([3, 0, 0, 4]);   // |v| = 5
  const base64 = Buffer.from(new Uint8Array(vector.buffer)).toString('base64');
  const asks = [];
  const hits = await cacheLookup({
    texts: ['a  b'],
    cacheUrl: 'cache',
    dim: 4,
    fetchImpl: async (url, opts) => {
      const body = JSON.parse(opts.body);
      asks.push(body.sha[0]);
      assert.equal(body.model, 'allenai/specter2_base');
      return ok({ hits: { [body.sha[0]]: base64 } });
    },
  });
  assert.equal(asks.length, 1);
  /* Float32, so compared as halves rather than as decimals. */
  const [x, y, z, w] = hits.hits[asks[0]];
  assert.ok(Math.abs(x - 0.6) < 1e-6 && y === 0 && z === 0 && Math.abs(w - 0.8) < 1e-6,
    `normalised hit is [0.6, 0, 0, 0.8], got ${[x, y, z, w]}`);

  const down = await cacheLookup({ texts: ['a'], cacheUrl: 'cache', dim: 4, fetchImpl: async () => text('no', { status: 500 }) });
  assert.deepEqual(down.hits, {});
  assert.equal(down.shas.length, 1);
  assert.deepEqual(await cacheLookup({ texts: ['a'], cacheUrl: null, dim: 4 }), { shas: [], hits: {} });
});

test('embedCandidates embeds only the misses, in order', async () => {
  const base64 = Buffer.from(new Uint8Array(new Float32Array([1, 0, 0, 0]).buffer)).toString('base64');
  const embedded = [];
  const vectors = await embedCandidates({
    texts: ['cached', 'fresh'],
    embedUrl: 'embed',
    cacheUrl: 'cache',
    dim: 4,
    fetchImpl: async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (url === 'cache') return ok({ hits: { [body.sha[0]]: base64 } });   // only the first sha answers
      embedded.push(...body.input);
      return ok({ dim: 4, data: body.input.map((_, i) => ({ index: i, embedding: [0, 1, 0, 0] })) });
    },
  });
  assert.deepEqual(embedded, ['fresh']);
  assert.deepEqual([...vectors[0]], [1, 0, 0, 0]);
  assert.deepEqual([...vectors[1]], [0, 1, 0, 0]);
  assert.equal(vectors.cached, 1);
});

/* ── localStorage, cards and refusals ──────────────────────────────────── */

test('the storage wrapper reads back what it wrote and never throws', () => {
  const store = {
    data: {},
    deny: false,
    getItem(k) { if (this.deny) throw new Error('denied'); return k in this.data ? this.data[k] : null; },
    setItem(k, v) { if (this.deny) throw new Error('denied'); this.data[k] = v; },
  };
  assert.equal(writeStore(store, 'k', { gate: 1 }), true);
  assert.deepEqual(readStore(store, 'k', null), { gate: 1 });
  assert.equal(readStore(store, 'absent', 'fallback'), 'fallback');

  store.deny = true;
  assert.equal(writeStore(store, 'k', 1), false);
  assert.equal(readStore(store, 'k', 'fallback'), 'fallback');

  store.deny = false;
  store.data.k = '{ not json';
  assert.equal(readStore(store, 'k', 'fallback'), 'fallback');
});

test('cardHtml links the title, escapes it and shows the why in one line', () => {
  const html = cardHtml({
    id: '2511.00001',
    title: 'A <script>alert(1)</script> title',
    abs_url: 'https://arxiv.org/abs/2511.00001',
    fit: 1.83,
    impact: 0.834,
    landmarks: [{ id: 'x', title: 'Proven & true', sim: 0.5, pct: 0.9 }],
  });
  assert.match(html, /<a href="https:\/\/arxiv\.org\/abs\/2511\.00001" rel="noopener">A &lt;script&gt;/);
  assert.ok(!html.includes('<script>'));
  assert.match(html, /fit \+1\.8/);
  assert.match(html, /impact 0\.83/);
  assert.match(html, /looks like: Proven &amp; true/);
  assert.match(html, /data-refine="2511\.00001"/);

  /* Demo papers have no arXiv page to link to. */
  const demo = cardHtml({ id: 'demo.0001', title: 'Demo paper', fit: -0.4, impact: 0, landmarks: [] });
  assert.ok(!demo.includes('<a href'));
  assert.match(demo, /fit -0\.4/);
});

test('refineResultFrom says the budget in words and passes an answer through', () => {
  assert.match(refineResultFrom(429, { error: 'budget' }).error, /budget for today is spent/);
  assert.match(refineResultFrom(200, { error: 'budget' }).error, /budget for today is spent/);
  assert.match(refineResultFrom(503, null).error, /not configured/);
  assert.match(refineResultFrom(502, null).error, /HTTP 502/);
  const answer = { relevance: 4, novelty: 2, why: 'close', adds: 'more' };
  assert.equal(refineResultFrom(200, answer), answer);
});

test('refineHtml renders the scores inline and escapes the prose', () => {
  const html = refineHtml({ relevance: 4, novelty: 2, why: '<b>close</b> to the goal', adds: '' });
  assert.match(html, /relevance 4\/5/);
  assert.match(html, /novelty 2\/5/);
  assert.match(html, /&lt;b&gt;close&lt;\/b&gt;/);
  assert.match(refineHtml({ error: 'gone' }), /sv-refine-err">gone/);
  assert.equal(refineHtml(null), '');
});
