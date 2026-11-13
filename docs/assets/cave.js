/**
 * cave — one page where Dig and Sieve meet: a text box, three sliders, the
 * topic tree, and tonight's arXiv ranked.
 *
 * WHAT IS REUSED AND WHAT IS NEW. The candidate fetch, the embed and the shared
 * cache are `sieve-ui`'s, unchanged — same relay pacing, same "typed words never
 * enter the shared cache" split. The ranking is `sieve-core`'s `caveScore`. What
 * is new here is the page: the tree, the chips, the phone sheet, and the four
 * pure functions below that turn a setting into a string, a chip row and a set
 * of counts.
 *
 * WHY THE PURE HALF IS EXPORTED. `scripts/cave-page.test.mjs` imports this file
 * under `node --test`, where there is no `document`. Everything above
 * `startPage()` is DOM-free and runs anywhere; the page itself is behind one
 * `typeof document` guard, and a browser is the only thing that ever calls it.
 *
 * NOTHING IS REFETCHED WHEN A CONTROL MOVES. Tonight's candidates and their
 * centred vectors are held in memory; every slider, select and chip press
 * re-runs `caveScore` over them 80 ms after the last event. Only the text box
 * can cost a network call, and only when its words actually changed — and it
 * gets a longer pause than the sliders, because a paid embed per keystroke is
 * not "live re-ranking", it is a bill.
 */
import {
  caveScore, centreUnit, defaultSetting, loadAxes, loadCorpus, loadTopics,
} from './sieve-core.mjs';
import {
  CorpusMissing, cacheKeyText, createRelay, embedCandidates, embedTexts, escapeHtml,
  fetchAnnouncement, joinUrl, loadCorpusFrom, paperEmbedText, readStore, refineHtml,
  refineResultFrom, writeStore,
} from './sieve-ui.mjs';
import { emptyState } from './cave-art.mjs';

/* ── what survives a reload ──────────────────────────────────────────────
 *
 * ONE SETTINGS STRING, TWO HOMES. The setting, the three sliders, the lookback
 * and the ML chip are serialised into one URL query (see `serialiseSettings`)
 * and that same string is what localStorage holds — under a `q` key, next to
 * the box's text, which stays out of the URL — so a remembered tab and a shared
 * link cannot drift into two formats. The format is `URLSearchParams`' own,
 * because that is the standard library and it already knows how to escape a
 * label.
 *
 * `topics` carries every parent whose choice differs from its default, then
 * every leaf that overrides its parent. Defaults are left out on purpose:
 * `defaultSetting` fills them back in, so the default tree serialises to
 * `topics=` and a shared link is short.
 */

export const STORE_KEY = 'arxave-cave-v1';

/** The four dropdown settings, in the order the contract lists them. */
export const CHOICES = Object.freeze(['equal', 'prefer', 'avoid', 'off']);
export const CHOICE_LABEL = Object.freeze({ equal: 'Equal', prefer: 'Prefer', avoid: 'Avoid', off: 'Off' });

