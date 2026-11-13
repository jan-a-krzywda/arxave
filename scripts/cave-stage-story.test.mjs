/**
 * `cd scripts && node --test cave-stage-story.test.mjs`.
 *
 * Stage 8 is one network call and one card, and the parts a browser cannot be
 * asked to hold are the ones that bite: a request that must be clipped and
 * capped before it leaves, a Markdown renderer that must never make a tag out
 * of model prose, and a cache key that must not depend on the order the reader
 * ticked papers in. Each is a pure function above the mount, so each is checked
 * here against a hand-built night — fourteen papers, four wagons, three topics.
 *
 * THE MOUNT AT THE END IS CALLED FOR REAL, with the fake DOM and fake `fetch`
 * pattern from `cave-stages-dig-map.test.mjs`: it checks the ask line, the
 * request body, the rendered card, the cache write and `complete('story')`, then
 * remounts on the same storage and checks the reader gets the story back
 * without a second call.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createFlow } from '../docs/assets/cave-flow.mjs';
import {
  BUDGET_SPENT, MAX_PAPERS, mount, plainText, readFirstWhy, renderStoryMd,
  storyCacheKey, storyCardHtml, storyMarkdown, storyRequest, storyWagons,
} from '../docs/assets/cave-stage-story.mjs';

/* ── fixtures ───────────────────────────────────────────────────────────── */

const TOPICS = {
  parents: [{ id: 'computing', label: 'Computing' }],
  leaves: [
    { id: 'tol', parent: 'computing', label: 'Topological order' },
    { id: 'qml', parent: 'computing', label: 'Quantum machine learning' },
    { id: 'mb', parent: 'computing', label: 'Many-body physics' },
  ],
};

/** localStorage, small enough to read. */
function fakeStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(String(key), String(value)); },
    removeItem: (key) => { map.delete(key); },
    key: (i) => [...map.keys()][i] ?? null,
    get length() { return map.size; },
    map,
  };
}

/**
 * Fourteen stones in four components — sizes 4, 4, 4, 2 — with the second
 * wagon unnamed on purpose, so "named only" cannot pass by accident.
 */
function makeNight(n = 14) {
  const stones = Array.from({ length: n }, (_, i) => ({
    id: '2611.' + String(10000 + i),
    title: 'Paper ' + i,
    abstract: 'Abstract of paper ' + i + '.',
    authors: ['A. Author'],
    cat: 'quant-ph',
    link: 'https://arxiv.org/abs/2611.' + String(10000 + i),
  }));
  const components = [];
  for (let i = 0; i < n; i += 4) {
    const indices = [];
    for (let k = i; k < Math.min(i + 4, n); k += 1) indices.push(k);
    components.push({ indices });
  }
  const names = components.map((_, c) => (c === 1 ? null : 'Wagon ' + c));
  return {
    date: '2026-11-13',
    categories: ['quant-ph'],
    stones,
    topic: Int32Array.from(stones.map((_, i) => i % 3)),
    components,
    names,
  };
}

/** The ranking's shape: stone facts plus a topic index and a score. */
function rankedFrom(night) {
  return night.stones.map((stone, i) => ({
    ...stone,
    topic: i % 3,
    fit: 100 - i,
    score: 1 - i / 100,
  }));
}

const NIGHT = makeNight();
const RANKED = rankedFrom(NIGHT);
const IDS = NIGHT.stones.map((stone) => stone.id);

/* ── storyRequest ───────────────────────────────────────────────────────── */

