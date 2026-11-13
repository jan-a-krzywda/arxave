/**
 * `cd scripts && node --test cave-export.test.mjs`.
 *
 * The three exports are pure string builders, so the tests are literal: hand
 * papers in, compare text out. The fixtures are the cases the card calls out —
 * a single-word author name, a LaTeX title with `$\alpha$` and `&`, an
 * old-style id — plus a versioned id to prove the version is dropped from the
 * DOI and URL while the year stays 2025.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toRis, toBibtex, toMarkdown, downloadText } from '../docs/assets/cave-export.mjs';

const PLATO = {
  id: '2511.01234v2',
  title: 'On the Cave',
  abstract: 'Shadows on a wall.',
  authors: ['Plato'],
  cat: 'physics.hist-ph',
};

const LATEX = {
  id: '2511.00042',
  title: '$\\alpha$-stable & robust: 50% of A_B #1 {x}',
  abstract: 'We study it.',
  authors: ['Ada Lovelace', 'Alan M. Turing'],
  cat: 'quant-ph',
};

const OLD = {
  id: 'quant-ph/0101001',
  title: 'Quantum weirdness',
  abstract: 'An old one.',
  authors: 'Ada Lovelace',
  cat: 'quant-ph',
};

test('toRis emits the exact RIS block, CRLF, version stripped', () => {
  const expected = [
    'TY  - RPRT',
    'M3  - Preprint',
    'PB  - arXiv',
    'TI  - On the Cave',
    'AU  - Plato',
    'PY  - 2025',
    'AB  - Shadows on a wall.',
    'UR  - https://arxiv.org/abs/2511.01234',
    'DO  - 10.48550/arXiv.2511.01234',
    'ER  - ',
  ].join('\r\n') + '\r\n';

  assert.equal(toRis([PLATO]), expected);
});

test('toRis names authors Last, First and reads old-style years', () => {
  const ris = toRis([LATEX, OLD]);
  assert.match(ris, /AU  - Lovelace, Ada\r\nAU  - Turing, Alan M\.\r\n/);
  assert.match(ris, /PY  - 2001\r\n/);
  assert.match(ris, /DO  - 10\.48550\/arXiv\.quant-ph\/0101001\r\n/);
  // Every line break is CRLF; no bare LF slips in.
  assert.ok(ris.split('\n').every((line) => line === '' || line.endsWith('\r')));
  assert.ok(!/[^\r]\n/.test(ris));
});

test('toRis carries the diamond summary in N1', () => {
  const paper = { ...PLATO, diamond: { summary: 'Caves are sticky.', takeaways: [], questions: [] } };
  assert.match(toRis([paper]), /N1  - Caves are sticky\.\r\n/);
});

test('toBibtex dedupes keys with a/b suffixes', () => {
  const a = { id: '2511.00001', title: 'Alpha decay', authors: ['Ada Lovelace'], cat: 'quant-ph' };
  const b = { id: '2511.00002', title: 'Alpha capture', authors: ['Ada Lovelace'], cat: 'quant-ph' };
  const bib = toBibtex([a, b]);
  assert.ok(bib.startsWith('@misc{lovelace2025alpha,'));
  assert.ok(bib.includes('@misc{lovelace2025alphaa,'));
});

test('toBibtex escapes { } % & # _ and protects capitals', () => {
  const bib = toBibtex([LATEX]);
  assert.ok(bib.includes('title = {$\\alpha$-stable \\& robust: 50\\% of A\\_B \\#1 \\{x\\}}'));
  assert.ok(bib.includes('author = {Ada Lovelace and Alan M. Turing}'));
  assert.ok(bib.includes('archivePrefix = {arXiv}'));
  assert.ok(bib.includes('primaryClass = {quant-ph}'));
});

test('toBibtex ASCII key from a single-word name and an old-style id', () => {
  const bib = toBibtex([OLD]);
  assert.ok(bib.startsWith('@misc{lovelace2001quantum,'));
  assert.ok(bib.includes('eprint = {quant-ph/0101001}'));
  assert.ok(bib.includes('year = {2001}'));
});

test('toMarkdown includes diamond bullets when present', () => {
  const paper = {
    ...PLATO,
    diamond: {
      summary: 'Shadows are cheap.',
      takeaways: ['Wall first', 'Then the fire'],
      questions: ['Who holds the lamp?'],
      readIf: 'You like caves.',
    },
  };
  const md = toMarkdown([paper], { title: 'Tonight' });
  assert.ok(md.startsWith('# Tonight\n\n'));
  assert.ok(md.includes('### [On the Cave](https://arxiv.org/abs/2511.01234)'));
  assert.ok(md.includes('Authors: Plato'));
  assert.ok(md.includes('Shadows are cheap.'));
  assert.ok(md.includes('**Takeaways**\n\n- Wall first\n- Then the fire'));
  assert.ok(md.includes('**Open questions**\n\n- Who holds the lamp?'));
});

test('toMarkdown omits the diamond sections when absent', () => {
  const md = toMarkdown([PLATO]);
  assert.ok(md.includes('### [On the Cave](https://arxiv.org/abs/2511.01234)'));
  assert.ok(!md.includes('Takeaways'));
  assert.ok(!md.includes('Open questions'));
});

test('downloadText is a no-op returning false in Node', () => {
  assert.equal(downloadText('picks.ris', 'TY  - RPRT\r\n', 'application/x-research-info-systems'), false);
});
