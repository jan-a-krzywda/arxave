/**
 * cave-paper-actions — the four things a ranking row offers, as markup.
 *
 * L2 folds the old Act stage into Ranking, so the row carries its own exits:
 * SciRate for the paper's own feed, a GitHub Discussions thread (join one, or
 * be the first and start it), the LLM's diamond, and the Story tick that
 * carries a paper to the last stage. This module is the pure half of that —
 * `actionsHtml` builds the bar, `threadsRequest` / `parseThreads` are the batch
 * lookup's body and answer, and the diamond cache helpers are the same contract
 * the Act stage kept (`arxave-cave-diamond:<bare id>`), copied here because
 * that stage is gone.
 *
 * THREE THREAD STATES, NOT TWO. `state.thread` is what the page knows about
 * this paper's thread on the maintainer's repo:
 *   { url }     — a thread exists; the bar links to it.
 *   null        — looked up, none exists; the reader would be the first, so the
 *                 bar offers "Start thread" (which mines the diamond first and
 *                 carries it into the thread body).
 *   undefined   — the lookup is unavailable or still pending; fall back to
 *                 Discussions' search, which finds the thread or offers a new
 *                 discussion. That is exactly what Act did.
 * With no repo configured there is no thread button at all — there is nowhere
 * to send the reader.
 *
 * EVERY STRING THAT CAME FROM ARXIV OR FROM A MODEL IS ESCAPED. Titles,
 * abstracts, urls and diamonds all arrive from outside this page, and this
 * module is where they become markup.
 */
import { newThreadUrl, parseRepo, searchUrl } from './cave-thread.mjs';
import { bareArxivId, escapeHtml } from './sieve-ui.mjs';

/** The endpoint's abstract cap (`MAX_ABSTRACT` in supabase/functions/diamond). */
export const ABSTRACT_MAX = 3000;

/** Where a mined diamond is kept, per paper, in `ctx.storage`. */
export const CACHE_PREFIX = 'arxave-cave-diamond:';

/** The one plain answer to a spent budget. */
export const BUDGET_NOTE = 'The shared daily AI budget is spent — try again tomorrow.';

const oneLine = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const listOf = (value) => (Array.isArray(value) ? value : []);
const textList = (value) => listOf(value).map(oneLine).filter(Boolean);
const idOf = (item) => String(item && item.id != null ? item.id : '');

/* ── the diamond cache ──────────────────────────────────────────────────── */

/** The storage key for one paper's diamond. */
export function cacheKey(id) {
  return CACHE_PREFIX + bareArxivId(id);
}

/**
 * The stored diamond for `id`, or null: a missing storage, a missing key, a
 * string that is not JSON, or JSON that is not an object all mean "not cached".
 */
