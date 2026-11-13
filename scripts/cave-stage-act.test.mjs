/**
 * `cd scripts && node --test cave-stage-act.test.mjs`.
 *
 * Stage 7 is mostly buttons and network, so the half a test can hold is the
 * half the page cannot get silently wrong: the diamond panel's escape and its
 * three sections, the order picks come back in, the bar's one line, the 3 000
 * character abstract cap, the action ids and the cache key. Those are the pure
 * helpers, checked against hand-written papers.
 *
 * The mount at the end runs for real against a hand-written fake DOM (no jsdom,
 * same pattern as `cave-stages-dig-map.test.mjs`): it checks that mounting does
 * not throw, that a 'picks' event paints one card per pick in rank order, and
 * that a fake diamond response draws the panel and writes the cache. The fake
 * `fetch` also answers the spent-budget shape once, because "say so plainly"
 * is a behaviour and not a comment.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BUDGET_NOTE, ABSTRACT_MAX, actionsFor, bulkBarText, cacheKey, cardHtml, diamondHtml,
  diamondRequest, mount, pickedPapers, readCachedDiamond,
} from '../docs/assets/cave-stage-act.mjs';
import { createFlow } from '../docs/assets/cave-flow.mjs';

/* ── fixtures ───────────────────────────────────────────────────────────── */

const DIAMOND = {
  summary: 'A cavity is cooled below its bath by a pulsed drive.',
  takeaways: ['Cooling reaches 40% below the bath.', 'The pulse is 12 ns long.', 'No feedback is needed.'],
  questions: ['Does it survive detector noise?', 'What limits the final phonon number?', 'Can it scale to two modes?'],
  readIf: 'You work on optomechanical ground-state cooling.',
};

const PAPERS = [
  {
    id: '2401.00001',
    title: 'Pulsed cooling of a cavity',
    abstract: 'We cool a cavity with a pulsed drive and measure the phonon number.',
    authors: ['Ada Lovelace', 'Emmy Noether'],
    link: 'https://arxiv.org/abs/2401.00001',
  },
  {
    id: '2401.00002v2',
    title: 'A second paper',
    abstract: 'Something else entirely.',
    authors: 'Grace Hopper; Alan Turing',
  },
];

/* ── pure helpers ───────────────────────────────────────────────────────── */

test('diamondHtml escapes model prose and carries the three sections', () => {
  const html = diamondHtml({
    summary: 'A <script>alert(1)</script> summary',
    takeaways: ['one & two', 'three', 'four'],
    questions: ['why?', 'how?', 'when?'],
    readIf: 'you like "quotes"',
  });
  assert.ok(!html.includes('<script>'), 'the summary was not escaped');
  assert.ok(html.includes('&lt;script&gt;'), 'the escaping is not the shared helper\'s');
  assert.match(html, /class="ac-diamond-label">Take home</);
  assert.match(html, /class="ac-diamond-label">Open questions</);
  assert.match(html, /Read this if…/);
  assert.equal((html.match(/<li>/g) || []).length, 6, 'two three-item lists');
  assert.ok(html.includes('&amp;'), 'an ampersand in a bullet survives escaped');
  assert.equal(diamondHtml(null), '', 'no diamond is no panel');
  assert.equal(diamondHtml([]), '', 'an array is not a diamond');
});

test('pickedPapers keeps rank order and drops picks that are not in the list', () => {
  const ranked = [...PAPERS, { id: '2401.00003', title: 'Unpicked' }];
  assert.deepEqual(pickedPapers(ranked, new Set(['2401.00002v2', '2401.00001'])).map((p) => p.id),
    ['2401.00001', '2401.00002v2']);
  assert.deepEqual(pickedPapers(ranked, ['2401.00002v2']).map((p) => p.id), ['2401.00002v2']);
  assert.deepEqual(pickedPapers(ranked, new Set(['2401.99999'])), [], 'a stale pick has no card');
  assert.deepEqual(pickedPapers([], new Set(['2401.00001'])), []);
  assert.deepEqual(pickedPapers(ranked, null), []);
});

test('bulkBarText is the act summary, singular and plural alike', () => {
  assert.equal(bulkBarText(3, 1), '3 picked · 1 diamonds');
  assert.equal(bulkBarText(0, 0), '0 picked · 0 diamonds');
  assert.equal(bulkBarText('2', ''), '2 picked · 0 diamonds');
});

test('diamondRequest clips the abstract to 3000 and keeps a bare id', () => {
  const long = `  ${'word '.repeat(1000)}  `;
  const body = diamondRequest({
    id: 'https://arxiv.org/abs/2401.00002v3',
    title: '  A   title ',
    abstract: long,
    authors: ['Ada Lovelace', ' Emmy Noether '],
  });
  assert.equal(body.paper.id, '2401.00002');
  assert.equal(body.paper.title, 'A title');
  assert.equal(body.paper.abstract.length, ABSTRACT_MAX);
  assert.ok(!body.paper.abstract.includes('  '), 'whitespace is collapsed before the clip');
  assert.equal(body.paper.authors, 'Ada Lovelace, Emmy Noether');
});

