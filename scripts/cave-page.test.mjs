/**
 * `cd scripts && node --test cave-page.test.mjs`.
 *
 * The v4 page is seven static sections plus a rail; a mistake in it fails late
 * and quietly — a renamed `data-stage` leaves `cave.js` painting nothing, a
 * `var(--token)` no stylesheet defines renders as nothing at all. So this file
 * reads the two files that describe the shell (`docs/cave.md`,
 * `docs/assets/cave.css`) and holds them to the interface contract, plus the
 * palette sheet they are allowed to read.
 *
 * WHAT IT CANNOT CHECK is what it looks like. That is the browser's job, at
 * 360 px and at desktop; here the assertions are the ones a machine can make:
 * one section per stage in order with the contract classes, the rail and the
 * walls, no v3 token sheet anywhere, and every colour resolved.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { STAGES } from '../docs/assets/cave-flow.mjs';
import { STAGE_NAMES } from '../docs/assets/cave.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(ROOT, file), 'utf8');

const PAGE = read('docs/cave.md');
const CSS = read('docs/assets/cave.css');
const PALETTE = read('docs/_sass/cave-theme.scss');

/* ── the sections ──────────────────────────────────────────────────────── */

/** Where each stage's section starts, so order can be compared. */
const sectionAt = (id) => PAGE.indexOf('id="stage-' + id + '"');

test('docs/cave.md has one section per stage, in STAGES order', () => {
  for (const id of STAGES) {
    assert.ok(sectionAt(id) !== -1, `cave.md has no #stage-${id}`);
  }
  const positions = STAGES.map(sectionAt);
  assert.deepEqual(positions, positions.slice().sort((a, b) => a - b),
    'the sections are out of STAGES order');
});

test('every section is the contract\'s markup, with its number and its name', () => {
  for (let i = 0; i < STAGES.length; i += 1) {
    const id = STAGES[i];
    const start = sectionAt(id);
    const end = PAGE.indexOf('</section>', start);
    assert.ok(end > start, `#stage-${id} is never closed`);
    const section = PAGE.slice(start, end);

    assert.match(section, /^id="stage-[a-z]+" data-stage="[a-z]+"/,
      `#stage-${id}: the section must carry id and data-stage`);
    assert.match(section, /<button type="button" class="cave-stage-head" aria-expanded="(true|false)">/,
      `#stage-${id}: no contract button`);
    assert.ok(section.includes('<span class="cave-stage-n">' + (i + 1) + '</span>'),
      `#stage-${id}: the number is not ${i + 1}`);
    assert.ok(section.includes('<span class="cave-stage-name">' + STAGE_NAMES[id] + '</span>'),
      `#stage-${id}: the name is not "${STAGE_NAMES[id]}"`);
    assert.ok(section.includes('<span class="cave-stage-summary"></span>'),
      `#stage-${id}: no empty summary span`);
    assert.ok(section.includes('<div class="cave-stage-body"></div>'),
      `#stage-${id}: no empty body for its module`);
  }

  /* `data-stage` is what cave.js looks the flow up by; a copy of the id in a
     second attribute is only worth having if the two agree. */
  for (const id of STAGES) {
    assert.ok(PAGE.includes('data-stage="' + id + '"'), `data-stage="${id}" is missing`);
  }
});

/* ── the shell ─────────────────────────────────────────────────────────── */

test('the page carries the rail, the app wrapper and the two side walls', () => {
  assert.match(PAGE, /<nav class="cave-rail" id="cave-rail" aria-label="[^"]+">/);
  assert.match(PAGE, /<div id="cave-app">/);
  assert.match(PAGE, /<div class="cave-wall cave-wall-left cave-wall-dig" aria-hidden="true"><\/div>/);
  assert.match(PAGE, /<div class="cave-wall cave-wall-right cave-wall-dig" aria-hidden="true"><\/div>/);

  /* The rail lives inside the wrapper, where the desktop grid places it. */
  const app = PAGE.indexOf('<div id="cave-app">');
  assert.ok(PAGE.indexOf('id="cave-rail"') > app, 'the rail sits outside #cave-app');

  /* The walls do not: as siblings before the wrapper they position against
     .page-content and land in the gutters. Inside it they position against the
     content box and paint over the rail and the cards (seen at 1280, 1440). */
  for (const needle of ['cave-wall-left', 'cave-wall-right']) {
    const at = PAGE.indexOf(needle);
    assert.ok(at !== -1 && at < app, `${needle} is not before #cave-app`);
  }
});

