/**
 * `cd scripts && node --test cave-paper-actions.test.mjs`.
 *
 * The action bar is markup plus two requests, so everything here is a string or
 * a plain object: the three thread states (and the one with no repo at all),
 * the SciRate URL's bare id, the batch lookup's body and answer, and the
 * diamond cache's round trip through a storage that can also throw.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ABSTRACT_MAX, BUDGET_NOTE, CACHE_PREFIX, actionsHtml, cacheKey, diamondHtml, diamondRequest,
  parseThreads, readCachedDiamond, scirateUrl, threadsRequest, writeCachedDiamond,
} from '../docs/assets/cave-paper-actions.mjs';

const REPO = 'jan-a-krzywda/arxave';

/** One ranked item, versioned, exactly as the ranking hands it over. */
function paper(extra = {}) {
  return { id: '2401.12345v2', title: 'A <paper> & friends', abstract: 'We <show> this.', ...extra };
}

/* ── the action bar ─────────────────────────────────────────────────────── */

test('actionsHtml: SciRate is keyed on the bare id, whatever the version', () => {
  const html = actionsHtml(paper(), { repo: REPO });
  assert.ok(html.includes('href="https://scirate.com/arxiv/2401.12345"'), 'bare id, no v2');
  assert.ok(!html.includes('scirate.com/arxiv/2401.12345v2'), 'the href carries no version');
  assert.ok(html.includes('target="_blank" rel="noopener"'), 'opens in a new tab');
  assert.ok(html.includes('>SciRate</a>'));
  assert.equal(scirateUrl('2608.00001'), 'https://scirate.com/arxiv/2608.00001');
  assert.equal(scirateUrl('arxiv:2608.00001v7'), 'https://scirate.com/arxiv/2608.00001');
});

test('actionsHtml: a thread that exists is a Discussion link to it', () => {
  const url = 'https://github.com/jan-a-krzywda/arxave/discussions/12';
  const html = actionsHtml(paper(), { repo: REPO, thread: { url } });
  assert.ok(html.includes('href="' + url + '"'), 'links to the thread itself');
  assert.ok(html.includes('💬 Discussion'));
  assert.ok(!html.includes('data-act="start-thread"'), 'no start button when one exists');
});

test('actionsHtml: thread null means "you would be the first" — Start thread', () => {
  const html = actionsHtml(paper(), { repo: REPO, thread: null });
  assert.ok(html.includes('data-act="start-thread"'));
  assert.ok(html.includes('✚ Start thread'));
  assert.ok(!html.includes('discussions?discussions_q='), 'no search fallback while starting');
  assert.ok(!html.includes('⤓ .md'), 'no download until the thread was started');

  const offered = actionsHtml(paper(), { repo: REPO, thread: null, md: true });
  assert.ok(offered.includes('data-act="md"'), 'the .md link appears after');
  assert.ok(offered.includes('⤓ .md'));
});

test('actionsHtml: thread undefined falls back to the Discussions search', () => {
  const html = actionsHtml(paper(), { repo: REPO });
  assert.ok(html.includes('https://github.com/jan-a-krzywda/arxave/discussions?discussions_q='));
  assert.ok(html.includes('2401.12345'), 'the search is the bare id');
  assert.ok(html.includes('💬 Discuss'));
  assert.ok(!html.includes('data-act="start-thread"'));
});

test('actionsHtml: no repo, no discussion button at all', () => {
  const html = actionsHtml(paper(), { repo: '', thread: null });
  assert.ok(!html.includes('github.com'), 'nowhere to send the reader');
  assert.ok(!html.includes('data-act="start-thread"'));
  assert.ok(html.includes('>SciRate</a>'), 'the other exits stay');
  assert.ok(html.includes('data-act="summarize"'));
});

test('actionsHtml: Summarize reads Summary once a diamond is known', () => {
  assert.ok(actionsHtml(paper(), {}).includes('✦ Summarize'));
  assert.ok(actionsHtml(paper(), { diamond: true }).includes('✦ Summary'));
});

test('actionsHtml: the Story tick is bound to the id and the pick', () => {
  const off = actionsHtml(paper(), { repo: REPO });
  assert.ok(off.includes('class="pa-pick" data-id="2401.12345v2"'));
  assert.ok(!off.includes('checked'));

  const on = actionsHtml(paper({ picked: true }), { repo: REPO, picked: true });
  assert.ok(on.includes('data-id="2401.12345v2" checked'));
  assert.ok(on.includes('> Story</label>'), 'the box is labelled Story');
});

test('actionsHtml escapes an id in every attribute', () => {
  const html = actionsHtml({ id: 'a"b', title: 'x' }, { repo: REPO });
  assert.ok(!html.includes('data-id="a"b"'), 'the quote is escaped');
  assert.ok(html.includes('data-id="a&quot;b"'));
});

/* ── the thread lookup ──────────────────────────────────────────────────── */

