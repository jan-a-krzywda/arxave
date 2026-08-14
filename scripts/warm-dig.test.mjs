/**
 * `node --test scripts/warm-dig.test.mjs` (after `npm install` in this dir).
 *
 * These tests all defend one property: **the warmer must hash the same string
 * the browser hashes.** Nothing enforces that at runtime — a divergence does
 * not throw, it just means every vector is filed under a key nobody looks up,
 * and the page stays slow while the job reports success. So the parse has to be
 * pinned here, against the same inputs `parseAnnouncementRSS` in
 * `docs/assets/filter.js` handles.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  bareArxivId, cacheKeyText, coreEmbedText, cutoffDate, deLatex, doiKey,
  feedBuildDate, fetchEarlier, parseAtom, parseFeed, presetUnits,
  reconstructAbstract, resolveEndpoint, withinCutoff,
} from './warm-dig.mjs';

const DEFAULT = 'https://ugxxakguqgpxpdfhgtsb.supabase.co/functions/v1/dig-cache';

test('an unset Actions variable does not become the endpoint', () => {
  // `env: DIG_CACHE_URL: ${{ vars.NOT_SET }}` hands us '', not undefined. With
  // `??` that passed straight through and failed 20 s later inside fetch, after
  // the whole day had been embedded and with nowhere to put it.
  assert.equal(resolveEndpoint(null, ''), DEFAULT);
  assert.equal(resolveEndpoint(undefined, undefined), DEFAULT);
});

test('the flag wins over the environment, which wins over the default', () => {
  assert.equal(resolveEndpoint('https://a.test/x', 'https://b.test/y'), 'https://a.test/x');
  assert.equal(resolveEndpoint(null, 'https://b.test/y'), 'https://b.test/y');
});

test('a malformed endpoint fails immediately, not after embedding', () => {
  assert.throws(() => resolveEndpoint('not-a-url', null), /not a valid URL/);
});

function feed(items) {
  return `<?xml version="1.0" encoding="UTF-8"?><rss><channel>${items.join('')}</channel></rss>`;
}

function item({ id = '2508.00001', announce = 'new', desc = 'Abstract: hello' }) {
  return `<item><link>https://arxiv.org/abs/${id}</link>` +
    `<arxiv:announce_type>${announce}</arxiv:announce_type>` +
    `<description>${desc}</description></item>`;
}

/* The build date is how the warmer tells today's listing from yesterday's still
   being served. Getting it wrong is the failure that reports success. */
test('the feed build date is read as a UTC date', () => {
  const xml = '<?xml version="1.0"?><rss><channel>' +
    '<lastBuildDate>Wed, 12 Aug 2026 04:00:21 +0000</lastBuildDate>' +
    '<pubDate>Wed, 12 Aug 2026 00:00:00 -0400</pubDate>' +
    '</channel></rss>';
  assert.equal(feedBuildDate(xml), '2026-08-12');
});

test('midnight Eastern in pubDate is 04:00 UTC the same day, not the day before', () => {
  // The whole confusion in one assertion: arXiv stamps midnight ET, which lands
  // at 04:00 UTC on the *same* date. A run at 02:00 UTC is before the rebuild.
  const xml = '<?xml version="1.0"?><rss><channel>' +
    '<pubDate>Wed, 12 Aug 2026 00:00:00 -0400</pubDate></channel></rss>';
  assert.equal(feedBuildDate(xml), '2026-08-12');
});

test('a feed with no date reads as unknown, not as today', () => {
  // Unknown must not be mistaken for fresh, and must not halt the run either.
  assert.equal(feedBuildDate('<?xml version="1.0"?><rss><channel></channel></rss>'), '');
  assert.equal(feedBuildDate('<?xml version="1.0"?><rss><channel>' +
    '<lastBuildDate>not a date</lastBuildDate></channel></rss>'), '');
});