test('storyRequest sends the top twelve by rank, and says nothing it cannot', () => {
  const storage = fakeStorage();
  storage.setItem('arxave-cave-diamond:' + IDS[0],
    JSON.stringify({ summary: 'A diamond in one sentence.', takeaways: [], questions: [], readIf: '' }));

  const request = storyRequest({
    night: NIGHT,
    ranked: RANKED,
    picks: new Set(IDS),          // all fourteen ticked
    topics: TOPICS,
    prefs: { text: 'x'.repeat(900) },
    storage,
  });

  assert.equal(request.date, '2026-11-13');
  assert.equal(request.papers.length, MAX_PAPERS, 'a 12-paper story is the ceiling');
  assert.deepEqual(request.papers.map((p) => p.id), IDS.slice(0, MAX_PAPERS),
    'the twelve sent are the top twelve of the ranking, in rank order');

  const first = request.papers[0];
  assert.equal(first.title, 'Paper 0');
  assert.equal(first.abstract, 'Abstract of paper 0.');
  assert.equal(first.topic, 'Topological order', 'the leaf label, not the index');
  assert.equal(first.wagon, 'Wagon 0');
  assert.equal(first.diamond, 'A diamond in one sentence.');
  assert.equal(request.papers[4].wagon, null, 'an unnamed wagon is null, not "Wagon 2"');
  assert.ok(!('diamond' in request.papers[1]), 'no cached diamond is omitted, not empty');

  assert.equal(request.care, 'x'.repeat(500), 'the care box is clipped to 500');
  assert.deepEqual(request.wagons, [
    { name: 'Wagon 0', size: 4 },
    { name: 'Wagon 2', size: 4 },
    { name: 'Wagon 3', size: 2 },
  ], 'named wagons only, largest first');
});

test('storyRequest clips the long fields and copes with no night at all', () => {
  const night = makeNight(2);
  const ranked = rankedFrom(night);
  ranked[0] = {
    ...ranked[0],
    title: 'T'.repeat(400),
    abstract: 'A'.repeat(2000),
  };

  const request = storyRequest({ night, ranked, picks: new Set([IDS[0]]), topics: TOPICS });
  assert.equal(request.papers[0].title.length, 300);
  assert.equal(request.papers[0].abstract.length, 1200);

  const empty = storyRequest({ night: null, ranked: [], picks: new Set(), storage: null });
  assert.deepEqual(empty, { date: '', papers: [], wagons: [], care: '' });
});

test('storyWagons caps at 24 and breaks size ties by name', () => {
  const components = [];
  const names = [];
  for (let i = 0; i < 30; i += 1) {
    components.push({ indices: [i] });
    names.push('Wagon ' + String(i).padStart(2, '0'));
  }
  const rows = storyWagons({ components, names });
  assert.equal(rows.length, 24);
  assert.equal(rows[0].name, 'Wagon 00');
  assert.equal(rows[23].name, 'Wagon 23');
});

/* ── the Markdown renderer ──────────────────────────────────────────────── */

test('renderStoryMd escapes markup and leaves a javascript: link inert', () => {
  const papers = { [IDS[0]]: { title: 'A <b>paper</b> on walls' } };

  const img = renderStoryMd('<img src=x onerror="alert(1)">', papers);
  assert.ok(!img.includes('<img'), 'a raw tag got through');
  assert.ok(img.includes('&lt;img'));

  const js = renderStoryMd('[x](javascript:alert(1))', papers);
  assert.ok(!js.includes('<a'), 'a javascript: link became an anchor');
  assert.ok(js.includes('(javascript:alert(1))'), 'the dangerous text should stay text');

  const known = renderStoryMd('Start with [' + IDS[0] + '] tonight.', papers);
  assert.ok(known.includes('href="https://arxiv.org/abs/' + IDS[0] + '"'));
  assert.ok(known.includes('title="A &lt;b&gt;paper&lt;/b&gt; on walls"'),
    'the tooltip is the short title, escaped');

  const unknown = renderStoryMd('[9999.99999]', papers);
  assert.ok(!unknown.includes('<a'), 'an id we did not send is not a link');
  assert.ok(unknown.includes('[9999.99999]'));
});

test('renderStoryMd recognises paragraphs, bold, italic and dash lists only', () => {
  const html = renderStoryMd('**Bold** and *light*\n\n- one\n- two\n\nA last line.', {});
  assert.equal(html,
    '<p><strong>Bold</strong> and <em>light</em></p>'
    + '<ul><li>one</li><li>two</li></ul>'
    + '<p>A last line.</p>');
  /* A heading is not in the contract, so it stays the text it was. */
  assert.ok(renderStoryMd('# Not a heading', {}).includes('# Not a heading'));
  assert.ok(!renderStoryMd('# Not a heading', {}).includes('<h1'));
});

