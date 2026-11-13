/**
 * cave-thread — K12: a paper's thread on GitHub Discussions, as URLs.
 *
 * Stage 7's "Open a thread" has no backend (spec, stage 7): the reader is sent
 * to Discussions on the maintainer's repo, where a search for the arXiv id
 * either finds the thread that already exists or opens a prefilled new one.
 * So everything here is string building — no fetch, no DOM, no clock — which
 * is also why it can be tested exactly, and why the page can build a link
 * without knowing anything about GitHub.
 *
 * TWO RULES DECIDE THE SHAPE BELOW.
 *
 * 1. The id is bare everywhere. A versioned id ("2401.12345v2") searches badly
 *    and titles worse: a thread titled with v2 is that version's thread, not
 *    the paper's. The suffix is stripped once, in `arxivId`, and the search,
 *    the title and the body links all read the same bare id.
 *
 * 2. A prefilled new-discussion URL travels in the address bar, and browsers
 *    and servers trim long ones. A 6 000-character abstract plus a diamond
 *    gets there, so `newThreadUrl` sheds the least important parts in the
 *    order the card fixes — the abstract quote, then the open questions, then
 *    a clip — and always hands back at most THREAD_URL_LIMIT characters.
 *
 * THE BODY IS MARKDOWN GITHUB RENDERS, not plain text: links, a quoted
 * abstract, bullets. LaTeX stays exactly as arXiv sent it, because GitHub
 * renders `$…$` today and de-TeXing it would lose the meaning the title is
 * about.
 */

/* Browsers accept far longer, but a URL this long is already past what GitHub
   keeps intact on the way back out of the form. */
const THREAD_URL_LIMIT = 7000;

const SITE_URL = 'https://arxave.com/';

/* threadTitle's cap, including the ellipsis. GitHub's own title field stops at
   250 and a title past a line or two is unreadable in the list anyway. */
const TITLE_MAX = 200;

const oneLine = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

/* ── the repo ───────────────────────────────────────────────────────────── */

/* GitHub's own rules, near enough: an owner is alphanumerics and inner
   hyphens, a repo adds dots and underscores. Anything else is not a repo, and
   treating it as one produces a URL that 404s instead of an action that is
   hidden. */
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const NAME = /^[A-Za-z0-9._-]+$/;

/**
 * "owner/name" out of the forms the config and a reader actually hand over:
 * the bare pair, a github.com URL, with a trailing slash, with ".git", with
 * both. Everything else — another host, a single word, a path inside a repo —
 * is null, because the caller's next move is to hide the action.
 */