test('cave.css widens the walls and narrows the centre, for this page only', () => {
  assert.match(CSS, /\.cave-wall-dig/, 'cave.css has no .cave-wall-dig rule');
  /* 60rem centre, gutter walls up to 320px, shown from 1100px up. */
  assert.match(CSS, /#cave-app \{[^}]*max-width: 60rem/, '#cave-app is not 60rem wide');
  assert.match(CSS, /\.cave-wall\.cave-wall-dig \{[^}]*width: clamp\(0px, calc\(\(100vw - 60rem - 3rem\) \/ 2\), 320px\)/,
    'the walls do not take the gutter outside the 60rem centre');
  const walls = CSS.slice(CSS.indexOf('.cave-wall.cave-wall-dig'));
  assert.match(walls, /@media \(min-width: 1100px\)/, 'the walls do not start at 1100px');
  /* Scoped by the page's own class, so no other room changes with it. */
  assert.ok(!/^\.cave-wall \{/m.test(CSS), 'cave.css restyles every room\'s walls');
});

test('the page loads the three stylesheets and the module with cache-busting', () => {
  for (const sheet of ['style.css', 'filter.css', 'cave.css']) {
    assert.ok(
      PAGE.includes("{{ '/assets/" + sheet + "' | relative_url }}?v={{ site.time | date: '%s' }}"),
      `${sheet} is not linked with ?v=`,
    );
  }
  assert.ok(PAGE.includes('<script type="module" src="{{ \'/assets/cave.js\' | relative_url }}'
    + '?v={{ site.time | date: \'%s\' }}"></script>'));
  assert.match(PAGE, /^permalink: \/$/m);  // the Cave is the site root since the v4 cutover
});

test('the discussions repo reaches the page from Jekyll, with a fallback', () => {
  assert.ok(PAGE.includes(
    'window.ARXAVE_DISCUSSIONS_REPO = "{{ site.discussions_repo | default: site.github_repo }}"'));
  assert.ok(PAGE.includes(
    'window.ARXAVE_CORPUS_BASE = "{{ \'/assets/corpus/\' | relative_url }}"'));
});


/* ── the palette ───────────────────────────────────────────────────────── */

test('no v3 token sheet is linked, imported or referenced', () => {
  for (const [name, text] of [['cave.md', PAGE], ['cave.css', CSS]]) {
    assert.ok(!text.includes('cave-tokens'), `${name} still names cave-tokens.css`);
    assert.ok(!text.includes('--cv-'), `${name} still uses a --cv- token`);
  }
});

test('every var() in cave.css is defined in cave.css or the site palette', () => {
  const defined = new Set([
    ...[...PALETTE.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]),
    ...[...CSS.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]),
  ]);
  const used = new Set([...CSS.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]));

  assert.ok(used.size > 10, 'cave.css should be reading the palette, not hard-coding hexes');
  for (const name of used) assert.ok(defined.has(name), `var(${name}) is never defined`);
});

test('cave.css keeps its layout promises and stays balanced', () => {
  /* Braces balanced, so a typo cannot swallow the rules below it. */
  assert.equal((CSS.match(/\{/g) ?? []).length, (CSS.match(/\}/g) ?? []).length);
  assert.match(CSS, /@media \(min-width: 900px\)/, 'the rail needs its desktop layout');
  assert.match(CSS, /@media \(max-width: 600px\)/, 'the page needs its 360 px layout');
  /* The rail is sticky exactly where it is vertical. */
  const desktop = CSS.slice(CSS.indexOf('@media (min-width: 900px)'));
  assert.match(desktop, /\.cave-rail \{[^}]*position: sticky/);
  /* Done, open and locked are the three looks the flow can produce. */
  for (const state of ['is-done', 'is-open', 'is-locked']) {
    assert.ok(CSS.includes('.' + state), `cave.css has no .${state} rule`);
  }
});

/* The cage's floor is a multiple of the step's height and nothing else, so these
   two constants are the whole alignment: change one alone and the lift parks
   between floors. */
test('the lift descends by whole floors and honours reduced motion', () => {
  const desktop = CSS.slice(CSS.indexOf('@media (min-width: 900px)'));

  assert.match(desktop, /--cave-lift-pitch:\s*[\d.]+rem/, 'no floor pitch');
  assert.match(desktop, /\.cave-rail-step \{[^}]*min-height: var\(--cave-lift-pitch\)/,
    'a floor is not the pitch tall');
  assert.match(desktop, /transform: translateY\(calc\(var\(--lift-floor\) \* var\(--cave-lift-pitch\)\)\)/,
    'the cage does not move by whole floors');
  assert.match(desktop, /transition: transform 700ms ease-in-out/);
  assert.match(CSS, /@media \(prefers-reduced-motion: reduce\) \{\s*\.cave-lift \{\s*transition: none;/);
});

/* ── cache busting for modules ─────────────────────────────────────────── */

// Only cave.js carries ?v= in its <script>; a stale cave-flow.mjs from the
// browser cache once ran the new shell against the old stage list.
test('cave.md maps every assets/*.mjs to a ?v= URL before the first module', () => {
  const md = read('docs/cave.md');
  const map = md.indexOf('<script type="importmap">');
  assert.ok(map !== -1, 'no import map');
  assert.ok(map < md.indexOf('<script type="module"'), 'import map after the module script');
  assert.match(md, /f\.extname == '\.mjs' and f\.path contains '\/assets\/'/);
});

test('stage stylesheets carry the version of the module that loads them', () => {
  for (const f of ['act', 'priorities', 'ranking', 'story']) {
    assert.match(read(`docs/assets/cave-stage-${f}.mjs`),
      new RegExp(`new URL\\('\\./cave-${f}\\.css' \\+ new URL\\(import\\.meta\\.url\\)\\.search, import\\.meta\\.url\\)`));
  }
});

/* ── the site theme import ─────────────────────────────────────────────── */

// Sass looks beside main.scss before _sass/, so an assets/<name>.css would
// silently replace the theme partial of the same name on every page.
test('main.scss imports no name that a file in docs/assets shadows', () => {
  const imports = [...read('docs/assets/main.scss').matchAll(/^@import "([^"]+)";/gm)].map((m) => m[1]);
  assert.ok(imports.includes('cave-theme'), 'main.scss no longer imports cave-theme');
  for (const name of imports) {
    for (const file of [name, '_' + name].flatMap((n) => ['.scss', '.sass', '.css'].map((x) => n + x))) {
      assert.ok(!existsSync(path.join(ROOT, 'docs/assets', file)),
        `docs/assets/${file} shadows the @import "${name}" in main.scss`);
    }
  }
});