test('plainText strips Markdown and readFirstWhy finds the sentence that says why', () => {
  assert.equal(plainText('**Bold** and *light* [' + IDS[0] + ']\n\n- one\n- two'),
    'Bold and light ' + IDS[0] + '\n\none\ntwo');

  const story = 'We open with [' + IDS[0] + ']. Then [' + IDS[1] + '] follows.';
  assert.equal(readFirstWhy(story, IDS[0]), 'We open with ' + IDS[0] + '.');
  assert.equal(readFirstWhy(story, IDS[5]), '');
  assert.equal(readFirstWhy(story, ''), '');
});

/* ── the cache key ──────────────────────────────────────────────────────── */

test('storyCacheKey does not depend on the order the picks were ticked', () => {
  const a = storyCacheKey('2026-11-13', [IDS[0], IDS[1], IDS[2]]);
  const b = storyCacheKey('2026-11-13', [IDS[2], IDS[0], IDS[1]]);
  assert.equal(a, b);
  assert.equal(a, 'arxave-cave-story:2026-11-13:' + [IDS[0], IDS[1], IDS[2]].sort().join(','));
});


/* ── the reader card ────────────────────────────────────────────────────── */

test('the card carries the title, the read-first callout and the threads', () => {
  const papers = {
    [IDS[0]]: { title: 'Walls that move' },
    [IDS[1]]: { title: 'Tunnels and time' },
  };
  const story = {
    title: 'The night the walls moved',
    story: 'We begin with [' + IDS[0] + '], because it **opens** the wall.',
    readFirst: IDS[0],
    threads: [{ ids: [IDS[0], IDS[1]], why: 'Both **dig** the same seam.' }],
  };
  const html = storyCardHtml(story, papers, { date: '2026-11-13', count: 2 });

  assert.match(html, /class="st-eyebrow">Tonight's story</);
  assert.match(html, /<h3 class="st-title">The night the walls moved<\/h3>/);
  assert.ok(html.includes('2026-11-13 · 2 papers'));
  assert.ok(html.includes('<strong>opens</strong>'), 'the story keeps its bold');
  assert.match(html, /class="st-label">Read first</);
  assert.ok(html.includes('>Walls that move</a>'), 'the read-first paper is a titled link');
  assert.ok(html.includes('We begin with ' + IDS[0] + ', because it opens the wall.'),
    'the sentence that names the paper is the why');
  assert.match(html, /class="st-label">Threads</);
  assert.ok(html.includes('>Tunnels and time</a>'), 'threads link titles, not ids');
  assert.ok(html.includes('<strong>dig</strong>'), 'thread whys keep their bold');
  assert.ok(html.includes('class="st-copy"'));
  assert.ok(html.includes('class="st-download"'));
});

test('the story title and a thread title are escaped like any other text', () => {
  const html = storyCardHtml({
    title: '<b>Not a title</b>',
    story: 'x',
    readFirst: IDS[0],
    threads: [{ ids: [IDS[0], IDS[1]], why: '<script>x</script>' }],
  }, { [IDS[0]]: { title: '<img onerror=x>' }, [IDS[1]]: { title: 'Safe' } });

  assert.ok(!html.includes('<b>Not a title</b>'));
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;b&gt;Not a title&lt;/b&gt;'));
});

test('storyMarkdown is the file a reader keeps: story then picked papers with links', () => {
  const md = storyMarkdown(
    { title: 'The night the walls moved', story: 'We begin with [' + IDS[0] + '].' },
    [{ id: IDS[0], title: 'Walls that move' }, { id: IDS[1], title: 'Tunnels [and] time' }],
    { date: '2026-11-13' },
  );

  assert.ok(md.startsWith('# The night the walls moved\n'));
  assert.ok(md.includes('_The night of 2026-11-13_'));
  assert.ok(md.includes('## Picked papers'));
  assert.ok(md.includes('- [Walls that move](https://arxiv.org/abs/' + IDS[0] + ')'));
  assert.ok(md.includes('- [Tunnels \\[and\\] time](https://arxiv.org/abs/' + IDS[1] + ')'));
});


/* ── the mount, on a browser small enough to read ───────────────────────── */

function fakeElement(tag = 'div') {
  const listeners = new Map();
  const el = {
    tagName: String(tag).toUpperCase(),
    innerHTML: '',
    textContent: '',
    value: '',
    hidden: false,
    disabled: false,
    style: {},
    dataset: {},
    attrs: {},
    children: [],
    lookup: new Map(),

    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    /** Was anything wired for `type`? */
    wired(type) {
      return (listeners.get(type) || []).length > 0;
    },
    /** Fire the real listeners, so a handler that never ran stays silent. */
    fire(type, event = {}) {
      for (const fn of (listeners.get(type) || []).slice()) {
        fn({ target: el, preventDefault() {}, ...event });
      }
    },
    setAttribute(name, value) { el.attrs[name] = String(value); },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(el.attrs, name) ? el.attrs[name] : null;
    },
    appendChild(child) { el.children.push(child); return child; },
    querySelector(sel) {
      if (!el.lookup.has(sel)) el.lookup.set(sel, fakeElement(sel));
      return el.lookup.get(sel);
    },
  };
  return el;
}

