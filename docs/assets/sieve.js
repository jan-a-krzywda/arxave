/**
 * sieve — the page: one text box, a handful of sliders, and last night's arXiv
 * ranked by fit and impact.
 *
 * THREE THINGS THIS FILE IS CAREFUL ABOUT.
 *
 * 1. NOTHING IS REFETCHED WHEN A SLIDER MOVES. `prepare()` measures the fit
 *    statistics over the corpus once per (weights, touchstones) pair and
 *    `rank()` re-reads them for whatever Strictness and Surprise are on the
 *    sliders, so a drag costs arithmetic and not a request. The two are split
 *    here exactly as sieve-core splits them, and `prepKey` is what decides which
 *    half has to run.
 *
 * 2. TYPED WORDS AND PUBLISHED WORDS TAKE DIFFERENT PATHS OUT OF THE BROWSER.
 *    The textbox goes to the hosted pick and nowhere else; only arXiv abstracts
 *    (already public) are looked up in the shared dig-cache. That split lives in
 *    sieve-ui (`embedTexts` vs `embedCandidates`) so it cannot drift.
 *
 * 3. THE SLIDERS SURVIVE A RELOAD, THE API KEY DOES NOT. Slider positions and
 *    touchstone text are written to localStorage inside a try/catch; the key
 *    lives in a variable and is gone when the tab is.
 */
import { centreUnit, loadCorpus, prepare, rank } from './sieve-core.mjs';
import {
  CorpusMissing, cacheKeyText, cardHtml, createRelay, demoCandidates, demoCorpus, embedCandidates,
  embedTexts, escapeHtml, fetchAnnouncement, loadCorpusFrom, paperEmbedText, readStore,
  refineHtml, refineResultFrom, writeStore,
} from './sieve-ui.mjs';

/* The same constants docs/assets/filter.js carries, with the same overrides, so
   a reader who pointed the Dig page at their own pick gets the same behaviour
   here. See that file for why each one exists. */
const FUNCTIONS_BASE = 'https://ugxxakguqgpxpdfhgtsb.supabase.co/functions/v1';
const RELAY_URL = window.ARXAVE_RELAY || (FUNCTIONS_BASE + '/relay');
const CACHE_URL = window.ARXAVE_DIG_CACHE === false ? null
  : (window.ARXAVE_DIG_CACHE || (FUNCTIONS_BASE + '/dig-cache'));
const EMBED_URL = window.ARXAVE_EMBED || (FUNCTIONS_BASE + '/embed');
const REFINE_URL = FUNCTIONS_BASE + '/refine';

/* Where corpus.json lives, handed over by Jekyll rather than guessed: a relative
   fetch works at / and breaks the day the site gains a baseurl. */
const CORPUS_BASE = window.ARXAVE_CORPUS_BASE || '/assets/corpus/';

const STORE_KEY = 'arxave-sieve-v1';
const TOP_SLIDERS = 6;
/* The scout's menu. The default two match S1's corpus window, so the topics under
   the sliders are the topics tonight's papers arrive in. */
const ALL_CATEGORIES = [
  'quant-ph', 'cond-mat.mes-hall', 'cond-mat.stat-mech', 'cond-mat.str-el',
  'cond-mat.supr-con', 'cs.LG', 'hep-th', 'math-ph', 'physics.optics',
];
const DEFAULT_CATEGORIES = ['quant-ph', 'cond-mat.mes-hall'];

const relay = createRelay({ relayBase: RELAY_URL });

const app = document.getElementById('sv-app');
const byId = (id) => document.getElementById(id);

const state = {
  corpus: null,
  demo: false,
  prep: null,
  candidates: [],
  ranked: [],
  weights: {},            // clusterId -> 0..1; missing means 0.5
  gate: 1,
  surprise: 0.4,
  categories: DEFAULT_CATEGORIES.slice(),
  lookback: 1,
  llmKey: '',             // in memory only, never written down
  corpusError: '',
  busy: false,
};

/* A suffix for the status line — a failed category, or papers that came from
   nowhere — kept out of state because it is said once per dig, not stored. */
let baggage = '';

/* Centred touchstone vectors, and the texts they were built from — the pair is
   what tells a slider drag whether the words have moved under it. */
let touchVectors = [];
let touchKey = '';
let prepKey = '';
let pendingFrame = false;

/* ── the one line of status ─────────────────────────────────────────────── */

function setStatus(message, kind) {
  const el = byId('sv-status');
  el.textContent = message || '';
  el.classList.toggle('is-error', kind === 'error');
  el.classList.toggle('is-demo', kind === 'demo');
}

