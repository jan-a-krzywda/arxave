/**
 * `cd scripts && node --test cave-stage-fire.test.mjs`.
 *
 * Stage 4 is one press and a colour wash, so what is testable is what would
 * break silently: the count line's plurals, the two class lists that light the
 * band and the page, the body markup both before and after the fire, the
 * stylesheet link that must appear exactly once, and the two files the browser
 * loads. The campfire is audited as art — crisp edges, a flame the CSS can
 * animate, and every fill a colour the site palette already owns (plus the one
 * declared pale core), the way `cave-art.test.mjs` audits the header.
 *
 * No jsdom and no browser: the SVG is parsed with a regex over a file this repo
 * authors by hand, and the stylesheet is read from its own resolved URL — the
 * same URL the module hands the `<link>`, which is the point.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  ART_HREF, FIRE_COPY, FLAME_CORE, STYLE_HREF, fireHtml, firelineText, litClassesFor, loadStyles, mount,
} from '../docs/assets/cave-stage-fire.mjs';

const SCSS = readFileSync(new URL('../docs/_sass/cave-theme.scss', import.meta.url), 'utf8');
const SVG = readFileSync(fileURLToPath(ART_HREF), 'utf8');
const CSS = readFileSync(fileURLToPath(STYLE_HREF), 'utf8');

/* Every hex the palette sheet declares — the only colours the art may use. */
const PALETTE = new Set(
  [...SCSS.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0].toLowerCase()),
);

/** One named token's colour, e.g. token('gold') -> '#f5b301'. */
function token(name) {
  const found = new RegExp('--' + name + ':\\s*(#[0-9a-fA-F]{3,8})').exec(SCSS);
  assert.ok(found, `cave.scss has no --${name}`);
  return found[1].toLowerCase();
}

const night = (papers, wagons) => ({
  stones: Array.from({ length: papers }, (_, i) => ({ id: '2608.' + i })),
  components: Array.from({ length: wagons }, () => ({ indices: [] })),
});

/* ── the numbers line ──────────────────────────────────────────────────── */

test('firelineText counts papers and wagons, singular or plural', () => {
  assert.equal(firelineText(night(312, 14)), '312 papers in 14 wagons');
  assert.equal(firelineText(night(1, 1)), '1 paper in 1 wagon');
  assert.equal(firelineText(night(0, 0)), null);
});

test('firelineText copes with no night and with a night the map has not cut', () => {
  assert.equal(firelineText(null), null);
  assert.equal(firelineText(undefined), null);
  assert.equal(firelineText({}), null);
  /* Stones but no components: papers only, rather than "0 wagons". */
  assert.equal(firelineText({ stones: [{}, {}, {}] }), '3 papers tonight');
  assert.equal(firelineText({ stones: [{}] }), '1 paper tonight');
});

/* ── the class lists ───────────────────────────────────────────────────── */

test('litClassesFor lights the band and the page only when fire is done', () => {
  assert.deepEqual(litClassesFor('done'), { band: 'cave-fire-band is-lit', app: 'cave-lit' });
  assert.deepEqual(litClassesFor('open'), { band: 'cave-fire-band', app: '' });
  assert.deepEqual(litClassesFor('locked'), { band: 'cave-fire-band', app: '' });
  assert.deepEqual(litClassesFor(undefined), { band: 'cave-fire-band', app: '' });
  assert.deepEqual(litClassesFor(true), { band: 'cave-fire-band is-lit', app: 'cave-lit' });
  /* A restored flow snapshot is accepted too: what `flow.snapshot()` returns. */
  assert.equal(litClassesFor({ done: { fire: 'by the fire' } }).app, 'cave-lit');
  assert.equal(litClassesFor({ done: {} }).app, '');
});

/* ── the body markup ──────────────────────────────────────────────────── */

test('fireHtml is the unlit band: copy, numbers, button', () => {
  const html = fireHtml(night(312, 14), 'open');
  assert.match(html, /class="cave-fire-band"/);
  assert.ok(!html.includes('is-lit'), 'unlit markup carries no lit class');
  assert.ok(html.includes(FIRE_COPY));
  assert.match(html, /<p class="cave-fire-numbers">312 papers in 14 wagons<\/p>/);
  assert.match(html, /<button type="button" class="cave-fire-btn">Sit by the fire<\/button>/);
  assert.match(html, /class="cave-fire-art" aria-hidden="true"/);
});

