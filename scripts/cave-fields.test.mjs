import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_FIELD, FIELDS, alignCategories, chooseField, fieldBase, fieldById, fieldForCategories,
  fieldFromUrl, fieldKey, fieldsInCategories, withoutField,
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

test('categories → the field of the first category any field claims', () => {
  assert.equal(fieldForCategories(['cs.LG']), ai);
  assert.equal(fieldForCategories(['cs.AI', 'quant-ph']), ai);
  assert.equal(fieldForCategories(['quant-ph', 'cs.AI', 'cs.LG']), quantum);
  assert.equal(fieldForCategories(['hep-th', 'cs.LG', 'quant-ph']), ai);
  assert.equal(fieldForCategories(['hep-th']), null);
  assert.equal(fieldForCategories(undefined), null);
});

test('fieldsInCategories lists every field touched, in order of appearance', () => {
  assert.deepEqual(fieldsInCategories(['cs.AI', 'quant-ph', 'cs.LG']), [ai, quantum]);
  assert.deepEqual(fieldsInCategories(['quant-ph']), [quantum]);
  assert.deepEqual(fieldsInCategories(['hep-th']), []);
});

test('alignCategories puts the field\'s codes first, or swaps in its defaults', () => {
  assert.deepEqual(alignCategories(['cs.AI', 'quant-ph', 'hep-th', 'cond-mat.mes-hall'], quantum),
    ['quant-ph', 'cond-mat.mes-hall', 'cs.AI', 'hep-th']);
  assert.deepEqual(alignCategories(['quant-ph'], ai), ['cs.AI', 'cs.LG']);
  assert.deepEqual(alignCategories(['cs.LG', 'quant-ph'], ai), ['cs.LG', 'quant-ph']);
  assert.equal(fieldForCategories(alignCategories(['cs.AI', 'quant-ph'], quantum)), quantum);
});

test('chooseField: URL, then Dig\'s first category, then the stored choice, then quantum', () => {
  assert.equal(chooseField({ search: '?field=ai', digCategories: ['quant-ph'] }), ai);
  assert.equal(chooseField({ search: '?field=bogus', stored: 'ai' }), ai);
  assert.equal(chooseField({ stored: 'quantum', digCategories: ['cs.LG'] }), ai);
  assert.equal(chooseField({ stored: 'ai', digCategories: ['quant-ph', 'cs.AI'] }), quantum);
  assert.equal(chooseField({ stored: 'ai', digCategories: ['hep-th'] }), ai);
  assert.equal(chooseField({ digCategories: ['hep-th'] }), quantum);
  assert.equal(chooseField(), quantum);
  assert.equal(fieldFromUrl('?field=ai'), ai);
  assert.equal(fieldFromUrl(''), null);
});

test('prefs keys: quantum keeps the old key, AI gets its own', () => {
  assert.equal(fieldKey(STORE_KEY, quantum), STORE_KEY);
  assert.equal(fieldKey(STORE_KEY, null), STORE_KEY);
  assert.equal(fieldKey(STORE_KEY, ai), STORE_KEY + '-ai');
});

test('withoutField drops ?field= and keeps the rest of the URL', () => {
  assert.equal(withoutField('https://x.org/cave/?a=1&field=ai#stage-dig'), 'https://x.org/cave/?a=1#stage-dig');
  assert.equal(withoutField('https://x.org/cave/?field=ai'), 'https://x.org/cave/');
});

test('Dig switches when the lead category is the other field\'s', () => {
  assert.equal(otherField(['cs.LG', 'cs.AI'], quantum), ai);
  assert.equal(otherField(['cs.LG', 'quant-ph'], quantum), ai);
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