/** The one line above the button: what the corpus is and what tonight has in it. */
function sayCorpus() {
  const { n, clusters } = state.corpus;
  if (state.demo) {
    setStatus('No corpus in this build yet — demo mode on 40 sample papers; the dig still works.'
      + state.corpusError, 'demo');
  } else {
    setStatus(`Corpus: ${n} papers · ${clusters.length} topics. Press Dig.`);
  }
}

/* ── what survives a reload ─────────────────────────────────────────────── */

const touchInputs = () => Array.from(document.querySelectorAll('.sv-touch'));

/** Every touchstone the reader has typed, blank rows dropped. */
function touchstoneTexts() {
  return touchInputs().map((el) => el.value.trim()).filter(Boolean);
}

function persist() {
  writeStore(window.localStorage, STORE_KEY, {
    weights: state.weights,
    gate: state.gate,
    surprise: state.surprise,
    categories: state.categories,
    lookback: state.lookback,
    touchstones: touchInputs().map((el) => el.value),
  });
}

function restore() {
  const saved = readStore(window.localStorage, STORE_KEY, null);
  if (!saved || typeof saved !== 'object') return;
  if (saved.weights && typeof saved.weights === 'object') state.weights = saved.weights;
  /* Clamped on the way in: a stored number outside the slider's range would leave
     the readout and the control disagreeing. */
  if (Number.isFinite(saved.gate)) state.gate = Math.min(3, Math.max(0, saved.gate));
  if (Number.isFinite(saved.surprise)) state.surprise = Math.min(1, Math.max(0, saved.surprise));
  if (Number.isFinite(saved.lookback)) state.lookback = Math.min(7, Math.max(1, saved.lookback));
  if (Array.isArray(saved.categories) && saved.categories.length) state.categories = saved.categories;
  if (Array.isArray(saved.touchstones) && saved.touchstones.length) {
    byId('sv-touch').value = saved.touchstones[0] || '';
    for (const text of saved.touchstones.slice(1)) addTouchRow(text);
  }
}

/* ── the controls, built from the corpus and the saved state ────────────── */

const weightOf = (id) => (Number.isFinite(state.weights[id]) ? state.weights[id] : 0.5);

function topicHtml(cluster) {
  const w = weightOf(cluster.id);
  return `<label class="sv-slider">
      <span class="sv-slider-name">${escapeHtml(cluster.label)}</span>
      <span class="sv-slider-val" data-weight-val="${cluster.id}">${w.toFixed(2)}</span>
      <input type="range" min="0" max="1" step="0.05" value="${w}"
             data-cluster="${cluster.id}" data-weight="${cluster.id}">
    </label>`;
}

/** The six biggest topics up front; every other topic one fold down, same slider. */
function renderTopics() {
  const clusters = [...state.corpus.clusters]
    .sort((a, b) => b.size - a.size || a.id - b.id);
  byId('sv-topics').innerHTML = clusters.slice(0, TOP_SLIDERS).map(topicHtml).join('');
  const rest = clusters.slice(TOP_SLIDERS);
  byId('sv-topics-more').innerHTML = rest.length
    ? rest.map(topicHtml).join('')
    : '<p class="sv-hint">The six above are the whole corpus.</p>';
}

function renderChips() {
  const chips = state.categories.map((cat) => `<button type="button" class="sv-chip-btn"
      data-drop-cat="${escapeHtml(cat)}" title="Stop reading ${escapeHtml(cat)}">${escapeHtml(cat)}
      <span aria-hidden="true">×</span></button>`).join('');
  byId('sv-cats').innerHTML = chips;

  const options = ALL_CATEGORIES.filter((c) => !state.categories.includes(c));
  byId('sv-cat-add').innerHTML = options.length
    ? '<option value="">Add a category…</option>'
      + options.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('')
    : '<option value="">All added</option>';
}

function addTouchRow(text = '') {
  const row = document.createElement('div');
  row.className = 'sv-touch-row';
  row.innerHTML = `<textarea class="sv-touch" rows="2" aria-label="Another touchstone"
      placeholder="Another thing you care about"></textarea>
    <button type="button" class="sv-drop" title="Remove this touchstone">Remove</button>`;
  row.querySelector('textarea').value = text;
  byId('sv-touch-rows').append(row);
}