test('numeric character references decode, as DOMParser decodes them', () => {
  // The bug this is here for: fast-xml-parser's default options decode the five
  // named XML entities and leave `&#8722;` as eight literal characters, where a
  // browser gives back a minus sign. Physics abstracts are full of these.
  const [stone] = parseFeed(feed([
    item({ desc: 'Abstract: a &amp; b &lt;c&gt; &quot;d&quot; &#8722;1 &#x3b1;' }),
  ]));
  assert.equal(stone.abstract, 'a & b <c> "d" −1 α');
});

test('the announcement header is stripped, so only the abstract is embedded', () => {
  const [stone] = parseFeed(feed([
    item({ desc: 'arXiv:2508.00001v1 Announce Type: new \nAbstract: the real text' }),
  ]));
  assert.equal(stone.abstract, 'the real text');
});

test("replacements are dropped — they are old papers, not tonight's haul", () => {
  const stones = parseFeed(feed([
    item({ id: '1', announce: 'new' }),
    item({ id: '2', announce: 'cross' }),
    item({ id: '3', announce: 'replace' }),
    item({ id: '4', announce: 'replace-cross' }),
  ]));
  assert.deepEqual(stones.map((s) => s.arxivId), ['1', '2']);
});

test('whitespace is collapsed the way the browser collapses it', () => {
  const [stone] = parseFeed(feed([
    item({ desc: 'Abstract: two   spaces\nand\ta newline ' }),
  ]));
  assert.equal(stone.abstract, 'two spaces and a newline');
  assert.equal(cacheKeyText('  a \n b  '), 'a b');
});

test('a single-item feed is not mistaken for a bare object', () => {
  // fast-xml-parser hands back an object, not an array, when there is one item.
  assert.equal(parseFeed(feed([item({})])).length, 1);
});

test('an empty feed yields nothing rather than throwing', () => {
  assert.deepEqual(parseFeed(feed([])), []);
});

test('an item with no abstract is skipped, not cached as an empty string', () => {
  assert.deepEqual(parseFeed(feed([item({ desc: '' })])), []);
});

/* LaTeX escapes. Same property again, and the sharpest case of it: the feed
   spells the author's LaTeX, the search API — which the browser reads for any
   day past tonight — spells Unicode. Both sides normalise towards the API's
   spelling, so an abstract hauled from either source lands on one key. */

const CASES = [
  ['L\\"uders bound', 'Lüders bound'],
  ["stabilizer R\\'enyi entropy", 'stabilizer Rényi entropy'],
  ['Schr\\"{o}dinger', 'Schrödinger'],
  ['{\\"U}ber die Quantenmechanik', 'Über die Quantenmechanik'],
  ['Poincar\\\'{e} section', 'Poincaré section'],
  ['Ma\\~né, Erd\\H{o}s, Ha\\c{c}, Ne\\v{s}et', 'Mañé, Erdős, Haç, Nešet'],
  // `\i` eats its terminating space like any other control word — 'iand', not
  // 'i and'. TeX does the same, and matching TeX is what matches the API.
  ['the \\i and the \\"\\i', 'the iand the ï'],
  ['$\\Omega$ and $\\beta$', '$Ω$ and $β$'],
  ['$1\\,\\mu\\mathrm{s}$', '$1\\,μ\\mathrm{s}$'],
  ['vanish at 1{\\deg}', 'vanish at 1°'],
  // Both control words eat their terminating space, as `\i` above does.
  ['Wei\\ss and \\O rsted', 'Weißand Ørsted'],
];

test('the feed spelling becomes the API spelling', () => {
  for (const [latex, unicode] of CASES) assert.equal(deLatex(latex), unicode);
});

test('a control word eats the space that terminates it, as TeX does', () => {
  // Measured against the live API 2026-08-14: the feed's `$\Delta \approx 8.8$`
  // is `$Δ\approx 8.8$` there. Keep the space and the two still hash apart.
  assert.equal(deLatex('$\\Delta \\approx 8.8$'), '$Δ\\approx 8.8$');
});