test('threadsRequest bares and dedupes the ids', () => {
  assert.deepEqual(threadsRequest(REPO, ['2401.12345v2', 'arxiv:2401.12345', '2608.00001']), {
    repo: REPO,
    ids: ['2401.12345', '2608.00001'],
  });
  assert.deepEqual(threadsRequest(REPO, null), { repo: REPO, ids: [] });
  assert.deepEqual(threadsRequest(null, ['x']), { repo: '', ids: ['x'] });
});

test('parseThreads keeps urls and nulls for the ids asked about', () => {
  const answer = parseThreads({
    threads: {
      '2401.12345': 'https://github.com/o/r/discussions/3',
      '2608.00001': null,
      '9999.99999': 'https://github.com/o/r/discussions/9',
    },
  }, ['2401.12345v2', '2608.00001']);
  assert.deepEqual(answer, {
    '2401.12345': 'https://github.com/o/r/discussions/3',
    '2608.00001': null,
  });
  assert.equal(answer['9999.99999'], undefined, 'ids nobody asked about are left out');
});

test('parseThreads gives {} for every bad shape — the caller keeps its fallback', () => {
  assert.deepEqual(parseThreads(null, ['a']), {});
  assert.deepEqual(parseThreads(undefined, ['a']), {});
  assert.deepEqual(parseThreads('not json', ['a']), {});
  assert.deepEqual(parseThreads('[1,2]', ['a']), {});
  assert.deepEqual(parseThreads({ threads: 'nope' }, ['a']), {});
  assert.deepEqual(parseThreads({ threads: ['a'] }, ['a']), {});
  assert.deepEqual(parseThreads({}, ['a']), {});
  assert.deepEqual(parseThreads({ threads: { a: 7 } }, ['a']), {}, 'a non-string url is dropped');
  assert.deepEqual(parseThreads({ threads: { a: '  ' } }, ['a']), {}, 'a blank url is dropped');
  assert.deepEqual(parseThreads({ threads: { a: 'u' } }, 'a'), {});
});

/* ── the diamond cache ──────────────────────────────────────────────────── */

function fakeStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    map,
  };
}

const DIAMOND = { summary: 'A short one.', takeaways: ['a'], questions: ['b'], readIf: 'you like it' };

test('the diamond round-trips through storage under the Act stage\'s key', () => {
  const storage = fakeStorage();
  assert.equal(readCachedDiamond(storage, '2401.12345v2'), null, 'nothing mined yet');
  writeCachedDiamond(storage, '2401.12345v2', DIAMOND);

  assert.equal(cacheKey('2401.12345v2'), CACHE_PREFIX + '2401.12345');
  assert.equal(cacheKey('2401.12345v2'), 'arxave-cave-diamond:2401.12345');
  assert.deepEqual(readCachedDiamond(storage, '2401.12345'), DIAMOND, 'read back by either form');
  assert.deepEqual(JSON.parse(storage.map.get('arxave-cave-diamond:2401.12345')), DIAMOND);
});

test('a throwing or missing storage is a cache miss, never an exception', () => {
  const throwing = {
    getItem: () => { throw new Error('private mode'); },
    setItem: () => { throw new Error('quota'); },
  };
  assert.equal(readCachedDiamond(throwing, 'x'), null);
  assert.doesNotThrow(() => writeCachedDiamond(throwing, 'x', DIAMOND));
  assert.equal(readCachedDiamond(null, 'x'), null);
  assert.doesNotThrow(() => writeCachedDiamond(null, 'x', DIAMOND));

  const junk = fakeStorage();
  junk.setItem('arxave-cave-diamond:x', 'not json');
  assert.equal(readCachedDiamond(junk, 'x'), null);
  junk.setItem('arxave-cave-diamond:x', '[1,2]');
  assert.equal(readCachedDiamond(junk, 'x'), null, 'an array is not a diamond');
});

/* ── the diamond itself ─────────────────────────────────────────────────── */

test('diamondRequest trims, clips and bares what goes on the wire', () => {
  const body = diamondRequest(paper({ authors: ['Ada Lovelace', 'Alan Turing'] }));
  assert.equal(body.paper.id, '2401.12345');
  assert.equal(body.paper.abstract, 'We <show> this.');
  assert.equal(body.paper.authors, 'Ada Lovelace, Alan Turing');

  const long = diamondRequest({ id: 'x', abstract: 'a'.repeat(ABSTRACT_MAX + 50) });
  assert.equal(long.paper.abstract.length, ABSTRACT_MAX);
});

test('diamondHtml draws the four parts and drops the ones that are missing', () => {
  const html = diamondHtml(DIAMOND);
  assert.ok(html.includes('A short one.'));
  assert.ok(html.includes('Take home') && html.includes('<li>a</li>'));
  assert.ok(html.includes('Open questions') && html.includes('<li>b</li>'));
  assert.ok(html.includes('Read this if…'));

  assert.equal(diamondHtml(null), '');
  assert.equal(diamondHtml([1]), '');
  assert.equal(diamondHtml({ summary: 'Only this.' }), '<div class="pa-diamond">' +
    '<p class="pa-diamond-summary">Only this.</p></div>');
});

test('BUDGET_NOTE is the one sentence a spent budget gets', () => {
  assert.ok(BUDGET_NOTE.includes('daily AI budget'));
});


