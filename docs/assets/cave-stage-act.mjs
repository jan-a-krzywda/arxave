/**
 * cave-stage-act — stage 7: what you do with a paper you decided to keep.
 *
 * ONE CARD PER PICK, AND FOUR THINGS TO DO WITH IT. Tonight's ranking left the
 * picks in `ctx.picks` (a Set of ids) and the ranked list in `ctx.ranked`; this
 * card turns that intersection back into papers, in rank order, and puts the
 * exits on each one: extract the diamond (the LLM's two-sentence card), take it
 * to Zotero (`.ris` / `.bib` / BibTeX on the clipboard), find or start a GitHub
 * Discussions thread, and nudge the ranking ("More like this" / "Less like
 * this"). Unpick is the way back out.
 *
 * THE DIAMOND IS CACHED, NOT REFETCHED. One call per paper is one call against
 * the shared daily budget (`diamond` funds itself from `refine`'s meter), so a
 * paper already mined is read out of `ctx.storage` under
 * `arxave-cave-diamond:<arXiv id>` and drawn at once, with a small "re-extract"
 * link when the reader wants a second opinion. The stored value is exactly the
 * endpoint's JSON ({summary, takeaways, questions, readIf}). Storage throws in
 * private mode and holds whatever an older build left there, so every read and
 * write here is wrapped and a bad entry is simply a cache miss.
 *
 * 429 {"error":"budget"} IS NOT AN ERROR THE READER CAN FIX. The shared daily
 * budget is spent; the card says so in those words rather than "HTTP 429", and
 * the bulk run stops there instead of firing nine more doomed calls.
 *
 * THE BULK BAR IS THE PAGE'S, NOT THE CARD'S. It floats at the bottom of the
 * viewport whenever there are picks and the ranking or act stage is on screen
 * (or folded open), so a reader who scrolls back up to the list can still carry
 * the picks forward without opening this card again. It lives on `document.body`
 * — a fixed child of a folded `.cave-stage-body` would be `display:none` with
 * its parent — and it is moved there once, after mount.
 *
 * NUDGES ARE DISPATCHED HERE (`CustomEvent 'nudge'`, {id, sign}) and pressed
 * state is kept in `ctx.nudges` (Map id → ±1), because re-ranking belongs to the
 * card that owns the score, not to this one. Pressing the active direction
 * clears it and says so with sign 0.
 *
 * Published helpers (used by `scripts/cave-stage-act.test.mjs`):
 * `diamondHtml`, `pickedPapers`, `bulkBarText`, `diamondRequest`, `actionsFor`,
 * plus `cacheKey` / `readCachedDiamond` for the cache contract.
 */
import { downloadText, toBibtex, toRis } from './cave-export.mjs';
import { newThreadUrl, parseRepo, searchUrl } from './cave-thread.mjs';
import { bareArxivId, escapeHtml, joinUrl } from './sieve-ui.mjs';

/** The endpoint's abstract cap (`MAX_ABSTRACT` in supabase/functions/diamond). */
export const ABSTRACT_MAX = 3000;

/** Where a mined diamond is kept, per paper, in `ctx.storage`. */
export const CACHE_PREFIX = 'arxave-cave-diamond:';

/** The one plain answer to a spent budget. */
export const BUDGET_NOTE = 'The shared daily AI budget is spent — try again tomorrow.';

/** What the card says before anything is picked. */
export const NO_PICKS = 'Pick a paper in the ranking first — the ones you keep come here.';

/** What replaces the thread links on a build with no Discussions repo. */
export const NO_REPO = 'Threads are off on this build (no Discussions repo is set).';

let styled = false;

/** The card's stylesheet, once, from beside this module (baseurl-safe). */
function ensureStyles() {
  if (styled || typeof document === 'undefined') return;
  styled = true;
  const href = new URL('./cave-act.css', import.meta.url).href;
  if (document.head && typeof document.head.querySelector === 'function'
    && document.head.querySelector('link[href="' + href + '"]')) return;
  if (typeof document.createElement !== 'function') return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  if (document.head && typeof document.head.appendChild === 'function') document.head.appendChild(link);
}

/* ── small shared bits ──────────────────────────────────────────────────── */

const oneLine = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const listOf = (value) => (Array.isArray(value) ? value : []);
const textList = (value) => listOf(value).map(oneLine).filter(Boolean);

/** A paper's id, bare and comparable (the Set's keys are strings). */
const idOf = (paper) => String((paper && paper.id) != null ? paper.id : '');