export function readCachedDiamond(storage, id) {
  if (!storage || typeof storage.getItem !== 'function') return null;
  try {
    const raw = storage.getItem(cacheKey(id));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

/** Write a diamond back; a full quota or a private-mode storage is not fatal. */
export function writeCachedDiamond(storage, id, diamond) {
  if (!storage || typeof storage.setItem !== 'function' || !diamond) return;
  try {
    storage.setItem(cacheKey(id), JSON.stringify(diamond));
  } catch (_) {
    /* the panel still shows what was just mined */
  }
}

/**
 * The panel for an extracted diamond: the summary, then the three sections the
 * endpoint promises — "Take home", "Open questions", "Read this if…". A part
 * that is missing is left out rather than rendered as an empty heading.
 */
export function diamondHtml(diamond) {
  if (!diamond || typeof diamond !== 'object' || Array.isArray(diamond)) return '';
  const summary = oneLine(diamond.summary);
  const takeaways = textList(diamond.takeaways);
  const questions = textList(diamond.questions);
  const readIf = oneLine(diamond.readIf);

  const block = (label, items) => (items.length
    ? '<h4 class="pa-diamond-label">' + label + '</h4>' +
      '<ul class="pa-diamond-list">' +
        items.map((item) => '<li>' + escapeHtml(item) + '</li>').join('') +
      '</ul>'
    : '');

  return '<div class="pa-diamond">' +
    (summary ? '<p class="pa-diamond-summary">' + escapeHtml(summary) + '</p>' : '') +
    block('Take home', takeaways) +
    block('Open questions', questions) +
    (readIf
      ? '<p class="pa-readif"><span class="pa-diamond-label">Read this if…</span> ' +
        escapeHtml(readIf) + '</p>'
      : '') +
  '</div>';
}

/**
 * The request body for `POST /diamond`. The endpoint validates and clips too,
 * but a 3 000-character abstract cap here keeps a runaway abstract off the wire.
 */
export function diamondRequest(paper) {
  const p = paper || {};
  const authors = Array.isArray(p.authors)
    ? p.authors.map(oneLine).filter(Boolean).join(', ')
    : oneLine(p.authors);
  return {
    paper: {
      id: bareArxivId(p.id),
      title: oneLine(p.title).slice(0, 300),
      abstract: oneLine(p.abstract).slice(0, ABSTRACT_MAX),
      authors: authors.slice(0, 300),
    },
  };
}

/* ── the action bar ─────────────────────────────────────────────────────── */

/** SciRate's page for the paper, keyed on the bare id. */
export function scirateUrl(id) {
  return 'https://scirate.com/arxiv/' + bareArxivId(id);
}

const button = (act, id, label, extra = '') =>
  '<button type="button" class="pa-btn' + (extra ? ' ' + extra : '') + '" data-act="' + act +
    '" data-id="' + escapeHtml(id) + '">' + label + '</button>';

const link = (cls, href, label) =>
  '<a class="pa-btn ' + cls + '" href="' + escapeHtml(href) +
    '" target="_blank" rel="noopener">' + label + '</a>';

/**
 * One paper's action bar, in reading order: SciRate, thread, Summarize, Story.
 *
 * `state` is `{ repo, thread, picked, diamond, md, open }`:
 * `repo` is the Discussions repo (empty → no thread button), `thread` is one of
 * the three states above, `picked` ticks the Story box, `diamond` says a
 * summary is already known (so the button reads "Summary"), `md` says the
 * `.md` download was offered after starting a thread, `open` reports whether
 * the row's detail is showing.
 */
export function actionsHtml(item, state = {}) {
  const id = idOf(item);
  const s = state || {};
  const parts = [link('pa-scirate', scirateUrl(id), 'SciRate')];

  if (s.repo && parseRepo(s.repo)) {
    const thread = s.thread;
    if (thread && typeof thread === 'object' && thread.url) {
      parts.push(link('pa-discussion', thread.url, '💬 Discussion'));
    } else if (thread === null) {
      parts.push(button('start-thread', id, '✚ Start thread', 'pa-start'));
      if (s.md) {
        parts.push('<a class="pa-btn pa-md" href="#" data-act="md" data-id="' + escapeHtml(id) +
          '">⤓ .md</a>');
      }
    } else {
      const fallback = searchUrl(s.repo, item);
      if (fallback) parts.push(link('pa-discuss', fallback, '💬 Discuss'));
    }
  }

  parts.push('<button type="button" class="pa-btn pa-summarize" data-act="summarize" data-id="' +
    escapeHtml(id) + '" aria-expanded="' + (s.open ? 'true' : 'false') + '">' +
    (s.diamond ? '✦ Summary' : '✦ Summarize') + '</button>');

  parts.push('<label class="pa-story"><input type="checkbox" class="pa-pick" data-id="' +
    escapeHtml(id) + '"' + (s.picked ? ' checked' : '') + '> Story</label>');

  return '<span class="pa-actions">' + parts.join('') + '</span>';
}

/* ── the thread lookup ──────────────────────────────────────────────────── */

/**
 * The one POST the whole visible list makes: `{ repo, ids }`, ids bare and
 * deduped. The response is `{ threads: { "<bare id>": "<url>" | null } }`.
 */
export function threadsRequest(repo, ids) {
  const list = (Array.isArray(ids) ? ids : [])
    .map((id) => bareArxivId(id))
    .filter(Boolean);
  return { repo: String(repo == null ? '' : repo), ids: [...new Set(list)] };
}

/**
 * The answer, as `{ "<bare id>": "<url>" | null }` for the ids actually asked
 * about. An id that is absent from the answer (or an answer that is not the
 * promised shape) is simply not in the object: the caller leaves it
 * `undefined`, which is the fallback-to-search state.
 */
export function parseThreads(payload, ids) {
  const out = {};
  let data = payload;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch (_) { return out; }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return out;
  const threads = data.threads;
  if (!threads || typeof threads !== 'object' || Array.isArray(threads)) return out;

  const wanted = new Set((Array.isArray(ids) ? ids : [])
    .map((one) => bareArxivId(one))
    .filter(Boolean));
  for (const id of wanted) {
    if (!Object.prototype.hasOwnProperty.call(threads, id)) continue;
    const value = threads[id];
    if (value === null) out[id] = null;
    else if (typeof value === 'string' && value.trim()) out[id] = value.trim();
  }
  return out;
}

/** The prefilled new-discussion URL for a paper, or '' with no usable repo. */
export function startThreadUrl(repo, paper, { category = 'general', diamond = null } = {}) {
  return newThreadUrl(repo, paper, { category, diamond });
}
