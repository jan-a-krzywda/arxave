/**
 * `cd scripts && node --test cave-stages-dig-map.test.mjs`.
 *
 * Stages 1–3 are mostly network and DOM, which is exactly the part a test
 * cannot hold. What is left is the arithmetic the page cannot get wrong
 * silently: the fold summary, the topic bar's counts, a wagon's fallback label,
 * the rail's three states, and the mean tonight's vectors are centred against
 * when there is no corpus. Each of those is a small pure function, so each is
 * checked here against a hand-built night — four papers, three leaves, two
 * parents — rather than against a live arXiv.
 *
 * The fixture tree is the contract's shape in miniature: two parents, three
 * leaves, one undefined topic (-1) so "no topic" cannot pass as "topic 0".
 *
 * THE MOUNTS AT THE END ARE CALLED FOR REAL. A stage that throws on mount is
 * not an arithmetic problem — the map shipped with an unclosed inner function,
 * which put the wiring in the wrong scope and made `mount()` die on a
 * `ReferenceError` before a single wagon was drawn — so the last two tests hand
 * `mount`/`mountDig`/`mountTrain` a hand-written fake DOM, a real flow and a
 * night of twelve stones, and check that the markup, the listeners and the
 * `night` → `wagons` → `map` chain all happen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_CATEGORIES, ARXIV_CATEGORIES, cleanTex, digSummary, meanVector, mountDig, mountTrain,
} from '../docs/assets/cave-stage-dig.mjs';
import { fallbackWagonName, mount, tooltipPosition, topicBar } from '../docs/assets/cave-stage-map.mjs';
import { STAGE_NAMES, stageRailHtml } from '../docs/assets/cave.js';
import { createFlow, STAGES } from '../docs/assets/cave-flow.mjs';
import { loadTopics } from '../docs/assets/sieve-core.mjs';

const TOPICS = {
  parents: [
    { id: 'computing', label: 'Computing' },
    { id: 'matter', label: 'Matter' },
  ],
  leaves: [
    { id: 'opt-qalgo', parent: 'computing', label: 'Optimisation & quantum algorithms' },
    { id: 'qml', parent: 'computing', label: 'Quantum machine learning' },
    { id: 'many-body', parent: 'matter', label: 'Many-body physics' },
  ],
};

function nightWith(topic) {
  return {
    stones: topic.map((_, i) => ({ id: '2608.0000' + i, title: 'Paper ' + i })),
    topic: Int32Array.from(topic),
  };
}

/* ── dig ────────────────────────────────────────────────────────────────── */

test('digSummary writes the archives and the window, singular or plural', () => {
  assert.equal(digSummary('cond-mat.mes-hall, quant-ph', 1),
    'cond-mat.mes-hall, quant-ph · last 1 day');
  assert.equal(digSummary(['quant-ph', 'cs.LG'], 3), 'quant-ph, cs.LG · last 3 days');
  /* A junk value is one day, not "NaN days": the field is a number input but
     its value is a string the reader can blank. */
  assert.equal(digSummary('quant-ph', ''), 'quant-ph · last 1 day');
  assert.equal(digSummary('quant-ph', '0'), 'quant-ph · last 1 day');
});

test('the picker carries Dig\'s default categories and its popular list', () => {
  const flat = ARXIV_CATEGORIES.flatMap(([, rows]) => rows.map(([code]) => code));
  for (const code of DEFAULT_CATEGORIES.split(',').map((c) => c.trim())) {
    assert.ok(flat.includes(code), `the picker has no ${code}`);
  }
  assert.equal(DEFAULT_CATEGORIES, 'cond-mat.mes-hall, quant-ph');
  assert.ok(ARXIV_CATEGORIES.length > 3, 'the grouped picker is the whole list, not a stub');
});

test('meanVector averages each dimension, and survives an empty night', () => {
  const mean = meanVector([
    Float32Array.from([1, 0, -1]),
    Float32Array.from([0, 2, 1]),
  ]);
  assert.deepEqual([...mean], [0.5, 1, 0]);
  assert.equal(meanVector([]).length, 0);
});

