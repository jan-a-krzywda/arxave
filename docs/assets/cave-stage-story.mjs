/**
 * cave-stage-story — stage 8: tonight, told around your picks.
 *
 * ONE REQUEST, ONE READER CARD. The reader has ranked a night and ticked a
 * handful of papers (stages 6–7); this card asks the `story` function for a
 * short narrative around those picks — what moved, how they connect, what to
 * read first — and draws the answer as a reader-mode panel: the way Spellbook
 * and Plane AI summaries give an answer its own page instead of a bubble.
 *
 * EVERYTHING THE STORY NEEDS IS ALREADY ON THE PAGE. The date is on the night,
 * the picks are a Set of ids, each paper's title / abstract / topic is on the
 * ranked row, the wagon names came from the map, and the diamond — when stage 7
 * has mined one — is cached in `ctx.storage` under
 * `arxave-cave-diamond:<arXiv id>` as the endpoint's JSON. Nothing here fetches
 * a paper; the one call is the story itself.
 *
 * TWELVE IS THE CEILING, AND THE READER IS TOLD. `story` accepts at most
 * `MAX_PAPERS` (twelve) and a story over twelve abstracts is two calls against
 * the shared daily budget, so a night with more picks sends the top twelve by
 * rank and says so above the button. The picks themselves are untouched: the
 * bar and the ranking still hold every one.
 *
 * THE MODEL'S MARKDOWN IS UNTRUSTED. A story is a string a hosted model wrote,
 * and it reaches the page through `innerHTML`, so `renderStoryMd` escapes the
 * whole thing FIRST and only then recognises paragraphs, `**bold**`, *italic*,
 * `- ` lists and `[<arXiv id>]`. An id that is not one of the papers we sent
 * stays literal text, which is what makes `[x](javascript:…)` inert by
 * construction rather than by a URL check.
 *
 * THE BUDGET IS SHARED, SO 429 IS PLAIN WORDS. `story` spends two of
 * `refine_usage_spend`'s daily calls; when the meter cannot grant them the
 * answer is `429 {"error":"budget"}`, and the card says exactly that instead of
 * dressing it as a provider fault. There is no BYO-key field on this page yet.
 *
 * THE LAST STORY SURVIVES A RELOAD, keyed by
 * `arxave-cave-story:<date>:<sorted ids>`, so the same picks on the same night
 * come back without paying twice. `ctx.storage` may be null (private mode) —
 * `readStore` / `writeStore` already swallow that, and a null storage costs a
 * reload, never a story.
 *
 * THE PURE HALF IS EXPORTED: `storyRequest`, `renderStoryMd`, `plainText`,
 * `storyCacheKey`, `readFirstWhy`, `storyCardHtml`, `storyMarkdown` — the parts
 * a browser cannot be asked to hold at 360 px (`scripts/
 * cave-stage-story.test.mjs`).
 */
import { downloadText } from './cave-export.mjs';
import { escapeHtml, joinUrl, readStore, writeStore } from './sieve-ui.mjs';

/* The caps `supabase/functions/story/story.ts` validates against, mirrored so
   the page never sends a body the function would refuse. */
export const MAX_PAPERS = 12;        // papers per story, the function's ceiling
export const MAX_WAGONS = 24;        // wagons in the prompt
export const MAX_ABSTRACT = 1200;    // the function clips to this anyway
export const MAX_TITLE = 300;
export const MAX_ID = 64;
export const MAX_WAGON = 120;
export const MAX_TOPIC = 120;
export const MAX_DIAMOND = 400;
export const MAX_CARE = 500;

/** Where a cached diamond and the last story live in `ctx.storage`. */
export const DIAMOND_PREFIX = 'arxave-cave-diamond:';
export const STORY_PREFIX = 'arxave-cave-story:';

/** The three sentences a reader can meet in this card. */
export const BUDGET_SPENT =
  "Tonight's shared budget is spent. Try tomorrow, or bring your own key.";
export const NO_NIGHT =
  "Dig first — the story is built from tonight's date and papers.";
export const WAITING = 'The fire is telling it…';

let styled = false;