function renderSliderValues() {
  for (const el of document.querySelectorAll('[data-weight-val]')) {
    el.textContent = weightOf(Number(el.dataset.weightVal)).toFixed(2);
  }
  byId('sv-gate-val').textContent = state.gate.toFixed(1);
  byId('sv-surprise-val').textContent = state.surprise.toFixed(2);
}

/* ── the corpus, or 40 papers standing in for it ────────────────────────── */

async function ensureCorpus() {
  if (state.corpus) return;
  try {
    const { json, bin } = await loadCorpusFrom(CORPUS_BASE);
    state.corpus = loadCorpus(json, bin);
  } catch (err) {
    /* A 404 means this build predates the corpus, which is what demo mode is for
       and says nothing a reader needs. Anything else is a *broken* corpus, and
       that is said out loud: a silently synthetic corpus looks exactly like a
       real one. */
    const missing = err instanceof CorpusMissing;
    const { json, bin } = demoCorpus();
    state.demo = true;
    state.corpus = loadCorpus(json, bin);
    state.corpusError = missing ? '' : ` (${(err && err.message) || err})`;
  }
  renderTopics();
  renderSliderValues();
}

/* ── ranking ────────────────────────────────────────────────────────────── */

/**
 * prepare() then rank(). Splitting them is what makes a Strictness or Surprise
 * drag instant: the fit statistics are measured over the corpus once and
 * `prepKey` says when that measurement is stale, so only the cheap half runs.
 */
function rerank({ reprepare = false } = {}) {
  if (!state.corpus) return;
  const key = JSON.stringify([state.weights, touchKey]);
  if (reprepare || key !== prepKey || !state.prep) {
    state.prep = prepare({ corpus: state.corpus, weights: state.weights, touchstones: touchVectors });
    prepKey = key;
  }
  state.ranked = rank(state.prep, state.candidates, { gate: state.gate, surprise: state.surprise });
  renderResults();
}

/* One rank per animation frame: a drag fires `input` faster than the corpus can
   be walked, and the last position is the only one that matters. */
function scheduleRank() {
  persist();
  if (pendingFrame) return;
  pendingFrame = true;
  requestAnimationFrame(() => {
    pendingFrame = false;
    rerank();
  });
}

function renderResults() {
  const results = byId('sv-results');
  const texts = touchstoneTexts();
  const stale = texts.length > 0 && touchKey !== JSON.stringify(texts);

  if (!state.ranked.length) {
    results.innerHTML = state.candidates.length
      ? `<p class="sv-empty">No paper cleared Strictness ${state.gate.toFixed(1)}. Drag it down, or widen the topics.</p>`
      : '<p class="sv-empty">Nothing dug yet. Say what you care about, then press Dig.</p>';
    return;
  }
  results.innerHTML = state.ranked.map(cardHtml).join('');
  const demo = state.demo ? ' · demo corpus' : '';
  const hint = stale ? ' · press Dig to use the new words' : '';
  setStatus(`${state.ranked.length} of ${state.candidates.length} papers cleared${demo}${hint}${baggage}`);
}

/* ── the dig itself ─────────────────────────────────────────────────────── */

/** Touchstone text on the hosted pick: embedded, never cached, never stored. */
async function ensureTouchstones() {
  const texts = touchstoneTexts().map(cacheKeyText);
  const key = JSON.stringify(texts);
  if (key === touchKey) return;
  if (!texts.length) {
    touchVectors = [];
    touchKey = key;
    prepKey = '';
    return;
  }
  setStatus('Embedding what you care about…');
  const vectors = await embedTexts({ texts, embedUrl: EMBED_URL, onProgress: (done, total) => setStatus(`Embedding what you care about… ${done}/${total}`) });
  touchVectors = vectors.map((v) => centreUnit(v, state.corpus.mean));
  touchKey = key;
  prepKey = '';
}

/** Tonight's arXiv, embedded. In demo mode a dead relay is not a dead end. */
async function haul() {
  const { candidates, failures } = await fetchAnnouncement({
    categories: state.categories,
    lookback: state.lookback,
    fetchViaRelay: relay,
  });
  if (!candidates.length) throw new Error('Tonight\'s announcement came back empty.');
  setStatus(`Embedding ${candidates.length} papers…`);
  const vectors = await embedCandidates({
    texts: candidates.map((c) => paperEmbedText(c.title, c.abstract)),
    embedUrl: EMBED_URL,
    cacheUrl: CACHE_URL,
    onProgress: (done, total) => setStatus(`Embedding ${done}/${total} papers…`),
  });
  return {
    candidates: candidates.map((c, i) => ({ ...c, vec: centreUnit(vectors[i], state.corpus.mean) })),
    failures,
  };
}

