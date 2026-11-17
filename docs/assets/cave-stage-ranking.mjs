/**
 * cave-stage-ranking — stage 5: tonight's papers, ranked, and the place you act.
 *
 * ONE CALL TO `caveScore`, AND NOTHING REFETCHED. The night arrived with the
 * stage before this one (`ctx.night`: stones and their centred vectors, and a
 * topic per stone) and the priorities stage left `ctx.prefs` (the setting, the
 * three sliders, the box's touchstones). A re-rank is those two objects and one
 * pass of arithmetic — no network, no re-embed, no second dig.
 *
 * THE SLIDERS LIVE HERE, beside the list they reorder: Topic match, Surprise,
 * Theory ↔ Experiment, and two penalties — Single author and AI trace. The
 * priorities stage still keeps their values (codec, storage, the one `prefs`
 * event); this card draws them and sends each change back as a `tune` event,
 * so a drag re-ranks the list live. ML for quantum is a row of that stage's
 * topic tree now, under Computing; this card only applies it.
 *
 * GRADES, NOT ONE NUMBER. Each row's bar is the order key; beside it sit the
 * parts a reader may want to judge separately: Match, Surprise, Impact, how
 * experimental the paper reads, AI trace once estimated, and a "1 author"
 * mark. Promise itself is not a grade — it is Impact and Surprise mixed, so
 * showing it beside them would say the same thing twice.
 *
 * AI TRACE IS A BUTTON, in the slider panel's free cell. It asks an LLM (the
 * `aitrace` function) how likely each abstract on screen was written by an
 * LLM — a guess, labelled as one, cached per paper in storage so a paper is
 * asked about once.
 *
 * NO GATE, ONE ORDER. A reader who came here wants the ranking, not a filter
 * that can empty the night, so the night is scored with Topic match at 0: gate
 * off, every paper of a live topic survives. Topic match is then a WEIGHT, not
 * a gate — `w = match / 100`, and the order key is
 * `(1 - w) * promisePct + w * fitPct`, both read against the background corpus
 * rather than tonight (see `meters`), so a weak night's best paper does not
 * read 100 just for being tonight's best. That key is the
 * row's one meter, `rel`, an integer 0..100. `orderNight` is the pure half.
 *
 * TOP TEN, THEN TEN MORE. The page shows PAGE = 10 rows and a "Show 10 more"
 * button; the line under the list says where the reader is ("10 of 24 tonight").
 * There is no bulk bar and no near-miss fallback: a short list is a short night.
 *
 * EACH ROW ACTS. SciRate, the paper's GitHub Discussions thread (join it, or
 * start it with the diamond inside), and Summarize (the LLM diamond, cached per
 * paper). The Pick tick sits under the rank, in the list's first column, which
 * a header names "Pick". The bar is
 * `actionsHtml` from `cave-paper-actions.mjs`; the thread states and the lookup
 * that fills them live there too. Thread answers are fetched once per page for
 * every row on screen, in ONE POST, and remembered in a module Map, so "Show 10
 * more" asks only about the ids it has not seen.
 *
 * THE ROW IS DIG'S LIST ROW. Rank, title, authors, chips, a detail that opens
 * in place with the abstract and the landmarks — a click, never a fetch,
 * because the abstract is already on the stone.
 *
 * PICKS LIVE ON `ctx.picks` (a Set of ids) and are dispatched as an array, so a
 * re-rank cannot drop one. The foot acts on them: Story carries them to the
 * last stage, RIS and BibTeX download them for Zotero — no story needed.
 *
 * THE PURE HALF IS EXPORTED — `meters`, `orderNight`, `applyPicks`, `rowHtml`,
 * `shownLine`, `storySummary` — because every number in this card is arithmetic
 * a test can hold without a browser (`scripts/cave-stage-ranking.test.mjs`).
 */