/* ── pure helpers ───────────────────────────────────────────────────────── */

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
function writeCachedDiamond(storage, id, diamond) {
  if (!storage || typeof storage.setItem !== 'function' || !diamond) return;
  try {
    storage.setItem(cacheKey(id), JSON.stringify(diamond));
  } catch (_) {
    /* the panel still shows what was just mined */
  }
}

/**
 * The panel for an extracted diamond: the summary, then the three sections the
 * endpoint promises — "Take home", "Open questions", "Read this if…". Every
 * string is a model's answer, so every string is escaped. A part that is
 * missing is left out rather than rendered as an empty heading.
 */
export function diamondHtml(diamond) {
  if (!diamond || typeof diamond !== 'object' || Array.isArray(diamond)) return '';
  const summary = oneLine(diamond.summary);
  const takeaways = textList(diamond.takeaways);
  const questions = textList(diamond.questions);
  const readIf = oneLine(diamond.readIf);

  const block = (label, items) => (items.length
    ? '<h4 class="ac-diamond-label">' + label + '</h4>' +
      '<ul class="ac-diamond-list">' +
        items.map((item) => '<li>' + escapeHtml(item) + '</li>').join('') +
      '</ul>'
    : '');

  return '<div class="ac-diamond">' +
    (summary ? '<p class="ac-diamond-summary">' + escapeHtml(summary) + '</p>' : '') +
    block('Take home', takeaways) +
    block('Open questions', questions) +
    (readIf
      ? '<p class="ac-readif"><span class="ac-diamond-label">Read this if…</span> ' +
        escapeHtml(readIf) + '</p>'
      : '') +
  '</div>';
}

/**
 * The picked papers that are in tonight's ranking, in rank order.
 *
 * `picks` may be the Set the page keeps or an array (a test, a restored
 * snapshot); a pick that is not in `ranked` is not actionable here and is left
 * out, exactly as the ranking stage's own count does.
 */
export function pickedPapers(ranked, picks) {
  const has = picks && typeof picks.has === 'function'
    ? (id) => picks.has(id)
    : Array.isArray(picks)
      ? (id) => picks.includes(id)
      : () => false;
  return listOf(ranked).filter((paper) => paper && paper.id != null && has(paper.id));
}

/** The act stage's one line, and the bar's count: "<n> picked · <d> diamonds". */
export function bulkBarText(n, d) {
  const picked = Math.max(0, Math.round(Number(n) || 0));
  const diamonds = Math.max(0, Math.round(Number(d) || 0));
  return picked + ' picked · ' + diamonds + ' diamonds';
}

/**
 * The request body for `POST /diamond`. The endpoint validates and clips too,
 * but a 3 000-character abstract cap here keeps a runaway abstract off the wire
 * (and the same cap is what its tests hold).
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

/**
 * The action ids a card shows, in reading order. Discuss is the one that can be
 * absent: with no parseable repo there is nowhere to send the reader.
 */
export function actionsFor(paper, { repoOk = true } = {}) {
  const ids = ['diamond', 'zotero'];
  if (repoOk) ids.push('discuss');
  ids.push('more', 'less', 'unpick');
  return ids;
}


/* ── markup ─────────────────────────────────────────────────────────────── */

const actionButton = (act, id, label, extra = '') =>
  '<button type="button" class="ac-btn' + (extra ? ' ' + extra : '') + '" data-act="' + act +
    '" data-id="' + escapeHtml(id) + '">' + escapeHtml(label) + '</button>';

function zoteroAction(paper) {
  const id = idOf(paper);
  return '<details class="ac-zmenu">' +
    '<summary class="ac-btn ac-summary">Zotero</summary>' +
    '<div class="ac-menu">' +
      '<button type="button" data-act="ris" data-id="' + escapeHtml(id) + '">Download .ris (Zotero)</button>' +
      '<button type="button" data-act="bib" data-id="' + escapeHtml(id) + '">Download .bib</button>' +
      '<button type="button" data-act="copy" data-id="' + escapeHtml(id) + '">Copy BibTeX</button>' +
    '</div>' +
  '</details>';
}

function discussAction(paper, info) {
  if (!info.repoOk) return '<span class="ac-discuss-note">' + escapeHtml(NO_REPO) + '</span>';
  const search = searchUrl(info.repo, paper);
  const start = newThreadUrl(info.repo, paper, {
    category: info.category,
    diamond: info.diamond || null,
  });
  return '<span class="ac-discuss">' +
    (search
      ? '<a class="ac-link" href="' + escapeHtml(search) + '" target="_blank" rel="noopener">Find a thread</a>'
      : '') +
    (start
      ? '<a class="ac-link" href="' + escapeHtml(start) + '" target="_blank" rel="noopener">Start a thread</a>'
      : '') +
  '</span>';
}

