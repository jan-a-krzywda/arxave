/**
 * cave-stage-ranking — stage 5: tonight's papers, ranked, and the place you act.
 *
 * ONE CALL TO `caveScore`, AND NOTHING REFETCHED. The night arrived with the
 * stage before this one (`ctx.night`: stones and their centred vectors, and a
 * topic per stone) and the priorities stage left `ctx.prefs` (the setting, the
 * three sliders, the box's touchstones). A re-rank is those two objects and one
 * pass of arithmetic — no network, no re-embed, no second dig.
 *
 * NO GATE, ONE ORDER. A reader who came here wants the ranking, not a filter
 * that can empty the night, so the night is scored with Topic match at 0: gate
 * off, every paper of a live topic survives. Topic match is then a WEIGHT, not
 * a gate — `w = match / 100`, and the order key is
 * `(1 - w) * promisePct + w * fitPct`, both percentiles over tonight's list
 * ("the share at or below", so the top row reads 100 and a bar of 87 means 87
 * of tonight's papers are no more promising than this one). That key is the
 * row's one meter, `rel`, an integer 0..100. `orderNight` is the pure half.
 *
 * TOP FIVE, THEN FIVE MORE. The page shows PAGE = 5 rows and a "Show 5 more"
 * button; the line under the list says where the reader is ("5 of 12 tonight").
 * There is no bulk bar and no near-miss fallback: a short list is a short night.
 *
 * EACH ROW ACTS. SciRate, the paper's GitHub Discussions thread (join it, or
 * start it with the diamond inside), Summarize (the LLM diamond, cached per
 * paper), and the Story tick that carries picks to the last stage. The bar is
 * `actionsHtml` from `cave-paper-actions.mjs`; the thread states and the lookup
 * that fills them live there too. Thread answers are fetched once per page for
 * every row on screen, in ONE POST, and remembered in a module Map, so "Show 5
 * more" asks only about the ids it has not seen.
 *
 * THE ROW IS DIG'S LIST ROW. Rank, title, authors, chips, a detail that opens
 * in place with the abstract and the landmarks — a click, never a fetch,
 * because the abstract is already on the stone.
 *
 * PICKS LIVE ON `ctx.picks` (a Set of ids) and are dispatched as an array, so a
 * re-rank cannot drop one.
 *
 * THE PURE HALF IS EXPORTED — `meters`, `orderNight`, `applyPicks`, `rowHtml`,
 * `shownLine`, `storySummary` — because every number in this card is arithmetic
 * a test can hold without a browser (`scripts/cave-stage-ranking.test.mjs`).
 */
import { LESS_WEIGHT, applyLess, vecsFor } from './cave-nudge.mjs';
import { caveScore, defaultSetting } from './sieve-core.mjs';
import { bareArxivId, escapeHtml, joinUrl } from './sieve-ui.mjs';
import { wagonLabel } from './cave-wagon-views.mjs';
import { downloadText } from './cave-export.mjs';
import { parseRepo, threadBody } from './cave-thread.mjs';
import {
  BUDGET_NOTE, actionsHtml, diamondHtml, diamondRequest, parseThreads, readCachedDiamond,
  startThreadUrl, threadsRequest, writeCachedDiamond,
} from './cave-paper-actions.mjs';

/** How many rows the first paint shows, and what "Show 5 more" adds. */
export const PAGE = 5;

/** The mute line each missing input gets. */
export const NO_NIGHT = 'Dig first — tonight\'s papers are what get ranked.';
export const NO_CORPUS = 'No corpus on this build, so ranking waits.';
export const NO_TOPICS = 'topics.json did not load, so nothing can be ranked.';
export const NO_PREFS = 'Set your priorities first — Topic match and Surprise decide the order.';

/**
 * The Topic match a scoring pass gets: none.
 *
 * `caveScore` turns the slider into `gate = 2 * match / 100` and `rank` keeps a
 * candidate only when its z-scored fit is at or above that. Match 0 is still a
 * gate — it drops every paper below the corpus median fit, which on the shipped
 * corpus measured 85 of 200 rows kept. The card promises no gate at all
 * ("every paper of a live topic survives"), so the slider is handed the one
 * value it cannot express: a negative infinite gate, which admits every
 * candidate with a finite fit. The reader's match still arrives, as the weight
 * `orderNight` orders by.
 */