import { LESS_WEIGHT, applyLess, vecsFor } from './cave-nudge.mjs';
import { PROMISE_REF, caveScore, defaultSetting, phi } from './sieve-core.mjs';
import { SLIDERS } from './cave-stage-priorities.mjs';
import { bareArxivId, escapeHtml, joinUrl } from './sieve-ui.mjs';
import { wagonLabel } from './cave-wagon-views.mjs';
import { downloadText, toBibtex, toRis } from './cave-export.mjs';
import { parseRepo, threadBody } from './cave-thread.mjs';
import {
  BUDGET_NOTE, actionsHtml, diamondHtml, diamondRequest, parseThreads, readCachedDiamond,
  startThreadUrl, threadsRequest, writeCachedDiamond,
} from './cave-paper-actions.mjs';

/** How many rows the first paint shows, and what "Show 10 more" adds. */
export const PAGE = 10;

/** The mute line each missing input gets. */
export const NO_NIGHT = 'Dig first — tonight\'s papers are what get ranked.';
export const NO_CORPUS = 'No corpus on this build, so ranking waits.';
export const NO_TOPICS = 'topics.json did not load, so nothing can be ranked.';
export const NO_PREFS = 'Priorities have not loaded yet, so there is nothing to order by.';

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

/**
 * The two penalties at full travel, in points of the 0..100 key. A
 * single-author paper loses up to SOLO_MAX; a paper the trace calls certainly
 * machine-written loses up to AI_MAX, scaled by the trace's own percentage.
 */
export const SOLO_MAX = 30;
export const AI_MAX = 40;

/** AI-trace answers in storage: `{ id: { p, why } }`, newest last, capped. */
export const TRACE_KEY = 'arxave-cave-aitrace-v1';
export const TRACE_KEEP = 600;

