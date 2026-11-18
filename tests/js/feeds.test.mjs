/*
 * Feeds room: one page listing every launch link. Run with
 * `node --test tests/js/feeds.test.mjs`.
 *
 * The list is built from the launch table rather than written into the page, so
 * a launch added to `cave-launch.mjs` cannot go missing from the room whose
 * whole job is to list them. What can still drift is what this file pins: the
 * nav order in `_config.yml`, the page's front matter, and the escaping of a
 * label. A label is written by hand in the table, and a label is the one thing
 * on the page a reader reads before clicking — so a stray `<b>` in it must be
 * text on the page, not markup.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LAUNCHES } from '../../docs/assets/cave-launch.mjs';
import { feedsHtml } from '../../docs/assets/feeds-page.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('feedsHtml lists every launch as a card pointing at its own address', () => {
  const html = feedsHtml(LAUNCHES);
  assert.equal(html.match(/class="feeds-card"/g)?.length, 12,
    'the room is not the twelve launches the proposal ranked');
  assert.equal(html.match(/class="feeds-card"/g)?.length, LAUNCHES.length,
    'a launch in the table has no card');
  for (const launch of LAUNCHES) {
    assert.ok(html.includes(`<a class="feeds-card" href="/${launch.id}">`), launch.id);
  }
});

test('feedsHtml groups the cards by field, with the field labels as headings', () => {
  const html = feedsHtml(LAUNCHES);
  assert.match(html, /<h2 class="feeds-field-head">Quantum<\/h2>/);
  assert.match(html, /<h2 class="feeds-field-head">AI<\/h2>/);
  // Fields appear in the order their first launch does, and LAUNCHES opens
  // with ai/llms — so AI's section leads.
  assert.ok(html.indexOf('>AI</h2>') < html.indexOf('>Quantum</h2>'),
    'the sections are not in the order their first launch appears');
});

test('a card carries the label, its categories and the phrase, escaped', () => {
  const html = feedsHtml(LAUNCHES);
  const spin = LAUNCHES.find((launch) => launch.id === 'quantum/spin-qubits');
  const card = html.slice(html.indexOf('href="/quantum/spin-qubits"'));
  const body = card.slice(0, card.indexOf('</a>'));
  assert.ok(body.includes('Spin qubits'), 'no label');
  assert.ok(body.includes('cond-mat.mes-hall'), 'no first category');
  assert.ok(body.includes('quant-ph'), 'no last category');
  assert.ok(body.includes(spin.phrase.slice(0, 40)), 'no phrase');
});

test('a label with markup in it is text, not markup', () => {
  const html = feedsHtml([{
    id: 'ai/ghost',
    field: 'ai',
    slug: 'ghost',
    label: '<b>Ghost</b>',
    categories: ['cs.AI'],
    phrase: 'a <i>phrase</i>',
  }]);
  assert.ok(!html.includes('<b>Ghost</b>'), 'the label was not escaped');
  assert.ok(html.includes('&lt;b&gt;Ghost&lt;/b&gt;'));
  assert.ok(!html.includes('<i>phrase</i>'), 'the phrase was not escaped');
});

test('no launches is no sections at all', () => {
  assert.equal(feedsHtml([]), '');
});

test('the nav lists Dig, Feeds, Stockpile, Details in that order', () => {
  const block = /^header_pages:\n((?:[ \t]+- .*\n?)+)/m.exec(read('docs/_config.yml'))?.[1] ?? '';
  const pages = [...block.matchAll(/- (\S+)/g)].map((found) => found[1]);
  assert.deepEqual(pages, ['cave.md', 'feeds.md', 'stockpile.md', 'details.md']);
});

test('feeds.md is a room in the nav, and says something with JS off', () => {
  const page = read('docs/feeds.md');
  const front = /^---\n([\s\S]*?)\n---/.exec(page)?.[1] ?? '';
  assert.match(front, /^layout: page$/m);
  assert.match(front, /^title: Feeds$/m);
  assert.match(front, /^permalink: \/feeds\/$/m);
  assert.match(front, /^gloss: topics$/m);
  assert.match(front, /^nav_icon: haul$/m, 'the room does not wear the haul icon');
  // The room must not be a blank page without JS: the list is built by the
  // module, so the noscript is the only thing a reader without it can see.
  assert.match(page, /<noscript>/);
  assert.ok(page.includes('Pick a topic. Each one digs tonight'), 'no intro line');
  // A container the module fills, and the module itself.
  assert.match(page, /id="feeds-list"/, 'nothing for the module to fill');
  assert.ok(page.includes('/assets/feeds-page.mjs'), 'the page never loads the list module');
});
