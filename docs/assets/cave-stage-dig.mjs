/**
 * cave-stage-dig — stages 1 and 2 of the v4 page: dig tonight's announcement,
 * then ride the haul train while the abstracts are cut into vectors.
 *
 * WHY TWO STAGES, ONE FILE. They are one press. The form lives in the Dig card
 * and the train lives in the Train card, but the only way to start the train
 * is Dig, and the only thing Dig produces is what the train fills with. Two
 * files would need a third place to keep the happen-stance between them; one
 * file keeps it in a single `ctx.haul` handle the two mounts pass each other.
 *
 * WHAT IS COPIED AND WHAT IS NEW. The scout and the embed are `sieve-ui`'s
 * (`fetchAnnouncement`, `embedCandidates`, the relay pacing and the shared
 * cache), unchanged, as v3's page used them. The train is `cave-train.mjs`,
 * which is `filter.js`'s drawing to the pixel. The category picker is Dig's
 * own list, copied from `filter.js`'s `ARXIV_CATEGORIES` with its default of
 * `cond-mat.mes-hall, quant-ph`, so the two pages dig the same archives by
 * default.
 *
 * THE NIGHT IS BUILT HERE, ONCE. Stones in the contract's shape, vectors
 * centred against the corpus mean (or against tonight's own mean when there is
 * no corpus), topics assigned when `topics.json` loaded, then `night` on the
 * bus. Every later stage reads that one object and nothing else.
 *
 * NIGHTS ARE NOT PERSISTED. The flow remembers which stage you reached; the
 * papers themselves would be a few megabytes of localStorage for a night that
 * arXiv re-announces tomorrow. A reload after a dig therefore opens the map on
 * an empty night, and the map says to dig again.
 */
import { assignTopics, centreUnit } from './sieve-core.mjs';
import {
  createRelay, embedCandidates, escapeHtml, fetchAnnouncement, paperEmbedText, readStore, writeStore,
} from './sieve-ui.mjs';
import { startHaulTrain } from './cave-train.mjs';

/** The categories Dig opens with, and the ones the warm-dig run pre-cuts. */
export const DEFAULT_CATEGORIES = 'cond-mat.mes-hall, quant-ph';

/** Where the form's three settings are remembered between visits. */
const FORM_KEY = 'arxave-cave-dig';

/**
 * The one-line summary stage 1 folds to: what was scouted and how far back.
 * Shared by the head's summary and the rail, so it is built once, here.
 */
export function digSummary(cats, lookback) {
  const list = Array.isArray(cats) ? cats.join(', ') : String(cats ?? '').trim();
  const days = Math.max(1, Math.round(Number(lookback) || 1));
  return `${list} · last ${days} ${days === 1 ? 'day' : 'days'}`;
}

/**
 * The mean of a set of unit vectors — the centring convention's fallback when
 * there is no corpus mean to subtract (a build without a corpus, or a dim
 * mismatch). Not divided by the norm: `centreUnit` renormalises what it
 * produces, and the corpus' own `mean` is an unnormalised mean too.
 */
export function meanVector(vectors) {
  if (!Array.isArray(vectors) || vectors.length === 0) return new Float32Array(0);
  const dim = vectors[0].length;
  const mean = new Float32Array(dim);
  for (const vec of vectors) {
    for (let k = 0; k < dim; k += 1) mean[k] += vec[k];
  }
  for (let k = 0; k < dim; k += 1) mean[k] /= vectors.length;
  return mean;
}

/** Split the categories field the way filter.js does. */
function categoryList(text) {
  return String(text || '').split(',').map((c) => c.trim()).filter(Boolean);
}

/** A whole number in range, from an input's string value. */
function whole(raw, lo, hi, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}
/* arXiv categories, for the picker. Grouped the way arXiv groups them, so the
   list reads like the listing pages. Not exhaustive on purpose — the dead
   archives and the long tail would bury the ones people scout — and "Other…"
   takes any code by hand for whatever is missing. Copied from
   docs/assets/filter.js (ARXIV_CATEGORIES); the popular group is repeated at
   the top because a haul of those is a cache lookup rather than a minute of
   local embedding. */