/** One press asks about at most this many rows (the function's own cap). */
export const TRACE_BATCH = 10;

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
 * Both meters for a ranked list, in its order: `[{ fitPct, promisePct }]`
 * (plus the grades' `surprisePct`, `impactPct` and `theoryPct`),
 * each 0..100 and measured against the BACKGROUND CORPUS, never against
 * tonight. A weak night therefore reads weak: its best paper is not 100.
 *
 * Promise is `caveScore`'s own 0..1 score as a percent: `promiseScore`
 * (sieve-core) reads impact (the citation percentile of the paper's corpus
 * neighbours) and novelty (distance from the nearest proven corpus paper)
 * against the corpus's own leave-one-out spread, so 80 means "above ~80% of
 * the background". Fit is the corpus-normalised z-score
 * `fit` through the normal CDF: 84 means closer to what you asked for than
 * ~84% of the background is.
 */
export function meters(ranked, ref = PROMISE_REF) {
  const list = Array.isArray(ranked) ? ranked : [];
  const novelty = (ref && ref.novelty) || PROMISE_REF.novelty;
  const impact = (ref && ref.impact) || PROMISE_REF.impact;
  return list.map((item) => {
    const theory = item && item.theory != null ? Number(item.theory) : NaN;
    return {
      fitPct: Math.round(100 * phi(asNumber(item && item.fit))),
      promisePct: Math.round(100 * clamp01(asNumber(item && item.score))),
      /* Surprise is novelty read against the corpus's own leave-one-out
         spread, so 50 is a typical distance from proven work. */
      surprisePct: Math.round(100 * phi(
        (asNumber(item && item.novelty) - novelty.mean) / (novelty.sd || 1))),
      /* Impact the same way: the citation percentile of the paper's corpus
         neighbours, against the corpus's own spread of it. */
      impactPct: Math.round(100 * phi(
        (asNumber(item && item.impact) - impact.mean) / (impact.sd || 1))),
      theoryPct: Number.isFinite(theory) ? Math.round(100 * clamp01(theory)) : null,
    };
  });
}

/** Authors on a paper; 0 when the list is missing (never read as solo). */
export function authorCount(item) {
  const list = item && Array.isArray(item.authors) ? item.authors : [];
  return list.filter((name) => String(name || '').trim()).length;
}

/**
 * Tonight's list, ordered by the one key the card shows.
 *
 * `opts` is `{ match, solo, ai, traces, ref }` (a bare number is `match`, as
 * before). `solo` and `ai` are the penalty sliders, 0..100: a single-author
 * paper loses `solo/100 * SOLO_MAX` points, and a paper with an AI trace of
 * p% loses `ai/100 * p/100 * AI_MAX`. Each row also carries its `grades`.
 *
 * `match` is the Topic match slider (0..100) read as a weight: `w = match/100`,
 * key = `(1 - w) * promisePct + w * fitPct`. At 0 the order is pure promise; at
 * 100 it is pure fit; in between the reader's own dial sets the blend. Both
 * terms are background percentiles (see `meters`), so `rel` is too. The key is
 * rounded to the integer `rel` each row displays, and ties break on id
 * ascending so two nights with the same numbers order the same way. The input
 * array is left alone.
 */
export function orderNight(ranked, opts = 50) {
  const o = typeof opts === 'object' && opts ? opts : { match: opts };
  const list = Array.isArray(ranked) ? ranked : [];
  const stats = meters(list, o.ref);
  const w = clamp01(Number(o.match ?? 50) / 100);
  const solo = clamp01(Number(o.solo) / 100) * SOLO_MAX;
  const ai = clamp01(Number(o.ai) / 100) * AI_MAX;
  const traces = o.traces || {};
  const out = list.map((item, i) => {
    const trace = traces[bareArxivId(item.id)] || traces[item.id];
    const traceP = trace && Number.isFinite(Number(trace.p)) ? clamp01(Number(trace.p) / 100) : 0;
    const penalty = (authorCount(item) === 1 ? solo : 0) + ai * traceP;
    return {
      ...item,
      grades: stats[i],
      rel: Math.round(Math.min(100, Math.max(0,
        (1 - w) * stats[i].promisePct + w * stats[i].fitPct - penalty))),
    };
  });
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

/** The count beside the foot's buttons: what they act on. */
export function pickedLine(k) {
  const n = Math.max(0, Math.round(Number(k) || 0));
  return n ? n + ' picked' : '';
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

/**
 * True when two chip labels say the same thing. A wagon's name is written by a
 * model that often reuses the topic's own words ("Fault-tolerant computing &
 * roadmaps" twice, or "FT computing roadmaps"), and a row that shows the same
 * label twice says nothing the first one did not. Case, punctuation and "&" /
 * "and" are ignored; a label whose words are mostly the other's counts as the
 * same.
 */
export function sameLabel(a, b) {
  const words = (v) => String(v || '').toLowerCase()
    .replace(/&/g, ' ').split(/[^a-z0-9]+/)
    .filter((w) => w && w !== 'and' && w !== 'of' && w !== 'the');
  /* A word, or the initials of two neighbouring words ("fault tolerant" is
     also "ft"), so an abbreviation meets its long form. */
  const known = (list) => {
    const out = new Set(list);
    for (let i = 0; i + 1 < list.length; i += 1) out.add(list[i][0] + list[i + 1][0]);
    return out;
  };
  const x = new Set(words(a));
  const y = new Set(words(b));
  if (!x.size || !y.size) return false;
  const inX = known([...x]);
  const inY = known([...y]);
  let shared = 0;
  for (const w of x) if (inY.has(w)) shared += 1;
  let back = 0;
  for (const w of y) if (inX.has(w)) back += 1;
  shared = Math.max(shared, back);
  return shared / Math.min(x.size, y.size) >= 0.6;
}

/** The row's one meter: "Score", the order key, as a bar and a number. */
function meterHtml(rel, total) {
  const pct = Math.round(Math.min(100, Math.max(0, asNumber(rel))));
  const title = 'The order key: Promise (Impact and Surprise) and Match blended by the Topic match slider,' +
    ' less the penalties (' +
    total + (total === 1 ? ' paper' : ' papers') + ' tonight)';
  return '<span class="rk-meter rk-meter-promise" title="' + escapeHtml(title) + '">' +
    '<span class="rk-meter-label">Score</span>' +
    '<span class="rk-track" role="meter" aria-label="Score"' +
      ' aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '">' +
      '<span class="rk-track-fill" style="width:' + pct + '%"></span>' +
    '</span>' +
    '<span class="rk-meter-pct">' + pct + '</span>' +
  '</span>';
}

/**
 * The small grades beside the bar: Match, Surprise, Impact, Exp., AI trace
 * (once estimated) and "1 author". Each is a 0..100 — the first three against
 * the background corpus, Exp. the axis's own certainty that the paper is
 * experiment (100 minus its theory reading).
 */
export function gradesHtml(item, trace) {
  const g = (item && item.grades) || {};
  const cell = (label, value, title, cls = '') =>
    '<span class="rk-grade' + cls + '" title="' + escapeHtml(title) + '">' +
      '<span class="rk-grade-k">' + escapeHtml(label) + '</span>' +
      '<span class="rk-grade-v">' + escapeHtml(String(value)) + '</span></span>';
  const out = [];
  if (Number.isFinite(g.fitPct)) out.push(cell('Match', g.fitPct, 'Closeness to your topics and words'));
  if (Number.isFinite(g.surprisePct)) {
    out.push(cell('Surprise', g.surprisePct, 'Distance from well-cited work, vs. the corpus'));
  }
  if (Number.isFinite(g.impactPct)) {
    out.push(cell('Impact', g.impactPct, 'How cited the paper\'s nearest corpus neighbours are, vs. the corpus'));
  }
  if (Number.isFinite(g.theoryPct)) {
    out.push(cell('Exp.', 100 - g.theoryPct, 'How sure the axis is that this is experiment (0 is theory)'));
  }
  if (trace && Number.isFinite(Number(trace.p))) {
    const p = Math.round(Number(trace.p));
    out.push(cell('AI', p + '%',
      'An LLM\'s guess that the abstract was machine-written' + (trace.why ? ': ' + trace.why : ''),
      p >= 60 ? ' is-warn' : ''));
  }
  if (authorCount(item) === 1) out.push(cell('', '1 author', 'Single-author paper', ' is-solo'));
  return out.length ? '<span class="rk-grades">' + out.join('') + '</span>' : '';
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
 * states `actionsHtml` reads), `diamond`, `pending`, `error`, `md`, `trace`.
 * The title is a link to the arXiv abstract page and takes the row's full
 * width; the Score bar and grades sit on one line under it, beside the topic
 * chips, so ten rows fit where five did. The row's ▸ opens the detail.
 * The Pick tick sits under the rank, so the first column reads down the list.
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
  const wagon = parts.wagon && !sameLabel(parts.wagon, parts.topic)
    ? '<span class="rk-chip rk-chip-wagon">' + escapeHtml(parts.wagon) + '</span>' : '';
  const open = !!parts.open;
  const rank = Number(parts.rank) || 0;
  const total = Math.max(0, Math.round(Number(parts.total) || 0));
  const actions = actionsHtml(data, {
    repo: parts.repo || '',
    thread: parts.thread,
    diamond: !!parts.diamond,
    md: !!parts.md,
    open,
  });
  const error = parts.error
    ? '<p class="pa-status pa-status-error" role="status">' + escapeHtml(parts.error) + '</p>'
    : '';

  return '<div class="rk-row' + (open ? ' is-open' : '') + (data.picked ? ' is-picked' : '') +
      '" data-id="' + escapeHtml(id) + '">' +
      '<span class="rk-rankcol">' +
        '<span class="rk-rank">' + rank + '</span>' +
        '<input type="checkbox" class="pa-pick" data-id="' + escapeHtml(id) + '"' +
          (data.picked ? ' checked' : '') + ' aria-label="Pick for the story">' +
      '</span>' +
      '<div class="rk-main">' +
        '<h3 class="rk-title">' +
          '<a class="rk-title-link" href="' + escapeHtml(absUrl(id)) + '" target="_blank" rel="noopener">' +
            escapeHtml(title) + '</a>' +
        '</h3>' +
        (authors ? '<p class="rk-authors">' + escapeHtml(authors) + '</p>' : '') +
        '<div class="rk-line">' +
          '<div class="rk-meters">' + meterHtml(data.rel, total) + gradesHtml(data, parts.trace) + '</div>' +
          ((topic || wagon) ? '<p class="rk-chips">' + topic + wagon + '</p>' : '') +
        '</div>' +
        actions +
        error +
      '</div>' +
      '<button type="button" class="rk-toggle" aria-expanded="' + (open ? 'true' : 'false') +
        '" aria-label="' + (open ? 'Hide' : 'Show') + ' abstract">▸</button>' +
    '</div>' +
    '<div class="rk-detail"' + (open ? '' : ' hidden') + '>' +
      (open ? detailHtml(data, parts) : '') +
    '</div>';
}

/** The arXiv abstract page for an id. */
export function absUrl(id) {
  return 'https://arxiv.org/abs/' + encodeURIComponent(bareArxivId(id) || String(id || ''));
}

/** The Theory ↔ Experiment slider's number, as drawn: just the value. */
export function experimentText(value) {
  return String(Math.round(Number(value) || 0) || 0);
}

/**
 * A slider's stored value as the panel draws it, and back. Theory ↔ Experiment
 * is drawn theory-left, but the codec keeps experiment negative, so its spec
 * says `invert` and the panel flips the sign both ways. `|| 0` keeps -0 out.
 */
export function shownValue(spec, value) {
  const v = Number(value);
  return (spec && spec.invert ? -v : v) || 0;
}

/**
 * The tuning panel's sliders: id, label, the two ends, and how the value
 * reads. Ranges come from the priorities stage's `SLIDERS`, the one table the
 * codec clamps against.
 */
export const TUNE = Object.freeze([
  { id: 'match', label: 'Topic match', ends: ['explore', 'match'], text: (v) => String(v) },
  { id: 'surprise', label: 'Surprise', ends: ['proven', 'surprising'], text: (v) => String(v) },
  { id: 'expTheory', label: 'Theory ↔ Experiment', ends: ['theory', 'experiment'], text: experimentText, axis: 'expTheory', invert: true },
  { id: 'solo', label: 'Single author', ends: ['keep', 'sink'], text: (v) => (v ? '−' + Math.round(v * SOLO_MAX / 100) : 'off') },
  { id: 'ai', label: 'AI trace', ends: ['keep', 'sink'], text: (v) => (v ? '−' + Math.round(v * AI_MAX / 100) + ' max' : 'off') },
]);

/** One small slider of the tuning panel, as markup; `value` is the stored one. */
export function tuneRowHtml(spec, value, hidden = false) {
  const range = SLIDERS[spec.id];
  const domId = 'rk-tune-' + spec.id;
  const shown = shownValue(spec, value);
  /* An inverted range is symmetric (-100..100), so its ends swap cleanly. */
  const min = spec.invert ? -range.max : range.min;
  const max = spec.invert ? -range.min : range.max;
  return '<div class="rk-tune-row"' + (hidden ? ' hidden' : '') + '>' +
    '<label class="rk-tune-label" for="' + domId + '">' + escapeHtml(spec.label) + '</label>' +
    '<output class="rk-tune-val" for="' + domId + '" data-val="' + spec.id + '">' +
      escapeHtml(spec.text(shown)) + '</output>' +
    '<input class="rk-tune-slider" type="range" id="' + domId + '" data-tune="' + spec.id + '"' +
      ' min="' + min + '" max="' + max + '" step="1" value="' + shown + '">' +
    '<span class="rk-tune-ends" aria-hidden="true"><span>' + escapeHtml(spec.ends[0]) +
      '</span><span>' + escapeHtml(spec.ends[1]) + '</span></span>' +
  '</div>';
}

/** Stored traces, as a plain object; anything malformed is an empty store. */
export function readTraces(storage) {
  try {
    const raw = storage && storage.getItem(TRACE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

/** Merge new answers in, newest last, keeping the last TRACE_KEEP. */
export function mergeTraces(old, fresh, keep = TRACE_KEEP) {
  const out = { ...(old || {}) };
  for (const [id, value] of Object.entries(fresh || {})) {
    delete out[id];
    out[id] = value;
  }
  const ids = Object.keys(out);
  for (const id of ids.slice(0, Math.max(0, ids.length - keep))) delete out[id];
  return out;
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
 * shared context. Every input is optional: a page
 * with no night yet, or a build with no corpus, gets one muted line instead of
 * an exception.
 */
export function mount(body, ctx) {
  if (!body || !ctx) return;

  ensureStyles();

  const shipExp = !!(ctx.axes && ctx.axes.expTheory && ctx.axes.expTheory.ship);
  const tuneNow = () => ({ ...(ctx.prefs && ctx.prefs.sliders) });
  const sliderOf = (id) => {
    const v = Number(tuneNow()[id]);
    return Number.isFinite(v) ? v : SLIDERS[id].value;
  };

  body.innerHTML =
    '<div class="cave-ranking">' +
      '<div class="rk-tune" role="group" aria-label="Ranking sliders">' +
        TUNE.map((spec) => tuneRowHtml(spec, sliderOf(spec.id), spec.axis === 'expTheory' && !shipExp)).join('') +
        /* The panel's free cell: the last slot of the grid, under Theory ↔
           Experiment on a three-column panel. */
        '<div class="rk-tune-tools">' +
          '<button type="button" class="rk-tool rk-trace">Estimate AI trace</button>' +
          '<span class="rk-trace-note" role="status"></span>' +
        '</div>' +
      '</div>' +
      '<p class="rk-note" hidden></p>' +
      '<div class="rk-head" aria-hidden="true">' +
        '<span class="rk-head-pick">Pick</span>' +
        '<span class="rk-head-paper">Paper</span>' +
      '</div>' +
      '<div class="rk-list"></div>' +
      '<div class="rk-more-wrap" hidden>' +
        '<button type="button" class="rk-more">Show ' + PAGE + ' more</button>' +
        '<span class="rk-shown"></span>' +
      '</div>' +
      '<div class="button-bar rk-foot">' +
        '<button type="button" class="cave-continue-btn cave-primary rk-continue" disabled>' +
          'Story</button>' +
        '<button type="button" class="rk-tool rk-ris" disabled>RIS</button>' +
        '<button type="button" class="rk-tool rk-bib" disabled>BibTeX</button>' +
        '<span class="rk-picked"></span>' +
        '<p class="rk-hint" hidden>Tick Pick on papers, then tell their story or export them.</p>' +
      '</div>' +
    '</div>';

  const noteEl = body.querySelector('.rk-note');
  const listEl = body.querySelector('.rk-list');
  const moreWrap = body.querySelector('.rk-more-wrap');
  const moreBtn = body.querySelector('.rk-more');
  const shownEl = body.querySelector('.rk-shown');
  const continueBtn = body.querySelector('.rk-continue');
  const hintEl = body.querySelector('.rk-hint');
  const risBtn = body.querySelector('.rk-ris');
  const bibBtn = body.querySelector('.rk-bib');
  const pickedEl = body.querySelector('.rk-picked');
  const tuneEl = body.querySelector('.rk-tune');
  const traceBtn = body.querySelector('.rk-trace');
  const traceNote = body.querySelector('.rk-trace-note');

  const state = {
    night: null,        // the night this list was built from
    ranked: [],         // orderNight output, with the picked flags
    shown: PAGE,        // how many rows the reader has opened up to
    open: null,         // the one row whose detail is showing, by id
    pending: new Set(), // ids with a diamond request in flight
    diamonds: new Map(), // id -> diamond, this session (cached ones land here too)
    errors: new Map(),  // id -> the line under the action bar
    md: new Set(),      // ids whose .md download was offered
    traces: readTraces(ctx.storage), // bare id -> { p, why }, the AI-trace answers
    tracing: false,     // one AI-trace request at a time
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
      trace: state.traces[bareArxivId(item.id)],
    })).join('');

    moreWrap.hidden = total === 0;
    moreBtn.hidden = state.shown >= total;
    shownEl.textContent = shownLine(rows.length, total);
    /* No thread lookup while Discuss is greyed out (actionsHtml): nothing on
       the row would show the answer. */
  }

  function paintFoot() {
    const k = pickedIds().length;
    continueBtn.disabled = k === 0;
    risBtn.disabled = k === 0;
    bibBtn.disabled = k === 0;
    pickedEl.textContent = pickedLine(k);
    hintEl.hidden = k > 0;
  }

  /** The picked rows, in rank order — every pick, not only the rows on screen. */
  function pickedPapers() {
    const ids = new Set(pickedIds());
    return state.ranked.filter((item) => ids.has(item.id));
  }

  function downloadPicks(kind) {
    const papers = pickedPapers();
    if (!papers.length) return;
    if (kind === 'ris') {
      downloadText('arxave-picks.ris', toRis(papers), 'application/x-research-info-systems');
    } else {
      downloadText('arxave-picks.bib', toBibtex(papers), 'application/x-bibtex');
    }
  }

  function paint() {
    const note = missing();
    noteEl.textContent = note;
    noteEl.hidden = !note;
    paintList();
    paintFoot();
    syncTune();
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

  /** One id's thread, asked now: `{ url }`, null for none, undefined unknown. */
  async function askThread(id) {
    const bare = bareArxivId(id);
    const base = String(config().threadsUrl ||
      (config().functionsBase ? joinUrl(config().functionsBase, 'threads') : ''));
    if (!bare || !base) return undefined;
    try {
      const resp = await fetch(base, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(threadsRequest(repo(), [bare])),
      });
      if (!resp.ok) return undefined;
      const answer = parseThreads(await resp.json(), [bare]);
      if (!Object.prototype.hasOwnProperty.call(answer, bare)) return undefined;
      const value = answer[bare] === null ? null : { url: answer[bare] };
      threadCache.set(bare, value);
      return value;
    } catch (_) {
      return undefined;
    }
  }

  /**
   * Discuss: join the paper's thread, or start it. The tab is opened on the
   * click itself — a popup blocker refuses one opened after an await — and is
   * pointed where it belongs once the answers are in: the thread that exists,
   * or GitHub's new-discussion form with the post written (title, links,
   * abstract, and the diamond, mined first). The same post is then offered as
   * a `.md`. With the lookup down the form opens anyway: one reader starting a
   * second thread beats every reader being sent to a search.
   */
  async function discuss(paper) {
    const id = String(paper.id);
    if (!repoOk()) return;
    const win = typeof window !== 'undefined' && typeof window.open === 'function'
      ? window.open('', '_blank')
      : null;
    if (win) {
      try {
        win.opener = null;
        win.document.title = 'arXave — to the thread…';
        win.document.body.textContent = 'Looking for this paper\'s thread…';
      } catch (_) { /* a browser that will not let us write it still navigates */ }
    }

    const found = await askThread(id);
    let url = found && found.url;
    if (!url) {
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
      url = startThreadUrl(repo(), paper, {
        category: String(config().discussionsCategory || 'general') || 'general',
        diamond: diamond || null,
      });
    }
    if (url) {
      if (win) win.location.href = url;
      /* Blocked: the row keeps the URL as its link, so the reader's own click
         gets there. */
      else threadCache.set(bareArxivId(id), { url });
    } else if (win) {
      win.close();
    }
    paintList();
  }

  /** The thread's own Markdown, as a file. */
  function downloadMd(paper) {
    const bare = bareArxivId(paper.id) || 'paper';
    const diamond = diamondOf(paper.id) || null;
    downloadText(bare + '.md', threadBody(paper, { diamond }), 'text/markdown');
  }

  /* ── the sliders ─────────────────────────────────────────────────────── */

  /**
   * The panel follows `ctx.prefs` (a restored URL, another tab's reset) but
   * never moves a slider the reader is holding: the one with focus keeps its
   * own value, and its label says what it is.
   */
  function syncTune() {
    for (const input of tuneEl.querySelectorAll('[data-tune]')) {
      const id = input.dataset.tune;
      const value = sliderOf(id);
      const spec = TUNE.find((row) => row.id === id);
      if (typeof document === 'undefined' || document.activeElement !== input) {
        input.value = String(shownValue(spec, value));
      }
      const out = tuneEl.querySelector('[data-val="' + id + '"]');
      if (out && spec) out.textContent = spec.text(Number(input.value));
    }
    const unknown = rowsOnScreen().filter((item) => !state.traces[bareArxivId(item.id)]).length;
    traceBtn.disabled = state.tracing || !unknown || !state.ranked.length;
  }

  function sendTune(detail) {
    ctx.bus.dispatchEvent(new CustomEvent('tune', { detail }));
  }

  /* ── AI trace: one POST for the rows on screen not yet asked about ───── */

  async function estimateTraces() {
    if (state.tracing) return;
    const base = String(config().aitraceUrl ||
      (config().functionsBase ? joinUrl(config().functionsBase, 'aitrace') : ''));
    if (!base) {
      traceNote.textContent = 'AI trace is not configured on this build.';
      return;
    }
    const papers = rowsOnScreen()
      .filter((item) => item.abstract && !state.traces[bareArxivId(item.id)])
      .slice(0, TRACE_BATCH)
      .map((item) => ({ id: bareArxivId(item.id), title: item.title || '', abstract: item.abstract }));
    if (!papers.length) return;

    state.tracing = true;
    traceNote.textContent = 'Asking about ' + papers.length + (papers.length === 1 ? ' abstract…' : ' abstracts…');
    syncTune();
    let resp = null;
    let data = null;
    try {
      resp = await fetch(base, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ papers }),
      });
      try { data = await resp.json(); } catch (_) { data = null; }
    } catch (err) {
      traceNote.textContent = 'Could not reach AI trace: ' + ((err && err.message) || err);
    }
    state.tracing = false;
    if (resp && !resp.ok) {
      traceNote.textContent = resp.status === 429 && data && data.error === 'budget'
        ? BUDGET_NOTE
        : 'AI trace failed: ' + ((data && data.error) || ('HTTP ' + resp.status));
    } else if (data && data.scores && typeof data.scores === 'object') {
      state.traces = mergeTraces(state.traces, data.scores);
      try { ctx.storage && ctx.storage.setItem(TRACE_KEY, JSON.stringify(state.traces)); } catch (_) { /* full */ }
      traceNote.textContent = 'An LLM\'s guess, not a verdict — hover a grade for its reason.';
      refresh();
      return;
    }
    syncTune();
  }

  /* ── scoring ─────────────────────────────────────────────────────────── */

  /**
   * Score the night, from what is already in memory.
   *
   * `caveScore` wants candidates as `{ …stone, vec, topic, topic2 }`; the night
   * already carries all three arrays, so this is a zip, not a re-embed. Topic
   * match goes in at 0 — the gate off, every paper of a live topic in the list —
   * and comes back as `orderNight`'s weight. ML for quantum (a row of the
   * priorities tree, under Computing) hides papers after scoring, as v3 did.
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
    /* A field pack with no Theory ↔ Experiment axis (AI) scores every paper a
       neutral 0.5; that is no reading, so the row shows no Exp. grade. */
    if (!shipExp) scored = scored.map((item) => ({ ...item, theory: null }));

    /* The dislikes last, on scores `caveScore` has already normalised. */
    scored = applyLess(scored, lessVecs, { weight: LESS_WEIGHT });

    state.ranked = applyPicks(orderNight(scored, {
      match,
      solo: sliders.solo,
      ai: sliders.ai,
      traces: state.traces,
      ref: ctx.corpus.promiseRef,
    }), ctx.picks);
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
      else if (what === 'discuss') discuss(paper);
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
     edge and the continue button are updated in place. The box sits under the
     rank, in the list's Pick column. */
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
    syncTune();
  });

  tuneEl.addEventListener('input', (event) => {
    const input = event.target;
    const id = input && input.dataset && input.dataset.tune;
    if (!id) return;
    const spec = TUNE.find((row) => row.id === id);
    const out = tuneEl.querySelector('[data-val="' + id + '"]');
    if (out && spec) out.textContent = spec.text(Number(input.value));
    sendTune({ sliders: { [id]: shownValue(spec, input.value) } });
  });

  traceBtn.addEventListener('click', () => { estimateTraces(); });
  risBtn.addEventListener('click', () => downloadPicks('ris'));
  bibBtn.addEventListener('click', () => downloadPicks('bib'));

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
