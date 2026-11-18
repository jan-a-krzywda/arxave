import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AFFIL_PREFIX, TTL_DAYS, affilKey, authorQueryUrl, lastAuthor, nameKey, pickAffiliation,
  readCachedAffil, sameName, shortAffil, writeCachedAffil,
} from '../docs/assets/cave-affil.mjs';

const inst = (...names) => names.map((display_name) => ({ display_name }));

test('lastAuthor takes the last name of an array or a comma list', () => {
  assert.equal(lastAuthor(['A One', 'B Two', ' C Three ']), 'C Three');
  assert.equal(lastAuthor('A One, B Two and C Three'), 'C Three');
  assert.equal(lastAuthor([]), '');
  assert.equal(lastAuthor(undefined), '');
});

test('nameKey and sameName ignore accents, dots and middle names', () => {
  assert.deepEqual(nameKey('J. Ignacio Cirac'), { surname: 'cirac', initial: 'j' });
  assert.ok(sameName('Hans J. Briegel', 'H. J. Briegel'));
  assert.ok(sameName('Jens Eisert', 'Jéns Eisert'));
  assert.ok(!sameName('Liang Jiang', 'Xingliang Jiang'));
  assert.equal(nameKey('  '), null);
});

test('authorQueryUrl searches Physics & Astronomy and asks for little', () => {
  const url = authorQueryUrl('Barbara M. Terhal');
  assert.ok(url.startsWith('https://api.openalex.org/authors?search=Barbara%20M.%20Terhal'));
  assert.ok(url.includes('filter=topics.field.id:31'));
  assert.ok(url.includes('select=display_name,works_count,last_known_institutions'));
});

test('shortAffil drops the country and a leading "The"', () => {
  assert.equal(shortAffil('QuEra Computing (United States)'), 'QuEra Computing');
  assert.equal(shortAffil('The University of Sydney'), 'University of Sydney');
  assert.equal(shortAffil(undefined), '');
});

test('pickAffiliation takes the top namesake\'s first institution', () => {
  const payload = { results: [
    { display_name: 'Mikhail D. Lukin', works_count: 1092,
      last_known_institutions: inst('Harvard University', 'QuEra Computing (United States)') },
  ] };
  assert.equal(pickAffiliation(payload, 'Mikhail Lukin'), 'Harvard University');
});

test('pickAffiliation skips hits that are another person', () => {
  const payload = { results: [
    { display_name: 'Xingliang Jiang', works_count: 358, last_known_institutions: inst('Chongqing University') },
    { display_name: 'Liang Jiang', works_count: 493, last_known_institutions: inst('University of Chicago') },
    { display_name: 'Liang Jiang', works_count: 64, last_known_institutions: inst('Wuxi University') },
  ] };
  assert.equal(pickAffiliation(payload, 'Liang Jiang'), 'University of Chicago', 'a small namesake is no rival');
});

test('pickAffiliation leaves a common name blank', () => {
  const payload = { results: [
    { display_name: 'Wei Zhang', works_count: 724, last_known_institutions: inst('Qinghai University') },
    { display_name: 'Wei Zhang', works_count: 364, last_known_institutions: inst('Henan Normal University') },
  ] };
  assert.equal(pickAffiliation(payload, 'Wei Zhang'), '');
});

test('pickAffiliation: a namesake at the same place is the same person', () => {
  const payload = { results: [
    { display_name: 'J. I. Cirac', works_count: 801, last_known_institutions: inst('Max Planck Institute of Quantum Optics') },
    { display_name: 'J. Ignacio Cirac', works_count: 700, last_known_institutions: inst('Max Planck Institute of Quantum Optics') },
  ] };
  assert.equal(pickAffiliation(payload, 'J. Ignacio Cirac'), 'Max Planck Institute of Quantum Optics');
});

test('pickAffiliation tolerates junk', () => {
  assert.equal(pickAffiliation(null, 'A B'), '');
  assert.equal(pickAffiliation({ results: 'no' }, 'A B'), '');
  assert.equal(pickAffiliation({ results: [{ display_name: 'A B' }] }, 'A B'), '', 'no institution');
  assert.equal(pickAffiliation({ results: [] }, ''), '');
});

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    map,
  };
}

test('the cache keeps answers, "don\'t know" included, until they expire', () => {
  const storage = memoryStorage();
  const t0 = 1_700_000_000_000;
  assert.equal(readCachedAffil(storage, 'Jens Eisert', t0), null);
  writeCachedAffil(storage, 'Jens Eisert', 'Freie Universität Berlin', t0);
  writeCachedAffil(storage, 'Wei Zhang', '', t0);
  assert.equal(readCachedAffil(storage, 'Jéns  Eisert', t0 + 1), 'Freie Universität Berlin', 'same key however spelled');
  assert.equal(readCachedAffil(storage, 'Wei Zhang', t0 + 1), '');
  assert.equal(readCachedAffil(storage, 'Jens Eisert', t0 + (TTL_DAYS + 1) * 86_400_000), null);
  assert.ok(affilKey('Jens Eisert').startsWith(AFFIL_PREFIX));
});

test('the cache shrugs off junk and missing storage', () => {
  const storage = memoryStorage();
  storage.setItem(affilKey('A B'), '{not json');
  assert.equal(readCachedAffil(storage, 'A B'), null);
  assert.equal(readCachedAffil(null, 'A B'), null);
  writeCachedAffil(null, 'A B', 'x');
  const full = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
  writeCachedAffil(full, 'A B', 'x');
});