test('cleanTex turns feed LaTeX into the letters the author typed', () => {
  /* filter.js' two examples, plus the two spellings its accent table exists
     for. String.raw so the backslashes reach the function. */
  assert.equal(cleanTex(String.raw`Jesper M{\o}rk`), 'Jesper Mørk');
  assert.equal(cleanTex(String.raw`Pawe{\l}`), 'Paweł');
  assert.equal(cleanTex(String.raw`{\"o}`), 'ö');
  assert.equal(cleanTex(String.raw`\'e`), 'é');
  assert.equal(cleanTex(String.raw`L\"uders`), 'Lüders');
  assert.equal(cleanTex(''), '');
  assert.equal(cleanTex(undefined), '');
  /* A name with nothing to clean comes back as it went in. */
  assert.equal(cleanTex('Ada Lovelace'), 'Ada Lovelace');
});

/* ── the topic bar ──────────────────────────────────────────────────────── */

test('topicBar counts each paper once, per its primary topic\'s parent', () => {
  const night = nightWith([0, 1, 0, 2]);      // three computing, one matter
  const bar = topicBar(night, TOPICS);

  assert.deepEqual(bar.map((row) => [row.parent, row.count]), [
    ['computing', 3],
    ['matter', 1],
  ]);
  assert.deepEqual(bar[0].leaves.map((leaf) => [leaf.id, leaf.count]), [
    ['opt-qalgo', 2],
    ['qml', 1],
  ]);
  assert.deepEqual(bar[1].leaves.map((leaf) => [leaf.id, leaf.count]), [['many-body', 1]]);
});

test('topicBar leaves out empty leaves and keeps a zero-count parent last', () => {
  const night = nightWith([2, 2, -1]);        // matter only; -1 belongs nowhere
  const bar = topicBar(night, TOPICS);

  assert.deepEqual(bar.map((row) => row.count), [2, 0]);
  assert.deepEqual(bar[0].leaves.map((leaf) => leaf.id), ['many-body']);
  assert.deepEqual(bar[1].leaves, [], 'a parent with no papers lists none of its leaves');
});

test('topicBar is empty without a night, a topics tree or any topics at all', () => {
  assert.deepEqual(topicBar(null, TOPICS), []);
  assert.deepEqual(topicBar(nightWith([0]), null), []);
  assert.deepEqual(topicBar(nightWith([0]), { parents: TOPICS.parents, leaves: [] }), []);
});


/* ── the fallback wagon name ────────────────────────────────────────────── */

test('an unnamed wagon is labelled with its most common leaf', () => {
  const night = nightWith([0, 0, 1, 2]);
  assert.equal(fallbackWagonName([0, 1, 3], night, TOPICS),
    'Optimisation & quantum algorithms');
  assert.equal(fallbackWagonName([2], night, TOPICS), 'Quantum machine learning');
});

test('a tie keeps the first label reached, and no topic means no label', () => {
  const night = nightWith([1, 0]);            // one of each, equal counts
  assert.equal(fallbackWagonName([0, 1], night, TOPICS), 'Quantum machine learning');

  assert.equal(fallbackWagonName([0, 1], nightWith([-1, -1]), TOPICS), '');
  assert.equal(fallbackWagonName([], night, TOPICS), '');
  assert.equal(fallbackWagonName([0], null, TOPICS), '');
  assert.equal(fallbackWagonName([0], night, null), '');
});

/* ── the graph tooltip's position ───────────────────────────────────────── */

test('the graph tooltip sits just off the cursor, and clamps to the viewport', () => {
  const view = { vw: 1000, vh: 800 };
  const size = { w: 220, h: 60 };

  /* The ordinary case: 12 px down-right, as Dig's floating tooltips do. */
  assert.deepEqual(tooltipPosition({ clientX: 100, clientY: 120 }, size, view),
    { left: 112, top: 132 });

  /* Near the right and bottom edges it flips to the other side of the cursor
     rather than hanging off the page, and still leaves an 8 px margin. */
  const edge = tooltipPosition({ clientX: 990, clientY: 790 }, size, view);
  assert.equal(edge.left, 990 - size.w - 12);
  assert.equal(edge.top, 790 - size.h - 12);
  assert.ok(edge.left + size.w <= view.vw && edge.top + size.h <= view.vh,
    'the tooltip hangs off the viewport');

  /* A tooltip wider than the window cannot fit anywhere; it still starts at
     the margin instead of at a negative coordinate. */
  assert.deepEqual(tooltipPosition({ clientX: 5, clientY: 5 }, { w: 2000, h: 60 }, view),
    { left: 8, top: 17 });

  /* No viewport known (a test, a detached page): the raw offset, no NaN. */
  assert.deepEqual(tooltipPosition({ clientX: 40, clientY: 50 }, size, {}),
    { left: 52, top: 62 });
});

