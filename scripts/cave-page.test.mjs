/**
 * `cd scripts && node --test cave-page.test.mjs`.
 *
 * The v4 page is eight static sections plus a rail; a mistake in it fails late
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
  assert.match(PAGE, /<div class="cave-wall cave-wall-left" aria-hidden="true"><\/div>/);
  assert.match(PAGE, /<div class="cave-wall cave-wall-right" aria-hidden="true"><\/div>/);

  /* The rail and both walls live inside the wrapper, or the desktop grid and
     the z-index that lifts the page over the walls are both moot. */
  const app = PAGE.indexOf('<div id="cave-app">');
  for (const needle of ['cave-wall-left', 'cave-wall-right', 'id="cave-rail"']) {
    assert.ok(PAGE.indexOf(needle) > app, `${needle} sits outside #cave-app`);
  }
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