export function parseRepo(input) {
  if (typeof input !== 'string') return null;
  let rest = input.trim();
  if (!rest) return null;

  const asUrl = rest.match(/^https?:\/\/(?:www\.)?github\.com\/?(.*)$/i);
  if (asUrl) {
    rest = asUrl[1];
  } else if (/^github\.com\//i.test(rest)) {
    rest = rest.slice('github.com/'.length);
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(rest)) {
    /* a scheme that is not github's: gitlab, ssh, a mailto — not this repo */
    return null;
  }

  /* "?tab=readme" and "#readme" are page state, not part of the name. */
  rest = rest.replace(/[?#].*$/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
  const parts = rest.split('/');
  if (parts.length !== 2) return null;

  const [owner, name] = parts;
  if (!OWNER.test(owner) || !NAME.test(name) || name === '.' || name === '..') return null;
  return `${owner}/${name}`;
}

/* ── the paper ──────────────────────────────────────────────────────────── */

/** The bare arXiv id: "2401.12345v2" → "2401.12345". */
const arxivId = (paper) => String(paper?.id ?? '')
  .replace(/^arxiv:/i, '')
  .replace(/v\d+$/i, '')
  .trim();

/** The paper's abs page, as the dig stage already recorded it, or derived. */
function absLink(paper, id) {
  const link = oneLine(paper?.link);
  if (link) return link;
  return id ? `https://arxiv.org/abs/${id}` : 'https://arxiv.org/';
}

/**
 * A paper's thread title: `[<id>] <title>`, one line, LaTeX as is, at most
 * TITLE_MAX code points plus the "…" that says it was cut.
 */
export function threadTitle(paper) {
  const id = arxivId(paper);
  const text = oneLine(`[${id}] ${oneLine(paper?.title)}`);
  const chars = [...text];
  if (chars.length <= TITLE_MAX) return text;
  return chars.slice(0, TITLE_MAX - 1).join('').trimEnd() + '…';
}

/**
 * Discussions' search for this paper: the one action that joins an existing
 * thread instead of starting a second one. An unparseable repo gives "", so a
 * fork without `discussions_repo` renders no thread action at all.
 */
export function searchUrl(repo, paper) {
  const at = parseRepo(repo);
  if (!at) return '';
  return `https://github.com/${at}/discussions?discussions_q=${encodeURIComponent(arxivId(paper))}`;
}

/* ── the body ───────────────────────────────────────────────────────────── */

/* The diamond belongs to K10 and its card names the parts, not their keys: the
   panel will hand over camelCase, a Supabase function snake_case. Read both
   and let a part that is missing simply not render. */
const TAKE_KEYS = ['takeaways', 'takeHomes', 'take_homes', 'takeAway', 'take_away'];
const QUESTION_KEYS = ['questions', 'openQuestions', 'open_questions'];

const listOf = (object, keys) => {
  for (const key of keys) if (Array.isArray(object[key])) return object[key];
  return [];
};

/* One bullet: a string, or an object that wraps it. Anything else is dropped
   rather than rendered as "[object Object]" in someone's thread. */
const bulletText = (item) => {
  if (typeof item === 'string') return oneLine(item);
  if (item && typeof item === 'object') return oneLine(item.text ?? item.message ?? '');
  return '';
};

/** "a\nb" → "> a\n> b": one quote block, line by line, no rewrapping. */
const asQuote = (text) => String(text)
  .trim()
  .split(/\r?\n/)
  .map((line) => (line ? `> ${line}` : '>'))
  .join('\n');

function diamondMarkdown(diamond, omit) {
  if (!diamond || typeof diamond !== 'object') return '';

  const out = [];
  const summary = oneLine(diamond.summary ?? diamond.tldr ?? '');
  if (summary) out.push(`**Summary**\n\n${summary}`);

  const takes = listOf(diamond, TAKE_KEYS).map(bulletText).filter(Boolean);
  if (takes.length) out.push(`**Take-homes**\n\n${takes.map((t) => `- ${t}`).join('\n')}`);

  const questions = omit.has('questions') ? [] : listOf(diamond, QUESTION_KEYS).map(bulletText).filter(Boolean);
  if (questions.length) out.push(`**Open questions**\n\n${questions.map((q) => `- ${q}`).join('\n')}`);

  return out.join('\n\n');
}

const NO_OMIT = new Set();

/**
 * The body of a thread about `paper`: the arXiv abs and PDF links, authors,
 * the abstract quoted, the diamond when one has been extracted, and a footer
 * that says where it came from.
 *
 * `omit` is how `newThreadUrl` sheds parts to fit its length limit; the public
 * caller never passes it, so the body it gets is always whole.
 */
function composeBody(paper, { diamond = null, siteUrl = SITE_URL, omit = NO_OMIT } = {}) {
  const id = arxivId(paper);
  const abs = absLink(paper, id);
  const pdf = abs.replace('/abs/', '/pdf/');

  const blocks = [`[${id ? `arXiv ${id}` : 'arXiv'}](${abs}) · [PDF](${pdf})`];

  const authors = (Array.isArray(paper?.authors) ? paper.authors : []).map(oneLine).filter(Boolean);
  if (authors.length) blocks.push(`**Authors:** ${authors.join(', ')}`);

  const abstract = String(paper?.abstract ?? '').trim();
  if (abstract && !omit.has('abstract')) blocks.push(asQuote(abstract));

  const diamondBlock = diamondMarkdown(diamond, omit);
  if (diamondBlock) blocks.push(diamondBlock);

  blocks.push(`---\n\nOpened from [arXave](${oneLine(siteUrl)})`);
  return blocks.join('\n\n');
}

/** Markdown for a new thread: links, authors, quoted abstract, diamond, footer. */
export function threadBody(paper, { diamond = null, siteUrl = SITE_URL } = {}) {
  return composeBody(paper, { diamond, siteUrl });
}

/* ── the new-thread URL ─────────────────────────────────────────────────── */

/**
 * GitHub's new-discussion form, prefilled.
 *
 * Three attempts before the body is touched at all (it fits with everything),
 * then the fixed order of losses: the abstract quote, the diamond's open
 * questions, and only then a clip. Clipping is a binary search over code
 * points — the encoders are per character, so a longer prefix never gives a
 * shorter URL, which is what makes the search sound and the result always at
 * most THREAD_URL_LIMIT.
 */
export function newThreadUrl(repo, paper, { category = 'general', diamond = null, siteUrl = SITE_URL } = {}) {
  const at = parseRepo(repo);
  if (!at) return '';

  const title = threadTitle(paper);
  const url = (body) => {
    const query = new URLSearchParams({ category, title, body }).toString();
    return `https://github.com/${at}/discussions/new?${query}`;
  };

  let body = composeBody(paper, { diamond, siteUrl });
  if (url(body).length <= THREAD_URL_LIMIT) return url(body);

  body = composeBody(paper, { diamond, siteUrl, omit: new Set(['abstract']) });
  if (url(body).length <= THREAD_URL_LIMIT) return url(body);

  body = composeBody(paper, { diamond, siteUrl, omit: new Set(['abstract', 'questions']) });
  if (url(body).length <= THREAD_URL_LIMIT) return url(body);

  const chars = [...body];
  let fits = 0;
  let tooLong = chars.length;
  while (fits < tooLong) {
    const mid = Math.ceil((fits + tooLong) / 2);
    if (url(`${chars.slice(0, mid).join('')}…`).length <= THREAD_URL_LIMIT) fits = mid;
    else tooLong = mid - 1;
  }
  return url(`${chars.slice(0, fits).join('')}…`);
}
