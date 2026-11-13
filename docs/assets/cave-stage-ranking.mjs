/**
 * cave-stage-ranking — stage 6: tonight's papers, ranked live.
 *
 * ONE CALL TO `caveScore`, AND NOTHING REFETCHED. The night arrived with the
 * stage before this one (`ctx.night`: stones and their centred vectors, and a
 * topic per stone) and the priorities stage left `ctx.prefs` (the setting, the
 * three sliders, the box's touchstones). A re-rank is those two objects and one
 * pass of arithmetic — no network, no re-embed, no second dig, which is the same
 * promise v3's page made.
 *
 * TWO METERS, BECAUSE THE LIST HAS TWO QUESTIONS. *Fit* is where a paper sits
 * among tonight's survivors on topic closeness, read as a percentile so a bar of
 * 90 means "few papers tonight are closer to what you asked for". *Promise* is
 * `caveScore`'s own 0..1 blend of impact and novelty (moved by Surprise), which
 * is what the list is ordered by. They disagree often and that is the point:
 * a paper can be exactly on topic and prove nothing, or a wildcard worth the walk.
 *
 * THE ROW IS DIG'S LIST ROW. `renderAssayList` / `assayListDetailHtml` from
 * `filter.js` gave it the shape — rank, title, a caret, and a detail that opens
 * in place with the abstract — and this card adds the pick box, the two chips
 * and the meters. The abstract is already on the stone, so opening a row is a
 * re-render, never a fetch.
 *
 * PICKS LIVE ON `ctx.picks` (a Set of ids) and are dispatched as an array. They
 * are not stored on the ranked items, so a re-rank cannot drop one: a paper the
 * gate hides for a moment comes back still ticked when Topic match goes down
 * again. The bar counts the picks that are in tonight's ranking, which is what
 * "Act on picks" can actually act on.
 *
 * THE NUDGES ARE PART OF THE SAME PASS. "More like this" adds the paper's own
 * night vector to the touchstones (so it pulls its neighbours up, exactly as
 * the box's words do), and "less like this" is `applyLess` from
 * `cave-nudge.mjs`: the disliked papers leave the list and everything else pays
 * `0.25 × cosine` to its nearest dislike. Both are `ctx.prefs` reads, so a
 * nudge re-runs `caveScore` over the night already in memory — no refetch, no
 * re-embed, and the picked flags never move.
 *
 * THE PURE HALF IS EXPORTED — `meters`, `rowHtml`, `applyPicks`,
 * `rankingSummary`, `closestAnyway` — because every number in this card is
 * arithmetic a test can hold without a browser
 * (`scripts/cave-stage-ranking.test.mjs`). The page half is behind `mount`, and
 * the stylesheet is fetched from beside this module once, the way every stage
 * card carries its own CSS.
 *
 * NOTHING PASSES IS NOT AN EMPTY STAGE. A reader who touched no slider can still
 * meet a gate their night does not clear, so the card re-scores the same night
 * with Topic match at 0 and shows the closest five by fit under a muted "Closest
 * anyway" heading. Same rows, same meters; `ctx.ranked` stays empty, because the
 * Act stage acts on what passed, not on what was near.
 */
import { LESS_WEIGHT, applyLess, vecsFor } from './cave-nudge.mjs';
import { caveScore, defaultSetting } from './sieve-core.mjs';
import { cacheKeyText, escapeHtml, joinUrl, refineHtml, refineResultFrom } from './sieve-ui.mjs';
import { wagonLabel } from './cave-wagon-views.mjs';

/** How many rows the first paint shows, and what "Show more" adds. */
export const PAGE = 25;

/** How many near-misses the empty stage shows instead of nothing. */
export const CLOSEST = 5;

/** The mute line each missing input gets. */
export const NO_NIGHT = 'Dig first — tonight\'s papers are what get ranked.';
export const NO_CORPUS = 'No corpus on this build, so ranking waits.';
export const NO_TOPICS = 'topics.json did not load, so nothing can be ranked.';
export const NO_PREFS = 'Set your priorities first — Topic match and Surprise decide the order.';
export const NO_GATE = 'Nothing passes; lower Topic match.';

let styled = false;

