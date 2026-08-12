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

import { cacheKeyText, feedBuildDate, parseFeed, resolveEndpoint } from './warm-dig.mjs';

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