test('fireHtml is already lit on restore, with nothing to animate and a spent button', () => {
  const html = fireHtml(night(1, 1), 'done');
  assert.match(html, /class="cave-fire-band is-lit"/);
  assert.match(html, /<button type="button" class="cave-fire-btn" disabled>The fire is lit<\/button>/);
  assert.ok(html.includes('>1 paper in 1 wagon<'));
});

test('fireHtml says a muted line instead of failing on a missing night', () => {
  for (const empty of [null, undefined, { stones: [] }]) {
    const html = fireHtml(empty, 'open');
    assert.match(html, /class="cave-fire-muted"/);
    assert.ok(!html.includes('cave-fire-numbers'));
    assert.ok(html.includes(FIRE_COPY), 'the copy and the button survive a null night');
    assert.match(html, /Sit by the fire/);
  }
});

/* ── the live numbers line ────────────────────────────────────────────── */

/** A node with the four methods `mount` touches, and nothing else. */
function stubEl() {
  return {
    innerHTML: '',
    hidden: false,
    disabled: false,
    textContent: '',
    classList: { add() {}, toggle() {}, contains: () => false },
    addEventListener() {},
    setAttribute() {},
  };
}

/** A stage body that hands back one stub per selector the mount asks for. */
function fakeFireBody() {
  const parts = {
    '.cave-fire-band': stubEl(),
    '.cave-fire-btn': stubEl(),
    '.cave-fire-art': stubEl(),
    '.cave-fire-line': stubEl(),
  };
  return {
    innerHTML: '',
    parts,
    querySelector: (sel) => parts[sel] || null,
  };
}

test('the numbers line follows the night and the wagons on the bus', () => {
  /* Mount happens with stage 1, long before a dig, so the line is muted; a
     `night` on the bus is what has to bring the count, and a `wagons` re-cut is
     what has to move the wagon half of it. This is a fake DOM on purpose: the
     line is one innerHTML swap, and no jsdom is needed to see it happen. */
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new Error('no network in a fake DOM'));
  try {
    const body = fakeFireBody();
    const bus = new EventTarget();
    const ctx = { bus, night: null, flow: null };

    assert.doesNotThrow(() => mount(body, ctx));
    const line = body.parts['.cave-fire-line'];
    /* The mount's own markup carries the muted line; the fake body keeps the
       string, the stub line is what the bus repaints. */
    assert.match(body.innerHTML, /class="cave-fire-muted"/, 'the unmounted night is muted');

    const tonight = night(199, 0);
    ctx.night = tonight;
    bus.dispatchEvent(new CustomEvent('night', { detail: tonight }));
    assert.match(line.innerHTML, /199 papers tonight/, line.innerHTML);

    /* Map writes `components` back onto the same night, then says `wagons`. */
    tonight.components = night(0, 17).components;
    bus.dispatchEvent(new CustomEvent('wagons', { detail: { components: tonight.components, names: [] } }));
    assert.match(line.innerHTML, /199 papers in 17 wagons/, line.innerHTML);
  } finally {
    if (realFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = realFetch;
  }
});

/* ── the stylesheet link ──────────────────────────────────────────────── */

test('loadStyles appends one stylesheet link, and only once', () => {
  const head = [];
  const doc = {
    head: { appendChild: (el) => head.push(el) },
    createElement: () => ({ id: '', rel: '', href: '' }),
    getElementById: (id) => head.find((el) => el.id === id) || null,
  };

  const link = loadStyles(doc);
  assert.equal(head.length, 1);
  assert.equal(link.rel, 'stylesheet');
  assert.equal(link.href, STYLE_HREF);
  assert.ok(link.href.endsWith('/assets/cave-fire.css'), link.href);

  assert.equal(loadStyles(doc), null);
  assert.equal(head.length, 1, 'a second mount must not add a second link');
});

test('the module resolves its two files beside itself', () => {
  assert.ok(STYLE_HREF.endsWith('/assets/cave-fire.css'), STYLE_HREF);
  assert.ok(ART_HREF.endsWith('/assets/cave-art/campfire.svg'), ART_HREF);
});

/* ── the campfire art ─────────────────────────────────────────────────── */