test('actionsFor is the card order, with Discuss only when there is a repo', () => {
  assert.deepEqual(actionsFor(PAPERS[0]), ['diamond', 'zotero', 'discuss', 'more', 'less', 'unpick']);
  assert.deepEqual(actionsFor(PAPERS[0], { repoOk: false }),
    ['diamond', 'zotero', 'more', 'less', 'unpick']);
});

test('the cache key is the endpoint JSON under the bare arXiv id', () => {
  assert.equal(cacheKey('2401.00002v4'), 'arxave-cave-diamond:2401.00002');
  assert.equal(cacheKey('https://arxiv.org/abs/2401.00002'), 'arxave-cave-diamond:2401.00002');

  const store = new Map([['arxave-cave-diamond:2401.00002', JSON.stringify(DIAMOND)]]);
  const storage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, value),
  };
  assert.deepEqual(readCachedDiamond(storage, '2401.00002v1'), DIAMOND);
  assert.equal(readCachedDiamond(storage, '2401.00003'), null);
  assert.equal(readCachedDiamond(null, '2401.00002'), null);

  const bad = { getItem: () => '{not json', setItem: () => {} };
  assert.equal(readCachedDiamond(bad, '2401.00002'), null, 'broken JSON is a cache miss');
  const throwing = { getItem: () => { throw new Error('private mode'); } };
  assert.equal(readCachedDiamond(throwing, '2401.00002'), null, 'storage that throws is a miss');
});

test('cardHtml puts the title, authors and every action in one card', () => {
  const html = cardHtml(PAPERS[0], {
    repoOk: true, repo: 'owner/repo', category: 'Ideas', nudge: 1, diamond: null,
  });
  assert.ok(html.includes('Pulsed cooling of a cavity'));
  assert.ok(html.includes('Ada Lovelace, Emmy Noether'));
  assert.match(html, /data-act="diamond"/);
  assert.match(html, /data-act="ris"/);
  assert.match(html, /Find a thread/);
  assert.match(html, /aria-pressed="true"/, 'a +1 nudge is pressed');
  assert.ok(!html.includes('ac-panel'), 'no diamond, no panel');
});


/* ── the fake DOM ───────────────────────────────────────────────────────── */

function fakeElement(tag = 'div') {
  const listeners = new Map();
  const el = {
    tagName: String(tag).toUpperCase(),
    innerHTML: '',
    textContent: '',
    hidden: false,
    disabled: false,
    style: {},
    attrs: {},
    children: [],
    lookup: new Map(),

    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    fire(type, event = {}) {
      for (const fn of (listeners.get(type) || []).slice()) {
        fn({ target: el, preventDefault() {}, ...event });
      }
    },
    wired(type) {
      return (listeners.get(type) || []).length > 0;
    },
    setAttribute(name, value) {
      el.attrs[name] = String(value);
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(el.attrs, name) ? el.attrs[name] : null;
    },
    appendChild(child) {
      el.children.push(child);
      return child;
    },
    querySelector(sel) {
      if (!el.lookup.has(sel)) el.lookup.set(sel, fakeElement(sel));
      return el.lookup.get(sel);
    },
    querySelectorAll() {
      return [];
    },
    scrollIntoView() {
      el.scrolled = (el.scrolled || 0) + 1;
    },
  };
  return el;
}

/** A stage body: innerHTML is a string, every selector its own fake element. */
function fakeBody() {
  const body = fakeElement('body');
  body.querySelector = (sel) => {
    if (!body.lookup.has(sel)) body.lookup.set(sel, fakeElement(sel));
    return body.lookup.get(sel);
  };
  return body;
}

/** The two globals `mount` reaches for; no `document.body`, so nothing moves. */
function installBrowser() {
  const saved = {
    document: globalThis.document,
    IntersectionObserver: globalThis.IntersectionObserver,
  };
  const head = fakeElement('head');
  head.querySelector = () => null;
  globalThis.document = {
    head,
    createElement: (tag) => fakeElement(tag),
  };
  delete globalThis.IntersectionObserver;
  return () => {
    if (saved.document === undefined) delete globalThis.document;
    else globalThis.document = saved.document;
    if (saved.IntersectionObserver === undefined) delete globalThis.IntersectionObserver;
    else globalThis.IntersectionObserver = saved.IntersectionObserver;
  };
}

/** A "click" on a button inside the list, the way a reader makes one. */
function clickAct(listEl, act, id) {
  const button = fakeElement('button');
  button.attrs['data-act'] = act;
  button.attrs['data-id'] = id;
  button.closest = () => button;
  listEl.fire('click', { target: button });
  return button;
}

/** The page's ctx, with the flow already at the act stage. */
function actCtx({ picks = new Set(), storage = null } = {}) {
  const flow = createFlow({ storage: null });
  for (const id of ['dig', 'train', 'map', 'priorities', 'ranking']) flow.complete(id, 'done');
  return {
    flow,
    bus: new EventTarget(),
    config: {
      functionsBase: 'https://functions.test',
      discussionsRepo: 'owner/repo',
      discussionsCategory: 'Ideas',
    },
    corpus: null,
    topics: null,
    axes: null,
    night: null,
    prefs: null,
    ranked: PAPERS.map((paper) => ({ ...paper })),
    picks,
    storage,
  };
}

