import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_FIELD, FIELDS, chooseField, fieldBase, fieldById, fieldForCategories, fieldHref, fieldKey,
} from '../docs/assets/cave-fields.mjs';
import { otherField } from '../docs/assets/cave-stage-dig.mjs';
import { STORE_KEY, fieldSwitchHtml } from '../docs/assets/cave-stage-priorities.mjs';

const quantum = fieldById('quantum');
const ai = fieldById('ai');

test('two packs: quantum at the corpus root, AI in its own folder', () => {
  assert.deepEqual(FIELDS.map((f) => f.id), ['quantum', 'ai']);
  assert.equal(DEFAULT_FIELD, quantum);
  assert.equal(fieldBase('/assets/corpus/', quantum), '/assets/corpus/');
  assert.equal(fieldBase('/assets/corpus', ai), '/assets/corpus/ai/');
  assert.equal(fieldById('nope'), null);
});

test('categories → the field that claims most of them; quantum wins a tie', () => {
  assert.equal(fieldForCategories(['cs.LG']), ai);
  assert.equal(fieldForCategories(['quant-ph', 'cs.AI', 'cs.LG']), ai);
  assert.equal(fieldForCategories(['quant-ph', 'cs.AI']), quantum);
  assert.equal(fieldForCategories(['hep-th']), null);
  assert.equal(fieldForCategories(undefined), null);
});

test('chooseField: URL, then the stored choice, then Dig\'s categories, then quantum', () => {
  assert.equal(chooseField({ search: '?field=ai', stored: 'quantum' }), ai);
  assert.equal(chooseField({ search: '?field=bogus', stored: 'ai' }), ai);
  assert.equal(chooseField({ stored: 'quantum', digCategories: ['cs.LG'] }), quantum);
  assert.equal(chooseField({ digCategories: ['cs.AI'] }), ai);
  assert.equal(chooseField({ digCategories: ['hep-th'] }), quantum);
  assert.equal(chooseField(), quantum);
});

test('prefs keys: quantum keeps the old key, AI gets its own', () => {
  assert.equal(fieldKey(STORE_KEY, quantum), STORE_KEY);
  assert.equal(fieldKey(STORE_KEY, null), STORE_KEY);
  assert.equal(fieldKey(STORE_KEY, ai), STORE_KEY + '-ai');
});

test('fieldHref sets ?field= and keeps the rest of the URL', () => {
  assert.equal(fieldHref('https://x.org/cave/?a=1#stage-dig', 'ai'), 'https://x.org/cave/?a=1&field=ai#stage-dig');
  assert.equal(fieldHref('https://x.org/cave/?field=ai', 'quantum'), 'https://x.org/cave/?field=quantum');
});

test('Dig offers the other pack only when the categories miss tonight\'s field', () => {
  assert.equal(otherField(['cs.LG', 'cs.AI'], quantum), ai);
  assert.equal(otherField(['quant-ph', 'cs.LG'], quantum), null);
  assert.equal(otherField(['quant-ph'], ai), quantum);
  assert.equal(otherField(['hep-th'], quantum), null);
  assert.equal(otherField(['cs.LG'], null), null);
});

test('the Field picker lists every pack with tonight\'s selected', () => {
  const html = fieldSwitchHtml(ai);
  assert.match(html, /class="cave-field-select"/);
  assert.match(html, /<option value="ai" selected>AI<\/option>/);
  assert.match(html, /<option value="quantum">Quantum<\/option>/);
  assert.equal(fieldSwitchHtml(null), '');
});