test('a brace group survives — the closing brace is not eaten', () => {
  // The bug the two-regex shape exists for: with `\{?…\}?` the greek pass ate
  // the group's closing brace and `$|x|^{-2\Delta}$` came out unbalanced.
  assert.equal(deLatex('$|x|^{-2\\Delta}$'), '$|x|^{-2Δ}$');
  assert.equal(deLatex('${\\Delta}$'), '$Δ$');
});

test('everything unrecognised passes through untouched', () => {
  // `\alphas` included on purpose: a command is its whole run of letters, so
  // this is `\alphas` and not `\alpha` with an s stuck to it.
  for (const s of ['$\\mathrm{d}x$', 'a \\, b', '\\version{2}', '\\understand',
    '100\\% of \\alphas', 'no latex at all']) {
    assert.equal(deLatex(s), s);
  }
  assert.equal(deLatex(''), '');
  assert.equal(deLatex(null), '');
});

test('it is idempotent, so a text already Unicode is left alone', () => {
  for (const [, unicode] of CASES) assert.equal(deLatex(unicode), unicode);
});

test('the feed parse runs the abstract through it', () => {
  const [stone] = parseFeed(feed([item({ desc: 'Abstract: the L\\"uders bound' })]));
  assert.equal(stone.abstract, 'the Lüders bound');
});

/* The one that actually holds the cache together. Everything above tests this
   copy; this tests that the browser's copy agrees, character for character, on
   every case above. They are two files by necessity — one is an ES module for
   Node, the other lives inside a browser IIFE with no build step — so the only
   thing keeping them equal is this assertion. */
test("the browser's copy of deLatex agrees on every case", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const js = fs.readFileSync(path.join(here, '..', 'docs', 'assets', 'filter.js'), 'utf8');
  const start = js.indexOf('  var GREEK = {');
  const end = js.indexOf('\n\n', js.indexOf('function deLatex(text) {'));
  assert.ok(start > 0 && end > start, 'deLatex not found in filter.js');
  const browser = new Function(js.slice(start, end) + '\n  return deLatex;')();

  for (const [latex, unicode] of CASES) {
    assert.equal(browser(latex), unicode, latex);
    assert.equal(browser(latex), deLatex(latex), latex);
  }
  for (const s of ['$\\Delta \\approx 8.8$', '$|x|^{-2\\Delta}$', '${\\Delta}$',
    '$\\mathrm{d}x$', '\\version{2}', '', 'plain text']) {
    assert.equal(browser(s), deLatex(s), s);
  }
});

/* The earlier days. Same property once more, now against the other source: the
   warmer reads the search API for the days behind tonight, and the abstracts it
   files there must be the ones the page's lookback pass asks for. */

function atom(entries) {
  return '<?xml version="1.0" encoding="UTF-8"?>' +
    '<feed xmlns="http://www.w3.org/2005/Atom">' + entries.join('') + '</feed>';
}

function entry({ id = '2508.00001v1', summary = 'hello', published = '2026-08-13T00:00:00Z' }) {
  return `<entry><id>http://arxiv.org/abs/${id}</id>` +
    `<published>${published}</published><summary>${summary}</summary></entry>`;
}

test('a search-API abstract is normalised exactly as a feed abstract is', () => {
  // The pair that made #53: one paper, two sources, and before deLatex two keys.
  const [fromApi] = parseAtom(atom([entry({ summary: 'the Lüders bound' })]));
  const [fromFeed] = parseFeed(feed([item({ desc: 'Abstract: the L\\"uders bound' })]));
  assert.equal(fromApi.abstract, fromFeed.abstract);
});

test('the version suffix is stripped on both sides, so dedup sees one paper', () => {
  assert.equal(bareArxivId('http://arxiv.org/abs/2508.12345v2'), '2508.12345');
  assert.equal(bareArxivId('arXiv:2508.12345'), '2508.12345');
  const [api] = parseAtom(atom([entry({ id: '2508.00001v3' })]));
  const [rss] = parseFeed(feed([item({ id: '2508.00001' })]));
  assert.equal(api.arxivId, rss.arxivId);
});