/* ── the rail ───────────────────────────────────────────────────────────── */

const STATES = (html) => [...html.matchAll(/class="cave-rail-step is-(\w+)"/g)].map((m) => m[1]);

test('stageRailHtml has one step per stage, in order, with the three states', () => {
  const html = stageRailHtml({ done: { dig: 'quant-ph · last 1 day' } }, STAGES);

  assert.deepEqual(STATES(html), ['done', 'open', ...STAGES.slice(2).map(() => 'locked')]);
  /* The words come from the head's own table, so the rail and the cards can
     never drift apart. */
  for (const name of Object.values(STAGE_NAMES)) {
    assert.ok(html.includes('>' + name + '<'), `the rail is missing ${name}`);
  }
  /* The stage order is the page's order, top to bottom. */
  const hrefs = [...html.matchAll(/href="#stage-(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(hrefs, STAGES);
});

test('a done step carries its summary; the open one is aria-current', () => {
  const html = stageRailHtml({ done: { dig: 'quant-ph · last 1 day', train: '312 papers' } }, STAGES);

  assert.match(html, /class="cave-rail-summary">quant-ph · last 1 day</);
  assert.match(html, /class="cave-rail-summary">312 papers</);
  assert.equal((html.match(/aria-current="step"/g) || []).length, 1);
  assert.match(html, /is-open">/);
  assert.match(html, /is-locked/);

  /* A whole night has no open step left, and nothing claims to be current. */
  const allDone = Object.fromEntries(STAGES.map((id) => [id, 'done']));
  assert.equal((stageRailHtml({ done: allDone }, STAGES).match(/is-open/g) || []).length, 0);
  assert.equal((stageRailHtml({ done: allDone }, STAGES).match(/aria-current/g) || []).length, 0);
});

test('the rail escapes what a summary carries and copes with a bare snapshot', () => {
  const html = stageRailHtml({ done: { dig: '<b>&"quotes"</b>' } }, STAGES);
  assert.ok(!html.includes('<b>'), 'a raw tag got through the summary');
  assert.ok(html.includes('&lt;b&gt;&amp;&quot;quotes&quot;&lt;/b&gt;'));

  assert.deepEqual(STATES(stageRailHtml(null, STAGES)),
    ['open', ...STAGES.slice(1).map(() => 'locked')]);
  assert.deepEqual(STATES(stageRailHtml({}, STAGES)), STATES(stageRailHtml(null, STAGES)));
});

/* ── the lift ───────────────────────────────────────────────────────────── */

const FLOOR = (html) => (html.match(/class="cave-lift" style="--lift-floor: (\d+)"/) || [])[1];

test('the rail is a shaft with exactly one lift, parked at the open floor', () => {
  const html = stageRailHtml(null, STAGES);

  assert.equal((html.match(/class="cave-lift"/g) || []).length, 1, 'one cage, not one per floor');
  assert.ok(html.includes('<div class="cave-lift-shaft">'), 'the floors sit in a shaft');
  assert.ok(html.includes('class="cave-lift-cable"'), 'the cage hangs from a cable');
  assert.ok(html.includes('src="/assets/cave-art/lift.svg"'), 'the cage drawing is not linked');
  /* Decoration: it must not be a second tab stop or a second name for a floor. */
  assert.match(html, /class="cave-lift" style="--lift-floor: \d+" aria-hidden="true"/);
  assert.match(html, /class="cave-lift-cage"[^>]*alt=""/);

  /* Nothing done → the top floor; three done → the fourth; all done → the last. */
  assert.equal(FLOOR(html), '0');
  assert.equal(FLOOR(stageRailHtml({ done: { dig: 'a', train: 'b', map: 'c' } }, STAGES)), '3');

  const allDone = Object.fromEntries(STAGES.map((id) => [id, 'done']));
  assert.equal(FLOOR(stageRailHtml({ done: allDone }, STAGES)), String(STAGES.length - 1));

  /* The floors themselves are unchanged: still one step per stage, still linked. */
  assert.equal((html.match(/class="cave-rail-link" href="#stage-/g) || []).length, STAGES.length);
});

test('the lift cage is a 16-cell rect drawing in the site palette', () => {
  const src = readFileSync(fileURLToPath(new URL('../docs/assets/cave-art/lift.svg', import.meta.url)), 'utf8');
  const theme = readFileSync(fileURLToPath(new URL('../docs/_sass/cave-theme.scss', import.meta.url)), 'utf8');

  assert.match(src.slice(0, src.indexOf('>')), /width="48" height="48" viewBox="0 0 16 16"/);
  assert.match(src, /shape-rendering="crispEdges"/);

  /* Rect-only, like the campfire: no paths and no gradients to anti-alias. */
  const tags = [...src.matchAll(/<([a-z]+)\b/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(tags)], ['svg', 'rect'], 'the cage is rects only');

  const fills = [...new Set([...src.matchAll(/fill="([^"]+)"/g)].map((m) => m[1]))];
  assert.ok(fills.includes('#f5b301') && fills.includes('#7aa2f7'), 'the lamp is gold and lamp blue');
  for (const fill of fills) {
    assert.match(fill, /^#[0-9a-f]{6}$/, `${fill} is not a hex colour`);
    assert.ok(theme.includes(fill), `${fill} is not a colour in cave-theme.scss`);
  }
});

/* ── the mounts ─────────────────────────────────────────────────────────── */

/* A browser, small enough to read. The mounts touch a narrow slice of it —
   `innerHTML` as a string, elements found by class, listeners, `style`,
   `textContent`, `value`, `classList`, `disabled`, `hidden` — and this is
   exactly that slice, so a selector the markup no longer carries fails here the
   way it would in a browser. */
function fakeClassList() {
  const names = new Set();
  return {
    add: (...list) => list.forEach((name) => names.add(name)),
    remove: (...list) => list.forEach((name) => names.delete(name)),
    contains: (name) => names.has(name),
    toggle(name, force) {
      const on = force === undefined ? !names.has(name) : !!force;
      if (on) names.add(name);
      else names.delete(name);
      return on;
    },
  };
}

function fakeElement(tag = 'div') {
  const listeners = new Map();
  const el = {
    tagName: String(tag).toUpperCase(),
    innerHTML: '',
    textContent: '',
    value: '',
    className: '',
    hidden: false,
    disabled: false,
    scrolled: 0,
    style: {},
    dataset: {},
    attrs: {},
    children: [],
    lookup: new Map(),
    classList: fakeClassList(),

    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = listeners.get(type) || [];
      const at = list.indexOf(fn);
      if (at !== -1) list.splice(at, 1);
    },
    /** Was anything wired for `type`? Half the bug was wiring that never ran. */
    wired(type) {
      return (listeners.get(type) || []).length > 0;
    },
    /** Fire the real listeners: a handler that was never added stays silent. */
    fire(type, event = {}) {
      for (const fn of (listeners.get(type) || []).slice()) {
        fn({ target: el, preventDefault() {}, ...event });
      }
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
    replaceChildren(...nodes) {
      el.children = nodes.slice();
    },
    scrollIntoView() {
      el.scrolled += 1;
    },
    querySelector(sel) {
      if (!el.lookup.has(sel)) el.lookup.set(sel, fakeElement(sel));
      return el.lookup.get(sel);
    },
    querySelectorAll() {
      return [];
    },
  };
  return el;
}

/** `class="cls" … value="…"`, the one thing the fake reads back out of markup. */
function markupValue(html, cls) {
  const at = html.indexOf('class="' + cls + '"');
  if (at === -1) return null;
  const tag = html.slice(at, html.indexOf('>', at));
  const match = tag.match(/value="([^"]*)"/);
  return match ? match[1] : null;
}

function fakeBody() {
  const body = fakeElement('body');
  const markup = () => [body, ...body.lookup.values()].map((el) => el.innerHTML).join('');
  body.querySelector = (sel) => {
    /* An id exists only if the markup really carries it, so a click on a wagon
       the table did not render fails here instead of passing quietly. */
    if (sel.startsWith('#') && !markup().includes('id="' + sel.slice(1) + '"')) return null;
    if (!body.lookup.has(sel)) body.lookup.set(sel, fakeElement(sel));
    const el = body.lookup.get(sel);
    /* No HTML parsing here, so an input's value is read back out of its tag. */
    if (!el.value && sel.startsWith('.')) {
      const found = markupValue(markup(), sel.slice(1));
      if (found != null) el.value = found;
    }
    return el;
  };
  return body;
}

const TOPICS_JSON = loadTopics(JSON.parse(readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../docs/assets/corpus/topics.json'), 'utf8',
)));

/** The page's `ctx`, with a real bus and a flow already past dig and train. */
function stageCtx(flow, topics) {
  return {
    flow,
    bus: new EventTarget(),
    config: {
      functionsBase: 'https://functions.test',
      relayUrl: 'https://relay.test',
      embedUrl: 'https://embed.test',
      cacheUrl: 'https://cache.test',
      nameUrl: 'https://name.test',
      discussionsRepo: 'owner/repo',
      discussionsCategory: 'Ideas',
    },
    corpus: null,
    topics,
    axes: null,
    night: null,
    prefs: null,
    ranked: [],
    picks: new Set(),
    storage: null,
  };
}

/** Install the two globals the stage modules reach for; returns the undo. */
function installBrowser() {
  const saved = { document: globalThis.document, window: globalThis.window };
  globalThis.document = { createElement: (tag) => fakeElement(tag) };
  globalThis.window = { innerWidth: 900, prompt: () => null };
  return () => {
    if (saved.document === undefined) delete globalThis.document;
    else globalThis.document = saved.document;
    if (saved.window === undefined) delete globalThis.window;
    else globalThis.window = saved.window;
  };
}

/**
 * Twelve stones in three tight groups of four, in 3-D — small enough to check
 * by hand: at any sane threshold the map must cut three wagons. `topic` points
 * every group at a different leaf of the real `topics.json`, so the topic bar
 * and the fallback labels are the ones the page will print.
 */
function twelveStoneNight(topics) {
  const centres = [[1, 0.02, 0], [0, 1, 0.02], [0.02, 0, 1]];
  const vecs = Array.from({ length: 12 }, (_, i) => {
    const base = centres[Math.floor(i / 4)];
    return Float32Array.from(base.map((v, k) => v + 0.001 * ((i + k) % 7)));
  });
  const leaves = topics.leaves.length;
  return {
    date: '2026-11-13',
    categories: ['quant-ph'],
    stones: vecs.map((_, i) => {
      const id = '2611.' + String(i).padStart(5, '0');
      return {
        id,
        title: 'Paper ' + i,
        abstract: 'An abstract of paper ' + i + '.',
        authors: ['A. Author'],
        cat: 'quant-ph',
        link: 'https://arxiv.org/abs/' + id,
      };
    }),
    vecs,
    topic: Int32Array.from({ length: 12 }, (_, i) => Math.floor(i / 4) % leaves),
    topic2: Int32Array.from({ length: 12 }, () => leaves - 1),
    components: [],
    names: [],
  };
}

test('mounting the map wires it once, and a night reaches the wagons', async () => {
  const undo = installBrowser();
  try {
    const body = fakeBody();
    const flow = createFlow({ storage: null });
    flow.complete('dig', 'quant-ph · last 1 day');
    flow.complete('train', '12 papers');
    const ctx = stageCtx(flow, TOPICS_JSON);
    const wagons = [];
    ctx.bus.addEventListener('wagons', (event) => wagons.push(event.detail));

    /* The bug: `mount` threw a ReferenceError here, so the card kept its
       "Coming soon" body and nothing below it was ever wired. */
    assert.doesNotThrow(() => mount(body, ctx));

    assert.ok(body.innerHTML.includes('class="cave-continue-btn'), 'the map markup never went in');
    const continueBtn = body.querySelector('.cave-continue-btn');
    assert.match(body.innerHTML, /class="cave-continue-btn[^"]*" disabled>/,
      'Continue must start disabled until there is a night');
    for (const [sel, type] of [
      ['.wagon-view-switch', 'click'],
      ['.wagon-thresh-slider', 'input'],
      ['.wagon-name-btn', 'click'],
      ['.cave-continue-btn', 'click'],
    ]) {
      assert.ok(body.querySelector(sel).wired(type),
        `${sel} has no ${type} listener — the wiring is nested in the wrong function`);
    }

    /* A night on the bus: the map clusters it and says so on `wagons`. */
    const night = twelveStoneNight(TOPICS_JSON);
    assert.doesNotThrow(() => ctx.bus.dispatchEvent(new CustomEvent('night', { detail: night })));
    assert.equal(wagons.length, 1, 'the night did not reach the map');
    assert.equal(wagons[0].components.length, 3, 'twelve stones in three groups are three wagons');
    assert.equal(night.components.length, 3, 'the cut was not handed back to the night');
    assert.match(body.querySelector('.wagon-stats').textContent, /^3 wagons · 12 papers · cut at /);
    assert.ok(body.querySelector('.cave-topic-bar').innerHTML.includes('cave-topic-seg'),
      'the topic bar is empty for a night with topics');
    assert.ok(body.querySelector('.wagon-table-wrap').innerHTML.includes('id="wagon-block-0"'),
      'the table never rendered');
    assert.equal(body.querySelector('.cave-map-empty').hidden, true);
    assert.equal(continueBtn.disabled, false);

    /* A click on a strip wagon opens the table there. This is the code that
       threw: it needs the picked `key`, which only the handler has. */
    const strip = body.querySelector('.cave-strip').children[0];
    const wagon = fakeElement('button');
    wagon.attrs['data-wagon'] = '1';
    wagon.closest = () => wagon;
    strip.fire('click', { target: wagon });
    assert.equal(body.querySelector('#wagon-block-1').scrolled, 1,
      "the strip click did not scroll to that wagon's block");

    body.querySelector('.cave-continue-btn').fire('click');
    assert.equal(flow.status('map'), 'done');
    assert.match(flow.summary('map'), /^3 wagons · \S/);

    /* `cut()` looks the new wagons up asynchronously (one SHA-256 per wagon)
       and repaints on the bus when it lands. Let it finish while the fake
       browser is still installed — the async half is the half a browser bug
       hits, and tearing the globals down under it is this test's own error. */
    const repainted = new Promise((resolve) => {
      ctx.bus.addEventListener('wagons', resolve, { once: true });
    });
    await Promise.race([repainted, new Promise((resolve) => setTimeout(resolve, 500))]);
  } finally {
    undo();
  }
});

test('mounting dig and train builds the form and the haul handle, and fetches nothing', () => {
  const undo = installBrowser();
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = () => {
    fetched += 1;
    throw new Error('the smoke test must not dig');
  };
  try {
    const ctx = stageCtx(createFlow({ storage: null }), TOPICS_JSON);

    const digBody = fakeBody();
    assert.doesNotThrow(() => mountDig(digBody, ctx));
    assert.ok(digBody.innerHTML.includes('class="cave-dig-btn'));
    assert.equal(digBody.querySelector('.cave-categories').value, DEFAULT_CATEGORIES,
      'the form did not open with its default categories');
    assert.ok(digBody.querySelector('.cat-chips').innerHTML.includes('cat-chip-code'));
    assert.ok(digBody.querySelector('.cat-add').innerHTML.includes('value="__other__"'));
    assert.ok(digBody.querySelector('.cave-dig').wired('submit'));
    assert.ok(digBody.querySelector('.cat-add').wired('change'));
    assert.ok(digBody.querySelector('.cave-lookback').wired('change'));

    const trainBody = fakeBody();
    assert.doesNotThrow(() => mountTrain(trainBody, ctx));
    assert.match(trainBody.innerHTML, /cave-haul-wrap[^>]*style="display:none"/,
      'the train must stay hidden until a haul starts');
    for (const method of ['begin', 'set', 'say', 'stop']) {
      assert.equal(typeof ctx.haul[method], 'function', `ctx.haul has no ${method}()`);
    }

    assert.equal(fetched, 0, 'mounting a stage may not touch the network');
  } finally {
    globalThis.fetch = realFetch;
    undo();
  }
});
