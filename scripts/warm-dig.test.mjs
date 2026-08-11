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

import { cacheKeyText, parseFeed } from './warm-dig.mjs';

function feed(items) {
  return `<?xml version="1.0" encoding="UTF-8"?><rss><channel>${items.join('')}</channel></rss>`;
}

function item({ id = '2508.00001', announce = 'new', desc = 'Abstract: hello' }) {
  return `<item><link>https://arxiv.org/abs/${id}</link>` +
    `<arxiv:announce_type>${announce}</arxiv:announce_type>` +
    `<description>${desc}</description></item>`;
}

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