test('numeric refs decode on the API side too, as DOMParser decodes them', () => {
  const [s] = parseAtom(atom([entry({ summary: 'a gap of &#8722;2 at &#x3b1;' })]));
  assert.equal(s.abstract, 'a gap of −2 at α');
});

test('a single-entry feed is not mistaken for a bare object', () => {
  assert.equal(parseAtom(atom([entry({})])).length, 1);
  assert.equal(parseAtom(atom([])).length, 0);
});

test('an entry with no abstract is skipped, not cached as an empty string', () => {
  assert.equal(parseAtom(atom([entry({ summary: '   ' })])).length, 0);
});

/* The cutoff counts weekdays because arXiv does not announce on the weekend.
   Counting calendar days from a Monday would ask for Sunday and Saturday and
   warm one real day out of the three the flag promised. */
test('the cutoff steps back over the weekend, not into it', () => {
  // Monday 2026-08-17, two weekdays back: Friday the 14th, then Thursday.
  assert.equal(cutoffDate(new Date('2026-08-17T06:00:00Z'), 2), '2026-08-13');
  // Friday 2026-08-14, two weekdays back: Thursday, then Wednesday.
  assert.equal(cutoffDate(new Date('2026-08-14T06:00:00Z'), 2), '2026-08-12');
  // The page treats 0 and 1 alike — one step back, whatever the caller meant.
  assert.equal(cutoffDate(new Date('2026-08-14T06:00:00Z'), 0),
    cutoffDate(new Date('2026-08-14T06:00:00Z'), 1));
});

test('the window stops at the first paper past the cutoff, it does not filter', () => {
  // Sorted newest first, so an old paper ends the list. Filtering instead would
  // let one resubmission drag a whole earlier day in behind it — and the page,
  // which breaks here, would never ask for what that warmed.
  const got = withinCutoff([
    { arxivId: 'a', published: '2026-08-14' },
    { arxivId: 'b', published: '2026-08-13' },
    { arxivId: 'c', published: '2026-08-02' },
    { arxivId: 'd', published: '2026-08-13' },
  ], '2026-08-13');
  assert.deepEqual(got.map((s) => s.arxivId), ['a', 'b']);
});

test('each category gets its own window, and a cross-list is still one stone', async () => {
  /* The page ORs its categories into one query under one max_results, and that
     shape does not survive being copied here: the warmer covers twice the page's
     categories, so the shared window bottomed out mid-day and left 13 papers of
     2026-08-12 cold. One request per category, deduped after. */
  const asked = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    const cat = String(url).match(/cat:([^&]*)/)[1];
    return { ok: true, text: async () => atom([
      entry({ id: '2508.0000' + asked.length, summary: 'only in ' + cat, published: '2026-08-13T00:00:00Z' }),
      entry({ id: '2508.99999', summary: 'cross-listed to both', published: '2026-08-13T00:00:00Z' }),
    ]) };
  };
  try {
    const got = await fetchEarlier(['quant-ph', 'math-ph'], 2, 400, new Date('2026-08-14T06:00:00Z'));
    assert.equal(asked.length, 2);
    assert.match(asked[0], /search_query=cat:quant-ph&/);
    assert.match(asked[1], /search_query=cat:math-ph&/);
    for (const u of asked) assert.match(u, /max_results=400/);
    assert.deepEqual(got.map((s) => s.arxivId).sort(), ['2508.00001', '2508.00002', '2508.99999']);
  } finally {
    globalThis.fetch = real;
  }
});

test('one dead category does not take the other categories down with it', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => (String(url).includes('cat:dead')
    ? { ok: false, status: 503, text: async () => '' }
    : { ok: true, text: async () => atom([entry({ published: '2026-08-13T00:00:00Z' })]) });
  try {
    const got = await fetchEarlier(['dead', 'math-ph'], 2, 400, new Date('2026-08-14T06:00:00Z'));
    assert.equal(got.length, 1);
    // But all of them failing is a real failure, not an empty warm.
    globalThis.fetch = async () => ({ ok: false, status: 503, text: async () => '' });
    await assert.rejects(
      fetchEarlier(['dead'], 2, 400, new Date('2026-08-14T06:00:00Z')), /HTTP 503/);
  } finally {
    globalThis.fetch = real;
  }
});