export const ARXIV_CATEGORIES = [
  ['Popular — cached, fast', [
    ['quant-ph', 'Quantum physics'],
    ['cs.AI', 'Artificial intelligence'],
    ['cs.LG', 'Machine learning'],
    ['cond-mat.mes-hall', 'Mesoscale and nanoscale physics'],
    ['cond-mat.str-el', 'Strongly correlated electrons'],
  ]],
  ['Physics — condensed matter', [
    ['cond-mat.mes-hall', 'Mesoscale and nanoscale physics'],
    ['cond-mat.mtrl-sci', 'Materials science'],
    ['cond-mat.str-el', 'Strongly correlated electrons'],
    ['cond-mat.supr-con', 'Superconductivity'],
    ['cond-mat.quant-gas', 'Quantum gases'],
    ['cond-mat.stat-mech', 'Statistical mechanics'],
    ['cond-mat.soft', 'Soft condensed matter'],
    ['cond-mat.dis-nn', 'Disordered systems and neural networks'],
    ['cond-mat.other', 'Other condensed matter'],
  ]],
  ['Physics — quantum, optics, atomic', [
    ['quant-ph', 'Quantum physics'],
    ['physics.optics', 'Optics'],
    ['physics.atom-ph', 'Atomic physics'],
    ['physics.app-ph', 'Applied physics'],
    ['physics.ins-det', 'Instrumentation and detectors'],
    ['physics.comp-ph', 'Computational physics'],
    ['physics.chem-ph', 'Chemical physics'],
    ['physics.plasm-ph', 'Plasma physics'],
  ]],
  ['Physics — high energy, gravity, astro', [
    ['hep-th', 'High energy physics — theory'],
    ['hep-ph', 'High energy physics — phenomenology'],
    ['hep-ex', 'High energy physics — experiment'],
    ['hep-lat', 'High energy physics — lattice'],
    ['gr-qc', 'General relativity and quantum cosmology'],
    ['nucl-th', 'Nuclear theory'],
    ['nucl-ex', 'Nuclear experiment'],
    ['astro-ph.CO', 'Cosmology and nongalactic astrophysics'],
    ['astro-ph.GA', 'Astrophysics of galaxies'],
    ['astro-ph.HE', 'High energy astrophysical phenomena'],
    ['astro-ph.IM', 'Instrumentation and methods for astrophysics'],
    ['astro-ph.SR', 'Solar and stellar astrophysics'],
    ['nlin.CD', 'Chaotic dynamics'],
    ['nlin.PS', 'Pattern formation and solitons'],
  ]],
  ['Computer science', [
    ['cs.LG', 'Machine learning'],
    ['cs.AI', 'Artificial intelligence'],
    ['cs.CL', 'Computation and language'],
    ['cs.CV', 'Computer vision and pattern recognition'],
    ['cs.CR', 'Cryptography and security'],
    ['cs.DS', 'Data structures and algorithms'],
    ['cs.CC', 'Computational complexity'],
    ['cs.DC', 'Distributed and cluster computing'],
    ['cs.ET', 'Emerging technologies'],
    ['cs.IT', 'Information theory'],
    ['cs.NE', 'Neural and evolutionary computing'],
    ['cs.RO', 'Robotics'],
    ['cs.SE', 'Software engineering'],
  ]],
  ['Mathematics', [
    ['math.AP', 'Analysis of PDEs'],
    ['math.CO', 'Combinatorics'],
    ['math.DS', 'Dynamical systems'],
    ['math.FA', 'Functional analysis'],
    ['math.MP', 'Mathematical physics'],
    ['math.NA', 'Numerical analysis'],
    ['math.OC', 'Optimization and control'],
    ['math.PR', 'Probability'],
    ['math.QA', 'Quantum algebra'],
    ['math.ST', 'Statistics theory'],
  ]],
  ['Statistics, EE, quantitative', [
    ['stat.ML', 'Machine learning (stats)'],
    ['stat.ME', 'Methodology'],
    ['stat.AP', 'Applications'],
    ['eess.SP', 'Signal processing'],
    ['eess.SY', 'Systems and control'],
    ['eess.IV', 'Image and video processing'],
    ['q-bio.BM', 'Biomolecules'],
    ['q-bio.NC', 'Neurons and cognition'],
    ['q-fin.ST', 'Statistical finance'],
    ['econ.EM', 'Econometrics'],
  ]],
];

