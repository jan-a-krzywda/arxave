/**
 * `cd scripts && node --test cave-thread.test.mjs`.
 *
 * Nothing here draws or fetches: the stage-7 thread action is a search link
 * and a prefilled new-discussion link, so the tests are string assertions over
 * the four builders. The length cases are the ones worth reading — a real
 * arXiv abstract is 1-2 000 characters and an LLM diamond can be another
 * 1 000, and the URL has to survive the address bar anyway.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseRepo, searchUrl, threadTitle, threadBody, newThreadUrl } from '../docs/assets/cave-thread.mjs';

const PAPER = {
  id: '2401.12345',
  title: 'Quantum Mpemba in a $\\alpha$-cavity',
  abstract: 'We study a driven cavity.\nThe second line matters.',
  authors: ['A. One', 'B. Two'],
  cat: 'quant-ph',
  link: 'https://arxiv.org/abs/2401.12345',
};

const DIAMOND = {
  summary: 'The cavity relaxes faster than its slowest mode suggests.',
  takeaways: ['Mpemba survives the drive', 'The effect is not a fitting artefact'],
  questions: ['Does it hold off resonance?', 'What sets the crossover time?'],
};

const REPO = 'jan-a-krzywda/arxave';

test('parseRepo reads every form the config and a reader hand over', () => {
  for (const input of [
    REPO,
    `${REPO}/`,
    `${REPO}.git`,
    `https://github.com/${REPO}`,
    `https://github.com/${REPO}/`,
    `https://github.com/${REPO}.git`,
    `https://github.com/${REPO}.git/`,
    `http://www.github.com/${REPO}`,
    `  https://github.com/${REPO}  `,
    `https://github.com/${REPO}?tab=readme`,
  ]) {
    assert.equal(parseRepo(input), REPO, JSON.stringify(input));
  }
});

test('parseRepo rejects anything that is not a GitHub repo', () => {
  for (const input of [
    '',
    '   ',
    'owner',
    'gitlab.com/x/y',
    'https://gitlab.com/x/y',
    'https://github.com/owner',
    'owner/name/extra',
    null,
    undefined,
    42,
  ]) {
    assert.equal(parseRepo(input), null, JSON.stringify(input));
  }
});

test('searchUrl uses the bare id, so a v2 finds the paper thread', () => {
  assert.equal(
    searchUrl('https://github.com/jan-a-krzywda/arxave/', { ...PAPER, id: '2401.12345v2' }),
    'https://github.com/jan-a-krzywda/arxave/discussions?discussions_q=2401.12345',
  );
});

test('searchUrl encodes an old-style id and hides on a bad repo', () => {
  assert.equal(
    searchUrl(REPO, { ...PAPER, id: 'quant-ph/0601001v1' }),
    'https://github.com/jan-a-krzywda/arxave/discussions?discussions_q=quant-ph%2F0601001',
  );
  assert.equal(searchUrl('https://gitlab.com/x/y', PAPER), '');
});

test('the title is one line, keeps LaTeX, and keeps the bare id', () => {
  assert.equal(
    threadTitle({ id: '2401.12345v3', title: '  Quantum\n  Mpemba   in a $\\alpha$-cavity ' }),
    '[2401.12345] Quantum Mpemba in a $\\alpha$-cavity',
  );
});

test('the title is clipped to 200 characters with an ellipsis', () => {
  const title = threadTitle({ id: '2401.12345', title: 'x'.repeat(400) });
  assert.equal([...title].length, 200);
  assert.ok(title.startsWith('[2401.12345] xxx'));
  assert.ok(title.endsWith('…'));
});

test('the body links abs and PDF, credits authors, quotes the abstract, and signs off', () => {
  const body = threadBody(PAPER);
  assert.ok(body.includes('[arXiv 2401.12345](https://arxiv.org/abs/2401.12345)'), body);
  assert.ok(body.includes('[PDF](https://arxiv.org/pdf/2401.12345)'), body);
  assert.ok(body.includes('**Authors:** A. One, B. Two'), body);
  assert.ok(body.includes('> We study a driven cavity.\n> The second line matters.'), body);
  assert.ok(body.includes('Opened from [arXave](https://arxave.com/)'), body);
  assert.ok(!body.includes('**Summary**'), 'no diamond was given');
  assert.ok(!body.includes('**Take-homes**'), 'no diamond was given');
});

test('the body without a link falls back to the id, and honours siteUrl', () => {
  const body = threadBody({ ...PAPER, link: '' }, { siteUrl: 'https://example.org/' });
  assert.ok(body.includes('](https://arxiv.org/abs/2401.12345)'), body);
  assert.ok(body.includes('](https://arxiv.org/pdf/2401.12345)'), body);
  assert.ok(body.includes('Opened from [arXave](https://example.org/)'), body);
});

test('the diamond arrives as summary, take-homes and open questions', () => {
  const body = threadBody(PAPER, { diamond: DIAMOND });
  assert.ok(body.includes(`**Summary**\n\n${DIAMOND.summary}`), body);
  assert.ok(
    body.includes('**Take-homes**\n\n- Mpemba survives the drive\n- The effect is not a fitting artefact'),
    body,
  );
  assert.ok(
    body.includes('**Open questions**\n\n- Does it hold off resonance?\n- What sets the crossover time?'),
    body,
  );
});

test('a snake_case diamond from a Supabase function renders the same', () => {
  const body = threadBody(PAPER, {
    diamond: { summary: 'S.', take_homes: ['T.'], open_questions: ['Q.'] },
  });
  assert.ok(body.includes('**Take-homes**\n\n- T.'), body);
  assert.ok(body.includes('**Open questions**\n\n- Q.'), body);
});

test('the new-thread URL carries the category, the title and the whole body', () => {
  const url = newThreadUrl(REPO, PAPER, { diamond: DIAMOND });
  assert.ok(url.startsWith(`https://github.com/${REPO}/discussions/new?`), url);

  const params = new URL(url).searchParams;
  assert.equal(params.get('category'), 'general');
  assert.equal(params.get('title'), threadTitle(PAPER));
  assert.equal(params.get('body'), threadBody(PAPER, { diamond: DIAMOND }));
});

test('the category comes from the config when there is one', () => {
  const url = newThreadUrl(REPO, PAPER, { category: 'papers' });
  assert.equal(new URL(url).searchParams.get('category'), 'papers');
});

test('a 6 000-character abstract still yields a URL under the limit', () => {
  const url = newThreadUrl(REPO, { ...PAPER, abstract: 'a'.repeat(6000) }, { diamond: DIAMOND });
  assert.ok(url.length <= 7000, `URL was ${url.length} characters`);

  const body = new URL(url).searchParams.get('body');
  assert.ok(body.includes('https://arxiv.org/abs/2401.12345'), 'the arXiv link survives');
  assert.ok(body.includes('**Take-homes**'), 'the diamond survives');
});

test('the abstract quote is the first thing dropped when the URL overflows', () => {
  const url = newThreadUrl(REPO, { ...PAPER, abstract: 'a'.repeat(8000) }, { diamond: DIAMOND });
  assert.ok(url.length <= 7000, `URL was ${url.length} characters`);

  const body = new URL(url).searchParams.get('body');
  assert.ok(!body.includes('a'.repeat(100)), 'the abstract quote went first');
  assert.ok(body.includes('https://arxiv.org/abs/2401.12345'), 'the arXiv link survives the drop');
  assert.ok(body.includes('**Open questions**'), 'the questions were not dropped yet');
});

test('a body still too long after the drops is clipped, not overrun', () => {
  const url = newThreadUrl(REPO, PAPER, { diamond: { summary: 'b'.repeat(9000) } });
  assert.ok(url.length <= 7000, `URL was ${url.length} characters`);

  const body = new URL(url).searchParams.get('body');
  assert.ok(body.endsWith('…'), body.slice(-40));
  assert.ok(body.length < 9000, 'the summary was clipped');
  assert.ok(body.includes('https://arxiv.org/abs/2401.12345'), 'the arXiv link survives the clip');
});