/** The body: every class selector is one stable fake element. */
function fakeBody() {
  const body = fakeElement('body');
  body.querySelector = (sel) => {
    if (!body.lookup.has(sel)) body.lookup.set(sel, fakeElement(sel));
    return body.lookup.get(sel);
  };
  return body;
}

/** The two globals the module reaches for; returns the undo. */
function installBrowser() {
  const saved = { document: globalThis.document, window: globalThis.window };
  globalThis.document = {
    createElement: (tag) => fakeElement(tag),
    head: { querySelector: () => null, appendChild: () => {} },
  };
  /* No speechSynthesis on purpose: "Read aloud" must hide, not throw. */
  globalThis.window = { innerWidth: 900 };
  return () => {
    if (saved.document === undefined) delete globalThis.document;
    else globalThis.document = saved.document;
    if (saved.window === undefined) delete globalThis.window;
    else globalThis.window = saved.window;
  };
}

/** Poll instead of guessing a delay: the call is a promise chain. */
async function until(check, ms = 1000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for the stage');
}

/** A flow already past Act, so `story` is open and can be completed. */
function unlockedFlow() {
  const flow = createFlow({ storage: null });
  for (const id of ['dig', 'train', 'map', 'priorities', 'ranking', 'act']) {
    flow.complete(id, 'done');
  }
  return flow;
}

function stageCtx(overrides = {}) {
  return {
    flow: unlockedFlow(),
    bus: new EventTarget(),
    config: { functionsBase: 'https://functions.test' },
    corpus: null,
    topics: TOPICS,
    axes: null,
    night: NIGHT,
    prefs: { text: 'x'.repeat(900), setting: {}, sliders: {}, touchstones: [] },
    ranked: RANKED,
    picks: new Set(IDS.slice(0, 3)),
    storage: null,
    ...overrides,
  };
}

const STORY = {
  title: 'The night the walls moved',
  story: 'Tonight begins with [' + IDS[0] + '], which **opens** the wall.'
    + '\n\nThen [' + IDS[1] + '] follows.',
  readFirst: IDS[0],
  threads: [{ ids: [IDS[0], IDS[1]], why: 'Both tunnel the same wall.' }],
};