/* ── stage 2: the train ─────────────────────────────────────────────────── */

/**
 * Mount the haul train in the Train card and hand the dig a handle to it.
 *
 * The wrap is filter.md's, class for class (`progress-wrap train-wrap` with a
 * `progress-label` under a `haul-train` canvas), so filter.css styles it and
 * `startHaulTrain` measures it. The train is started on `begin`, not on mount:
 * `startHaulTrain` sizes itself from the wrap's width, and a hidden wrap has
 * no width to measure.
 */
export function mountTrain(body, ctx) {
  if (!body || !ctx) return;
  body.innerHTML =
    '<div class="progress-wrap train-wrap cave-haul-wrap" id="haul-progress-wrap" style="display:none">' +
      '<canvas class="haul-train" id="haul-train" aria-hidden="true"></canvas>' +
      '<span class="progress-label" id="haul-label" role="status"></span>' +
    '</div>' +
    '<p class="cave-train-hint">The train fills as tonight\'s abstracts are cut into vectors.</p>';

  const wrap = body.querySelector('.cave-haul-wrap');
  const canvas = body.querySelector('.haul-train');
  const label = body.querySelector('.progress-label');
  let train = null;

  ctx.haul = {
    /** Show the wrap and lay the train out for a new haul. */
    begin(text) {
      wrap.style.display = '';
      if (label) label.textContent = text || '';
      if (train) train.stop();
      train = startHaulTrain(canvas);
    },
    /** Relay the haul's progress; the label follows if given one. */
    set(done, total, text) {
      if (train) train.set(done, total);
      if (label && text) label.textContent = text;
    },
    say(text) {
      if (label) label.textContent = text || '';
    },
    /** Hide the wrap and stop asking for frames. */
    stop() {
      if (train) train.stop();
      train = null;
      wrap.style.display = 'none';
    },
  };
}


/* ── stage 1: dig ───────────────────────────────────────────────────────── */

/**
 * Mount the Dig form and wire the whole haul.
 *
 * The form is three things — the category chips, the lookback, the max — and
 * one button, which is Dig's `scout` block reduced to what a staged page
 * needs (the touchstones and the claims belong to later stages). Pressing Dig
 * completes stage 1 immediately with a line saying what it is digging, because
 * the train is now the stage to watch; a failure reopens stage 1 with the
 * reason under the button rather than leaving a folded card that says it
 * worked.
 */