/* ── the mount, for real ────────────────────────────────────────────────── */

test('mounting act draws one card per pick and the diamond writes its cache', async () => {
  const undo = installBrowser();
  const realFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return { ok: true, status: 200, json: async () => DIAMOND };
  };

  const store = new Map();
  const storage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
  };

  try {
    const ctx = actCtx({ storage });
    const body = fakeBody();

    assert.doesNotThrow(() => mount(body, ctx));
    const listEl = body.querySelector('.ac-cards');
    const barEl = body.querySelector('.ac-bulk');
    assert.ok(body.innerHTML.includes('class="ac-bulk'), 'the bulk bar markup never went in');
    assert.equal(barEl.hidden, true, 'no picks, no bar');
    assert.equal(body.querySelector('.ac-continue').disabled, true);

    /* The picks event is the ranking stage's; this card only listens. */
    ctx.picks.add('2401.00002v2');
    ctx.picks.add('2401.00001');
    ctx.bus.dispatchEvent(new CustomEvent('picks', { detail: [...ctx.picks] }));

    const cards = listEl.innerHTML;
    assert.equal((cards.match(/class="ac-card"/g) || []).length, 2, 'one card per pick');
    assert.ok(cards.indexOf('Pulsed cooling of a cavity') < cards.indexOf('A second paper'),
      'cards follow the ranking, not the Set');
    assert.equal(barEl.hidden, false, 'picks with the act stage open must show the bar');
    assert.equal(barEl.querySelector('.ac-bulk-count').textContent, '2 picked');
    assert.equal(body.querySelector('.ac-continue').disabled, false);

    /* Extract one diamond: a fake fetch answers with the endpoint's JSON. */
    clickAct(listEl, 'diamond', '2401.00001');
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(requests.length, 1, 'one press, one call');
    assert.ok(requests[0].url.endsWith('/diamond'));
    assert.equal(requests[0].body.paper.id, '2401.00001');
    assert.ok(listEl.innerHTML.includes('Take home'), 'the panel never rendered');
    assert.ok(listEl.innerHTML.includes('Open questions'));
    assert.ok(listEl.innerHTML.includes('Read this if…'));
    assert.ok(listEl.innerHTML.includes('re-extract'), 'a cached diamond offers a second opinion');
    assert.ok(store.has('arxave-cave-diamond:2401.00001'), 'the diamond was not cached');
    assert.deepEqual(JSON.parse(store.get('arxave-cave-diamond:2401.00001')), DIAMOND);

    /* A card that already has its diamond only calls again on re-extract. */
    clickAct(listEl, 'diamond', '2401.00001');
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(requests.length, 2, 're-extract is a deliberate second call');
  } finally {
    globalThis.fetch = realFetch;
    undo();
  }
});

test('a spent budget is said in words, and the bulk run stops there', async () => {
  const undo = installBrowser();
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: false, status: 429, json: async () => ({ error: 'budget' }) };
  };

  try {
    const ctx = actCtx({ picks: new Set(['2401.00001', '2401.00002v2']) });
    const body = fakeBody();
    mount(body, ctx);
    const listEl = body.querySelector('.ac-cards');
    const barEl = body.querySelector('.ac-bulk');
    const diamonds = barEl.querySelector('[data-bulk="diamonds"]');

    ctx.bus.dispatchEvent(new CustomEvent('picks', { detail: ['2401.00001', '2401.00002v2'] }));

    const button = fakeElement('button');
    button.attrs['data-bulk'] = 'diamonds';
    button.closest = () => button;
    barEl.fire('click', { target: button });
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.equal(calls, 1, 'the bulk run must not keep calling a spent budget');
    assert.ok(listEl.innerHTML.includes(BUDGET_NOTE), 'the reader is not told plainly');
    assert.ok(barEl.querySelector('.ac-bulk-status').textContent.includes('budget is spent'));
    assert.equal(diamonds.textContent, 'Diamonds', 'the progress label was not reset');
  } finally {
    globalThis.fetch = realFetch;
    undo();
  }
});

test('Story completes the act stage with the picks and diamonds it carries', async () => {
  const undo = installBrowser();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => DIAMOND });
  try {
    const ctx = actCtx({ picks: new Set(['2401.00001']) });
    const body = fakeBody();
    mount(body, ctx);

    const listEl = body.querySelector('.ac-cards');
    const barEl = body.querySelector('.ac-bulk');
    ctx.bus.dispatchEvent(new CustomEvent('picks', { detail: ['2401.00001'] }));

    clickAct(listEl, 'diamond', '2401.00001');
    await new Promise((resolve) => setTimeout(resolve, 20));

    const story = fakeElement('button');
    story.attrs['data-bulk'] = 'story';
    story.closest = () => story;
    barEl.fire('click', { target: story });

    assert.equal(ctx.flow.status('act'), 'done');
    assert.equal(ctx.flow.summary('act'), '1 picked · 1 diamonds');
  } finally {
    globalThis.fetch = realFetch;
    undo();
  }
});