const GATE_OFF = -Infinity;

/** Every thread answer for the page's life, keyed by bare arXiv id. */
const threadCache = new Map();

/** Ids already asked about — an id answered "no thread" is not asked twice. */
const threadAsked = new Set();

let styled = false;

/** The card's stylesheet, once, from beside this module (baseurl-safe). */
function ensureStyles() {
  if (styled || typeof document === 'undefined') return;
  styled = true;
  const href = new URL('./cave-ranking.css' + new URL(import.meta.url).search, import.meta.url).href;
  if (document.head.querySelector('link[href="' + href + '"]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  document.head.appendChild(link);
}

/* ── pure helpers ───────────────────────────────────────────────────────── */

const clamp01 = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
const asNumber = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * The share of `values` at or below `value`, as a percent — the percentile a
 * bar of 90 reads as "few papers tonight are more than this".
 *
 * ponytail: an O(n²) scan over the night. A few hundred rows at most, so it
 * costs less than the re-render; if a night ever runs to thousands, sort once
 * and binary-search.
 */
function shareAtOrBelow(values, value) {
  const n = values.length;
  if (!n) return 0;
  let atOrBelow = 0;
  for (let i = 0; i < n; i += 1) if (values[i] <= value) atOrBelow += 1;
  return Math.round((100 * atOrBelow) / n);
}

/**
 * Both percentiles for a ranked list, in its order: `[{ fitPct, promisePct }]`.
 *
 * Fit is the percentile of `fit` — the share of tonight's list whose fit is at
 * or below this paper's. Promise is the same rule over `score`, `caveScore`'s
 * own 0..1 blend of impact and novelty. Both are measured over tonight's list
 * and nothing else, which is what makes them comparable enough to blend.
 */
export function meters(ranked) {
  const list = Array.isArray(ranked) ? ranked : [];
  const fits = list.map((item) => asNumber(item && item.fit));
  const scores = list.map((item) => asNumber(item && item.score));
  return list.map((item, i) => ({
    fitPct: shareAtOrBelow(fits, fits[i]),
    promisePct: shareAtOrBelow(scores, scores[i]),
  }));
}

/**
 * Tonight's list, ordered by the one key the card shows.
 *
 * `match` is the Topic match slider (0..100) read as a weight: `w = match/100`,
 * key = `(1 - w) * promisePct + w * fitPct`. At 0 the order is pure promise; at
 * 100 it is pure fit; in between the reader's own dial sets the blend. The key
 * is rounded to the integer `rel` each row displays, and ties break on id
 * ascending so two nights with the same numbers order the same way. The input
 * array is left alone.
 */
export function orderNight(ranked, match = 50) {
  const list = Array.isArray(ranked) ? ranked : [];
  const stats = meters(list);
  const w = clamp01(Number(match) / 100);
  const out = list.map((item, i) => ({
    ...item,
    rel: Math.round(Math.min(100, Math.max(0,
      (1 - w) * stats[i].promisePct + w * stats[i].fitPct))),
  }));
  out.sort((a, b) => b.rel - a.rel ||
    (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));
  return out;
}

/**
 * The ranked list with a `picked` flag per item, in the same order.
 *
 * Stable across a re-rank by construction: the flag comes from the ids in the
 * Set, never from a position, so the same papers stay ticked when the list
 * reorders itself under a slider.
 */
export function applyPicks(ranked, picks) {
  const has = picks && typeof picks.has === 'function' ? (id) => picks.has(id) : () => false;
  return (Array.isArray(ranked) ? ranked : []).map((item) => ({ ...item, picked: has(item.id) }));
}

/** The line under the list: where the reader is tonight. */
export function shownLine(shown, total) {
  const n = Math.max(0, Math.round(Number(total) || 0));
  const k = Math.min(n, Math.max(0, Math.round(Number(shown) || 0)));
  return k + ' of ' + n + ' tonight';
}

/** The ranking stage's completion line: what goes to the story. */
export function storySummary(k) {
  const n = Math.max(0, Math.round(Number(k) || 0));
  return n + ' for the story';
}

/** The first three authors, then "et al." — a phone-width line. */
export function shortAuthors(authors) {
  const list = (Array.isArray(authors) ? authors : [])
    .map((name) => String(name || '').trim())
    .filter(Boolean);
  if (!list.length) return '';
  const shown = list.slice(0, 3).join(', ');
  return list.length > 3 ? shown + ' et al.' : shown;
}

/** The row's one meter: "Promise" with `rel` as a bar and a number. */
function meterHtml(rel, total) {
  const pct = Math.round(Math.min(100, Math.max(0, asNumber(rel))));
  const title = 'relative to tonight\'s ' + total + (total === 1 ? ' paper' : ' papers');
  return '<span class="rk-meter rk-meter-promise" title="' + escapeHtml(title) + '">' +
    '<span class="rk-meter-label">Promise</span>' +
    '<span class="rk-track" role="meter" aria-label="Promise"' +
      ' aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '">' +
      '<span class="rk-track-fill" style="width:' + pct + '%"></span>' +
    '</span>' +
    '<span class="rk-meter-pct">' + pct + '</span>' +
  '</span>';
}

/** "Looks like": the nearest corpus papers, with their citation percentile. */
function landmarksHtml(item) {
  const rows = (item.landmarks || [])
    .filter((landmark) => landmark && landmark.title)
    .map((landmark) => '<li>' + escapeHtml(landmark.title) +
      (Number.isFinite(landmark.pct)
        ? ' <span class="rk-like-pct">(' + Math.round(landmark.pct * 100) + 'th pct)</span>'
        : '') + '</li>');
  if (!rows.length) return '';
  return '<div class="rk-like">' +
    '<span class="rk-like-label">Looks like</span>' +
    '<ul class="rk-like-list">' + rows.join('') + '</ul>' +
  '</div>';
}

/** The diamond's panel under an open row: loading, the card, or nothing. */
function panelHtml(parts) {
  if (parts.diamond) {
    return '<div class="pa-panel">' + diamondHtml(parts.diamond) + '</div>';
  }
  if (parts.pending) {
    return '<div class="pa-panel is-loading">' +
      '<span class="pa-spark" aria-hidden="true"></span>' +
      '<span class="pa-loading-text">Mining the diamond…</span>' +
    '</div>';
  }
  return '';
}

/** What opens in place under a row: the abstract, the landmarks, the diamond. */
function detailHtml(item, parts) {
  const abstract = item.abstract
    ? '<p class="rk-abstract">' + escapeHtml(item.abstract) + '</p>'
    : '';
  return abstract + landmarksHtml(item) + panelHtml(parts);
}

/**
 * One row, plus its (usually empty) detail, as markup.
 *
 * `parts` is what the page knows that the item does not: `rank`, `total` (the
 * night's size, for the meter's title), `open`, `repo`, `thread` (the three
 * states `actionsHtml` reads), `diamond`, `pending`, `error`, `md`.
 * Titles, authors, links and landmarks all arrive from arXiv, so every one of
 * them is escaped — `rowHtml` is the one place that happens.
 */
export function rowHtml(item, parts = {}) {
  const data = item || {};
  const id = String(data.id ?? '');
  const title = data.title || id;
  const authors = shortAuthors(data.authors);
  const topic = parts.topic
    ? '<span class="rk-chip rk-chip-topic">' + escapeHtml(parts.topic) + '</span>' : '';
  const wagon = parts.wagon
    ? '<span class="rk-chip rk-chip-wagon">' + escapeHtml(parts.wagon) + '</span>' : '';
  const open = !!parts.open;
  const rank = Number(parts.rank) || 0;
  const total = Math.max(0, Math.round(Number(parts.total) || 0));
  const actions = actionsHtml(data, {
    repo: parts.repo || '',
    thread: parts.thread,
    picked: !!data.picked,
    diamond: !!parts.diamond,
    md: !!parts.md,
    open,
  });
  const error = parts.error
    ? '<p class="pa-status pa-status-error" role="status">' + escapeHtml(parts.error) + '</p>'
    : '';

  return '<div class="rk-row' + (open ? ' is-open' : '') + (data.picked ? ' is-picked' : '') +
      '" data-id="' + escapeHtml(id) + '">' +
      '<span class="rk-rank">' + rank + '</span>' +
      '<div class="rk-main">' +
        '<h3 class="rk-title">' +
          '<button type="button" class="rk-title-btn" data-id="' + escapeHtml(id) + '"' +
            ' aria-expanded="' + (open ? 'true' : 'false') + '">' + escapeHtml(title) + '</button>' +
        '</h3>' +
        (authors ? '<p class="rk-authors">' + escapeHtml(authors) + '</p>' : '') +
        ((topic || wagon) ? '<p class="rk-chips">' + topic + wagon + '</p>' : '') +
        actions +
        error +
      '</div>' +
      '<div class="rk-meters">' + meterHtml(data.rel, total) + '</div>' +
      '<button type="button" class="rk-toggle" aria-expanded="' + (open ? 'true' : 'false') +
        '" aria-label="' + (open ? 'Hide' : 'Show') + ' abstract">▸</button>' +
    '</div>' +
    '<div class="rk-detail"' + (open ? '' : ' hidden') + '>' +
      (open ? detailHtml(data, parts) : '') +
    '</div>';
}

/* ── the page ───────────────────────────────────────────────────────────── */

/** Leaf label for a stone's primary topic index, '' when it has none. */
function leafLabel(topics, index) {
  const leaves = topics && Array.isArray(topics.leaves) ? topics.leaves : [];
  const leaf = index >= 0 ? leaves[index] : null;
  return leaf ? String(leaf.label || '') : '';
}

/** Stone id → wagon label, from the night the map annotated. */
function wagonByStone(night) {
  const out = new Map();
  const components = (night && night.components) || [];
  const names = (night && night.names) || [];
  for (let c = 0; c < components.length; c += 1) {
    const label = wagonLabel(names, c);
    const indices = (components[c] && components[c].indices) || [];
    for (const i of indices) {
      const stone = night.stones && night.stones[i];
      if (stone && stone.id != null) out.set(stone.id, label);
    }
  }
  return out;
}

/**
 * Mount stage 5. `body` is the stage card's body element; `ctx` is the page's
 * shared context (see cave-v4-interfaces.md). Every input is optional: a page
 * with no night yet, or a build with no corpus, gets one muted line instead of
 * an exception.
 */
export function mount(body, ctx) {
  if (!body || !ctx) return;

  ensureStyles();

  body.innerHTML =
    '<div class="cave-ranking">' +
      '<p class="rk-note" hidden></p>' +
      '<div class="rk-list"></div>' +
      '<div class="rk-more-wrap" hidden>' +
        '<button type="button" class="rk-more">Show ' + PAGE + ' more</button>' +
        '<span class="rk-shown"></span>' +
      '</div>' +
      '<div class="button-bar rk-foot">' +
        '<button type="button" class="cave-continue-btn cave-primary rk-continue" disabled>' +
          'Tell the story</button>' +
        '<p class="rk-hint" hidden>Tick Story on the papers you want woven in.</p>' +
      '</div>' +
    '</div>';

  const noteEl = body.querySelector('.rk-note');
  const listEl = body.querySelector('.rk-list');
  const moreWrap = body.querySelector('.rk-more-wrap');
  const moreBtn = body.querySelector('.rk-more');
  const shownEl = body.querySelector('.rk-shown');
  const continueBtn = body.querySelector('.rk-continue');
  const hintEl = body.querySelector('.rk-hint');

  const state = {
    night: null,        // the night this list was built from
    ranked: [],         // orderNight output, with the picked flags
    shown: PAGE,        // how many rows the reader has opened up to
    open: null,         // the one row whose detail is showing, by id
    pending: new Set(), // ids with a diamond request in flight
    diamonds: new Map(), // id -> diamond, this session (cached ones land here too)
    errors: new Map(),  // id -> the line under the action bar
    md: new Set(),      // ids whose .md download was offered
  };

  /* ── the page's knobs, read defensively ─────────────────────────────── */

  const config = () => (ctx.config && typeof ctx.config === 'object' ? ctx.config : {});
  const repo = () => String(config().discussionsRepo || '');
  const repoOk = () => !!parseRepo(repo());

  /** What is missing, in the order a reader meets it. '' when nothing is. */
  function missing() {
    if (!ctx.night) return NO_NIGHT;
    if (!ctx.corpus) return NO_CORPUS;
    if (!ctx.topics) return NO_TOPICS;
    if (!ctx.prefs) return NO_PREFS;
    return '';
  }

  /** Picks that are in tonight's ranking — what the continue button counts. */
  function pickedIds() {
    const ids = new Set(state.ranked.map((item) => item.id));
    const out = [];
    if (ctx.picks && typeof ctx.picks.forEach === 'function') {
      ctx.picks.forEach((id) => { if (ids.has(id)) out.push(id); });
    }
    return out;
  }

  /** A diamond from this session or from storage; null when never mined. */
  function diamondOf(id) {
    const key = String(id);
    if (state.diamonds.has(key)) return state.diamonds.get(key);
    const cached = readCachedDiamond(ctx.storage, key);
    if (cached) state.diamonds.set(key, cached);
    return cached;
  }

  /** Ids on screen, in rank order, as the lookup and the rows both want them. */
  function rowsOnScreen() {
    return state.ranked.slice(0, state.shown);
  }

  function paintList() {
    const rows = rowsOnScreen();
    const wagons = wagonByStone(ctx.night);
    const total = state.ranked.length;

    listEl.innerHTML = rows.map((item, i) => rowHtml(item, {
      rank: i + 1,
      total,
      topic: leafLabel(ctx.topics, item.topic),
      wagon: wagons.get(item.id) || '',
      open: state.open === item.id,
      repo: repoOk() ? repo() : '',
      thread: threadCache.get(bareArxivId(item.id)),
      diamond: diamondOf(item.id),
      pending: state.pending.has(String(item.id)),
      error: state.errors.get(String(item.id)) || '',
      md: state.md.has(String(item.id)),
    })).join('');

    moreWrap.hidden = total === 0;
    moreBtn.hidden = state.shown >= total;
    shownEl.textContent = shownLine(rows.length, total);

    lookupThreads(rows.map((item) => item.id));
  }

  function paintFoot() {
    const k = pickedIds().length;
    continueBtn.disabled = k === 0;
    hintEl.hidden = k > 0;
  }

  function paint() {
    const note = missing();
    noteEl.textContent = note;
    noteEl.hidden = !note;
    paintList();
    paintFoot();
  }

  /* ── the thread lookup: one POST for every row on screen ─────────────── */

  /**
   * Ask the `threads` function about the ids just painted, once each for the
   * page's life. An answer lands in the module cache; anything else (a throw, a
   * non-200, a body that is not `{ threads: {…} }`) leaves that id `undefined`,
   * which is the fallback-to-search state the row already draws.
   */
  async function lookupThreads(ids) {
    if (!repoOk()) return;
    const base = String(config().threadsUrl ||
      (config().functionsBase ? joinUrl(config().functionsBase, 'threads') : ''));
    if (!base) return;

    const wanted = (Array.isArray(ids) ? ids : [])
      .map((id) => bareArxivId(id))
      .filter((id) => id && !threadAsked.has(id));
    if (!wanted.length) return;
    for (const id of wanted) threadAsked.add(id);

    let resp = null;
    let payload = null;
    try {
      resp = await fetch(base, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(threadsRequest(repo(), wanted)),
      });
      payload = await resp.json();
    } catch (_) {
      return;
    }
    if (!resp || !resp.ok) return;

    const answers = parseThreads(payload, wanted);
    let found = 0;
    for (const [id, value] of Object.entries(answers)) {
      /* `actionsHtml` reads `{ url }` for a thread that exists and `null` for a
         paper nobody has opened yet; the wire says `"<url>"` and `null`. */
      threadCache.set(id, value === null ? null : { url: value });
      found += 1;
    }
    if (found) paintList();
  }

  /* ── the diamond: the cache, the one call, and the panel ─────────────── */

  /**
   * One diamond, from the cache or the endpoint. Resolves to `{ diamond }` or
   * `{ error }`; a spent budget is the plain sentence, not an HTTP code. One
   * request in flight per paper.
   */
  async function loadDiamond(paper) {
    const id = String(paper.id);
    const cached = diamondOf(id);
    if (cached) return { diamond: cached };
    if (state.pending.has(id)) return {};

    const base = String(config().functionsBase || '');
    if (!base) return { error: 'Diamonds are not configured on this build.' };

    state.pending.add(id);
    state.errors.delete(id);
    paintList();

    let resp = null;
    let data = null;
    try {
      resp = await fetch(joinUrl(base, 'diamond'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(diamondRequest(paper)),
      });
      try { data = await resp.json(); } catch (_) { data = null; }
    } catch (err) {
      state.pending.delete(id);
      return { error: 'Could not reach the diamond: ' + ((err && err.message) || err) };
    }
    state.pending.delete(id);

    if (!resp || !resp.ok) {
      const budget = !!resp && resp.status === 429 && data && data.error === 'budget';
      return {
        error: budget
          ? BUDGET_NOTE
          : 'The diamond failed: ' + ((data && data.error) || ('HTTP ' + (resp ? resp.status : '?'))),
      };
    }

    state.diamonds.set(id, data);
    writeCachedDiamond(ctx.storage, id, data);
    return { diamond: data };
  }

  /** Summarize: the panel under the row, cached at once or mined once. */
  async function summarize(paper) {
    const id = String(paper.id);
    state.open = id;
    if (diamondOf(id)) {
      paintList();
      return;
    }
    const result = await loadDiamond(paper);
    if (result.error) state.errors.set(id, result.error);
    else state.errors.delete(id);
    paintList();
  }

  /**
   * Start thread: the diamond first (it travels in the body), then GitHub's
   * prefilled new-discussion form in a new tab, then the same Markdown as a
   * `<id>.md` download. A failed diamond still opens the thread, without it.
   */
  async function startThread(paper) {
    const id = String(paper.id);
    if (!repoOk()) return;

    let diamond = diamondOf(id);
    if (!diamond) {
      const result = await loadDiamond(paper);
      if (result.diamond) {
        diamond = result.diamond;
        state.errors.delete(id);
      } else if (result.error) {
        state.errors.set(id, result.error);
      }
    }

    state.md.add(id);
    const url = startThreadUrl(repo(), paper, {
      category: String(config().discussionsCategory || 'general') || 'general',
      diamond: diamond || null,
    });
    if (url && typeof window !== 'undefined' && typeof window.open === 'function') {
      /* A popup blocker can refuse an open that follows an await; in that case
         the row keeps the thread URL as its Discussion link, so the reader's
         own click opens it. */
      if (!window.open(url, '_blank', 'noopener')) threadCache.set(bareArxivId(id), { url });
    }
    paintList();
  }

  /** The thread's own Markdown, as a file. */
  function downloadMd(paper) {
    const bare = bareArxivId(paper.id) || 'paper';
    const diamond = diamondOf(paper.id) || null;
    downloadText(bare + '.md', threadBody(paper, { diamond }), 'text/markdown');
  }

  /* ── scoring ─────────────────────────────────────────────────────────── */

  /**
   * Score the night, from what is already in memory.
   *
   * `caveScore` wants candidates as `{ …stone, vec, topic, topic2 }`; the night
   * already carries all three arrays, so this is a zip, not a re-embed. Topic
   * match goes in at 0 — the gate off, every paper of a live topic in the list —
   * and comes back as `orderNight`'s weight. The ML-for-quantum chip hides
   * papers after scoring, exactly as v3 did.
   */
  function refresh() {
    const absent = missing();
    if (absent) {
      state.ranked = [];
      ctx.ranked = [];
      paint();
      return;
    }

    const night = ctx.night;
    const prefs = ctx.prefs;
    if (night !== state.night) {
      /* A new dig: fold back to the first page and close whatever was open. */
      state.night = night;
      state.shown = PAGE;
      state.open = null;
    }

    const candidates = night.stones.map((stone, i) => ({
      ...stone,
      vec: night.vecs ? night.vecs[i] : null,
      topic: night.topic ? (night.topic[i] ?? -1) : -1,
      topic2: night.topic2 ? (night.topic2[i] ?? -1) : -1,
    }));

    const sliders = prefs.sliders || {};
    const match = Number.isFinite(Number(sliders.match)) ? Number(sliders.match) : 50;

    /* The nudges, resolved against tonight: a "more like" paper's vector is a
       touchstone like the box's words, a "less like" paper's is a penalty. An
       id from an older night is simply absent from both lists. */
    const moreVecs = vecsFor(prefs.more, night);
    const lessVecs = vecsFor(prefs.less, night);

    let scored;
    try {
      scored = caveScore({
        corpus: ctx.corpus,
        topics: ctx.topics,
        axes: ctx.axes,
        setting: prefs.setting || defaultSetting(ctx.topics),
        sliders: { ...sliders, match: GATE_OFF },
        touchstones: [...(Array.isArray(prefs.touchstones) ? prefs.touchstones : []), ...moreVecs],
        candidates,
      });
    } catch (err) {
      state.ranked = [];
      ctx.ranked = [];
      noteEl.textContent = 'Could not rank tonight\'s papers: ' + ((err && err.message) || err);
      noteEl.hidden = false;
      listEl.innerHTML = '';
      moreWrap.hidden = true;
      paintFoot();
      return;
    }

    if (prefs.ml4q) scored = scored.filter((item) => item.ml4q >= 0.5);

    /* The dislikes last, on scores `caveScore` has already normalised. */
    scored = applyLess(scored, lessVecs, { weight: LESS_WEIGHT });

    state.ranked = applyPicks(orderNight(scored, match), ctx.picks);
    ctx.ranked = state.ranked;
    ctx.bus.dispatchEvent(new CustomEvent('ranked', { detail: state.ranked }));
    paint();
  }

  /* ── wiring ──────────────────────────────────────────────────────────── */

  /* Delegated: the list is re-rendered on every toggle, and one listener on the
     container outlives all of it. An action button, a link or the Story box is
     its own target; anything else on the row opens the detail, the way Dig's
     list does. */
  listEl.addEventListener('click', (event) => {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    const action = target.closest('[data-act]');
    if (action) {
      const id = action.getAttribute('data-id');
      const paper = state.ranked.find((item) => String(item.id) === id);
      if (!paper) return;
      const what = action.getAttribute('data-act');
      if (what === 'summarize') summarize(paper);
      else if (what === 'start-thread') startThread(paper);
      else if (what === 'md') {
        event.preventDefault();
        downloadMd(paper);
      }
      return;
    }
    if (target.closest('a, input, label')) return;
    const row = target.closest('.rk-row');
    if (!row) return;
    const id = row.getAttribute('data-id');
    state.open = state.open === id ? null : id;
    paintList();
  });

  /* The pick set is the page's, not this module's: mutate it and say so. The
     list is not re-rendered — the box the reader just clicked is already in the
     right state, and a re-render would take the focus with it; the row's gold
     edge and the continue button are updated in place. */
  listEl.addEventListener('change', (event) => {
    const box = event.target;
    if (!box || !box.classList || !box.classList.contains('pa-pick')) return;
    if (!ctx.picks || typeof ctx.picks.add !== 'function') return;
    const id = box.getAttribute('data-id');
    if (!id) return;
    if (box.checked) ctx.picks.add(id);
    else ctx.picks.delete(id);

    const row = typeof box.closest === 'function' ? box.closest('.rk-row') : null;
    if (row && row.classList) row.classList.toggle('is-picked', box.checked);
    for (const item of state.ranked) {
      if (String(item.id) === id) item.picked = box.checked;
    }

    paintFoot();
    ctx.bus.dispatchEvent(new CustomEvent('picks', { detail: [...ctx.picks] }));
  });

  moreBtn.addEventListener('click', () => {
    state.shown += PAGE;
    paintList();
  });

  continueBtn.addEventListener('click', () => {
    const k = pickedIds().length;
    if (!k || !ctx.flow || ctx.flow.status('ranking') === 'locked') return;
    ctx.flow.complete('ranking', storySummary(k));
    const target = typeof document !== 'undefined' && typeof document.getElementById === 'function'
      ? document.getElementById('stage-story')
      : null;
    if (target && typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });

  /* Both halves of the input, in either order: a reader can set priorities
     before or after the dig lands. Wagons arrive later still (the map names
     them), so a naming pass re-labels the chips without rescoring anything. */
  ctx.bus.addEventListener('prefs', (event) => {
    /* The event's detail is the documented payload and `ctx.prefs` is its
       documented home; take the copy if the stage that made it has not stored
       one, so this card cannot wait forever on a missing assignment. */
    if (!ctx.prefs && event.detail) ctx.prefs = event.detail;
    refresh();
  });
  ctx.bus.addEventListener('night', refresh);
  ctx.bus.addEventListener('wagons', () => {
    if (state.ranked.length) paintList();
  });
  ctx.bus.addEventListener('picks', () => paintFoot());

  refresh();
}