test('mount asks, renders, caches and completes the story stage', async () => {
  const undo = installBrowser();
  const realFetch = globalThis.fetch;
  let sent = null;
  globalThis.fetch = async (url, init) => {
    sent = { url, body: JSON.parse(init.body) };
    return { ok: true, status: 200, json: async () => STORY };
  };
  try {
    const storage = fakeStorage();
    const flow = unlockedFlow();
    const ctx = stageCtx({ flow, storage });
    const body = fakeBody();
    mount(body, ctx);

    assert.ok(body.innerHTML.includes('class="st-tell"'));
    assert.ok(body.innerHTML.includes('Only the top 12 by rank'),
      'the twelve-paper ceiling is on the card');
    assert.equal(body.querySelector('.st-count').textContent, '3 picked papers.');
    assert.equal(body.querySelector('.st-tell').disabled, false, 'three picks can ask');
    assert.equal(body.querySelector('.st-missing').hidden, true, 'the night is here');
    assert.ok(body.querySelector('.st-tell').wired('click'));

    body.querySelector('.st-tell').fire('click');
    await until(() => flow.status('story') === 'done');

    assert.equal(sent.url, 'https://functions.test/story');
    assert.equal(sent.body.date, '2026-11-13');
    assert.equal(sent.body.papers.length, 3);
    assert.equal(sent.body.care, 'x'.repeat(500), 'the care box is clipped on the way out');
    assert.deepEqual(sent.body.wagons[0], { name: 'Wagon 0', size: 4 });
    assert.equal(sent.body.papers[0].topic, 'Topological order');

    const card = body.querySelector('.st-card');
    assert.equal(card.hidden, false);
    assert.ok(card.innerHTML.includes('The night the walls moved'));
    assert.ok(card.innerHTML.includes('<strong>opens</strong>'));
    assert.ok(card.innerHTML.includes('href="https://arxiv.org/abs/' + IDS[0] + '"'));
    assert.ok(card.innerHTML.includes('Read first'));
    assert.ok(card.innerHTML.includes('Threads'));
    assert.equal(body.querySelector('.st-wait').hidden, true);
    assert.equal(body.querySelector('.st-error').hidden, true);

    assert.equal(flow.summary('story'), 'The night the walls moved');
    assert.ok(storage.getItem(storyCacheKey('2026-11-13', IDS.slice(0, 3))),
      'the story was not cached under its picks');

    /* Remount: same picks, same night, the story comes back without a call. */
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      throw new Error('the remount must not ask again');
    };
    const again = fakeBody();
    mount(again, ctx);
    assert.equal(again.querySelector('.st-card').hidden, false,
      'the cached story did not come back on remount');
    assert.ok(again.querySelector('.st-card').innerHTML.includes('The night the walls moved'));
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = realFetch;
    undo();
  }
});

test('a 429 is the shared budget, said plainly, and the ask comes back', async () => {
  const undo = installBrowser();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 429,
    json: async () => ({ error: 'budget' }),
  });
  try {
    const ctx = stageCtx();
    const body = fakeBody();
    mount(body, ctx);
    body.querySelector('.st-tell').fire('click');

    await until(() => body.querySelector('.st-error').hidden === false);
    assert.equal(body.querySelector('.st-error').textContent, BUDGET_SPENT);
    assert.equal(body.querySelector('.st-wait').hidden, true);
    assert.equal(body.querySelector('.st-tell').disabled, false, 'the reader may try again');
    assert.equal(body.querySelector('.st-card').hidden, true, 'no card without a story');
  } finally {
    globalThis.fetch = realFetch;
    undo();
  }
});

test('no picks and no night are sentences, not a broken button', () => {
  const undo = installBrowser();
  try {
    const body = fakeBody();
    mount(body, stageCtx({ night: null, ranked: [], picks: new Set() }));

    assert.equal(body.querySelector('.st-count').textContent, '0 picked papers.');
    assert.equal(body.querySelector('.st-tell').disabled, true);
    assert.equal(body.querySelector('.st-missing').hidden, false);
    assert.match(body.querySelector('.st-missing').textContent, /^Dig first/);
    assert.equal(body.querySelector('.st-over').hidden, true);

    /* Fourteen picks: the card says the story takes only the top twelve. */
    const many = fakeBody();
    mount(many, stageCtx({ picks: new Set(IDS) }));
    assert.equal(many.querySelector('.st-count').textContent, '14 picked papers.');
    assert.equal(many.querySelector('.st-over').hidden, false);
    assert.ok(many.innerHTML.includes('top 12 by rank'));
  } finally {
    undo();
  }
});