/** One action id → its markup. `diamond` is skipped once a panel exists. */
function actionHtml(act, paper, info) {
  const id = idOf(paper);
  switch (act) {
    case 'diamond':
      if (info.diamond || info.pending) return '';
      return '<button type="button" class="ac-btn ac-extract" data-act="diamond" data-id="' +
        escapeHtml(id) + '">Extract the diamond</button>';
    case 'zotero':
      return zoteroAction(paper);
    case 'discuss':
      return discussAction(paper, info);
    case 'more':
      return '<button type="button" class="ac-btn ac-nudge' + (info.nudge === 1 ? ' is-on' : '') +
        '" data-act="more" data-id="' + escapeHtml(id) + '" aria-pressed="' +
        (info.nudge === 1 ? 'true' : 'false') + '">More like this</button>';
    case 'less':
      return '<button type="button" class="ac-btn ac-nudge' + (info.nudge === -1 ? ' is-on' : '') +
        '" data-act="less" data-id="' + escapeHtml(id) + '" aria-pressed="' +
        (info.nudge === -1 ? 'true' : 'false') + '">Less like this</button>';
    case 'unpick':
      return actionButton('unpick', id, 'Unpick');
    default:
      return '';
  }
}

/**
 * One card: title and authors, the action row, and whatever the diamond has to
 * say. `info` is everything the page knows that the ranked item does not:
 * `{ diamond, pending, error, nudge, repoOk, repo, category }`.
 */
export function cardHtml(paper, info = {}) {
  const id = idOf(paper);
  const bare = bareArxivId(id);
  const title = oneLine(paper && paper.title) || bare || 'Untitled';
  const link = oneLine(paper && (paper.link || paper.abs_url))
    || (bare ? 'https://arxiv.org/abs/' + bare : '');
  const heading = link
    ? '<a class="ac-title-link" href="' + escapeHtml(link) +
      '" target="_blank" rel="noopener">' + escapeHtml(title) + '</a>'
    : escapeHtml(title);
  const authors = Array.isArray(paper && paper.authors)
    ? textList(paper.authors).join(', ')
    : oneLine(paper && paper.authors);

  const actions = actionsFor(paper, { repoOk: info.repoOk !== false })
    .map((act) => actionHtml(act, paper, info))
    .filter(Boolean)
    .join('');

  let panel = '';
  if (info.error) {
    panel += '<p class="ac-status ac-status-error" role="status">' + escapeHtml(info.error) + '</p>';
  }
  if (info.diamond) {
    panel += '<div class="ac-panel">' + diamondHtml(info.diamond) +
      (info.pending
        ? '<span class="ac-spark" aria-hidden="true"></span>'
        : '<button type="button" class="ac-retext" data-act="diamond" data-id="' +
          escapeHtml(id) + '">re-extract</button>') +
      '</div>';
  } else if (info.pending) {
    panel += '<div class="ac-panel is-loading">' +
      '<span class="ac-spark" aria-hidden="true"></span>' +
      '<span class="ac-loading-text">Mining the diamond…</span>' +
    '</div>';
  }

  return '<article class="ac-card" data-id="' + escapeHtml(id) + '" role="listitem">' +
    '<div class="ac-head">' +
      '<h3 class="ac-title">' + heading + '</h3>' +
      (authors ? '<p class="ac-authors">' + escapeHtml(authors) + '</p>' : '') +
    '</div>' +
    '<div class="ac-actions">' + actions + '</div>' +
    panel +
  '</article>';
}

/* ── the stage ──────────────────────────────────────────────────────────── */

/**
 * Mount stage 7. `body` is the stage card's body, `ctx` the page's shared
 * context. Every input is optional: no night, no ranking, no picks gets one
 * muted line, and a pick that vanishes from the list simply stops having a
 * card.
 */