export function mountDig(body, ctx) {
  if (!body || !ctx) return;

  const saved = readStore(ctx.storage, FORM_KEY, null) || {};
  const startCats = categoryList(saved.categories).length
    ? categoryList(saved.categories)
    : categoryList(DEFAULT_CATEGORIES);
  const lookback0 = whole(saved.lookback, 1, 7, 1);
  const max0 = whole(saved.maxResults, 10, 1000, 200);

  body.innerHTML =
    '<form class="cave-dig" novalidate>' +
      '<div class="cave-field">' +
        '<span class="cave-field-label">arXiv categories</span>' +
        '<div class="cat-chips" role="group" aria-label="arXiv categories"></div>' +
        '<select class="cat-add" aria-label="Add an arXiv category"></select>' +
        /* The field stays the source of truth: the chips and the picker write
           into it, and a restored form reads it back, exactly as on Dig. */
        '<input type="hidden" class="cave-categories" value="' +
          escapeHtml(startCats.join(', ')) + '">' +
      '</div>' +
      '<div class="role-grid scout-grid">' +
        '<label>Lookback (days)' +
          '<input type="number" class="cave-lookback" value="' + lookback0 +
            '" min="1" max="7" step="1" inputmode="numeric">' +
        '</label>' +
        '<label>Max results' +
          '<input type="number" class="cave-max" value="' + max0 +
            '" min="10" max="1000" step="10" inputmode="numeric">' +
        '</label>' +
      '</div>' +
      '<div class="button-bar">' +
        '<button type="submit" class="cave-dig-btn cave-primary">Dig</button>' +
        '<span class="stage-status" role="status"></span>' +
      '</div>' +
    '</form>';

  const form = body.querySelector('.cave-dig');
  const chips = body.querySelector('.cat-chips');
  const add = body.querySelector('.cat-add');
  const catsInput = body.querySelector('.cave-categories');
  const lookbackEl = body.querySelector('.cave-lookback');
  const maxEl = body.querySelector('.cave-max');
  const btn = body.querySelector('.cave-dig-btn');
  const statusEl = body.querySelector('.stage-status');
  const relay = createRelay({ relayBase: ctx.config.relayUrl });
  let busy = false;

  const categories = () => categoryList(catsInput.value);

  function say(text, isError = false) {
    statusEl.textContent = text || '';
    statusEl.classList.toggle('cave-dig-error', !!isError);
  }

  function saveForm() {
    if (!ctx.storage) return;
    writeStore(ctx.storage, FORM_KEY, {
      categories: catsInput.value,
      lookback: whole(lookbackEl.value, 1, 7, 1),
      maxResults: whole(maxEl.value, 10, 1000, 200),
    });
  }

  /** Human name for a category code, '' if it is not one of the listed ones. */
  function categoryName(code) {
    for (const [, rows] of ARXIV_CATEGORIES) {
      for (const [value, label] of rows) if (value === code) return label;
    }
    return '';
  }

  function renderChips() {
    chips.innerHTML = categories().map((code) => {
      const name = categoryName(code);
      return '<span class="cat-chip"' + (name ? ' title="' + escapeHtml(name) + '"' : '') + '>' +
        '<span class="cat-chip-code">' + escapeHtml(code) + '</span>' +
        '<button type="button" class="cat-chip-x" data-code="' + escapeHtml(code) +
          '" aria-label="Remove ' + escapeHtml(code) + '">×</button></span>';
    }).join('');
  }

  function setCategories(list) {
    const seen = new Set();
    const unique = list.filter((code) => {
      if (!code || seen.has(code)) return false;
      seen.add(code);
      return true;
    });
    catsInput.value = unique.join(', ');
    renderChips();
    saveForm();
  }

  function buildSelect() {
    let html = '<option value="">+ Add a category…</option>';
    for (const [group, rows] of ARXIV_CATEGORIES) {
      html += '<optgroup label="' + escapeHtml(group) + '">';
      for (const [value, label] of rows) {
        html += '<option value="' + escapeHtml(value) + '">' +
          escapeHtml(value) + ' — ' + escapeHtml(label) + '</option>';
      }
      html += '</optgroup>';
    }
    html += '<option value="__other__">Other — type a code…</option>';
    add.innerHTML = html;
  }

  async function dig() {
    if (busy) return;
    const cats = categories();
    if (!cats.length) {
      say('Pick at least one arXiv category first.', true);
      return;
    }
    const lookback = whole(lookbackEl.value, 1, 7, 1);
    const maxResults = whole(maxEl.value, 10, 1000, 200);
    lookbackEl.value = String(lookback);
    maxEl.value = String(maxResults);
    saveForm();

    busy = true;
    btn.disabled = true;
    say('');
    if (ctx.notice) ctx.notice('');
    /* The card the reader is on folds to its summary, the train opens, and
       everything after this point is stale until the new night lands. */
    ctx.night = null;
    ctx.flow.invalidateFrom('train');
    ctx.flow.complete('dig', digSummary(cats, lookback));
    const haul = ctx.haul;
    if (haul) haul.begin('Scouting arXiv…');
    say('Scouting arXiv…');

    try {
      const { candidates, failures } = await fetchAnnouncement({
        categories: cats,
        lookback,
        maxResults,
        fetchViaRelay: relay,
      });
      if (!candidates.length) throw new Error('Tonight\'s announcement came back empty.');

      say(`Embedding ${candidates.length} papers…`);
      if (haul) haul.say(`Embedding ${candidates.length} abstracts…`);
      const vectors = await embedCandidates({
        texts: candidates.map((c) => paperEmbedText(c.title, c.abstract)),
        embedUrl: ctx.config.embedUrl,
        cacheUrl: ctx.config.cacheUrl,
        onProgress: (done, total) => {
          if (haul) haul.set(done, total, `Stones hauled: ${done} / ${total}`);
        },
      });

      /* Centre against the corpus mean, the convention every cosine on this
         site reads (see sieve-core's centreUnit). A build with no corpus still
         gets a night: tonight's own mean is the honest fallback, and the map
         works on those vectors all the same. */
      const mean = ctx.corpus && ctx.corpus.mean && ctx.corpus.mean.length === vectors[0].length
        ? ctx.corpus.mean
        : meanVector(vectors);
      const vecs = vectors.map((vec) => centreUnit(vec, mean));

      const stones = candidates.map((c) => ({
        id: c.id,
        title: c.title,
        abstract: c.abstract,
        authors: c.authors || [],
        cat: c.primary_category || '',
        link: c.abs_url || '',
      }));

      const topic = new Int32Array(stones.length).fill(-1);
      const topic2 = new Int32Array(stones.length).fill(-1);
      if (ctx.topics) {
        for (let i = 0; i < stones.length; i += 1) {
          const assigned = assignTopics(vecs[i], ctx.topics);
          topic[i] = assigned.topic;
          topic2[i] = assigned.topic2;
        }
      }

      const night = {
        date: new Date().toISOString().slice(0, 10),
        categories: cats,
        stones,
        vecs,
        topic,
        topic2,
        components: [],
        names: [],
      };
      ctx.night = night;
      ctx.bus.dispatchEvent(new CustomEvent('night', { detail: night }));
      ctx.flow.complete('train', stones.length === 1 ? '1 paper' : `${stones.length} papers`);
      if (haul) haul.stop();

      /* A category that failed is worth one line, not an error: the night is
         still a night, it is just missing one archive. The Dig card has just
         folded, so the line goes on the page notice above the cards. */
      if (failures.length) {
        const line = `${failures.length} feed${failures.length === 1 ? '' : 's'} failed: ${failures.join(' | ')}`;
        if (ctx.notice) ctx.notice(line);
        else say(line);
      }
    } catch (err) {
      const message = (err && err.message) || String(err);
      if (haul) haul.stop();
      /* Nothing was hauled, so the night is not where the flow says it is:
         reopen the Dig card and put the reason under its own button. */
      ctx.flow.invalidateFrom('dig');
      say(message, true);
    } finally {
      busy = false;
      btn.disabled = false;
    }
  }

  /* ── the form's wiring ─────────────────────────────────────────────── */

  buildSelect();
  renderChips();

  add.addEventListener('change', () => {
    let value = add.value;
    add.value = '';
    if (!value) return;
    if (value === '__other__') {
      const typed = window.prompt('arXiv category code (e.g. cond-mat.mes-hall)');
      if (!typed) return;
      value = typed.trim();
      if (!value) return;
    }
    setCategories(categories().concat([value]));
  });

  chips.addEventListener('click', (event) => {
    const x = event.target.closest ? event.target.closest('.cat-chip-x') : null;
    if (!x) return;
    const code = x.getAttribute('data-code');
    setCategories(categories().filter((c) => c !== code));
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    dig();
  });

  lookbackEl.addEventListener('change', saveForm);
  maxEl.addEventListener('change', saveForm);
}