test('campfire.svg is pixel-crisp and self-contained', () => {
  const root = /<svg[^>]*>/.exec(SVG)[0];
  assert.match(root, /shape-rendering="crispEdges"/);
  assert.match(root, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(root, /viewBox="0 0 64 48"/);
  assert.match(root, /width="192"/);
  assert.match(root, /height="144"/);
  assert.ok(!/\b(?:xlink:)?href\s*=/i.test(SVG), 'the drawing pulls nothing from elsewhere');
  assert.ok(!/<image\b/i.test(SVG));
  assert.ok(!/url\(|@import/i.test(SVG));
  assert.deepEqual(SVG.match(/https?:\/\/[^"'\s>]+/g) ?? [], ['http://www.w3.org/2000/svg']);
});

test('campfire.svg has a flame group for the CSS flicker', () => {
  const groups = [...SVG.matchAll(/<g\b[^>]*class="[^"]*\bcave-flame\b[^"]*"[^>]*>/g)];
  assert.ok(groups.length >= 1, 'no element carries class cave-flame');
  assert.ok(SVG.trimEnd().endsWith('</svg>'));
});

test('campfire.svg uses only palette colours plus the declared core', () => {
  const fills = [...new Set([...SVG.matchAll(/fill="([^"]+)"/g)].map((m) => m[1].toLowerCase()))];
  assert.ok(fills.length > 0, 'the drawing has no fills');
  for (const fill of fills) {
    const allowed = fill === 'none' || fill === 'currentcolor'
      || fill === FLAME_CORE.toLowerCase() || PALETTE.has(fill);
    assert.ok(allowed, `fill ${fill} is not in cave.scss and is not FLAME_CORE`);
  }
  /* The card's colours, present: rock logs, ember rim, gold flame, pale core. */
  for (const [name, colour] of [
    ['rock-lit', token('rock-lit')],
    ['rock-edge', token('rock-edge')],
    ['ember', token('ember')],
    ['gold', token('gold')],
    ['FLAME_CORE', FLAME_CORE.toLowerCase()],
  ]) {
    assert.ok(fills.includes(colour), `the drawing has no ${name} (${colour})`);
  }
});

test('campfire.svg stays on its 2 px grid and inside the 64x48 box', () => {
  for (const [, attrs] of SVG.matchAll(/<rect ([^>]*)\/>/g)) {
    for (const [, name, value] of attrs.matchAll(/\b(x|y|width|height)="(\d+)"/g)) {
      assert.equal(Number(value) % 2, 0, `${name}="${value}" is off the 2 px grid`);
    }
    const x = Number(/\bx="(\d+)"/.exec(attrs)[1]);
    const y = Number(/\by="(\d+)"/.exec(attrs)[1]);
    const w = Number(/\bwidth="(\d+)"/.exec(attrs)[1]);
    const h = Number(/\bheight="(\d+)"/.exec(attrs)[1]);
    assert.ok(x + w <= 64, `a rect runs past the right edge: x=${x} w=${w}`);
    assert.ok(y + h <= 48, `a rect runs past the bottom edge: y=${y} h=${h}`);
  }
});

/* ── the stylesheet's contract ────────────────────────────────────────── */

test('cave-fire.css washes and rings the stages after the fire', () => {
  assert.match(CSS, /#cave-app\.cave-lit/);
  for (const id of ['priorities', 'ranking', 'act', 'story']) {
    assert.ok(CSS.includes(`[data-stage="${id}"]`), `no firelight rule for ${id}`);
  }
  assert.match(CSS, /color-mix\(in srgb, var\(--gold\) 10%, transparent\)/);
  assert.match(CSS, /outline: 2px solid var\(--gold\)/);
});

test('cave-fire.css flickers in four steps and stops for reduced motion', () => {
  assert.match(CSS, /steps\(4\)/);
  assert.match(CSS, /0\.9s/);
  /* The 600 ms fade the card asks for, on the flame group. */
  assert.match(CSS, /transition: opacity 600ms/);
  assert.match(CSS, /@media \(prefers-reduced-motion: reduce\)[\s\S]*animation: none/);
  assert.match(CSS, /@media \(prefers-reduced-motion: reduce\)[\s\S]*transition: none/);
});

test('cave-fire.css speaks the palette, not hexes or v3 tokens', () => {
  assert.equal((CSS.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).length, 0, 'raw hex in the stylesheet');
  assert.ok(!CSS.includes('--cv-'), 'a v3 token leaked in');
  /* Every var() it reads exists in cave.scss, so no rule silently dies. */
  for (const [, name] of CSS.matchAll(/var\((--[a-z0-9-]+)/g)) {
    assert.ok(SCSS.includes(name + ':'), `cave.scss defines no ${name}`);
  }
});