/** The card's stylesheet, once, from beside this module (baseurl-safe). */
function ensureStyles() {
  if (styled || typeof document === 'undefined') return;
  styled = true;
  const href = new URL('./cave-story.css' + new URL(import.meta.url).search, import.meta.url).href;
  const head = document.head;
  if (head && typeof head.querySelector === 'function'
    && head.querySelector('link[href="' + href + '"]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  if (head && typeof head.appendChild === 'function') head.appendChild(link);
}

/* ── pure helpers ───────────────────────────────────────────────────────── */

/** One line, clipped — the same normalisation `story.ts` does on input. */
const oneLine = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

const asId = (value) => String(value ?? '').trim().slice(0, MAX_ID);

/** `https://arxiv.org/abs/<id>`, with the id's own slashes kept. */
export function absUrl(id) {
  return 'https://arxiv.org/abs/' + asId(id).split('/').map(encodeURIComponent).join('/');
}

/** A tooltip-sized title: its first clause, ellipsised. */
function shortTitle(title, max = 60) {
  const full = oneLine(title, MAX_TITLE);
  return full.length > max ? full.slice(0, max - 1).trimEnd() + '…' : full;
}

/** A Map or a plain object of id → paper, read as one function. */
function paperLookup(papersById) {
  if (!papersById) return () => null;
  if (typeof papersById.get === 'function') {
    return (id) => papersById.get(String(id)) || null;
  }
  return (id) => (Object.prototype.hasOwnProperty.call(papersById, String(id))
    ? papersById[String(id)]
    : null);
}

/** Leaf label for a stone's primary topic index; '' when it has none. */
function leafLabel(topics, index) {
  const leaves = topics && Array.isArray(topics.leaves) ? topics.leaves : [];
  const at = Number(index);
  const leaf = Number.isInteger(at) && at >= 0 ? leaves[at] : null;
  return leaf ? oneLine(leaf.label, MAX_TOPIC) : '';
}

/** Stone id → the wagon name the map gave it, named wagons only. */
function wagonNames(night) {
  const out = new Map();
  const components = (night && night.components) || [];
  const names = (night && night.names) || [];
  for (let c = 0; c < components.length; c += 1) {
    const name = oneLine(names[c], MAX_WAGON);
    if (!name) continue;
    for (const i of (components[c] && components[c].indices) || []) {
      const stone = night.stones && night.stones[i];
      if (stone && stone.id != null) out.set(String(stone.id), name);
    }
  }
  return out;
}

/** The cached diamond's summary for one paper, '' when there is none. */
function cachedDiamond(storage, id) {
  const diamond = readStore(storage, DIAMOND_PREFIX + asId(id), null);
  if (!diamond || typeof diamond !== 'object') return '';
  return oneLine(diamond.summary, MAX_DIAMOND);
}


/**
 * The named wagons of tonight, largest first — the context that lets the model
 * say "the tunnelling wagon moved" instead of naming twelve isolations.
 *
 * Sorted by size, with the name as the tie-break so the same night twice sends
 * the same order (the request must be stable to be cacheable), then capped at
 * the function's twenty-four. Unnamed wagons are left out: "Wagon 3" is a
 * label, not something a story can be about.
 */
export function storyWagons(night, max = MAX_WAGONS) {
  const components = (night && night.components) || [];
  const names = (night && night.names) || [];
  const rows = [];
  for (let c = 0; c < components.length; c += 1) {
    const name = oneLine(names[c], MAX_WAGON);
    if (!name) continue;
    const size = ((components[c] && components[c].indices) || []).length;
    if (!size) continue;
    rows.push({ name, size });
  }
  rows.sort((a, b) => b.size - a.size || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return rows.slice(0, Math.max(0, max));
}

/**
 * Everything the card sends, from what the page already holds.
 *
 * Order is rank order: `ctx.ranked` is the reader's list, so the top twelve
 * are the twelve the reader would pick from. A picked id that is not in the
 * ranking (a stale tick from an earlier re-rank) still goes, after the ranked
 * ones, as long as the night knows the paper — a story needs a title and an
 * abstract, so a pick with neither is left out rather than sent empty.
 */
export function storyRequest(ctx) {
  const c = ctx || {};
  const night = c.night || null;
  const ranked = Array.isArray(c.ranked) ? c.ranked : [];
  const picks = c.picks;
  /* The contract says a Set; an array of ids is the same answer read out loud,
     so a caller that hands one over is understood rather than ignored. */
  const picked = picks && typeof picks.has === 'function'
    ? picks
    : new Set(Array.isArray(picks) ? picks.map(String) : []);
  const chose = (id) => picked.has(String(id));

  /* The night indexes the facts; a ranked row is the same stone plus its score,
     so it wins where both exist. */
  const detail = new Map();
  for (const stone of (night && night.stones) || []) {
    if (stone && stone.id != null) detail.set(String(stone.id), stone);
  }
  for (const item of ranked) {
    if (!item || item.id == null) continue;
    const id = String(item.id);
    detail.set(id, { ...(detail.get(id) || {}), ...item });
  }

  const ids = [];
  const seen = new Set();
  for (const item of ranked) {
    if (!item || item.id == null) continue;
    const id = String(item.id);
    if (!chose(id) || seen.has(id) || !detail.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  if (picks && typeof picks[Symbol.iterator] === 'function') {
    for (const raw of picks) {
      const id = String(raw);
      if (seen.has(id) || !detail.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }

  const wagons = wagonNames(night);
  const papers = ids.slice(0, MAX_PAPERS)
    .filter((id) => detail.get(id).title && detail.get(id).abstract)
    .map((id) => {
      const item = detail.get(id);
      const paper = {
        id: asId(id),
        title: oneLine(item.title, MAX_TITLE),
        abstract: oneLine(item.abstract, MAX_ABSTRACT),
        wagon: wagons.get(id) || null,
        topic: leafLabel(c.topics, item.topic),
      };
      const diamond = cachedDiamond(c.storage, id);
      if (diamond) paper.diamond = diamond;
      return paper;
    });

  return {
    date: oneLine(night && night.date, 10),
    papers,
    wagons: storyWagons(night),
    care: oneLine(c.prefs && c.prefs.text, MAX_CARE),
  };
}

/**
 * The cache key for one night's picks. Sorted, because ticking a paper and
 * unticking it again is the same request, and the same request deserves the
 * same answer.
 */
export function storyCacheKey(date, ids) {
  const list = [];
  if (ids && typeof ids[Symbol.iterator] === 'function') {
    for (const id of ids) list.push(String(id));
  }
  return STORY_PREFIX + String(date ?? '') + ':' + list.sort().join(',');
}


/* ── the tiny Markdown renderer ─────────────────────────────────────────── */

/**
 * Inline markup on already-escaped text: first `**bold**` / `*italic*`, then
 * `[<arXiv id>]` → a link to that paper.
 *
 * Emphasis runs first so a title attribute inserted by the second pass can
 * never be read as emphasis. The link pass only rewrites an id that is in
 * `papersById`; anything else — a URL, a footnote, `[x](javascript:…)` — stays
 * the escaped text it already was. Nothing here ever splices model text into
 * an attribute without `escapeHtml`.
 */
function inlineMd(escaped, lookup) {
  const emphasised = escaped
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  return emphasised.replace(
    /\[([0-9A-Za-z][0-9A-Za-z./-]{0,63})\]/g,
    (match, id) => {
      const paper = lookup(id);
      if (!paper) return match;
      const title = oneLine(paper.title, MAX_TITLE) || id;
      return '<a class="st-paper" href="' + escapeHtml(absUrl(id)) + '" title="'
        + escapeHtml(shortTitle(title)) + '" target="_blank" rel="noopener">'
        + escapeHtml(id) + '</a>';
    },
  );
}

/**
 * Markdown → HTML, safe by construction: escape everything, then recognise
 * paragraphs (blank-line separated), `- ` lists, `**bold**`, `*italic*` and
 * `[<arXiv id>]`. Nothing else becomes a tag, so there is no HTML pass for a
 * model to write into.
 */
export function renderStoryMd(md, papersById) {
  const lookup = paperLookup(papersById);
  const text = escapeHtml(String(md ?? '')).replace(/\r\n?/g, '\n');
  const out = [];
  let para = [];
  let list = [];

  const flushPara = () => {
    if (!para.length) return;
    out.push('<p>' + inlineMd(para.join(' '), lookup) + '</p>');
    para = [];
  };
  const flushList = () => {
    if (!list.length) return;
    out.push('<ul>'
      + list.map((item) => '<li>' + inlineMd(item, lookup) + '</li>').join('')
      + '</ul>');
    list = [];
  };

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) {
      flushPara();
      flushList();
      continue;
    }
    const bullet = /^-\s+(.*)$/.exec(line);
    if (bullet) {
      flushPara();
      list.push(bullet[1]);
      continue;
    }
    flushList();
    para.push(line);
  }
  flushPara();
  flushList();
  return out.join('');
}

/**
 * The same text for a speaker, not a reader: markdown markers removed, `[id]`
 * brackets dropped (the id is read aloud as an id), blank runs collapsed.
 */
export function plainText(md) {
  return String(md ?? '')
    .replace(/\[([^\]\n]{1,64})\]/g, '$1')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/^[ \t]*-[ \t]+/gm, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * The sentence in the story that names the read-first paper, stripped of
 * Markdown — the "why" the callout shows when the story actually gives one.
 * `story.readFirst` is only an id; the reason is prose, and if the model never
 * gave one the callout is just the title.
 */
export function readFirstWhy(md, id) {
  const paperId = asId(id);
  if (!paperId) return '';
  const text = String(md ?? '');
  if (!text.includes('[' + paperId + ']')) return '';
  /* An arXiv id carries a full stop, so the dots inside `[id]` must not end a
     sentence while the text is split: they are lent a placeholder and given
     back before the sentence is shown. */
  const guarded = text.replace(/\[[^\]\n]{1,64}\]/g, (marker) => marker.replace(/\./g, '\u0001'));
  for (const sentence of guarded.match(/[^.!?\n]+[.!?]*/g) || []) {
    const back = sentence.replace(/\u0001/g, '.');
    if (back.includes('[' + paperId + ']')) return oneLine(plainText(back), 240);
  }
  return '';
}


/* ── the reader card, as a string ───────────────────────────────────────── */

/** A paper's title as its own link — the threads and the callout read better
 *  with titles than with ids. */
function titleLink(id, lookup) {
  const paperId = asId(id);
  const paper = lookup(paperId);
  const title = (paper && oneLine(paper.title, MAX_TITLE)) || paperId;
  return '<a class="st-paper" href="' + escapeHtml(absUrl(paperId)) + '" title="'
    + escapeHtml(shortTitle(title)) + '" target="_blank" rel="noopener">'
    + escapeHtml(title) + '</a>';
}

/** Threads as a list: the linked papers, then the why. */
function threadsHtml(threads, lookup) {
  const rows = (Array.isArray(threads) ? threads : []).filter((t) => t && Array.isArray(t.ids));
  if (!rows.length) return '';
  const items = rows.map((thread) => {
    const names = thread.ids.map((id) => titleLink(id, lookup))
      .join('<span class="st-thread-sep"> · </span>');
    const why = oneLine(thread.why, 240);
    return '<li class="st-thread">'
      + '<p class="st-thread-papers">' + names + '</p>'
      + (why ? '<p class="st-thread-why">' + inlineMd(escapeHtml(why), lookup) + '</p>' : '')
      + '</li>';
  }).join('');
  return '<section class="st-threads">'
    + '<p class="st-label">Threads</p>'
    + '<ul class="st-thread-list">' + items + '</ul>'
    + '</section>';
}

/**
 * The result panel: eyebrow, title, the story itself, the read-first callout,
 * the threads, and the three tools. No date or count is invented — `date` and
 * `count` come from the request that produced the story.
 */
export function storyCardHtml(story, papersById, { date = '', count = 0 } = {}) {
  const s = story || {};
  const lookup = paperLookup(papersById);
  const title = oneLine(s.title, 160) || "Tonight's story";
  const meta = [oneLine(date, 10), count ? count + (count === 1 ? ' paper' : ' papers') : '']
    .filter(Boolean).join(' · ');

  const readFirstId = asId(s.readFirst);
  const readFirstLine = readFirstWhy(s.story, readFirstId);

  return '<header class="st-head">'
      + '<p class="st-eyebrow">Tonight\'s story</p>'
      + '<h3 class="st-title">' + escapeHtml(title) + '</h3>'
      + (meta ? '<p class="st-meta">' + escapeHtml(meta) + '</p>' : '')
    + '</header>'
    + '<div class="st-prose">' + renderStoryMd(s.story, papersById) + '</div>'
    + (readFirstId
      ? '<section class="st-readfirst">'
        + '<p class="st-label">Read first</p>'
        + '<p class="st-rf-title">' + titleLink(readFirstId, lookup) + '</p>'
        + (readFirstLine ? '<p class="st-rf-why">' + escapeHtml(readFirstLine) + '</p>' : '')
        + '</section>'
      : '')
    + threadsHtml(s.threads, lookup)
    + '<div class="st-tools">'
      + '<button type="button" class="st-speak" hidden>Read aloud</button>'
      + '<button type="button" class="st-copy">Copy Markdown</button>'
      + '<button type="button" class="st-download">Download .md</button>'
    + '</div>';
}

/** Markdown link text cannot carry an unescaped bracket. */
const linkText = (title) => oneLine(title, MAX_TITLE).replace(/[[\]]/g, '\\$&');

/** The `.md` a reader keeps: the story, then the papers it was about. */
export function storyMarkdown(story, papers, { date = '' } = {}) {
  const s = story || {};
  const out = ['# ' + (oneLine(s.title, 160) || "Tonight's story"), ''];
  if (date) out.push('_The night of ' + oneLine(date, 10) + '_', '');
  out.push(String(s.story ?? '').trim(), '');
  const list = (Array.isArray(papers) ? papers : []).filter((p) => p && p.id);
  if (list.length) {
    out.push('## Picked papers', '');
    for (const paper of list) {
      out.push('- [' + linkText(paper.title || paper.id) + '](' + absUrl(paper.id) + ')');
    }
    out.push('');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}


/* ── the stage ──────────────────────────────────────────────────────────── */

/**
 * Mount stage 8. Every input is optional: no night, no picks, no storage and
 * an unanswered story all land as a sentence in the card, never a throw.
 */
export function mount(body, ctx) {
  if (!body || !ctx) return;

  ensureStyles();

  body.innerHTML =
    '<div class="cave-story">'
    + '<p class="st-line"><span class="st-count">0 picked papers.</span>'
      + ' Ask for the story of tonight around them.</p>'
    + '<p class="st-over" hidden>Only the top ' + MAX_PAPERS + ' by rank go into the story.</p>'
    + '<p class="st-missing" hidden></p>'
    + '<div class="st-ask">'
      + '<button type="button" class="st-tell" disabled>Tell me tonight\'s story</button>'
    + '</div>'
    + '<p class="st-error" role="alert" hidden></p>'
    + '<div class="st-wait" role="status" hidden>'
      + '<span class="st-ember" aria-hidden="true"></span>'
      + '<p class="st-wait-line">' + escapeHtml(WAITING) + '</p>'
    + '</div>'
    + '<article class="st-card" aria-live="polite" hidden></article>'
    + '</div>';

  const countEl = body.querySelector('.st-count');
  const overEl = body.querySelector('.st-over');
  const missingEl = body.querySelector('.st-missing');
  const tellBtn = body.querySelector('.st-tell');
  const errorEl = body.querySelector('.st-error');
  const waitEl = body.querySelector('.st-wait');
  const cardEl = body.querySelector('.st-card');

  const state = {
    busy: false,
    speaking: false,
    story: null,      // the story object last shown
    papers: [],       // the request papers it was written around
    date: '',
    utter: null,      // held while speaking: some browsers drop an unreferenced one
    flashTimer: null,
  };

  /* ── what the page holds ─────────────────────────────────────────────── */

  /** Picked ids, whatever container the page handed us. */
  function pickedIds() {
    const out = [];
    const picks = ctx.picks;
    if (!picks || typeof picks[Symbol.iterator] !== 'function') return out;
    for (const id of picks) out.push(String(id));
    return out;
  }

  function speechReady() {
    return typeof window !== 'undefined' && !!window.speechSynthesis
      && typeof window.SpeechSynthesisUtterance === 'function';
  }

  /** id → paper, for titles and links: the story's own papers first, then the
   *  night and the ranking (which is all a restored story has to lean on). */
  function paperIndex(extra = []) {
    const index = new Map();
    for (const paper of extra) {
      if (paper && paper.id != null) index.set(String(paper.id), paper);
    }
    const night = ctx.night;
    for (const stone of (night && night.stones) || []) {
      if (stone && stone.id != null && !index.has(String(stone.id))) {
        index.set(String(stone.id), stone);
      }
    }
    for (const item of (Array.isArray(ctx.ranked) ? ctx.ranked : [])) {
      if (!item || item.id == null) continue;
      const id = String(item.id);
      index.set(id, { ...(index.get(id) || {}), ...item });
    }
    return index;
  }

  /* ── painting ────────────────────────────────────────────────────────── */

  function paintCount() {
    const n = pickedIds().length;
    countEl.textContent = n + ' picked paper' + (n === 1 ? '' : 's') + '.';
    overEl.hidden = n <= MAX_PAPERS;
    missingEl.textContent = ctx.night ? '' : NO_NIGHT;
    missingEl.hidden = !!ctx.night;
    tellBtn.disabled = state.busy || n === 0 || !(ctx.night && ctx.night.date);
  }

  function showError(message) {
    errorEl.textContent = message || '';
    errorEl.hidden = !message;
  }

  function show(story, papers, date) {
    state.story = story;
    state.papers = Array.isArray(papers) ? papers : [];
    state.date = oneLine(date, 10) || state.date;
    cardEl.innerHTML = storyCardHtml(story, paperIndex(state.papers), {
      date: state.date,
      count: state.papers.length,
    });
    cardEl.hidden = false;
    const speak = cardEl.querySelector('.st-speak');
    if (speak) speak.hidden = !speechReady();
  }


  /* ── the cache ───────────────────────────────────────────────────────── */

  /** The newest story in storage, for a remount that no longer has the picks
   *  (a reload starts a fresh Set). */
  function newestStory() {
    const storage = ctx.storage;
    if (!storage) return null;
    try {
      let best = null;
      for (let i = 0; i < storage.length; i += 1) {
        const key = storage.key(i);
        if (!key || key.indexOf(STORY_PREFIX) !== 0) continue;
        const value = readStore(storage, key, null);
        if (!value || !value.story) continue;
        if (!best || (Number(value.savedAt) || 0) > (Number(best.savedAt) || 0)) best = value;
      }
      return best;
    } catch (_) {
      return null;
    }
  }

  /**
   * The story this page already has: the exact key when there are picks, and
   * otherwise the newest one for tonight — but never another day's, which would
   * be a story about papers this night does not contain.
   */
  function restore() {
    const date = (ctx.night && ctx.night.date) || '';
    const ids = pickedIds();
    let cached = null;
    if (date && ids.length) cached = readStore(ctx.storage, storyCacheKey(date, ids), null);
    if (!cached || !cached.story) {
      const newest = newestStory();
      const sameDay = !newest || !newest.date || !date || newest.date === date;
      cached = sameDay ? newest : null;
    }
    if (cached && cached.story) {
      show(cached.story, Array.isArray(cached.papers) ? cached.papers : [],
        cached.date || date);
    }
  }

  /* ── the one call ────────────────────────────────────────────────────── */

  async function tell() {
    if (state.busy) return;
    const request = storyRequest(ctx);
    if (!request.date || !request.papers.length) {
      showError(NO_NIGHT);
      return;
    }

    state.busy = true;
    tellBtn.disabled = true;
    showError('');
    if (state.speaking) toggleSpeech();
    cardEl.hidden = true;
    waitEl.hidden = false;

    try {
      const resp = await fetch(joinUrl(ctx.config.functionsBase, 'story'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
      let data = null;
      try { data = await resp.json(); } catch (_) { /* a refusal may carry no body */ }

      if (resp.status === 429) {
        showError(BUDGET_SPENT);
        return;
      }
      if (!resp.ok) {
        showError('The fire could not tell it: '
          + ((data && data.error) || ('HTTP ' + resp.status)));
        return;
      }
      if (!data || typeof data.story !== 'string' || !data.story) {
        showError('The fire came back without a story.');
        return;
      }

      show(data, request.papers, request.date);
      writeStore(ctx.storage, storyCacheKey(request.date, request.papers.map((p) => p.id)), {
        story: data,
        papers: request.papers.map((p) => ({ id: p.id, title: p.title })),
        date: request.date,
        savedAt: Date.now(),
      });
      try {
        if (ctx.flow) ctx.flow.complete('story', data.title);
      } catch (_) {
        /* locked until Act is done: the story is still readable */
      }
    } catch (err) {
      showError('Could not reach the fire: ' + ((err && err.message) || err));
    } finally {
      state.busy = false;
      waitEl.hidden = true;
      paintCount();
    }
  }

  /* ── the tools ───────────────────────────────────────────────────────── */

  function somethingToSay(story) {
    const parts = [oneLine(story.title, 160), plainText(story.story)];
    const paper = story.readFirst ? paperIndex(state.papers).get(asId(story.readFirst)) : null;
    if (paper && paper.title) parts.push('Read first: ' + oneLine(paper.title, MAX_TITLE) + '.');
    return parts.filter(Boolean).join(' ');
  }

  function setSpeaking(on) {
    state.speaking = on;
    const btn = cardEl.querySelector('.st-speak');
    if (btn) btn.textContent = on ? 'Stop' : 'Read aloud';
  }

  function toggleSpeech() {
    if (!speechReady() || !state.story) return;
    const synth = window.speechSynthesis;
    if (state.speaking) {
      synth.cancel();
      setSpeaking(false);
      return;
    }
    const utter = new window.SpeechSynthesisUtterance(somethingToSay(state.story));
    utter.onend = () => setSpeaking(false);
    utter.onerror = () => setSpeaking(false);
    state.utter = utter;
    setSpeaking(true);
    synth.cancel();
    synth.speak(utter);
  }

  function flash(button, text) {
    if (!button) return;
    button.textContent = text;
    clearTimeout(state.flashTimer);
    state.flashTimer = setTimeout(() => {
      button.textContent = 'Copy Markdown';
    }, 1800);
  }

  async function copy() {
    if (!state.story) return;
    const markdown = storyMarkdown(state.story, state.papers, { date: state.date });
    const button = cardEl.querySelector('.st-copy');
    try {
      await navigator.clipboard.writeText(markdown);
      flash(button, 'Copied');
    } catch (_) {
      flash(button, 'Copy failed — download it');
    }
  }

  function download() {
    if (!state.story) return;
    const markdown = storyMarkdown(state.story, state.papers, { date: state.date });
    downloadText('tonight-story-' + (state.date || 'cave') + '.md', markdown,
      'text/markdown;charset=utf-8');
  }

  /* ── wiring ──────────────────────────────────────────────────────────── */

  tellBtn.addEventListener('click', tell);

  /* Delegated: the card is re-rendered on every story and every restore, and
     one listener on the article outlives all of it. */
  cardEl.addEventListener('click', (event) => {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    if (target.closest('.st-speak')) { toggleSpeech(); return; }
    if (target.closest('.st-copy')) { copy(); return; }
    if (target.closest('.st-download')) download();
  });

  ctx.bus.addEventListener('picks', paintCount);
  ctx.bus.addEventListener('ranked', paintCount);
  ctx.bus.addEventListener('night', () => {
    /* A new dig is a new night: the last story was about other papers. */
    state.story = null;
    state.papers = [];
    state.date = '';
    cardEl.hidden = true;
    showError('');
    paintCount();
    restore();
  });

  paintCount();
  restore();
}

