import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AFFIL_PREFIX, TTL_DAYS, affilKey, authorQueryUrl, authorSignal, explainHIndex, lastAuthor, nameKey,
  pickAffiliation, pickHIndex, readCachedAffil, sameName, shortAffil, writeCachedAffil,
} from '../docs/assets/cave-affil.mjs';

const inst = (...names) => names.map((display_name) => ({ display_name }));
const stats = (h_index) => ({ summary_stats: { h_index } });

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

test('nameKey reads arXiv\'s LaTeX names as the surname OpenAlex indexes', () => {
  assert.equal(nameKey("Szyma\\'nski").surname, 'szymanski');
  assert.equal(nameKey("Szyma{\\'n}ski").surname, 'szymanski');
  assert.equal(nameKey("Szyma\\'{n}ski").surname, 'szymanski');
  assert.equal(nameKey('Szymański').surname, 'szymanski');
  assert.deepEqual(nameKey('M{\\"u}ller'), { surname: 'muller', initial: 'm' });
  assert.equal(nameKey('Bła\\.zej Łukasiewicz').surname, 'lukasiewicz');
  assert.equal(nameKey('Søren Kierkegaard').surname, 'kierkegaard');
  assert.equal(nameKey('Marcus Müller').surname, 'muller');
  assert.equal(nameKey('{\\O}rsted').surname, 'orsted', 'a whole-letter command keeps its letter');
  assert.equal(nameKey('G{\\o}mez').surname, 'gomez');
  assert.deepEqual(nameKey("Ren\\'e \\c{c}apa"), { surname: 'capa', initial: 'r' },
    'an accent must not eat the space after it');
  assert.equal(nameKey('\\c c').surname, 'c');
  assert.equal(nameKey('John Smith Jr.').surname, 'smith');
  assert.equal(nameKey('Anna B. Lee III').surname, 'lee');
  assert.equal(nameKey('Jan van der Berg').surname, 'berg', 'spaces still split words');
});

test('explainHIndex names the reason a name has no h-index', () => {
  const hit = { results: [{ display_name: 'Ada Phys', works_count: 40, ...stats(83) }] };
  assert.deepEqual(explainHIndex(hit, 'Ada Phys'), { h: 83, why: null });

  assert.deepEqual(explainHIndex(null, 'Ada Phys'), { h: null, why: 'no-match' });
  assert.deepEqual(explainHIndex({ results: [] }, 'Ada Phys'), { h: null, why: 'no-match' });
  assert.deepEqual(
    explainHIndex({ results: [{ display_name: 'Xingliang Jiang', works_count: 358 }] }, 'Liang Jiang'),
    { h: null, why: 'no-match' });

  const rival = { results: [
    { display_name: 'Wei Zhang', works_count: 724, ...stats(71), last_known_institutions: inst('Qinghai University') },
    { display_name: 'Wei Zhang', works_count: 364, ...stats(50), last_known_institutions: inst('Henan Normal University') },
  ] };
  assert.deepEqual(explainHIndex(rival, 'Wei Zhang'), { h: null, why: 'ambiguous' });
  assert.equal(pickHIndex(rival, 'Wei Zhang'), null, 'pickHIndex still answers the same');

  assert.deepEqual(
    explainHIndex({ results: [{ display_name: 'Ada Phys', works_count: 40 }] }, 'Ada Phys'),
    { h: null, why: 'no-hindex' });
});

test('authorQueryUrl searches Physics & Astronomy and asks for little', () => {
  const url = authorQueryUrl('Barbara M. Terhal');
  assert.ok(url.startsWith('https://api.openalex.org/authors?search=Barbara%20M.%20Terhal'));
  assert.ok(url.includes('filter=topics.field.id:31'));
  assert.ok(url.includes('&per-page=5'));
  assert.ok(url.includes('select=display_name,works_count,last_known_institutions,summary_stats'));
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

test('pickHIndex reads the top namesake\'s h-index', () => {
  const payload = { results: [
    { display_name: 'Mikhail D. Lukin', works_count: 1092, ...stats(83),
      last_known_institutions: inst('Harvard University', 'QuEra Computing (United States)') },
  ] };
  assert.equal(pickHIndex(payload, 'Mikhail Lukin'), 83);
});

test('pickHIndex answers without an institution', () => {
  const payload = { results: [{ display_name: 'A B', works_count: 40, ...stats(12) }] };
  assert.equal(pickHIndex(payload, 'A B'), 12, 'affiliation is not required for an h-index');
});

test('pickHIndex: no results or no h-index is null', () => {
  assert.equal(pickHIndex(null, 'A B'), null);
  assert.equal(pickHIndex({ results: 'no' }, 'A B'), null);
  assert.equal(pickHIndex({ results: [] }, 'A B'), null);
  assert.equal(pickHIndex({ results: [{ display_name: 'A B', works_count: 9 }] }, 'A B'), null, 'no summary_stats');
  assert.equal(pickHIndex({ results: [{ display_name: 'A B', works_count: 9, ...stats(null) }] }, 'A B'), null);
});

test('pickHIndex leaves a common name blank', () => {
  const payload = { results: [
    { display_name: 'Wei Zhang', works_count: 724, ...stats(71), last_known_institutions: inst('Qinghai University') },
    { display_name: 'Wei Zhang', works_count: 364, ...stats(50), last_known_institutions: inst('Henan Normal University') },
  ] };
  assert.equal(pickHIndex(payload, 'Wei Zhang'), null);
});

test('pickHIndex matches an initial-compatible name', () => {
  const payload = { results: [
    { display_name: 'J. I. Cirac', works_count: 801, ...stats(94),
      last_known_institutions: inst('Max Planck Institute of Quantum Optics') },
    { display_name: 'J. Ignacio Cirac', works_count: 700, ...stats(93),
      last_known_institutions: inst('Max Planck Institute of Quantum Optics') },
  ] };
  assert.equal(pickHIndex(payload, 'J. Ignacio Cirac'), 94);
});

test('authorSignal maps an h-index onto 0..1 and saturates at 60', () => {
  assert.equal(authorSignal(0), 0);
  assert.equal(authorSignal(60), 1);
  assert.equal(authorSignal(600), 1, 'never above 1');
  const mid = authorSignal(10);
  assert.ok(Math.abs(mid - Math.log1p(10) / Math.log1p(60)) < 1e-12);
  assert.ok(mid > 0 && mid < 1);
  assert.equal(authorSignal(5, 5), 1, 'a custom saturation');
  assert.ok(Math.abs(authorSignal(5, 30) - Math.log1p(5) / Math.log1p(30)) < 1e-12);
});

test('authorSignal is null for an unknown h', () => {
  assert.equal(authorSignal(null), null);
  assert.equal(authorSignal(undefined), null);
  assert.equal(authorSignal(NaN), null);
  assert.equal(authorSignal(-1), null);
  assert.equal(authorSignal('nope'), null);
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