/** The sliders' ranges and defaults, in one place so the page and the codec agree. */
export const SLIDERS = Object.freeze({
  match: Object.freeze({ min: 0, max: 100, value: 50 }),
  surprise: Object.freeze({ min: 0, max: 100, value: 50 }),
  expTheory: Object.freeze({ min: -100, max: 100, value: 0 }),
});

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** A stored/typed number, clamped; anything unreadable falls back. '' is not 0. */
function number(raw, fallback, lo, hi) {
  if (raw === null || raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? clamp(n, lo, hi) : fallback;
}

/** A setting string we did not write is `equal`, never a deleted topic (see sieve-core). */
const choiceOf = (raw) => (CHOICES.includes(raw) ? raw : 'equal');

/**
 * The state a first visit and a Reset both start from: the tree's own default
 * (Computing prefer, everything else equal), the three sliders at their middle,
 * nothing else pressed.
 */
export function defaultState(topics) {
  return {
    setting: defaultSetting(topics),
    match: SLIDERS.match.value,
    surprise: SLIDERS.surprise.value,
    expTheory: SLIDERS.expTheory.value,
    lookback: 1,
    ml4q: false,
  };
}

/**
 * A setting with every parent equal and no leaf overrides — what "Clear
 * filters" means, as opposed to "Reset topics" (which restores the shipped
 * default, Computing prefer, via `defaultSetting`).
 */
export function clearSetting(topics) {
  const setting = { leaves: {} };
  for (const parent of topics.parents) setting[parent.id] = 'equal';
  return setting;
}

/**
 * State → query string. Every parent differing from its own default, then every
 * leaf override, then the four scalars. Order follows `topics.json`, so the
 * same state always serialises to the same string and a test can compare two.
 */
export function serialiseSettings(topics, state) {
  const parts = [];
  const leaves = state.setting?.leaves ?? {};
  for (const parent of topics.parents) {
    const fallback = parent.default ?? 'equal';
    const choice = choiceOf(state.setting?.[parent.id] ?? fallback);
    if (choice !== fallback) parts.push(`${parent.id}:${choice}`);
  }
  for (const leaf of topics.leaves) {
    if (CHOICES.includes(leaves[leaf.id])) parts.push(`${leaf.id}:${leaves[leaf.id]}`);
  }

  const q = new URLSearchParams();
  q.set('topics', parts.join(','));
  q.set('match', String(number(state.match, SLIDERS.match.value, SLIDERS.match.min, SLIDERS.match.max)));
  q.set('surprise', String(number(state.surprise, SLIDERS.surprise.value, SLIDERS.surprise.min, SLIDERS.surprise.max)));
  q.set('exp', String(number(state.expTheory, SLIDERS.expTheory.value, SLIDERS.expTheory.min, SLIDERS.expTheory.max)));
  q.set('lookback', String(number(state.lookback, 1, 1, 3)));
  if (state.ml4q) q.set('ml4q', '1');
  return q.toString();
}

/**
 * Query string → state. Anything missing, malformed or out of range falls back
 * to the default rather than throwing: this string can arrive from a hand-edited
 * URL, and a page that will not open because a query param is odd is a worse
 * page than one that opens at its defaults.
 */
export function parseSettings(topics, raw) {
  const q = new URLSearchParams(String(raw ?? ''));
  const setting = defaultSetting(topics);

  for (const entry of (q.get('topics') || '').split(',')) {
    const at = entry.indexOf(':');
    if (at < 0) continue;
    const id = entry.slice(0, at).trim();
    const value = entry.slice(at + 1).trim();
    if (!CHOICES.includes(value)) continue;
    if (topics.parents.some((p) => p.id === id)) setting[id] = value;
    else if (topics.leafIndex.has(id)) setting.leaves[id] = value;
  }

  return {
    setting,
    match: number(q.get('match'), SLIDERS.match.value, SLIDERS.match.min, SLIDERS.match.max),
    surprise: number(q.get('surprise'), SLIDERS.surprise.value, SLIDERS.surprise.min, SLIDERS.surprise.max),
    expTheory: number(q.get('exp'), SLIDERS.expTheory.value, SLIDERS.expTheory.min, SLIDERS.expTheory.max),
    lookback: number(q.get('lookback'), 1, 1, 3),
    ml4q: q.get('ml4q') === '1',
  };
}

/**
 * A setting → the chips under the box.
 *
 * A chip exists for every parent that is not `equal` (the default tree already
 * shows one: Computing · Prefer) and for every leaf that overrides its parent
 * with a different value. A leaf set to the same value its parent already has
 * changes nothing, so it earns no chip — the row would read "Error-correcting
 * codes · Prefer" next to "Computing · Prefer" and imply a difference that is
 * not there.
 */
export function chipsFromSetting(topics, setting) {
  const out = [];
  for (const parent of topics.parents) {
    const choice = choiceOf(setting?.[parent.id] ?? parent.default);
    if (choice !== 'equal') {
      out.push({ scope: 'parent', id: parent.id, label: parent.label, choice });
    }
  }

  const leaves = setting?.leaves ?? {};
  for (const leaf of topics.leaves) {
    const choice = leaves[leaf.id];
    if (!CHOICES.includes(choice)) continue;
    const parent = topics.parents[topics.parentOf[topics.leafIndex.get(leaf.id)]];
    const inherited = choiceOf(setting?.[parent.id] ?? parent.default);
    if (choice === inherited) continue;
    out.push({ scope: 'leaf', id: leaf.id, parent: parent.id, label: leaf.label, choice });
  }
  return out;
}

/**
 * Dropping a chip: a parent chip means "stop preferring or avoiding this", so
 * the parent goes back to `equal`; a leaf chip means "stop overriding", so the
 * override is deleted and the leaf inherits its parent again. Returns a new
 * setting — nothing is mutated, so the caller still holds the old one.
 */
export function removeChip(topics, setting, chip) {
  const next = { ...setting, leaves: { ...(setting.leaves ?? {}) } };
  if (chip.scope === 'parent') next[chip.id] = 'equal';
  else delete next.leaves[chip.id];
  return next;
}

/**
 * Tonight's ranked papers → how many each parent holds.
 *
 * A parent counts a paper when the paper's primary *or* its secondary topic is
 * one of that parent's leaves, once per parent: the secondary is half a vote in
 * the scoring, but a paper sitting between Error-correcting codes and
 * Fault-tolerant computing is still a Computing paper for the purposes of "how
 * much of tonight is in here". A paper with no assigned topic counts nowhere.
 */
export function parentCounts(ranked, topics) {
  const counts = {};
  for (const parent of topics.parents) counts[parent.id] = 0;
  for (const item of ranked) {
    const seen = new Set();
    for (const at of [item.topic, item.topic2]) {
      if (!(at >= 0) || at >= topics.leaves.length) continue;
      const parent = topics.parents[topics.parentOf[at]];
      if (parent && !seen.has(parent.id)) {
        seen.add(parent.id);
        counts[parent.id] += 1;
      }
    }
  }
  return counts;
}

/* ── the page itself ──────────────────────────────────────────────────────
 * Everything below talks to a document, a window and a network. It is guarded
 * so the file can be imported by `node --test` for the functions above.
 */

/** The one way this file asks the document for an element. */
const byId = (id) => document.getElementById(id);

if (typeof document !== 'undefined') startPage();

function startPage() {
  /* The same endpoints and overrides docs/assets/sieve.js and filter.js carry,
     so a reader who pointed one page at their own pick gets it here too. */
  const FUNCTIONS_BASE = 'https://ugxxakguqgpxpdfhgtsb.supabase.co/functions/v1';
  const RELAY_URL = window.ARXAVE_RELAY || (FUNCTIONS_BASE + '/relay');
  const CACHE_URL = window.ARXAVE_DIG_CACHE === false ? null
    : (window.ARXAVE_DIG_CACHE || (FUNCTIONS_BASE + '/dig-cache'));
  const EMBED_URL = window.ARXAVE_EMBED || (FUNCTIONS_BASE + '/embed');
  const REFINE_URL = FUNCTIONS_BASE + '/refine';
  const CORPUS_BASE = window.ARXAVE_CORPUS_BASE || '/assets/corpus/';

  /* S1's corpus window, so the topics under the sliders are the topics tonight's
     papers arrive in. Not configurable: "the corpus window" in Advanced shows
     this and how far back the scout reaches, nothing more. */
  const CATEGORIES = ['quant-ph', 'cond-mat.mes-hall'];
  const PHONE = '(max-width: 720px)';
  const DEBOUNCE = 80;      // the contract's live re-rank delay
  const TEXT_PAUSE = 600;   // longer, because words are a paid embed (see header)

  const relay = createRelay({ relayBase: RELAY_URL });

  const state = {
    corpus: null,
    topics: null,
    axes: null,
    window: null,
    setting: null,
    match: SLIDERS.match.value,
    surprise: SLIDERS.surprise.value,
    expTheory: SLIDERS.expTheory.value,
    lookback: 1,
    ml4q: false,
    candidates: [],
    ranked: [],
    busy: false,
    error: '',
    llmKey: '',             // memory only, never written down
  };

  const expanded = new Set();   // parent ids whose children are showing
  let touchVectors = [];
  let touchKey = '[]';
  let rankTimer = 0;
  let sheetModal = false;
  let baggage = '';

  /* ── the one status line ───────────────────────────────────────────── */

  function say(message, kind) {
    const el = byId('cv-status');
    el.textContent = message || '';
    el.classList.toggle('is-error', kind === 'error');
  }


  /* ── persistence ───────────────────────────────────────────────────── */

  function persist() {
    if (!state.topics) return;
    const code = serialiseSettings(state.topics, state);
    /* The words ride along in the store but never in the URL: an abstract in a
       query string is both a privacy leak and longer than some sites. */
    writeStore(window.localStorage, STORE_KEY, { q: code, text: byId('cv-text').value });
    /* A replaceState, not a pushState: the URL is a mirror of the controls, and
       a slider drag must not fill the back button with forty entries. Blocked in
       sandboxed frames and on file://, hence the catch. */
    try {
      const { pathname, hash } = window.location;
      window.history.replaceState(null, '', pathname + '?' + code + hash);
    } catch (_) { /* the URL is a convenience, not a requirement */ }
  }

  function restore() {
    const fromUrl = window.location.search.replace(/^\?/, '');
    const saved = readStore(window.localStorage, STORE_KEY, null);
    const stored = saved && typeof saved === 'object' ? saved.q : (typeof saved === 'string' ? saved : '');
    Object.assign(state, parseSettings(state.topics, fromUrl || stored || ''));
    if (saved && typeof saved.text === 'string') byId('cv-text').value = saved.text;
  }

  /* ── the tree ──────────────────────────────────────────────────────── */

  const selectHtml = (scope, id, label) => `<select class="cv-select" data-${scope}="${id}"
      aria-label="${escapeHtml(label)} weight">${CHOICES.map((c) => `<option value="${c}">${CHOICE_LABEL[c]}</option>`).join('')}</select>`;

  function renderTree() {
    expanded.clear();
    for (const parent of state.topics.parents) expanded.add(parent.id);

    byId('cv-tree').innerHTML = state.topics.parents.map((parent) => {
      const leaves = state.topics.leaves.filter((leaf) => leaf.parent === parent.id);
      return `<div class="cv-tgroup" data-group="${parent.id}">
        <div class="cv-trow cv-trow--parent">
          <button type="button" class="cv-twisty" data-twisty="${parent.id}" aria-expanded="true"
                  aria-label="Show ${escapeHtml(parent.label)} topics"><span aria-hidden="true">▾</span></button>
          <span class="cv-tlabel">${escapeHtml(parent.label)}</span>
          <span class="cv-tcount" data-count="${parent.id}" hidden></span>
          ${selectHtml('parent', parent.id, parent.label)}
        </div>
        <div class="cv-kids" data-kids="${parent.id}">
          ${leaves.map((leaf) => `<div class="cv-trow cv-trow--leaf">
            <span class="cv-tlabel">${escapeHtml(leaf.label)}</span>
            ${selectHtml('leaf', leaf.id, leaf.label)}
          </div>`).join('')}
        </div>
      </div>`;
    }).join('');

    syncTree();
  }

  /** What a leaf actually weighs, after its own override or its parent's choice. */
  function effectiveLeaf(leaf) {
    return choiceOf(state.setting.leaves?.[leaf.id] ?? state.setting[leaf.parent]);
  }

  /** Selects and twisties back in step with the setting — without re-rendering,
   * so an open dropdown is not torn out from under a keyboard. */
  function syncTree() {
    const tree = byId('cv-tree');
    for (const sel of tree.querySelectorAll('select[data-parent]')) {
      sel.value = choiceOf(state.setting[sel.dataset.parent]);
    }
    for (const sel of tree.querySelectorAll('select[data-leaf]')) {
      const leaf = state.topics.leaves[state.topics.leafIndex.get(sel.dataset.leaf)];
      sel.value = effectiveLeaf(leaf);
    }
    for (const btn of tree.querySelectorAll('[data-twisty]')) {
      const open = expanded.has(btn.dataset.twisty);
      btn.setAttribute('aria-expanded', String(open));
      btn.firstElementChild.textContent = open ? '▾' : '▸';
      btn.closest('.cv-tgroup').querySelector('.cv-kids').hidden = !open;
    }
  }

  /* ── the chips ─────────────────────────────────────────────────────── */

  function renderChips() {
    const chips = chipsFromSetting(state.topics, state.setting);
    byId('cv-chips').innerHTML = chips.map((chip) => `<button type="button" class="cv-chip"
        data-drop="${chip.scope}:${chip.id}"
        aria-label="Remove filter: ${escapeHtml(chip.label)} ${CHOICE_LABEL[chip.choice]}">${escapeHtml(chip.label)} · ${CHOICE_LABEL[chip.choice]}<span aria-hidden="true">×</span></button>`).join('');
    byId('cv-ml4q').setAttribute('aria-pressed', String(state.ml4q));
    byId('cv-clear').hidden = chips.length === 0 && !state.ml4q;
  }

  function afterFilterChange() {
    syncTree();
    renderChips();
    persist();
    scheduleRank();
  }

  /* ── the sliders ───────────────────────────────────────────────────── */

  function experimentText(value) {
    if (value === 0) return 'no preference';
    return Math.abs(value) + ' toward ' + (value < 0 ? 'experiment' : 'theory');
  }

  function renderSliders() {
    const match = byId('cv-match');
    const surprise = byId('cv-surprise');
    const exp = byId('cv-exptheory');

    match.value = String(state.match);
    surprise.value = String(state.surprise);
    exp.value = String(state.expTheory);

    match.setAttribute('aria-valuetext', `Topic match: ${state.match} of 100`);
    surprise.setAttribute('aria-valuetext', `Surprise: ${state.surprise} of 100`);
    exp.setAttribute('aria-valuetext', `Experiment to theory: ${experimentText(state.expTheory)}`);

    byId('cv-match-val').textContent = String(state.match);
    byId('cv-surprise-val').textContent = String(state.surprise);
    byId('cv-exptheory-val').textContent = experimentText(state.expTheory);

    /* The contract's ship flags: an axis that never cleared held-out accuracy is
       hidden, not shown disabled — a control that does nothing is a lie. */
    byId('cv-exptheory-row').hidden = !state.axes?.expTheory.ship;
    byId('cv-ml4q').hidden = !state.axes?.ml4q.ship;
    if (!state.axes?.ml4q.ship) state.ml4q = false;   // a stored press from a build where it shipped
  }


  /* ── the sheet ─────────────────────────────────────────────────────── */

  const isPhone = () => window.matchMedia(PHONE).matches;

  /**
   * One element, two lives: a plain static panel in the desktop's left column
   * (the `open` attribute, no top layer) and a modal bottom sheet on a phone
   * (`showModal`, which is where the focus trap, the inert background and Esc
   * come from for free).
   */
  function syncSheet() {
    const sheet = byId('cv-sheet');
    if (isPhone()) {
      if (sheet.open && !sheetModal && sheet.close) sheet.close();
    } else {
      if (sheetModal) {
        sheetModal = false;
        if (sheet.close) sheet.close();
      }
      sheet.setAttribute('open', '');
    }
    byId('cv-topics-btn').setAttribute('aria-expanded', String(sheetModal));
  }

  function openSheet() {
    const sheet = byId('cv-sheet');
    try {
      if (!sheet.open && sheet.showModal) sheet.showModal();
      sheetModal = true;
    } catch (_) { /* already modal: nothing to do */ }
    byId('cv-topics-btn').setAttribute('aria-expanded', 'true');
  }

  function closeSheet() {
    const sheet = byId('cv-sheet');
    sheetModal = false;
    if (sheet.open && sheet.close) sheet.close();
    byId('cv-topics-btn').setAttribute('aria-expanded', 'false');
  }

  /* ── touchstones ───────────────────────────────────────────────────── */

  /**
   * The box's words, embedded on the hosted pick and never through the shared
   * cache — the same rule and the same reason as sieve-ui's `embedTexts`. The
   * key check means a slider drag, or a topic change, never re-embeds.
   */
  async function ensureTouchstones() {
    const texts = [byId('cv-text').value.trim()].filter(Boolean).map(cacheKeyText);
    const key = JSON.stringify(texts);
    if (key === touchKey) return;
    if (!texts.length) {
      touchVectors = [];
      touchKey = key;
      return;
    }
    say('Embedding what you care about…');
    const vectors = await embedTexts({
      texts,
      embedUrl: EMBED_URL,
      onProgress: (done, total) => say(`Embedding what you care about… ${done}/${total}`),
    });
    touchVectors = vectors.map((v) => centreUnit(v, state.corpus.mean));
    touchKey = key;
  }

  /* ── ranking ───────────────────────────────────────────────────────── */

  function rerank() {
    if (!state.corpus || !state.topics || !state.setting) return;
    if (!state.candidates.length) {
      renderResults();
      renderCounts();
      return;
    }
    state.ranked = caveScore({
      corpus: state.corpus,
      topics: state.topics,
      axes: state.axes,
      setting: state.setting,
      sliders: { match: state.match, surprise: state.surprise, expTheory: state.expTheory },
      touchstones: touchVectors,
      candidates: state.candidates,
    });
    /* ponytail: the ML chip hides papers after scoring, so the survivors' scores
       still carry percentiles measured over the whole night. Moving the filter
       into caveScore would mean a second ml4q pass over every candidate; this is
       one line and the order inside the filtered set is unchanged. */
    if (state.ml4q) state.ranked = state.ranked.filter((r) => r.ml4q >= 0.5);
    renderResults();
    renderCounts();
    sayRanked();
  }

  async function rerankSoon() {
    try {
      await ensureTouchstones();
    } catch (err) {
      say('Could not embed your words: ' + ((err && err.message) || err), 'error');
      return;
    }
    rerank();
  }

  function scheduleRank(delay = DEBOUNCE) {
    persist();
    clearTimeout(rankTimer);
    rankTimer = setTimeout(rerankSoon, delay);
  }

  /* ── results ───────────────────────────────────────────────────────── */

  const round1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : '—');
  const round2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : '—');

  /** One sentence of evidence, built from the numbers already on the card. */
  function whyLine(item) {
    const bits = [];
    if (item.fit >= 1) bits.push('closer to your topics than most of the corpus');
    else if (item.fit <= -0.5) bits.push('at the edge of your topics');
    if (item.impact >= 0.55) bits.push('its neighbours are well cited');
    else if (item.impact <= 0.3) bits.push('its neighbours are quiet so far');
    if (item.novelty >= 0.75) bits.push('unlike anything proven');
    return bits.slice(0, 2).join(' · ') || 'a fresh neighbour of the corpus';
  }

  function topicLabel(item) {
    const primary = state.topics.leaves[item.topic];
    const second = item.topic2 >= 0 ? state.topics.leaves[item.topic2] : null;
    if (!primary) return '';
    return second ? `${primary.label} + ${second.label}` : primary.label;
  }

  function resultHtml(item) {
    const title = escapeHtml(item.title || item.id);
    const heading = item.abs_url
      ? `<a href="${escapeHtml(item.abs_url)}" rel="noopener">${title}</a>`
      : title;
    const landmark = (item.landmarks && item.landmarks[0]) || null;
    return `<article class="cv-card cv-result">
      <h3 class="cv-result-title">${heading}</h3>
      <p class="cv-result-why">${escapeHtml(whyLine(item))}</p>
      <p class="cv-result-meta">
        <span class="cv-chip cv-chip--fit">fit ${item.fit >= 0 ? '+' : ''}${round1(item.fit)}</span>
        <span class="cv-chip cv-chip--impact">impact ${round2(item.impact)}</span>
        <span class="cv-result-topic">${escapeHtml(topicLabel(item))}</span>
      </p>
      ${landmark ? `<p class="cv-result-like">looks like: ${escapeHtml(landmark.title)}</p>` : ''}
      <button type="button" class="cv-btn cv-btn--ghost cv-refine" data-refine="${escapeHtml(item.id)}">Refine with AI</button>
      <div class="cv-refine-out"></div>
    </article>`;
  }

  function renderResults() {
    const box = byId('cv-results');
    if (!state.candidates.length) {
      box.innerHTML = state.busy
        ? emptyState('digging', 'Digging tonight\'s arXiv — this is slow on a cold cache.')
        : emptyState('idle', state.error || 'Nothing dug yet. Tonight\'s papers are on their way.');
      return;
    }
    if (!state.ranked.length) {
      box.innerHTML = emptyState('none', `No paper cleared Topic match ${state.match}. Lower it, or widen the topics.`);
      return;
    }
    box.innerHTML = state.ranked.map(resultHtml).join('');
  }

  /** Parent rows carry the count once there is a ranked list to count. */
  function renderCounts() {
    const counts = state.ranked.length ? parentCounts(state.ranked, state.topics) : null;
    for (const el of byId('cv-tree').querySelectorAll('[data-count]')) {
      const n = counts ? counts[el.dataset.count] : null;
      el.hidden = n === null || n === undefined;
      el.textContent = n === null || n === undefined ? '' : String(n);
    }
  }

  function sayRanked() {
    if (!state.ranked.length) return;
    say(`${state.ranked.length} of ${state.candidates.length} papers${baggage ? ' · ' + baggage : ''}`);
  }

  /* ── tonight's haul ────────────────────────────────────────────────── */

  async function fetchJson(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`${url} answered HTTP ${resp.status}`);
    return resp.json();
  }

  /**
   * Fetch, embed, keep. Every failure says so in the status line rather than
   * leaving a dead form: there is no Dig button to press again, the page digs
   * itself the moment the corpus is up.
   */
  async function dig() {
    if (state.busy) return;
    state.busy = true;
    state.error = '';
    baggage = '';
    renderResults();
    say('Digging tonight\'s arXiv…');
    try {
      const { candidates, failures } = await fetchAnnouncement({
        categories: CATEGORIES,
        lookback: state.lookback,
        fetchViaRelay: relay,
      });
      if (!candidates.length) throw new Error('Tonight\'s announcement came back empty.');
      say(`Embedding ${candidates.length} papers…`);
      const vectors = await embedCandidates({
        texts: candidates.map((c) => paperEmbedText(c.title, c.abstract)),
        embedUrl: EMBED_URL,
        cacheUrl: CACHE_URL,
        onProgress: (done, total) => say(`Embedding ${done}/${total} papers…`),
      });
      state.candidates = candidates.map((c, i) => ({ ...c, vec: centreUnit(vectors[i], state.corpus.mean) }));
      if (failures.length) baggage = 'some categories failed: ' + failures.join('; ');
      state.busy = false;
      await rerankSoon();     // embeds the box too, if it had words from the URL
    } catch (err) {
      state.busy = false;
      state.error = (err && err.message) || String(err);
      say(state.error, 'error');
      renderResults();
    }
  }

  /* ── Refine with AI ────────────────────────────────────────────────── */

  async function refine(button) {
    const id = button.dataset.refine;
    const item = state.ranked.find((r) => r.id === id);
    if (!item) return;
    const out = button.parentElement.querySelector('.cv-refine-out');
    button.disabled = true;
    out.innerHTML = '<p class="cv-hint">Asking…</p>';

    const headers = { 'Content-Type': 'application/json' };
    if (state.llmKey) headers['x-llm-key'] = state.llmKey;

    try {
      const resp = await fetch(REFINE_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          paper: { title: item.title, abstract: item.abstract || '' },
          neighbours: (item.landmarks || []).slice(0, 5).map((l) => ({ title: l.title, pct: l.pct })),
          touchstones: [byId('cv-text').value.trim()].filter(Boolean).map(cacheKeyText),
        }),
      });
      let data = null;
      try { data = await resp.json(); } catch (_) { /* a refusal may carry no body */ }
      out.innerHTML = refineHtml(refineResultFrom(resp.status, data));
    } catch (err) {
      out.innerHTML = refineHtml({ error: 'Could not reach the refiner: ' + ((err && err.message) || err) });
    } finally {
      button.disabled = false;
    }
  }

  /* ── export ────────────────────────────────────────────────────────── */

  function exportResults() {
    const rows = state.ranked.map(({ vec, ...rest }) => rest);   // 768 floats a row are not a report
    const blob = new Blob([JSON.stringify({ window: state.window, results: rows }, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'cave-results.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /* ── wiring ────────────────────────────────────────────────────────── */

  function wire() {
    const app = byId('cv-app');

    /* Delegated: the tree, the chips and the cards are re-rendered as the reader
       works, and one listener on the container outlives all of them. */
    app.addEventListener('input', (event) => {
      const el = event.target;
      if (el.id === 'cv-key') {
        state.llmKey = el.value.trim();      // memory only — deliberately not persisted
        return;
      }
      if (el.id === 'cv-text') {
        scheduleRank(TEXT_PAUSE);
      } else if (el.id === 'cv-match') {
        state.match = Number(el.value);
        renderSliders();
        scheduleRank();
      } else if (el.id === 'cv-surprise') {
        state.surprise = Number(el.value);
        renderSliders();
        scheduleRank();
      } else if (el.id === 'cv-exptheory') {
        state.expTheory = Number(el.value);
        renderSliders();
        scheduleRank();
      }
    });

    app.addEventListener('change', (event) => {
      const el = event.target;
      if (el.matches?.('select[data-parent]')) {
        /* A parent's choice sets its children: the overrides go, or the parent
           dropdown would claim something its children contradict. */
        state.setting[el.dataset.parent] = choiceOf(el.value);
        for (const leaf of state.topics.leaves) {
          if (leaf.parent === el.dataset.parent) delete state.setting.leaves[leaf.id];
        }
        afterFilterChange();
        return;
      }
      if (el.matches?.('select[data-leaf]')) {
        state.setting.leaves[el.dataset.leaf] = choiceOf(el.value);
        afterFilterChange();
        return;
      }
      if (el.id === 'cv-lookback') {
        state.lookback = number(el.value, 1, 1, 3);
        persist();
        dig();
      }
    });

    app.addEventListener('click', (event) => {
      const twisty = event.target.closest('[data-twisty]');
      if (twisty) {
        const id = twisty.dataset.twisty;
        if (expanded.has(id)) expanded.delete(id);
        else expanded.add(id);
        syncTree();
        return;
      }

      const drop = event.target.closest('[data-drop]');
      if (drop) {
        const [scope, id] = drop.dataset.drop.split(':');
        state.setting = removeChip(state.topics, state.setting, { scope, id });
        afterFilterChange();
        return;
      }

      if (event.target.closest('#cv-ml4q')) {
        state.ml4q = !state.ml4q;
        afterFilterChange();
        return;
      }
      if (event.target.closest('#cv-topics-btn')) {
        openSheet();
        return;
      }
      if (event.target.closest('#cv-sheet-apply')) {
        closeSheet();
        return;
      }
      if (event.target.closest('#cv-sheet-clear') || event.target.closest('#cv-clear')) {
        state.setting = clearSetting(state.topics);
        state.ml4q = false;
        afterFilterChange();
        if (event.target.closest('#cv-sheet-clear')) closeSheet();
        return;
      }
      if (event.target.closest('#cv-reset-topics')) {
        state.setting = defaultSetting(state.topics);
        state.ml4q = false;
        afterFilterChange();
        return;
      }

      const refineButton = event.target.closest('button.cv-refine');
      if (refineButton) {
        refine(refineButton);
        return;
      }
      if (event.target.closest('#cv-export')) exportResults();
    });

    /* Esc closes the native dialog and fires `close`; the chip's aria-expanded
       has to follow whichever way the sheet went. */
    byId('cv-sheet').addEventListener('close', () => {
      sheetModal = false;
      byId('cv-topics-btn').setAttribute('aria-expanded', 'false');
      if (!isPhone()) byId('cv-sheet').setAttribute('open', '');
    });

    /* A tap on the dimmed area above a bottom sheet dismisses it, as every
       sheet on a phone does. Only the backdrop — a tap inside the sheet has a
       child as its target. */
    byId('cv-sheet').addEventListener('click', (event) => {
      if (event.target !== event.currentTarget) return;
      if (event.clientY < event.currentTarget.getBoundingClientRect().top) closeSheet();
    });

    window.addEventListener('resize', syncSheet);
  }


  /* ── boot ──────────────────────────────────────────────────────────── */

  function windowText() {
    const w = state.window;
    const span = w && w.from && w.to ? `${w.from} … ${w.to}` : 'the shipped window';
    return `Corpus window ${span} · scouting ${CATEGORIES.join(', ')}`;
  }

  async function boot() {
    say('Loading the corpus…');
    renderResults();

    try {
      const [files, topicsJson, axesJson] = await Promise.all([
        loadCorpusFrom(CORPUS_BASE),
        fetchJson(joinUrl(CORPUS_BASE, 'topics.json')).catch(() => null),
        fetchJson(joinUrl(CORPUS_BASE, 'axes.json')).catch(() => null),
      ]);
      if (!topicsJson) throw new Error('this build has no topics.json beside the corpus');

      state.corpus = loadCorpus(files.json, files.bin);
      /* C1 shipped the corpus' own topic assignment; carrying it in saves a
         nearest-centroid pass over 6000 rows on every load. Missing arrays make
         caveScore assign per candidate instead, which is correct, just slower. */
      if (Array.isArray(files.json.topic)) state.corpus.topic = Int32Array.from(files.json.topic);
      if (Array.isArray(files.json.topic2)) state.corpus.topic2 = Int32Array.from(files.json.topic2);
      state.window = files.json.window;
      state.topics = loadTopics(topicsJson);
      state.axes = loadAxes(axesJson);       // null → both axes ship:false, both controls hidden

      wire();
      restore();
      renderSliders();
      renderTree();
      renderChips();
      syncSheet();
      renderResults();                       // the idle state, before the dig

      byId('cv-window').textContent = windowText();
      byId('cv-lookback').value = String(state.lookback);

      dig();
    } catch (err) {
      state.error = err instanceof CorpusMissing
        ? 'this build predates the corpus — there is nothing to rank yet'
        : ((err && err.message) || String(err));
      say(state.error, 'error');
      byId('cv-results').innerHTML = emptyState('idle', 'The cave could not open: ' + state.error);
    }
  }

  boot();
}