export function mount(body, ctx) {
  if (!body || !ctx) return;

  ensureStyles();

  body.innerHTML =
    '<div class="cave-act">' +
      '<p class="ac-note ac-empty">' + escapeHtml(NO_PICKS) + '</p>' +
      '<div class="ac-cards" role="list"></div>' +
      '<div class="button-bar ac-foot">' +
        '<button type="button" class="cave-continue-btn cave-primary ac-continue" disabled>' +
          'Continue to the story</button>' +
      '</div>' +
    '</div>' +
    '<div class="ac-bulk" role="region" aria-label="Picked papers" hidden>' +
      '<span class="ac-bulk-count">0 picked</span>' +
      '<button type="button" class="ac-bulk-btn" data-bulk="diamonds">Diamonds</button>' +
      '<details class="ac-bmenu">' +
        '<summary class="ac-bulk-btn">Zotero</summary>' +
        '<div class="ac-menu ac-menu-up">' +
          '<button type="button" data-bulk="ris">Download .ris (all picks)</button>' +
          '<button type="button" data-bulk="bib">Download .bib (all picks)</button>' +
        '</div>' +
      '</details>' +
      '<details class="ac-bmenu ac-bmenu-discuss">' +
        '<summary class="ac-bulk-btn">Discuss</summary>' +
        '<div class="ac-menu ac-menu-up ac-discuss-list"></div>' +
      '</details>' +
      '<button type="button" class="ac-bulk-btn ac-bulk-story" data-bulk="story">Story →</button>' +
      '<span class="ac-bulk-status" role="status"></span>' +
    '</div>';

  const emptyEl = body.querySelector('.ac-empty');
  const listEl = body.querySelector('.ac-cards');
  const continueBtn = body.querySelector('.ac-continue');
  const barEl = body.querySelector('.ac-bulk');
  const barCount = barEl.querySelector('.ac-bulk-count');
  const barDiamonds = barEl.querySelector('[data-bulk="diamonds"]');
  const barStatus = barEl.querySelector('.ac-bulk-status');
  const discussWrap = barEl.querySelector('.ac-bmenu-discuss');
  const discussList = barEl.querySelector('.ac-discuss-list');

  const state = {
    diamonds: new Map(),   // id -> diamond, this session (cached entries land here too)
    pending: new Set(),    // ids with a request in flight
    errors: new Map(),     // id -> the line under the actions
    bulk: false,           // one bulk diamond run at a time
    seen: { act: true, ranking: true },  // on-screen state, narrowed by the observer
  };

  /* ── the page's knobs, read defensively ─────────────────────────────── */

  const config = () => (ctx.config && typeof ctx.config === 'object' ? ctx.config : {});
  const repo = () => String(config().discussionsRepo || '');
  const repoOk = () => !!parseRepo(repo());
  const category = () => String(config().discussionsCategory || 'general') || 'general';
  const pickedNow = () => pickedPapers(ctx.ranked, ctx.picks);

  function nudges() {
    if (!(ctx.nudges instanceof Map)) ctx.nudges = new Map();
    return ctx.nudges;
  }

  function expanded(id) {
    return !!(ctx.flow && typeof ctx.flow.expanded === 'function' && ctx.flow.expanded(id));
  }

  /** A diamond from this session or from storage; null when never mined. */
  function diamondOf(id) {
    const key = String(id);
    if (state.diamonds.has(key)) return state.diamonds.get(key);
    const cached = readCachedDiamond(ctx.storage, key);
    if (cached) state.diamonds.set(key, cached);
    return cached;
  }

  function diamondCount(papers) {
    return papers.filter((paper) => !!diamondOf(paper.id)).length;
  }

  function setStatus(text) {
    if (barStatus) barStatus.textContent = text || '';
  }
  /* ── painting ───────────────────────────────────────────────────────── */

  function paintBar(papers) {
    const n = papers.length;
    const onScreen = state.seen.act || state.seen.ranking || expanded('act') || expanded('ranking');
    barCount.textContent = n + ' picked';
    barEl.hidden = !(n > 0 && onScreen);
    continueBtn.disabled = n === 0;

    if (discussWrap) discussWrap.hidden = !repoOk();
    if (discussList) {
      discussList.innerHTML = repoOk()
        ? papers.map((paper) => {
          const bare = bareArxivId(paper.id);
          return '<a href="' + escapeHtml(searchUrl(repo(), paper)) +
            '" target="_blank" rel="noopener">Find a thread — ' + escapeHtml(bare) + '</a>' +
            '<a href="' + escapeHtml(newThreadUrl(repo(), paper, {
              category: category(),
              diamond: diamondOf(paper.id) || null,
            })) + '" target="_blank" rel="noopener">Start a thread — ' + escapeHtml(bare) + '</a>';
        }).join('')
        : '<span class="ac-discuss-note">' + escapeHtml(NO_REPO) + '</span>';
    }
  }

  function render() {
    const papers = pickedNow();
    const ok = repoOk();
    emptyEl.hidden = papers.length > 0;
    listEl.innerHTML = papers.map((paper) => cardHtml(paper, {
      diamond: diamondOf(paper.id),
      pending: state.pending.has(String(paper.id)),
      error: state.errors.get(String(paper.id)) || '',
      nudge: nudges().get(String(paper.id)) || 0,
      repoOk: ok,
      repo: repo(),
      category: category(),
    })).join('');
    paintBar(papers);
  }

  /* ── actions on one paper ───────────────────────────────────────────── */

  /** The paper with its diamond, in the shape `cave-export.mjs` reads. */
  function exportPaper(paper) {
    const diamond = diamondOf(paper.id);
    return diamond ? { ...paper, diamond } : { ...paper };
  }

  function downloadOne(kind, paper) {
    const bare = bareArxivId(paper.id) || 'paper';
    const papers = [exportPaper(paper)];
    if (kind === 'ris') {
      downloadText('arxave-' + bare + '.ris', toRis(papers), 'application/x-research-info-systems');
    } else {
      downloadText('arxave-' + bare + '.bib', toBibtex(papers), 'application/x-bibtex');
    }
  }

  function downloadAll(kind) {
    const papers = pickedNow().map(exportPaper);
    if (!papers.length) return;
    if (kind === 'ris') {
      downloadText('arxave-picks.ris', toRis(papers), 'application/x-research-info-systems');
    } else {
      downloadText('arxave-picks.bib', toBibtex(papers), 'application/x-bibtex');
    }
  }

  /** Clipboard where it exists, a download where it does not. */
  function copyBibtex(paper, button) {
    const text = toBibtex([exportPaper(paper)]);
    const nav = typeof navigator !== 'undefined' ? navigator : null;
    try {
      if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
        nav.clipboard.writeText(text);
        if (button) {
          const was = button.textContent;
          button.textContent = 'Copied';
          setTimeout(() => { button.textContent = was; }, 1200);
        }
        return;
      }
    } catch (_) {
      /* fall through to the file */
    }
    downloadText('arxave-' + (bareArxivId(paper.id) || 'paper') + '.bib', text, 'application/x-bibtex');
  }

  /**
   * A pressed toggle is one direction per paper; pressing the same direction
   * again clears it (sign 0), pressing the other switches it.
   */
  function nudge(paper, sign) {
    const id = String(paper.id);
    const map = nudges();
    const next = map.get(id) === sign ? 0 : sign;
    if (next) map.set(id, next);
    else map.delete(id);
    if (ctx.bus && typeof ctx.bus.dispatchEvent === 'function') {
      ctx.bus.dispatchEvent(new CustomEvent('nudge', { detail: { id, sign: next } }));
    }
    render();
  }

  function unpick(id) {
    if (ctx.picks && typeof ctx.picks.delete === 'function') ctx.picks.delete(id);
    if (ctx.bus && typeof ctx.bus.dispatchEvent === 'function') {
      ctx.bus.dispatchEvent(new CustomEvent('picks', { detail: [...(ctx.picks || [])] }));
    }
    render();
  }
  /**
   * One diamond, from the cache or the endpoint. Resolves to
   * `{ ok, budget }` so the bulk run knows whether to stop: only a 429 stops it.
   */
  async function extract(paper) {
    const id = String(paper.id);
    if (state.pending.has(id)) return { ok: false, budget: false };

    state.pending.add(id);
    state.errors.delete(id);
    render();

    const base = String(config().functionsBase || '');
    if (!base) {
      state.pending.delete(id);
      state.errors.set(id, 'Diamonds are not configured on this build.');
      render();
      return { ok: false, budget: false };
    }

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
      state.errors.set(id, 'Could not reach the diamond: ' + ((err && err.message) || err));
      render();
      return { ok: false, budget: false };
    }

    state.pending.delete(id);

    if (!resp || !resp.ok) {
      const budget = !!resp && resp.status === 429 && data && data.error === 'budget';
      state.errors.set(id, budget
        ? BUDGET_NOTE
        : 'The diamond failed: ' + ((data && data.error) || ('HTTP ' + (resp ? resp.status : '?'))));
      render();
      return { ok: false, budget };
    }

    state.diamonds.set(id, data);
    state.errors.delete(id);
    writeCachedDiamond(ctx.storage, id, data);
    render();
    return { ok: true, budget: false };
  }

  /** Diamonds for every pick without one, one call at a time, stopping on 429. */
  async function bulkDiamonds() {
    if (state.bulk) return;
    const papers = pickedNow().filter((paper) => !diamondOf(paper.id));
    if (!papers.length) {
      setStatus('Every picked paper already has a diamond.');
      return;
    }

    state.bulk = true;
    barDiamonds.disabled = true;
    const total = papers.length;
    let done = 0;
    barDiamonds.textContent = 'Diamonds 0 / ' + total;

    for (const paper of papers) {
      const result = await extract(paper);
      if (result.budget) {
        barDiamonds.textContent = 'Diamonds';
        barDiamonds.disabled = false;
        state.bulk = false;
        setStatus(BUDGET_NOTE);
        return;
      }
      done += 1;
      barDiamonds.textContent = 'Diamonds ' + done + ' / ' + total;
    }

    barDiamonds.textContent = 'Diamonds';
    barDiamonds.disabled = false;
    state.bulk = false;
    setStatus(done + ' of ' + total + (done === 1 ? ' diamond mined.' : ' diamonds mined.'));
  }

  /**
   * Carry the picks to the story. Completing 'act' is what opens stage 8 and
   * records the night's one line; a locked act (no ranking yet) is left alone
   * rather than completing a stage the machine will not accept.
   */
  function toStory() {
    const papers = pickedNow();
    if (!papers.length) return;
    const flow = ctx.flow;
    if (flow && typeof flow.status === 'function' && flow.status('act') !== 'done'
      && flow.status('act') !== 'locked') {
      flow.complete('act', bulkBarText(papers.length, diamondCount(papers)));
    }
    const target = typeof document !== 'undefined' && typeof document.getElementById === 'function'
      ? document.getElementById('stage-story')
      : null;
    if (target && typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }
  /* ── wiring ─────────────────────────────────────────────────────────── */

  listEl.addEventListener('click', (event) => {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    const button = target.closest('[data-act]');
    if (!button) return;
    const act = button.getAttribute('data-act');
    const id = button.getAttribute('data-id');
    const paper = pickedNow().find((item) => String(item.id) === id);
    if (!paper) return;
    if (act === 'diamond') extract(paper);
    else if (act === 'ris') downloadOne('ris', paper);
    else if (act === 'bib') downloadOne('bib', paper);
    else if (act === 'copy') copyBibtex(paper, button);
    else if (act === 'more') nudge(paper, 1);
    else if (act === 'less') nudge(paper, -1);
    else if (act === 'unpick') unpick(id);
  });

  barEl.addEventListener('click', (event) => {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    const button = target.closest('[data-bulk]');
    if (!button) return;
    const what = button.getAttribute('data-bulk');
    if (what === 'diamonds') bulkDiamonds();
    else if (what === 'ris') downloadAll('ris');
    else if (what === 'bib') downloadAll('bib');
    else if (what === 'story') toStory();
  });

  continueBtn.addEventListener('click', toStory);

  if (ctx.bus && typeof ctx.bus.addEventListener === 'function') {
    ctx.bus.addEventListener('picks', render);
    ctx.bus.addEventListener('ranked', render);
  }
  if (ctx.flow && typeof ctx.flow.onChange === 'function') ctx.flow.onChange(render);

  /* The bar must outlive the card fold: a fixed child of a closed
     `.cave-stage-body` is `display:none` with its parent. */
  if (typeof document !== 'undefined' && document.body
    && typeof document.body.appendChild === 'function' && document.body !== body) {
    document.body.appendChild(barEl);
  }

  /* "Visible on screen" narrows the bar to the two stages that can make a
     pick. Without an observer (a test, an old browser) the flow's folds are
     the whole answer and `seen` starts open, so the bar still behaves. */
  const canObserve = typeof IntersectionObserver === 'function' && typeof document !== 'undefined'
    && typeof document.getElementById === 'function';
  if (!canObserve) {
    state.seen = { act: false, ranking: false };
  } else {
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const el = entry.target;
        const id = el && typeof el.getAttribute === 'function' ? el.getAttribute('data-stage') : '';
        if (id === 'act' || id === 'ranking') state.seen[id] = !!entry.isIntersecting;
      }
      render();
    }, { threshold: 0.01 });
    for (const id of ['act', 'ranking']) {
      const el = document.getElementById('stage-' + id);
      if (el) observer.observe(el);
    }
  }

  render();
}