async function dig() {
  if (state.busy) return;
  state.busy = true;
  const button = byId('sv-dig');
  button.disabled = true;
  try {
    await ensureCorpus();
    await ensureTouchstones();

    let dug = null;
    baggage = '';
    try {
      dug = await haul();
      if (dug.failures && dug.failures.length) {
        baggage = ' (some categories failed: ' + dug.failures.join('; ') + ')';
      }
    } catch (err) {
      /* Demo mode reads the papers out of the corpus it just built, so the page
         works with the relay down as well as with no corpus at all. */
      if (!state.demo) throw err;
      dug = { candidates: demoCandidates(state.corpus), failures: [] };
      baggage = ' · sample papers, no network';
    }

    state.candidates = dug.candidates;
    rerank();
  } catch (err) {
    setStatus((err && err.message) || String(err), 'error');
  } finally {
    state.busy = false;
    button.disabled = false;
  }
}

/* ── Refine with AI ─────────────────────────────────────────────────────── */

/**
 * One card, one call. The paper and its neighbours are what the refiner reads;
 * the touchstones are the reader's own words, sent with the request and not
 * stored anywhere. `x-llm-key` is only set when a key was typed in this tab.
 */
async function refine(button) {
  const id = button.dataset.refine;
  const item = state.ranked.find((r) => r.id === id);
  if (!item) return;
  const out = byId('sv-refine-' + id);
  button.disabled = true;
  out.innerHTML = '<p class="sv-hint">Asking…</p>';

  const headers = { 'Content-Type': 'application/json' };
  if (state.llmKey) headers['x-llm-key'] = state.llmKey;

  try {
    const resp = await fetch(REFINE_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        paper: { title: item.title, abstract: item.abstract || '' },
        neighbours: (item.landmarks || []).slice(0, 5).map((l) => ({ title: l.title, pct: l.pct })),
        touchstones: touchstoneTexts().map(cacheKeyText),
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

/* ── wiring ─────────────────────────────────────────────────────────────── */

function wire() {
  /* Delegated: the topic sliders and the results are re-rendered as the reader
     digs, and one listener on the container outlives all of them. */
  app.addEventListener('input', (event) => {
    const el = event.target;

    if (el.id === 'sv-key') {
      state.llmKey = el.value.trim();       // memory only — deliberately not persisted
      return;
    }
    if (el.id === 'sv-gate') state.gate = Number(el.value);
    else if (el.id === 'sv-surprise') state.surprise = Number(el.value);
    else if (el.dataset.cluster !== undefined) state.weights[el.dataset.cluster] = Number(el.value);
    else if (el.id === 'sv-lookback') {
      state.lookback = Math.min(7, Math.max(1, Number(el.value) || 1));
      persist();
      return;
    } else if (el.classList.contains('sv-touch')) {
      persist();
      return;                               // words need a Dig to be embedded
    }
    renderSliderValues();
    scheduleRank();
  });

  app.addEventListener('click', (event) => {
    const drop = event.target.closest('[data-drop-cat]');
    if (drop) {
      state.categories = state.categories.filter((c) => c !== drop.dataset.dropCat);
      renderChips();
      persist();
      return;
    }
    const refineButton = event.target.closest('button.sv-refine');
    if (refineButton) {
      refine(refineButton);
      return;
    }
    if (event.target.closest('#sv-add-touch')) {
      addTouchRow();
      return;
    }
    const remove = event.target.closest('.sv-drop');
    if (remove) {
      remove.closest('.sv-touch-row').remove();
      persist();
    }
  });

  byId('sv-cat-add').addEventListener('change', (event) => {
    const cat = event.target.value;
    if (!cat) return;
    if (!state.categories.includes(cat)) state.categories.push(cat);
    renderChips();
    persist();
  });

  byId('sv-dig').addEventListener('click', dig);
}

/* ── boot ───────────────────────────────────────────────────────────────── */

async function boot() {
  restore();
  wire();
  byId('sv-gate').value = state.gate;
  byId('sv-surprise').value = state.surprise;
  byId('sv-lookback').value = state.lookback;
  renderChips();
  await ensureCorpus();
  rerank();          // the empty state, so the results area is never a blank
  sayCorpus();
}

/* A page that cannot start must say so in its own status line rather than
   leaving a dead form behind. */
boot().catch((err) => setStatus('The page could not start: ' + ((err && err.message) || err), 'error'));