/** The card's stylesheet, once, from beside this module (baseurl-safe). */
function ensureStyles() {
  if (styled || typeof document === 'undefined') return;
  styled = true;
  const href = new URL('./cave-ranking.css', import.meta.url).href;
  if (document.head.querySelector('link[href="' + href + '"]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  document.head.appendChild(link);
}

/* ── pure helpers ───────────────────────────────────────────────────────── */

const clamp01 = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
const asPct = (v) => Math.round(100 * clamp01(Number(v) / 100));

/**
 * Both meters for a ranked list, in its order: `[{ fitPct, promisePct }]`.
 *
 * Fit is the plain percentile — the share of tonight's ranked list whose fit is
 * at or below this paper's — so the closest paper reads 100% and the furthest
 * reads its own share. (`sieve-core`'s `percentRank` is the midrank variant the
 * impact/novelty scores are built on; it tops out at (n-1)/n, which is fine for
 * a score and misleading on a bar.) Promise is the score itself, clamped to
 * 0..1 and shown as a percent.
 *
 * ponytail: the percentile is an O(n²) scan over the ranked list — a few hundred
 * rows at most on a night, so it costs less than the re-render. If a night ever
 * runs to thousands of survivors, sort the fits once and binary-search.
 */
export function meters(ranked) {
  const list = Array.isArray(ranked) ? ranked : [];
  const n = list.length;
  const fits = list.map((item) => {
    const fit = Number(item && item.fit);
    return Number.isFinite(fit) ? fit : 0;
  });
  return list.map((item, i) => {
    let atOrBelow = 0;
    for (let j = 0; j < n; j += 1) if (fits[j] <= fits[i]) atOrBelow += 1;
    return {
      fitPct: n ? Math.round((100 * atOrBelow) / n) : 0,
      promisePct: Math.round(100 * clamp01(Number(item && item.score))),
    };
  });
}

/**
 * The closest `n` papers when the gate lets nothing through.
 *
 * `scoreFn(match)` is one `caveScore` pass for a Topic match value — the card
 * hands it the night already in memory, so this costs no refetch. Match 0 is
 * gate 0, so every paper is scored and the closest by fit can be picked out;
 * ordering is fit descending, id ascending, the same deterministic tie-break
 * `caveScore` uses. The input array is left alone (a caller's cache stays a
 * cache) and a missing scorer or a zero count is an empty list, never a throw:
 * the fallback must not be able to break a stage that was merely empty.
 */
export function closestAnyway(scoreFn, n = CLOSEST) {
  const take = Math.max(0, Math.round(Number(n) || 0));
  if (!take || typeof scoreFn !== 'function') return [];
  const ranked = scoreFn(0);
  const list = Array.isArray(ranked) ? ranked.slice() : [];
  const fitOf = (item) => {
    const fit = Number(item && item.fit);
    return Number.isFinite(fit) ? fit : -Infinity;
  };
  list.sort((a, b) => fitOf(b) - fitOf(a) ||
    ((a && a.id) < (b && b.id) ? -1 : (a && a.id) > (b && b.id) ? 1 : 0));
  return list.slice(0, take);
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

/** The sticky bar's one line: "<n> ranked · <k> picked". */
export function rankingSummary(n, k) {
  const ranked = Math.max(0, Math.round(Number(n) || 0));
  const picked = Math.max(0, Math.round(Number(k) || 0));
  return ranked + ' ranked · ' + picked + ' picked';
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

/** One labelled bar. `role="meter"` carries the value to a screen reader. */
function meterHtml(label, kind, value) {
  const pct = asPct(value);
  return '<span class="rk-meter rk-meter-' + kind + '">' +
    '<span class="rk-meter-label">' + label + '</span>' +
    '<span class="rk-track" role="meter" aria-label="' + label + '"' +
      ' aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '">' +
      '<span class="rk-track-fill" style="width:' + pct + '%"></span>' +
    '</span>' +
    '<span class="rk-meter-pct">' + pct + '%</span>' +
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

/** What opens in place under a row: the abstract, the landmarks, the refiner. */
function detailHtml(item) {
  const abstract = item.abstract
    ? '<p class="rk-abstract">' + escapeHtml(item.abstract) + '</p>'
    : '';
  return abstract + landmarksHtml(item) +
    '<div class="rk-actions">' +
      '<button type="button" class="rk-refine" data-refine="' + escapeHtml(item.id) + '">' +
        'Refine with AI</button>' +
      '<div class="rk-refine-out"></div>' +
    '</div>';
}

/**
 * One row, plus its (usually empty) detail, as markup.
 *
 * `parts` is what the page knows that the item does not: `rank`, `meters`
 * (`{ fitPct, promisePct }`), `topic` (leaf label), `wagon` (name), `picked`,
 * `open`. Titles, authors, links and landmarks all arrive from arXiv, so every
 * one of them is escaped — `rowHtml` is the one place that happens.
 */
export function rowHtml(item, parts = {}) {
  const data = item || {};
  const id = String(data.id ?? '');
  const link = data.link || data.abs_url || '';
  const title = escapeHtml(data.title || id);
  const heading = link
    ? '<a class="rk-link" href="' + escapeHtml(link) + '" target="_blank" rel="noopener">' + title + '</a>'
    : title;
  const authors = shortAuthors(data.authors);
  const topic = parts.topic
    ? '<span class="rk-chip rk-chip-topic">' + escapeHtml(parts.topic) + '</span>' : '';
  const wagon = parts.wagon
    ? '<span class="rk-chip rk-chip-wagon">' + escapeHtml(parts.wagon) + '</span>' : '';
  const met = parts.meters || {};
  const open = !!parts.open;
  const rank = Number(parts.rank) || 0;

  return '<div class="rk-row' + (open ? ' is-open' : '') + '" data-id="' + escapeHtml(id) + '">' +
      '<input type="checkbox" class="rk-pick" data-id="' + escapeHtml(id) + '"' +
        (parts.picked ? ' checked' : '') +
        ' aria-label="Pick ' + escapeHtml(data.title || id) + '">' +
      '<span class="rk-rank">' + rank + '</span>' +
      '<div class="rk-main">' +
        '<h3 class="rk-title">' + heading + '</h3>' +
        (authors ? '<p class="rk-authors">' + escapeHtml(authors) + '</p>' : '') +
        ((topic || wagon) ? '<p class="rk-chips">' + topic + wagon + '</p>' : '') +
      '</div>' +
      '<div class="rk-meters">' +
        meterHtml('Fit', 'fit', met.fitPct) +
        meterHtml('Promise', 'promise', met.promisePct) +
      '</div>' +
      '<button type="button" class="rk-toggle" aria-expanded="' + (open ? 'true' : 'false') +
        '" aria-label="' + (open ? 'Hide' : 'Show') + ' abstract">▸</button>' +
    '</div>' +
    '<div class="rk-detail"' + (open ? '' : ' hidden') + '>' +
      (open ? detailHtml(data) : '') +
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
 * Mount stage 6. `body` is the stage card's body element; `ctx` is the page's
 * shared context (see cave-v4-interfaces.md). Every input is optional: a page
 * with no night yet, or a build with no corpus, gets one muted line instead of
 * an exception.
 */
export function mount(body, ctx) {
  if (!body || !ctx) return;

  ensureStyles();

  body.innerHTML =
    '<div class="cave-ranking">' +
      '<div class="rk-bar" hidden>' +
        '<span class="rk-count" role="status"></span>' +
        '<button type="button" class="rk-act" disabled>Act on picks</button>' +
      '</div>' +
      '<p class="rk-note" hidden></p>' +
      '<div class="rk-list"></div>' +
      '<div class="rk-more-wrap" hidden>' +
        '<button type="button" class="rk-more">Show more</button>' +
      '</div>' +
    '</div>';

  const barEl = body.querySelector('.rk-bar');
  const countEl = body.querySelector('.rk-count');
  const actBtn = body.querySelector('.rk-act');
  const noteEl = body.querySelector('.rk-note');
  const listEl = body.querySelector('.rk-list');
  const moreWrap = body.querySelector('.rk-more-wrap');
  const moreBtn = body.querySelector('.rk-more');

  const state = {
    night: null,        // the night this list was built from
    ranked: [],         // last caveScore output, with the picked flags
    stats: [],          // meters() of that output, in the same order
    closest: [],        // the near-misses shown when the gate empties the list
    shown: PAGE,        // how many rows the reader has opened up to
    open: null,         // the one row whose detail is showing, by id
  };

  /** What is missing, in the order a reader meets it. '' when nothing is. */
  function missing() {
    if (!ctx.night) return NO_NIGHT;
    if (!ctx.corpus) return NO_CORPUS;
    if (!ctx.topics) return NO_TOPICS;
    if (!ctx.prefs) return NO_PREFS;
    return '';
  }

  /** Picks that are in tonight's ranking — what the bar counts. */
  function pickedIds() {
    const ids = new Set(state.ranked.map((item) => item.id));
    const out = [];
    if (ctx.picks && typeof ctx.picks.forEach === 'function') {
      ctx.picks.forEach((id) => { if (ids.has(id)) out.push(id); });
    }
    return out;
  }

  function paintBar() {
    const k = pickedIds().length;
    countEl.textContent = rankingSummary(state.ranked.length, k);
    actBtn.disabled = k === 0;
    barEl.hidden = state.ranked.length === 0;
  }

  function paintList() {
    const wagons = wagonByStone(ctx.night);
    /* The gate emptied the list: the closest papers anyway, under a muted
       heading, so a reader who touched no slider still meets five papers. Same
       row markup and meters as the ranked list — only the heading differs. */
    if (!state.ranked.length) {
      const stats = meters(state.closest);
      listEl.innerHTML = state.closest.length
        ? '<p class="rk-note rk-closest">Closest anyway</p>' + state.closest.map((item, i) => rowHtml(item, {
            rank: i + 1,
            meters: stats[i],
            topic: leafLabel(ctx.topics, item.topic),
            wagon: wagons.get(item.id) || '',
            picked: !!item.picked,
            open: state.open === item.id,
          })).join('')
        : '';
      moreWrap.hidden = true;
      return;
    }
    const shown = state.ranked.slice(0, state.shown);
    listEl.innerHTML = shown.map((item, i) => rowHtml(item, {
      rank: i + 1,
      meters: state.stats[i],
      topic: leafLabel(ctx.topics, item.topic),
      wagon: wagons.get(item.id) || '',
      picked: !!item.picked,
      open: state.open === item.id,
    })).join('');
    moreWrap.hidden = state.shown >= state.ranked.length;
  }

  function paint() {
    const note = missing() || (state.ranked.length ? '' : NO_GATE);
    noteEl.textContent = note;
    noteEl.hidden = !note;
    paintBar();
    /* paintList draws the nearest-five fallback when the ranked list is empty,
       so the stage is never a blank card (and the note above it is never the
       last word). */
    paintList();
  }

  /**
   * Score the night, from what is already in memory.
   *
   * `caveScore` wants candidates as `{ …stone, vec, topic, topic2 }`; the night
   * already carries all three arrays, so this is a zip, not a re-embed. The
   * ML-for-quantum chip hides papers after scoring, exactly as v3 did (the
   * survivors keep percentiles measured over the whole night).
   */
  function refresh() {
    const absent = missing();
    if (absent) {
      state.ranked = [];
      state.stats = [];
      state.closest = [];
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

    /* The nudges, resolved against tonight. A "more like" paper's vector is a
       touchstone like the box's words; a "less like" paper's is a penalty. An
       id from an older night is simply absent from both lists. */
    const moreVecs = vecsFor(prefs.more, night);
    const lessVecs = vecsFor(prefs.less, night);

    /* One scoring pass, for whatever sliders it is given — the fallback below
       needs the same night with Topic match at 0 and nothing else changed. */
    const scoreAt = (sliders) => caveScore({
      corpus: ctx.corpus,
      topics: ctx.topics,
      axes: ctx.axes,
      setting: prefs.setting || defaultSetting(ctx.topics),
      sliders,
      touchstones: [...(Array.isArray(prefs.touchstones) ? prefs.touchstones : []), ...moreVecs],
      candidates,
    });

    let ranked;
    try {
      ranked = scoreAt(prefs.sliders || {});
    } catch (err) {
      state.ranked = [];
      state.stats = [];
      state.closest = [];
      ctx.ranked = [];
      paintBar();
      noteEl.textContent = 'Could not rank tonight\'s papers: ' + ((err && err.message) || err);
      noteEl.hidden = false;
      listEl.innerHTML = '';
      moreWrap.hidden = true;
      return;
    }

    if (prefs.ml4q) ranked = ranked.filter((item) => item.ml4q >= 0.5);

    /* The dislikes last, on scores `caveScore` has already normalised: the
       paper itself leaves, its neighbours sink by a quarter of their cosine,
       and the list is ordered again. No refetch — the vectors are in memory. */
    ranked = applyLess(ranked, lessVecs, { weight: LESS_WEIGHT });

    state.ranked = applyPicks(ranked, ctx.picks);
    state.stats = meters(ranked);

    /* The empty gate gets a second, cheaper answer: the same night with Match at
       0, nearest five by fit. Only paid for on the night where nothing passed,
       and it never feeds `ctx.ranked` — Act acts on what passed. */
    state.closest = [];
    if (!ranked.length) {
      try {
        state.closest = applyPicks(
          closestAnyway((match) => scoreAt({ ...(prefs.sliders || {}), match })),
          ctx.picks,
        );
      } catch (_) {
        /* The main run already worked; a blank fallback beats a broken stage. */
      }
    }

    ctx.ranked = ranked;
    ctx.bus.dispatchEvent(new CustomEvent('ranked', { detail: ranked }));
    paint();
  }

  /* ── Refine with AI ──────────────────────────────────────────────────── */

  /**
   * One card, one call — v3's refine, with the URL from `functionsBase` and the
   * answer drawn by `refineHtml`. There is no BYO-key field on this page, so the
   * deployment's own key and its daily budget are what answer.
   */
  async function refine(button) {
    const id = button.getAttribute('data-refine');
    /* A "Closest anyway" row opens the same detail, so its refiner looks in the
       fallback list too. */
    const item = state.ranked.find((r) => r.id === id) || state.closest.find((r) => r.id === id);
    if (!item || button.disabled) return;
    const out = button.parentElement.querySelector('.rk-refine-out');
    button.disabled = true;
    if (out) out.innerHTML = '<p class="rk-hint">Asking…</p>';

    const payload = {
      paper: { title: item.title, abstract: item.abstract || '' },
      neighbours: (item.landmarks || []).slice(0, 5).map((l) => ({ title: l.title, pct: l.pct })),
      touchstones: [cacheKeyText((ctx.prefs && ctx.prefs.text) || '')].filter(Boolean),
    };

    try {
      const resp = await fetch(joinUrl(ctx.config.functionsBase, 'refine'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      let data = null;
      try { data = await resp.json(); } catch (_) { /* a refusal may carry no body */ }
      if (out) out.innerHTML = refineHtml(refineResultFrom(resp.status, data));
    } catch (err) {
      if (out) {
        out.innerHTML = refineHtml({ error: 'Could not reach the refiner: ' + ((err && err.message) || err) });
      }
    } finally {
      button.disabled = false;
    }
  }

  /* ── wiring ──────────────────────────────────────────────────────────── */

  /* Delegated: the list is re-rendered on every toggle, and one listener on the
     container outlives all of it. A link, the pick box or the refiner is its
     own target; anything else on the row opens the detail, the way Dig's list
     does. */
  listEl.addEventListener('click', (event) => {
    const target = event.target;
    if (!target || !target.closest) return;
    const refineBtn = target.closest('.rk-refine');
    if (refineBtn) {
      refine(refineBtn);
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
     right state, and a re-render would take the focus with it. */
  listEl.addEventListener('change', (event) => {
    const box = event.target;
    if (!box || !box.classList || !box.classList.contains('rk-pick')) return;
    if (!ctx.picks || typeof ctx.picks.add !== 'function') return;
    const id = box.getAttribute('data-id');
    if (!id) return;
    if (box.checked) ctx.picks.add(id);
    else ctx.picks.delete(id);
    paintBar();
    ctx.bus.dispatchEvent(new CustomEvent('picks', { detail: [...ctx.picks] }));
  });

  moreBtn.addEventListener('click', () => {
    state.shown += PAGE;
    paintList();
  });

  actBtn.addEventListener('click', () => {
    const k = pickedIds().length;
    if (!k || !ctx.flow || ctx.flow.status('ranking') === 'locked') return;
    ctx.flow.complete('ranking', k + ' picked');
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

  refresh();
}