test("the browser's copy of cutoffDate agrees on a year of dates", () => {
  // The second thing the two files must spell identically: warming days the page
  // never asks for is wasted, and the page asking for a day nobody warmed is the
  // bug this flag exists to fix.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const js = fs.readFileSync(path.join(here, '..', 'docs', 'assets', 'filter.js'), 'utf8');
  const start = js.indexOf('  function cutoffDate(onDate, lookbackDays) {');
  const end = js.indexOf('\n  }', start) + 4;
  assert.ok(start > 0 && end > start, 'cutoffDate not found in filter.js');
  const browser = new Function(js.slice(start, end) + '\n  return cutoffDate;')();

  for (let d = 0; d < 365; d++) {
    const day = new Date(Date.UTC(2026, 0, 1 + d));
    for (const lb of [1, 2, 3, 7]) {
      assert.equal(browser(day, lb), cutoffDate(day, lb), `${day.toISOString()} lb=${lb}`);
    }
  }
});

/* Presets. Same property as the feed tests above: the warmer must hash the
   string the browser hashes, or the preset caches under keys nobody asks for. */

test('a bare DOI becomes the form OpenAlex resolves', () => {
  // /works/10.1038/nature02693 is a 404; /works/doi:10.1038/nature02693 is 200.
  // Verified against the live API 2026-08-12.
  assert.equal(doiKey('10.1038/nature02693'), 'doi:10.1038/nature02693');
  assert.equal(doiKey('https://doi.org/10.1038/nature02693'), 'doi:10.1038/nature02693');
  assert.equal(doiKey('http://dx.doi.org/10.1038/NATURE02693'), 'doi:10.1038/nature02693');
  assert.equal(doiKey('doi:10.1038/nature02693'), 'doi:10.1038/nature02693');
  assert.equal(doiKey('  10.1038/nature02693  '), 'doi:10.1038/nature02693');
  assert.equal(doiKey(''), '');
  assert.equal(doiKey(null), '');
});

test('an inverted index rebuilds into the prose the page embeds', () => {
  assert.equal(
    reconstructAbstract({ We: [0], show: [1], that: [2], spins: [3] }),
    'We show that spins',
  );
  assert.equal(reconstructAbstract(null), '');
});

test('a gap in the inverted index truncates, as it does in the browser', () => {
  // filter.js walks positions from 0 until one is missing. Reproducing the
  // truncation is the point: matching the browser beats a better abstract.
  assert.equal(reconstructAbstract({ a: [0], b: [1], d: [3] }), 'a b');
});

test('a core sample is embedded as title, space, abstract', () => {
  assert.equal(coreEmbedText('Title', 'Body text'), 'Title Body text');
});

test('a core sample with no abstract repeats the title, as the page does', () => {
  // filter.js falls back to `abstract = title`, then embeds `title + ' ' +
  // abstract` — so the title genuinely appears twice in the hashed string.
  assert.equal(coreEmbedText('Only a title', ''), 'Only a title Only a title');
});

test('preset touchstones are trimmed and empty rows dropped', () => {
  const units = presetUnits({
    touchstones: [{ text: '  exchange gates  ' }, { text: '' }, { text: '   ' }],
  }, 'spin-qubits');
  assert.deepEqual(units, [{
    text: 'exchange gates', source: 'preset:spin-qubits', kind: 'touchstone', weight: 1.0,
  }]);
});

test('a preset row without a weight assays at 1.0, as an untouched page row does', () => {
  const [row] = presetUnits({ touchstones: [{ text: 'a' }] }, 's');
  assert.equal(row.weight, 1.0);
  const [weighted] = presetUnits({ touchstones: [{ text: 'a', weight: 0.6 }] }, 's');
  assert.equal(weighted.weight, 0.6);
});
