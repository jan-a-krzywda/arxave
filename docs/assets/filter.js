/**
 * arxave filter — staged Dig pipeline.
 *
 * Three stages, each with its own button, output, and resumable state:
 *   1. Haul the stones   — scout arXiv + embed abstracts + coupling map
 *   2. Filter            — sharpen the pick, then free text + core samples
 *   3. Assay             — (k+1)×N matrix with live re-blend
 *
 * Dependencies: none. Runs in the browser, no bundler.
 */
(function () {
  'use strict';

  // ── Constants ────────────────────────────────────────────────────
  const FUNCTIONS_BASE = 'https://ugxxakguqgpxpdfhgtsb.supabase.co/functions/v1';
  const RELAY_URL = window.ARXAVE_RELAY || (FUNCTIONS_BASE + '/relay');
  /* The shared vector cache. Set window.ARXAVE_DIG_CACHE = false to opt out and
     embed everything locally — the page works either way, just slower. */
  const CACHE_URL = window.ARXAVE_DIG_CACHE === false ? null
    : (window.ARXAVE_DIG_CACHE || (FUNCTIONS_BASE + '/dig-cache'));
  /* Wagon naming. Set window.ARXAVE_WAGON_NAME = false to hide the button
     entirely — the train works unnamed, which is what it did before this
     existed. */
  const NAME_URL = window.ARXAVE_WAGON_NAME === false ? null
    : (window.ARXAVE_WAGON_NAME || (FUNCTIONS_BASE + '/wagon-name'));
  const NAME_MAX_WAGONS = 24;     // must match MAX_WAGONS in wagon-name/naming.ts
  const TRANSFORMERS_VERSION = '3.7.6';
  const TRANSFORMERS_URLS = [
    'https://cdn.jsdelivr.net/npm/@huggingface/transformers@' + TRANSFORMERS_VERSION,
    'https://unpkg.com/@huggingface/transformers@' + TRANSFORMERS_VERSION,
    'https://esm.sh/@huggingface/transformers@' + TRANSFORMERS_VERSION,
  ];
  const LOCAL_MODEL = 'Xenova/bge-small-en-v1.5';
  const LOCAL_DIM = 384;
  /* Two batch sizes, because the two paths pay for size differently. In the
     worker the extractor blocks a thread nobody is watching, so batches are
     sized for throughput alone — bigger is faster per abstract. On the main
     thread the batch size *is* the length of the freeze (one extractor call is
     synchronous WASM; nothing paints until it returns), so the fallback trades
     throughput for a page that still moves. */
  const WORKER_BATCH = 16;
  const INLINE_BATCH = 4;
  /* The worker sits next to this file, wherever this file was served from —
     read off the script tag rather than hard-coded, so the page works from a
     Jekyll baseurl, a local server or a file:// checkout alike. */
  const WORKER_URL = (function () {
    var src = (document.currentScript && document.currentScript.src) || '';
    return src ? src.replace(/[^/]*(\?.*)?$/, 'embed-worker.js') : 'assets/embed-worker.js';
  })();
  const CACHE_READ_CHUNK = 500;   // stays under dig-cache's MAX_SHAS
  const OPENALEX_MAILTO = 'arxiv-filter@example.com';

  /* arXiv categories, for the picker. Grouped the way arXiv groups them, so
     the dropdown reads like the listing pages. Not exhaustive on purpose —
     the dead archives and the long tail would bury the ones people scout —
     and "Other…" takes any code by hand for whatever is missing. */
  const ARXIV_CATEGORIES = [
    /* The codes the nightly warm-dig run pre-cuts (scripts/warm-dig.mjs, run by
       .github/workflows/warm-dig.yml off the ARXAVE_WARM_CATEGORIES variable),
       repeated at the top: a haul of these is a cache lookup, seconds rather
       than a minute of local embedding. Keep this group in step with that
       variable or the label starts lying. Adding one is deduped against the
       list, so picking it here or below is the same. */
    ['Popular — cached, fast', [
      ['quant-ph', 'Quantum physics'],
      ['cs.AI', 'Artificial intelligence'],
      ['cs.LG', 'Machine learning'],
      ['cond-mat.mes-hall', 'Mesoscale and nanoscale physics'],
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

  /** Human name for a code, or '' if it is not one of the listed ones. */
  function categoryName(code) {
    for (var g = 0; g < ARXIV_CATEGORIES.length; g++) {
      var rows = ARXIV_CATEGORIES[g][1];
      for (var i = 0; i < rows.length; i++) {
        if (rows[i][0] === code) return rows[i][1];
      }
    }
    return '';
  }

  // ── DOM helpers ──────────────────────────────────────────────────
  function byId(id) { return document.getElementById(id); }

  // Row-id counters. Ids are per-session handles that tie a DOM row to its
  // record; they are never part of a claim, so a loaded claim mints fresh ones.
  var touchstoneCounter = 0;
  var coreCounter = 0;

  // ── State ─────────────────────────────────────────────────────────
  /* `state` is the single source of truth for everything the user sets. The
     DOM renders from it and writes back into it; nothing reads a control's
     value to decide a number. That is what makes a claim (§ Claims below)
     serializable at all — before this, weights lived only in the DOM and
     died on reload. */
  const state = {
    extractor: null,        // transformers.js pipeline
    modelLoaded: false,
    stones: [],             // [{arxiv_id, title, abstract, authors, primary_category, published, abs_url, pdf_url}]
    A: null,                // [N × d] abstract vectors, row-major, L2-normalized
    // ── claim-owned (saved, restored, exportable) ──
    scout: { categories: 'cond-mat.mes-hall, quant-ph', lookback: 1, max_results: 200 },
    blend: { paydirt_n: 10 },
    /* The gate — see "The gate" below. Same four names a preset file's
       `select` block carries, so a claim and a preset stay one shape. */
    select: { min_z: 2.0, min_items: 3, soft_z: 1.0, max_items: 15 },
    touchstones: [],        // [{id, text, weight, vector}]  free text
    cores: [],              // [{id, doi, weight, title, abstract, vector, status, weak}]
    claimSlug: 'working',   // key into the saved-claims map
    // ── derived / runtime (never saved) ──
    featureVectors: null,   // [k × d] row-major, unit vectors
    /* featureVectors rows are: touchstones[0..kk-1], then cores[0..kp-1], then rush (null) */
    grades: null,           // [N] blended scores
    order: null,            // [N] indices into stones, sorted by grade desc
    wagonOrder: null,        // [N] indices into stones, sorted by cluster
    wagonMap: null,          // [N×N] cosine matrix (upper triangle populated)
    wagonComponents: null,   // [{indices: [int], centralTitle: string, key, name, gloss}]
    wagonNames: {},          // wagon key → {name, gloss}, kept across thresholds
    wagonNaming: false,      // a naming request is in flight
    wagonView: 'table',      // 'table' | 'graph' | 'matrix'
    wagonThresh: 0.75,       // live-tunable, starts at WAGON_THRESH
    wagonGraph: null,        // live graph handle for the inline canvas
    wagonModalGraph: null,   // live graph handle for the modal canvas
    haulTrain: null,        // live handle for stage 1's mine-train progress
    hauledFromCache: 0,     // stones whose vector came from the shared cache
  };

  // ── Persistence ───────────────────────────────────────────────────
  function lsKey(base) { return 'arxave-dig-' + base; }

  function saveCoreCache() {
    try { localStorage.setItem(lsKey('core-cache'), JSON.stringify(state._coreCache || {})); } catch (_) {}
  }

  function loadCoreCache() {
    /* Fetched-and-embedded core samples, keyed by doi|model|dim. Not part of a
       claim — it is a cache of work, shared across every claim, and it is the
       reason loading a claim with ten core samples is instant rather than ten
       OpenAlex round-trips plus ten embeddings. */
    try {
      var cv = localStorage.getItem(lsKey('core-cache'));
      state._coreCache = cv ? JSON.parse(cv) : {};
    } catch (_) { state._coreCache = {}; }
    if (!state._coreCache) state._coreCache = {};
  }

  // ═══════════════════════════════════════════════════════════════════
  // Claims — a named, saved setup
  // ═══════════════════════════════════════════════════════════════════
  /*
   * A claim is everything the user chose: scout window, touchstones, core
   * samples, weights. It is deliberately *slim* — no vectors, no abstracts,
   * no titles. Those are all re-derivable (vectors by re-embedding, the rest
   * from OpenAlex via the core cache above), and keeping them out is what
   * makes a claim small enough to hand to someone as a file or a link.
   *
   * `arxave_claim` is a schema version, not decoration: a v2 that changes the
   * shape can migrate a v1 instead of throwing a stack trace at someone whose
   * only mistake was saving a setup last month.
   */
  const CLAIM_VERSION = 1;
  const CLAIMS_KEY = lsKey('claims');
  const CURRENT_KEY = lsKey('current');
  const WORKING_SLUG = 'working';
  /* The unnamed slot everyone starts in. The slug stays 'working' — it is in
     everyone's localStorage — but the label people read is what the slot is:
     the dig you are setting up right now. */
  const WORKING_NAME = 'Dig Setup';
  const LEGACY_WORKING_NAME = 'Working claim';

  /* The gate's defaults, and the only place they are written down. They match
     `selectItems` in scripts/preset-feed.mjs exactly — a claim that says
     nothing about the gate must cut where the feed builder would. */
  const GATE_DEFAULTS = { min_z: 2.0, min_items: 3, soft_z: 1.0, max_items: 15 };

  function parseSelect(raw) {
    function num(v, dflt, lo, hi) {
      var f = parseFloat(v);
      if (!isFinite(f)) return dflt;
      return Math.min(hi, Math.max(lo, f));
    }
    var s = raw || {};
    return {
      min_z: num(s.min_z, GATE_DEFAULTS.min_z, 0, 4),
      min_items: Math.round(num(s.min_items, GATE_DEFAULTS.min_items, 0, 50)),
      soft_z: num(s.soft_z, GATE_DEFAULTS.soft_z, 0, 4),
      max_items: Math.round(num(s.max_items, GATE_DEFAULTS.max_items, 1, 50)),
    };
  }

  function slugify(name) {
    var s = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '').substring(0, 48);
    return s || 'claim';
  }

  function serializeClaim(name) {
    return {
      arxave_claim: CLAIM_VERSION,
      name: name || WORKING_NAME,
      saved: new Date().toISOString().substring(0, 10),
      scout: {
        categories: state.scout.categories,
        lookback_days: state.scout.lookback,
        max_results: state.scout.max_results,
      },
      touchstones: state.touchstones.map(function (t) {
        /* Provenance persists with the row. Without it a reload turns every
           preset phrase back into typed text — safe, but it re-embeds six
           phrases the cache already holds, which is the whole point of a
           preset. Losing the flag can only ever cost speed, never disclosure. */
        return { text: t.text, weight: t.weight, preset: t.preset || undefined };
      }),
      cores: state.cores.map(function (c) {
        return { doi: c.doi, weight: c.weight };
      }),
      blend: {
        paydirt_n: state.blend.paydirt_n,
      },
      select: {
        min_z: state.select.min_z,
        min_items: state.select.min_items,
        soft_z: state.select.soft_z,
        max_items: state.select.max_items,
      },
    };
  }

  function loadClaims() {
    try {
      var raw = localStorage.getItem(CLAIMS_KEY);
      var map = raw ? (JSON.parse(raw) || {}) : {};
      /* Anyone who used the page before the rename has the old label sitting in
         their storage; the slot is the same slot, so relabel it in passing
         rather than leaving two names for one thing. A slot the user named
         themselves is never touched. */
      if (map[WORKING_SLUG] && map[WORKING_SLUG].name === LEGACY_WORKING_NAME) {
        map[WORKING_SLUG].name = WORKING_NAME;
      }
      return map;
    } catch (_) { return {}; }
  }

  function writeClaims(map) {
    try { localStorage.setItem(CLAIMS_KEY, JSON.stringify(map)); } catch (_) {}
  }

  /* Every edit lands in the current slot immediately. There is no unsaved
     state to lose and no "did I press save?" — "Save as" only ever *forks* a
     new slot, it is not the thing that makes an edit durable. */
  function autosave() {
    var map = loadClaims();
    var existing = map[state.claimSlug];
    map[state.claimSlug] = serializeClaim(existing ? existing.name : WORKING_NAME);
    writeClaims(map);
    try { localStorage.setItem(CURRENT_KEY, state.claimSlug); } catch (_) {}
  }

  function applyClaim(claim) {
    /* Claim → state → DOM. Runtime fields (vectors, fetched titles) are reset;
       Stage 1's hauled stones are untouched, so switching claims re-assays the
       day you already hauled instead of making you haul it again. */
    if (!claim || typeof claim !== 'object') return;

    var sc = claim.scout || {};
    state.scout = {
      /* typeof, not ||: an empty category list is a real setting now that the
         picker can clear one, and must not silently fall back to the default. */
      categories: typeof sc.categories === 'string' ? sc.categories : state.scout.categories,
      lookback: parseInt(sc.lookback_days, 10) || 1,
      max_results: parseInt(sc.max_results, 10) || 200,
    };
    var bl = claim.blend || {};
    state.blend = {
      paydirt_n: parseInt(bl.paydirt_n, 10) || 10,
    };
    /* A preset file's own `select` block lands here, so loading a preset shows
       the cut its feed makes rather than the page's default one. */
    state.select = parseSelect(claim.select);

    /* Provenance, carried per row. A preset's phrases are text this repo
       published, so their hashes may go through the shared cache; anything the
       user types may not (docs/dig-spec.md §6c.3). The flag rides on the row
       rather than on the claim because the two mix the moment someone edits one
       row of a loaded preset. */
    var fromPreset = typeof claim.preset === 'string' ? claim.preset : null;

    state.touchstones = (claim.touchstones || []).map(function (t) {
      return {
        id: 'ts-' + (++touchstoneCounter),
        text: t.text || '',
        weight: isFinite(parseFloat(t.weight)) ? parseFloat(t.weight) : 1.0,
        vector: null,
        preset: (typeof t.preset === 'string' && t.preset) || fromPreset,
      };
    });
    state.cores = (claim.cores || []).map(function (c) {
      return {
        id: 'core-' + (++coreCounter),
        doi: c.doi || '',
        weight: isFinite(parseFloat(c.weight)) ? parseFloat(c.weight) : 1.0,
        title: '', abstract: '', vector: null, status: '', weak: false,
      };
    });

    renderClaimIntoDom();
  }

  function renderClaimIntoDom() {
    byId('categories').value = state.scout.categories;
    renderCategoryChips();
    byId('lookback').value = state.scout.lookback;
    byId('max-results').value = state.scout.max_results;
    byId('paydirt-n').value = state.blend.paydirt_n;
    renderGateInputs();

    byId('touchstones-list').innerHTML = '';
    byId('cores-list').innerHTML = '';
    for (var i = 0; i < state.touchstones.length; i++) {
      renderTouchstoneRow(state.touchstones[i]);
    }
    for (var j = 0; j < state.cores.length; j++) {
      renderCoreRow(state.cores[j]);
      if (state.cores[j].doi) resolveCore(state.cores[j].id);
    }
    syncPresetSelection();
  }

  // ═══════════════════════════════════════════════════════════════════
  // Category picker — chips over a hidden `#categories` field
  // ═══════════════════════════════════════════════════════════════════
  /* Codes are still stored as the one comma-separated string a claim carries,
     so an exported claim from before the picker still loads. The chips are a
     view of that string; add and remove rewrite it. */

  function categoryList() {
    return state.scout.categories.split(',')
      .map(function (c) { return c.trim(); })
      .filter(function (c) { return c.length > 0; });
  }

  function setCategoryList(codes) {
    // Dedupe, keeping first-added order — the scout sends them as one query.
    var seen = {};
    var out = [];
    for (var i = 0; i < codes.length; i++) {
      var c = codes[i].trim();
      if (c && !seen[c]) { seen[c] = 1; out.push(c); }
    }
    state.scout.categories = out.join(', ');
    byId('categories').value = state.scout.categories;
    renderCategoryChips();
    markHaulStale();
    autosave();
  }

  /* A haul is bound to the scout settings it ran with. Change them and the
     hauled stones are the wrong ones — say so, and offer the button back. */
  function markHaulStale() {
    var btn = byId('haul-btn');
    if (!btn || !state.stones.length) return;
    btn.disabled = false;
    btn.classList.remove('is-done');
    btn.textContent = '🪨 Haul again';
    var statusEl = byId('haul-status');
    statusEl.textContent = 'Scout changed — haul again to pick it up.';
    statusEl.style.color = 'var(--text-dim)';
  }

  function renderCategoryChips() {
    var wrap = byId('cat-chips');
    if (!wrap) return;
    var codes = categoryList();
    if (codes.length === 0) {
      wrap.innerHTML = '<span class="cat-empty">No categories — add one below.</span>';
      return;
    }
    var html = '';
    for (var i = 0; i < codes.length; i++) {
      var name = categoryName(codes[i]);
      html += '<span class="cat-chip"' + (name ? ' title="' + escapeHtml(name) + '"' : '') + '>' +
        '<span class="cat-chip-code">' + escapeHtml(codes[i]) + '</span>' +
        '<button type="button" class="cat-chip-x" data-code="' + escapeHtml(codes[i]) +
        '" aria-label="Remove ' + escapeHtml(codes[i]) + '">×</button></span>';
    }
    wrap.innerHTML = html;
  }

  function buildCategorySelect() {
    var sel = byId('cat-add');
    if (!sel) return;
    var html = '<option value="">+ Add a category…</option>';
    for (var g = 0; g < ARXIV_CATEGORIES.length; g++) {
      html += '<optgroup label="' + escapeHtml(ARXIV_CATEGORIES[g][0]) + '">';
      var rows = ARXIV_CATEGORIES[g][1];
      for (var i = 0; i < rows.length; i++) {
        html += '<option value="' + escapeHtml(rows[i][0]) + '">' +
          escapeHtml(rows[i][0]) + ' — ' + escapeHtml(rows[i][1]) + '</option>';
      }
      html += '</optgroup>';
    }
    html += '<option value="__other__">Other — type a code…</option>';
    sel.innerHTML = html;
  }

  function wireCategoryPicker() {
    buildCategorySelect();
    renderCategoryChips();

    byId('cat-add').addEventListener('change', function () {
      var v = this.value;
      this.value = '';
      if (!v) return;
      if (v === '__other__') {
        var typed = window.prompt('arXiv category code (e.g. cond-mat.mes-hall)');
        if (!typed) return;
        v = typed.trim();
        if (!v) return;
      }
      setCategoryList(categoryList().concat([v]));
    });

    byId('cat-chips').addEventListener('click', function (e) {
      var btn = e.target.closest('.cat-chip-x');
      if (!btn) return;
      var code = btn.getAttribute('data-code');
      setCategoryList(categoryList().filter(function (c) { return c !== code; }));
    });
  }

  /* Re-assay after a claim switch, but only if there is something to assay. */
  function reassay() {
    if (!state.A || !state.A.length) return Promise.resolve();
    return maybeEmbedFeatures().then(function () {
      computeGrades();
      renderAssay();
    });
  }

  function migrateLegacyState() {
    /* Pre-claims builds kept two flat keys and no weights. Fold them into the
       working claim once, then drop them, so an existing user's touchstones
       survive the upgrade instead of silently vanishing. */
    var map = loadClaims();
    if (Object.keys(map).length > 0) return map;

    function j(k) {
      try { var r = localStorage.getItem(lsKey(k)); return r ? JSON.parse(r) : null; }
      catch (_) { return null; }
    }
    var ts = j('touchstones') || [];
    var cs = j('cores') || [];
    if (!ts.length && !cs.length) return map;

    map[WORKING_SLUG] = {
      arxave_claim: CLAIM_VERSION,
      name: WORKING_NAME,
      saved: new Date().toISOString().substring(0, 10),
      scout: { categories: state.scout.categories, lookback_days: 1, max_results: 200 },
      touchstones: ts.map(function (t) { return { text: t.text || '', weight: 1.0 }; }),
      cores: cs.map(function (c) { return { doi: c.doi || '', weight: 1.0 }; }),
      blend: { paydirt_n: 10 },
      select: parseSelect(null),
    };
    writeClaims(map);
    try {
      localStorage.removeItem(lsKey('touchstones'));
      localStorage.removeItem(lsKey('cores'));
    } catch (_) {}
    return map;
  }

  function sanitizeClaim(raw, name) {
    /* Same shape serializeClaim produces, but built from untrusted JSON —
       every field is re-parsed and defaulted, nothing from the file is
       trusted as-is. */
    var sc = (raw && raw.scout) || {};
    var bl = (raw && raw.blend) || {};
    return {
      arxave_claim: CLAIM_VERSION,
      name: name,
      saved: new Date().toISOString().substring(0, 10),
      scout: {
        categories: sc.categories || '',
        lookback_days: parseInt(sc.lookback_days, 10) || 1,
        max_results: parseInt(sc.max_results, 10) || 200,
      },
      touchstones: ((raw && raw.touchstones) || []).map(function (t) {
        return {
          text: t.text || '',
          weight: isFinite(parseFloat(t.weight)) ? parseFloat(t.weight) : 1.0,
        };
      }),
      cores: ((raw && raw.cores) || []).map(function (c) {
        return {
          doi: c.doi || '',
          weight: isFinite(parseFloat(c.weight)) ? parseFloat(c.weight) : 1.0,
        };
      }),
      blend: { paydirt_n: parseInt(bl.paydirt_n, 10) || 10 },
      select: parseSelect(raw && raw.select),
    };
  }

  function exportClaim() {
    var map = loadClaims();
    var claim = map[state.claimSlug] || serializeClaim(WORKING_NAME);
    var blob = new Blob([JSON.stringify(claim, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = slugify(claim.name || 'claim') + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function importClaimFile(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var raw;
      try { raw = JSON.parse(reader.result); } catch (_) {
        setClaimStatus('Not valid JSON.');
        return;
      }
      if (!raw || typeof raw !== 'object' || raw.arxave_claim !== CLAIM_VERSION) {
        setClaimStatus('Not a claim file this version understands.');
        return;
      }
      var name = (raw.name || 'Imported claim').trim() || 'Imported claim';
      var map = loadClaims();
      var slug = slugify(name), base = slug, n = 2;
      while (map[slug]) { slug = base + '-' + (n++); }
      map[slug] = sanitizeClaim(raw, name);
      writeClaims(map);
      state.claimSlug = slug;
      try { localStorage.setItem(CURRENT_KEY, slug); } catch (_) {}
      applyClaim(map[slug]);
      renderClaimPicker();
      reassay();
      setClaimStatus('Imported “' + name + '”.');
    };
    reader.readAsText(file);
  }

  function renderClaimPicker() {
    var sel = byId('claim-select');
    if (!sel) return;
    var map = loadClaims();
    var slugs = Object.keys(map).sort(function (a, b) {
      if (a === WORKING_SLUG) return -1;
      if (b === WORKING_SLUG) return 1;
      return (map[a].name || a).localeCompare(map[b].name || b);
    });
    sel.innerHTML = slugs.map(function (s) {
      return '<option value="' + escapeHtml(s) + '"' +
        (s === state.claimSlug ? ' selected' : '') + '>' +
        escapeHtml(map[s].name || s) + '</option>';
    }).join('');
    byId('claim-delete').disabled = (state.claimSlug === WORKING_SLUG);
  }

  // ── Relay helper ──────────────────────────────────────────────────
  function relayBase() {
    var custom = byId('cors-proxy').value.trim();
    return custom || RELAY_URL;
  }
  function relayUrl(url) {
    var p = relayBase();
    if (p.endsWith('?') || p.endsWith('=')) return p + encodeURIComponent(url);
    if (p.indexOf('?') === -1) return p + '?url=' + encodeURIComponent(url);
    return p + '&url=' + encodeURIComponent(url);
  }
  function fetchViaRelay(url, opts) {
    return fetch(relayUrl(url), opts || {});
  }

  // ── escapeHtml ────────────────────────────────────────────────────
  function escapeHtml(str) {
    if (!str) return '';
    /* Every replacement but the last had lost its entity somewhere and was
       rewriting a character to itself. Titles and author names go into
       innerHTML and, since the wagon table, into title="…" attributes, so a
       stray < or " from arXiv would rewrite the markup around it. */
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* Author names arrive straight out of the .bbl, so a fair number still wear
     their TeX accents: \'Alvaro, Mois\es, {\o}. Strip the markup down to the
     bare letter — an unaccented A beats a stray backslash in a column this
     narrow. */
  function unTex(name) {
    return String(name)
      /* \'{a}, \"o, \v s … the accent command plus its (maybe braced) letter. */
      .replace(/\\[`'^"~=.uvHrcbdk]\s*\{?([A-Za-z])\}?/g, '$1')
      .replace(/\\ss\b/g, 'ss')
      .replace(/\\(aa|AA|o|O|l|L|ae|AE|oe|OE)\b/g, function (_, c) { return c; })
      .replace(/[{}\\]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /* "Álvaro Navarrete" → "Á. Navarrete", "Duarte, A. H." → "A. H. Duarte".
     Uniform initials keep the column narrow and scannable; the untouched full
     list stays in the cell's tooltip. */
  function shortAuthor(name) {
    var n = unTex(name);
    if (!n) return '';
    var given, last;
    if (n.indexOf(',') !== -1) {
      var parts = n.split(',');
      last = parts.shift().trim();
      given = parts.join(' ').trim();
    } else {
      var words = n.split(' ');
      last = words.pop();
      /* Keep the particle with the surname: "van Dijk", not "v. Dijk". */
      while (words.length &&
             /^(van|von|der|den|de|del|della|di|da|dos|du|la|le|ter|ten|bin|ibn|al|st\.?)$/i
               .test(words[words.length - 1])) {
        last = words.pop() + ' ' + last;
      }
      given = words.join(' ');
    }
    if (!given) return last;
    var inits = given.split(' ').map(function (w) {
      /* Jean-Pierre → J.-P. */
      return w.split('-').map(function (p) {
        return p ? p.charAt(0).toUpperCase() + '.' : '';
      }).filter(Boolean).join('-');
    }).filter(Boolean).join(' ');
    return inits ? inits + ' ' + last : last;
  }

  function shortAuthors(list) {
    return (list || []).map(shortAuthor).filter(Boolean).join(', ');
  }

  // ═══════════════════════════════════════════════════════════════════
  // The pick — loaded on demand, gated at the top of Stage 2
  // ═══════════════════════════════════════════════════════════════════
  /*
   * The pick is loaded when something actually needs it, not before.
   *
   * It used to be a gate: 32 MB downloaded up front, with Stage 1 disabled
   * until it finished. Since the shared cache arrived, a day whose vectors are
   * already cut needs no model at all — the haul is a lookup, and the coupling map,
   * which the spec calls the first thing worth looking at, arrives in about a
   * second. Making everyone pay 32 MB to reach a screen that no longer needs it
   * is the wrong default.
   *
   * So every path that needs the extractor asks for it here, and only a real
   * need triggers the download:
   *   * a haul with cache misses (embedTexts, via embedTextsCached);
   *   * any touchstone, always — touchstones never go through the cache.
   *
   * The button now lives at the top of Stage 2, where the need is unavoidable:
   * your own words are never in the shared cache. It also stays the escape
   * hatch for core samples parked on a fresh page load.
   */

  var _pickPromise = null;

  /** The extractor, loading it if this is the first caller. */
  function ensurePick() {
    if (state.extractor) return Promise.resolve(state.extractor);
    if (!_pickPromise) {
      // Memoized so a haul and a touchstone racing each other download once;
      // cleared on failure so a retry is possible rather than permanently stuck.
      _pickPromise = loadPick().catch(function (err) {
        _pickPromise = null;
        throw err;
      });
    }
    return _pickPromise;
  }

  /* The pick in a worker: the same model, cutting on a thread the page is not
     drawing on. Resolves to a handle — .embed(texts) → vectors, .batch — so the
     caller cannot tell which of the two paths it got. Rejects if the browser
     has no workers, if the worker script will not start, or if loading the
     model inside it fails; loadPick() then falls back to the main thread. */
  function loadPickInWorker(onProgress) {
    return new Promise(function (resolve, reject) {
      if (typeof Worker !== 'function') return reject(new Error('no Worker in this browser'));

      var worker;
      try {
        worker = new Worker(WORKER_URL, { type: 'module' });
      } catch (err) {
        return reject(err);
      }

      var settled = false;
      var nextId = 0;
      var pending = {};   // id → {resolve, reject} for batches in flight

      worker.onerror = function (e) {
        var err = new Error('embed worker failed: ' + ((e && e.message) || 'load error'));
        if (!settled) { settled = true; worker.terminate(); return reject(err); }
        /* After the handle is out, a worker-level error can no longer be
           reported by rejecting the load — fail the batches waiting on it
           instead, or embedTexts hangs forever. */
        Object.keys(pending).forEach(function (id) { pending[id].reject(err); delete pending[id]; });
      };

      worker.onmessage = function (e) {
        var msg = e.data || {};

        if (msg.type === 'progress') return onProgress(msg.file, msg.pct);

        if (msg.type === 'ready') {
          settled = true;
          return resolve({
            batch: WORKER_BATCH,
            embed: function (texts) {
              return new Promise(function (res, rej) {
                var id = ++nextId;
                pending[id] = { resolve: res, reject: rej };
                worker.postMessage({ type: 'embed', id: id, texts: texts });
              });
            },
          });
        }

        if (msg.type === 'vectors') {
          var got = pending[msg.id];
          if (got) { delete pending[msg.id]; got.resolve(msg.vectors); }
          return;
        }

        if (msg.type === 'error') {
          var err = new Error(msg.message);
          if (!settled) { settled = true; worker.terminate(); return reject(err); }
          var waiting = pending[msg.id];
          if (waiting) { delete pending[msg.id]; waiting.reject(err); }
        }
      };

      worker.postMessage({ type: 'load', urls: TRANSFORMERS_URLS, model: LOCAL_MODEL });
    });
  }

  /* The old path, kept as the fallback. Same handle, smaller batches, and a
     yield around every call — on this thread those are the only frames the
     page gets. */
  async function loadPickInline(onProgress) {
    var mod = null;
    var failures = [];
    for (var u = 0; u < TRANSFORMERS_URLS.length && !mod; u++) {
      try {
        mod = await import(TRANSFORMERS_URLS[u]);
      } catch (err) {
        failures.push(TRANSFORMERS_URLS[u] + ' → ' + (err && err.message ? err.message : String(err)));
      }
    }
    if (!mod) {
      throw new Error('Could not load transformers.js from any CDN: ' + failures.join(' | '));
    }

    mod.env.allowLocalModels = false;

    var extractor = await mod.pipeline('feature-extraction', LOCAL_MODEL, {
      dtype: 'q8',
      device: 'wasm',
      progress_callback: function (p) {
        if (p && p.status === 'progress' && p.file && typeof p.progress === 'number') {
          onProgress(p.file, Math.round(p.progress));
        }
      },
    });

    return {
      batch: INLINE_BATCH,
      embed: async function (texts) {
        await yieldToPaint();
        var out = await extractor(texts, { pooling: 'mean', normalize: true });
        var rows = out.tolist();
        await yieldToPaint();
        return rows;
      },
    };
  }

  async function loadPick() {
    var btn = byId('sharpen-btn');
    var statusEl = byId('sharpen-status');
    var progWrap = byId('sharpen-progress-wrap');
    var progBar = byId('sharpen-progress');
    var progLabel = byId('sharpen-label');
    var doneEl = byId('sharpen-done');

    btn.disabled = true;
    statusEl.textContent = '';
    progWrap.style.display = 'flex';
    progBar.value = 0;
    progLabel.textContent = 'Starting...';

    function onProgress(file, pct) {
      progBar.value = pct;
      progLabel.textContent = file + ' — ' + pct + '%';
    }

    var pick = null;
    try {
      pick = await loadPickInWorker(onProgress);
    } catch (err) {
      // Not fatal: the main thread can still do it, just less smoothly.
      console.warn('embed worker unavailable, cutting on the main thread:', err);
      progBar.value = 0;
      progLabel.textContent = 'Starting...';
    }

    if (!pick) {
      try {
        pick = await loadPickInline(onProgress);
      } catch (err) {
        statusEl.textContent = 'Failed to load from any CDN.';
        statusEl.style.color = 'var(--ember)';
        progWrap.style.display = 'none';
        btn.disabled = false;
        throw err;
      }
    }

    state.extractor = pick;
    state.modelLoaded = true;
    progWrap.style.display = 'none';
    doneEl.style.display = '';
    /* The whole gate goes, not just its button: once the pick is sharpened the
       one-time notice is noise, and the done line says what happened. */
    var gate = byId('pick-gate');
    if (gate) gate.style.display = 'none';
    btn.style.display = 'none';
    statusEl.textContent = '';

    // Core samples restored from a claim parked themselves until now
    resolveAllCores();
    return state.extractor;
  }

  // ═══════════════════════════════════════════════════════════════════
  // Scout (shared between stages)
  // ═══════════════════════════════════════════════════════════════════

  function cutoffDate(onDate, lookbackDays) {
    var cursor = new Date(Date.UTC(onDate.getUTCFullYear(), onDate.getUTCMonth(), onDate.getUTCDate()));
    var remaining = Math.max(lookbackDays, 1);
    while (remaining > 0) {
      cursor.setUTCDate(cursor.getUTCDate() - 1);
      var dow = cursor.getUTCDay();
      if (dow >= 1 && dow <= 5) remaining -= 1;
    }
    return cursor.toISOString().substring(0, 10);
  }

  /* ── LaTeX escapes → Unicode ───────────────────────────────────────────
   *
   * The two scout sources also disagree on how they spell math and accents.
   * The announcement RSS carries the author's LaTeX (`L\"uders`, `$\Omega$`,
   * `1{\deg}`); the search API has already converted it (`Lüders`, `$Ω$`,
   * `1°`). Since the shared cache is keyed on the text, the same paper hashed
   * to two different keys depending on which source it arrived from, so every
   * escape-carrying abstract missed on the lookback pass — measured 2026-08-14
   * across quant-ph, cond-mat.mes-hall, cs.LG and math-ph: 19 of 273 abstracts
   * present in both sources, and the whole of that 19 is this.
   *
   * Normalising towards Unicode rather than towards LaTeX is also the better
   * text to embed: `Lüders` is one token the model has seen, `L\"uders` is
   * four it has not.
   *
   * Anything unrecognised passes through untouched — `\,`, `\mathrm{}`, `$…$`
   * and every unknown command survive, which is what the API does too. THIS
   * MUST STAY BYTE-IDENTICAL TO deLatex() IN scripts/warm-dig.mjs; the parity
   * test in scripts/warm-dig.test.mjs is what holds the two together.
   */
  var GREEK = {
    alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε',
    zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'θ', iota: 'ι', kappa: 'κ',
    lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', varpi: 'π', rho: 'ρ',
    varrho: 'ρ', sigma: 'σ', varsigma: 'ς', tau: 'τ', upsilon: 'υ', phi: 'φ',
    varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
    Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
    Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  };

  var SPECIALS = {
    ss: 'ß', o: 'ø', O: 'Ø', l: 'ł', L: 'Ł', aa: 'å', AA: 'Å',
    ae: 'æ', AE: 'Æ', oe: 'œ', OE: 'Œ', i: 'i', j: 'j',
    deg: '°', degree: '°', textdegree: '°',
  };

  // The accent marks, as the combining codepoint each one adds to its letter.
  var COMBINING = {
    '`': '̀', "'": '́', '^': '̂', '~': '̃', '"': '̈',
    '=': '̄', '.': '̇', c: '̧', v: '̌', u: '̆',
    r: '̊', H: '̋', k: '̨',
  };

  /* \"u, \"{u}, \"\i, \c{c}, \v{s} — and the braced whole, {\"u}. The
     letter-named accents demand their braces, so that \version and \understand
     are not read as one. Both brace positions are matched in full rather than
     as optional halves: `\{?…\}?` would happily eat the closing brace of
     `{-2\Delta}` and leave the group unbalanced. */
  var ACCENT_SRC = '\\\\([`\'"^~=.]|[cvruHk](?=\\{))\\s*(?:\\{\\\\?([A-Za-z])\\}|\\\\?([A-Za-z]))';
  var ACCENT_BARE = new RegExp(ACCENT_SRC, 'g');
  var ACCENT_BRACED = new RegExp('\\{' + ACCENT_SRC + '\\}', 'g');

  function _accent(m, acc, braced, bare) {
    return ((braced || bare) + COMBINING[acc]).normalize('NFC');
  }

  /* The trailing space goes with the command: TeX eats the whitespace that
     terminates a control word, so `$\Delta \approx 8$` reaches the API side as
     `$Δ\approx 8$`. Keep that space and the two spellings still hash apart.
     An unrecognised command is returned whole, space included. */
  function _command(m, cmd) {
    if (Object.prototype.hasOwnProperty.call(GREEK, cmd)) return GREEK[cmd];
    if (Object.prototype.hasOwnProperty.call(SPECIALS, cmd)) return SPECIALS[cmd];
    return m;
  }

  function deLatex(text) {
    var s = String(text || '');
    s = s.replace(ACCENT_BRACED, _accent).replace(ACCENT_BARE, _accent);
    s = s.replace(/\{\\([A-Za-z]+)\}/g, _command).replace(/\\([A-Za-z]+) ?/g, _command);
    return s;
  }

  /* '.../abs/2508.12345v2' → '2508.12345'. The two scout sources disagree on
     the version suffix — the RSS feed drops it, the search API keeps it — so
     dedup only works if both sides are stripped to the same bare id. */
  function bareArxivId(raw) {
    return String(raw || '').trim()
      .replace(/^.*\/abs\//, '')
      .replace(/^arxiv:/i, '')
      .replace(/v\d+$/, '');
  }

  function parseAtomXML(xmlText) {
    var parser = new DOMParser();
    var doc = parser.parseFromString(xmlText, 'application/xml');
    var entries = doc.querySelectorAll('entry');
    var candidates = [];
    entries.forEach(function (entry) {
      var idEl = entry.querySelector('id');
      if (!idEl) return;
      var arxivId = bareArxivId(idEl.textContent);
      var titleEl = entry.querySelector('title');
      var title = titleEl ? titleEl.textContent.replace(/\s+/g, ' ').trim() : '';
      var summaryEl = entry.querySelector('summary');
      var abstract = summaryEl ? deLatex(summaryEl.textContent).replace(/\s+/g, ' ').trim() : '';
      var authorEls = entry.querySelectorAll('author name');
      var authors = [];
      authorEls.forEach(function (a) { var n = a.textContent.trim(); if (n) authors.push(n); });
      var catEl = entry.querySelector('category[term]');
      var primaryCat = catEl ? catEl.getAttribute('term') : '';
      var pubEl = entry.querySelector('published');
      var published = pubEl ? pubEl.textContent.trim().substring(0, 10) : '';
      candidates.push({
        arxiv_id: arxivId, title: title, abstract: abstract, authors: authors,
        primary_category: primaryCat, published: published,
        abs_url: 'https://arxiv.org/abs/' + arxivId,
        pdf_url: 'https://arxiv.org/pdf/' + arxivId,
      });
    });
    return candidates;
  }

  /* One category's announcement feed → stones.
     Measured 2026-08-10 on quant-ph: the feed carries 39 new + 16 cross-listed
     + 48 replacements, and the 55 new+cross are exactly what the listing page
     shows for the day. The search API cannot reproduce that set: it can only
     window on *submission* date, and a cross-list is usually submitted days
     before the archive announces it, so those 16 fall outside any 24-hour
     window. Hence the feed, not the API, is the source for the day. */
  function parseAnnouncementRSS(xmlText, wantedCat) {
    var doc = new DOMParser().parseFromString(xmlText, 'application/xml');
    var items = doc.querySelectorAll('item');
    var out = [];
    items.forEach(function (item) {
      var typeEl = item.getElementsByTagName('arxiv:announce_type')[0];
      var announce = typeEl ? typeEl.textContent.trim() : 'new';
      // Replacements are old papers with a new version — not tonight's haul.
      if (announce !== 'new' && announce !== 'cross') return;

      var linkEl = item.querySelector('link');
      if (!linkEl) return;
      var arxivId = bareArxivId(linkEl.textContent);
      if (!arxivId) return;

      var titleEl = item.querySelector('title');
      var title = titleEl ? titleEl.textContent.replace(/\s+/g, ' ').trim() : '';

      /* description is "arXiv:ID vN Announce Type: new \nAbstract: …" — the
         header is boilerplate and would only add noise to the embedding. */
      var descEl = item.querySelector('description');
      var desc = descEl ? descEl.textContent : '';
      var absMatch = desc.match(/Abstract:\s*([\s\S]*)$/);
      var abstract = deLatex(absMatch ? absMatch[1] : desc).replace(/\s+/g, ' ').trim();

      var authors = [];
      var creators = item.getElementsByTagName('dc:creator');
      for (var c = 0; c < creators.length; c++) {
        creators[c].textContent.split(',').forEach(function (n) {
          var name = n.trim();
          if (name) authors.push(name);
        });
      }

      var catEls = item.querySelectorAll('category');
      var primaryCat = catEls.length ? catEls[0].textContent.trim() : wantedCat;

      var dateEl = item.querySelector('pubDate');
      var announced = '';
      if (dateEl) {
        var d = new Date(dateEl.textContent.trim());
        if (!isNaN(d)) announced = d.toISOString().substring(0, 10);
      }

      out.push({
        arxiv_id: arxivId, title: title, abstract: abstract, authors: authors,
        primary_category: primaryCat, published: announced,
        announce: announce,
        abs_url: 'https://arxiv.org/abs/' + arxivId,
        pdf_url: 'https://arxiv.org/pdf/' + arxivId,
      });
    });
    return out;
  }

  /** Tonight's announcement across every scouted category, deduped by id. */
  async function fetchAnnouncement(cats) {
    var seen = {};
    var stones = [];
    var failures = [];
    for (var i = 0; i < cats.length; i++) {
      var url = 'https://rss.arxiv.org/rss/' + encodeURIComponent(cats[i]);
      var resp;
      try {
        resp = await fetchViaRelay(url);
      } catch (err) {
        failures.push(cats[i] + ' → ' + (err && err.message ? err.message : String(err)));
        continue;
      }
      if (!resp.ok) {
        failures.push(cats[i] + ' → HTTP ' + resp.status);
        continue;
      }
      var batch = parseAnnouncementRSS(await resp.text(), cats[i]);
      for (var j = 0; j < batch.length; j++) {
        // A paper announced in two scouted archives is one stone, not two.
        if (seen[batch[j].arxiv_id]) continue;
        seen[batch[j].arxiv_id] = 1;
        stones.push(batch[j]);
      }
    }
    // Every feed failing is an error; some failing is a warning we can survive.
    if (stones.length === 0 && failures.length > 0) {
      throw new Error('arXiv scout failed: ' + failures.join(' | '));
    }
    return stones;
  }

  async function scoutDay() {
    var cats = state.scout.categories.split(',').map(function (c) { return c.trim(); }).filter(Boolean);
    if (cats.length === 0) throw new Error('No arXiv categories configured.');
    var lookback = state.scout.lookback;
    var maxResults = state.scout.max_results;

    var stones = await fetchAnnouncement(cats);
    var seen = {};
    for (var s = 0; s < stones.length; s++) seen[stones[s].arxiv_id] = 1;

    /* Lookback past tonight still goes through the search API — the feed only
       ever carries the latest announcement. Those older days are therefore
       windowed on submission date, and miss their cross-lists the same way
       they always did; tonight, the part people actually read, is exact. */
    if (lookback > 1) {
      var query = cats.map(function (c) { return 'cat:' + c; }).join('+OR+');
      var url = 'https://export.arxiv.org/api/query?' +
        'search_query=' + query +
        '&sortBy=submittedDate&sortOrder=descending' +
        '&max_results=' + maxResults +
        '&start=0';
      var resp = await fetchViaRelay(url);
      if (!resp.ok) {
        var relayErr = '';
        try { relayErr = (await resp.text()).substring(0, 200); } catch (_) {}
        throw new Error('arXiv scout failed: HTTP ' + resp.status + (relayErr ? ' — ' + relayErr : ''));
      }
      var candidates = parseAtomXML(await resp.text());
      var cutoff = cutoffDate(new Date(), lookback);
      for (var i = 0; i < candidates.length; i++) {
        if (candidates[i].published && candidates[i].published < cutoff) break;
        if (seen[candidates[i].arxiv_id]) continue;
        seen[candidates[i].arxiv_id] = 1;
        candidates[i].announce = 'earlier';
        stones.push(candidates[i]);
      }
    }

    if (stones.length === 0) throw new Error('No papers found. Check categories or try a larger lookback.');
    if (stones.length > maxResults) stones = stones.slice(0, maxResults);
    return stones;
  }

  // ═══════════════════════════════════════════════════════════════════
  // Embedding helpers
  // ═══════════════════════════════════════════════════════════════════

  function normalize(v) {
    var sq = 0;
    for (var i = 0; i < v.length; i++) sq += v[i] * v[i];
    var len = Math.sqrt(sq);
    if (len === 0) return v;
    for (var j = 0; j < v.length; j++) v[j] /= len;
    return v;
  }

  /* Hand the main thread back long enough to actually paint a frame. A bare
     setTimeout(0) only promises another task, and the next batch can win the
     race to it — the train then advances in lurches. Waiting for a frame is
     what the train needs, but a backgrounded tab gets one a second, so the
     timeout stays in as a floor and whichever comes first wins. */
  function yieldToPaint() {
    return new Promise(function (res) {
      var done = false;
      function go() { if (!done) { done = true; res(); } }
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(go);
      setTimeout(go, 16);
    });
  }

  async function embedTexts(texts, statusFn) {
    /* The one place the pick is genuinely required. Everything that embeds
       locally funnels through here, so asking for it here means no other call
       site has to remember to — and a path served entirely from the cache never
       reaches this line, which is the whole point of loading it lazily. */
    var pick = await ensurePick();
    var step = pick.batch || INLINE_BATCH;
    var vectors = [];
    for (var i = 0; i < texts.length; i += step) {
      var rows = await pick.embed(texts.slice(i, i + step));
      for (var r = 0; r < rows.length; r++) {
        normalize(rows[r]);  // defensive: ensure unit vector
        vectors.push(rows[r]);
      }
      /* Report what has actually landed, once the batch is back. The train runs
         on its own clock either way — it is only the stones that wait here, and
         a batch that has not returned has not earned any. */
      if (statusFn) statusFn(vectors.length, texts.length);
    }
    return vectors;
  }

  // ── The shared vector cache ───────────────────────────────────────
  /*
   * Embedding a day of abstracts here costs ~60 s; the vectors are ~200 kB.
   * So the second person to haul a day downloads instead of re-embedding.
   *
   * The key is the sha256 of the text — never an arXiv id — so one cache
   * serves abstracts, touchstones and core samples alike, and a revised
   * abstract is a *different text* and therefore a miss rather than a stale
   * hit. `model` and `dim` ride in the key for the reason in §5.6 of the spec:
   * a 384-dim bge vector and a 768-dim one for the same text are not
   * interchangeable, and mixing them fails silently.
   *
   * Every failure here is a miss, never an error. The cache is an
   * optimization; the haul must work with it down, empty, or opted out.
   *
   * ONLY PUBLISHED TEXT GOES THROUGH HERE. Abstracts (arXiv) and core-sample
   * abstracts (OpenAlex) are already public and already left this tab to be
   * fetched. Touchstones are the user's own words and are embedded locally,
   * always — Stage 0 promises "nothing you type leaves this tab", and a sha256
   * of a short typed phrase is one dictionary away from the phrase itself.
   * See maybeEmbedFeatures(), which is where the split is enforced.
   */

  /** Collapse exactly as the server does, so both sides hash the same string. */
  function cacheKeyText(text) { return (text || '').replace(/\s+/g, ' ').trim(); }

  async function sha256Hex(text) {
    var bytes = new TextEncoder().encode(cacheKeyText(text));
    var digest = await crypto.subtle.digest('SHA-256', bytes);
    var out = '';
    new Uint8Array(digest).forEach(function (b) {
      out += b.toString(16).padStart(2, '0');
    });
    return out;
  }

  /** base64 of little-endian float32 → a plain Array, L2-normalized. */
  function decodeVector(b64, dim) {
    var binary = atob(b64);
    if (binary.length !== dim * 4) {
      throw new Error('cached vector is ' + binary.length + ' bytes, expected ' + (dim * 4));
    }
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    var floats = new Float32Array(bytes.buffer);
    var v = Array.prototype.slice.call(floats);
    // The invariant is ours to hold, not the server's — normalize on ingest.
    return normalize(v);
  }

  /** Ask the cache for these texts. Returns {sha: vector}; {} on any failure. */
  async function cacheLookup(texts) {
    if (!CACHE_URL || !texts.length || !(crypto && crypto.subtle)) return { shas: [], hits: {} };
    var shas;
    try {
      shas = await Promise.all(texts.map(sha256Hex));
    } catch (_) {
      return { shas: [], hits: {} };
    }
    var unique = Object.keys(shas.reduce(function (acc, s) { acc[s] = 1; return acc; }, {}));
    var hits = {};
    try {
      /* Chunked: the endpoint caps a read, and "Max results" is a free number
         field, so a wide scout can exceed it. One oversized request would 413
         and drop the whole day back to local embedding — with nothing visibly
         wrong, just slow. */
      for (var c = 0; c < unique.length; c += CACHE_READ_CHUNK) {
        var resp = await fetch(CACHE_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: LOCAL_MODEL, dim: LOCAL_DIM,
            sha: unique.slice(c, c + CACHE_READ_CHUNK),
          }),
        });
        if (!resp.ok) return { shas: shas, hits: {} };
        var data = await resp.json();
        Object.keys(data.hits || {}).forEach(function (sha) {
          try { hits[sha] = decodeVector(data.hits[sha], LOCAL_DIM); } catch (_) {}
        });
      }
    } catch (_) {
      return { shas: shas, hits: {} };
    }
    return { shas: shas, hits: hits };
  }

  /**
   * embedTexts, with the shared cache in front of it. Same contract — one unit
   * vector per input text, in order — plus a `cached` count on the returned
   * array for the status line. Only the misses reach the model.
   */
  async function embedTextsCached(texts, statusFn, onMisses) {
    var look = await cacheLookup(texts);
    var vectors = new Array(texts.length);
    var missIdx = [];
    for (var i = 0; i < texts.length; i++) {
      var hit = look.shas.length ? look.hits[look.shas[i]] : null;
      if (hit) vectors[i] = hit.slice();
      else missIdx.push(i);
    }
    var nCached = texts.length - missIdx.length;
    if (statusFn) statusFn(nCached, texts.length);
    /* Announced before embedding starts, because this is the moment a 32 MB
       download may be about to happen. A caller that stalls silently here reads
       as a hang; one that says "12 stones need cutting" reads as work. */
    if (onMisses) onMisses(missIdx.length, texts.length, state.modelLoaded);
    if (missIdx.length) {
      var missed = await embedTexts(
        missIdx.map(function (i) { return texts[i]; }),
        statusFn && function (done, total) { statusFn(nCached + done, texts.length); }
      );
      for (var m = 0; m < missIdx.length; m++) vectors[missIdx[m]] = missed[m];
    }
    vectors.cached = nCached;
    return vectors;
  }

  function dot(a, b) {
    if (a.length !== b.length) throw new Error('Dimension mismatch: ' + a.length + ' vs ' + b.length);
    var s = 0;
    for (var i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
  }

  function cosine(a, b) {
    var d = dot(a, b);
    // Defensive: re-normalize in case of drift
    var na = 0, nb = 0;
    for (var i = 0; i < a.length; i++) { na += a[i] * a[i]; nb += b[i] * b[i]; }
    na = Math.sqrt(na); nb = Math.sqrt(nb);
    if (na === 0 || nb === 0) return 0;
    var cos = d / (na * nb);
    return cos < 0 ? 0 : cos;
  }

  // ═══════════════════════════════════════════════════════════════════
  // STAGE 1 — Haul the stones
  // ═══════════════════════════════════════════════════════════════════

  function computeWagonMap(A) {
    var N = A.length;
    var S = new Array(N);
    for (var i = 0; i < N; i++) {
      S[i] = new Float32Array(N);
      S[i][i] = 1.0;
    }
    // Upper triangle only (i < j)
    for (var i = 0; i < N; i++) {
      for (var j = i + 1; j < N; j++) {
        var c = cosine(A[i], A[j]);
        S[i][j] = c;
        S[j][i] = c;
      }
    }
    return S;
  }

  // Edge threshold and minimum wagon size — shared by the matrix ordering
  // and the graph view so both draw the same adjacency.
  var WAGON_THRESH = 0.75;
  var WAGON_MIN_SIZE = 3;

  /** Count wagons ≥ WAGON_MIN_SIZE at one threshold, and how many stones they
   *  hold. Cheaper than clusterOrder — no ordering, no centrality — because
   *  the threshold sweep runs this a few dozen times. */
  function countWagons(S, N, thresh) {
    var seen = new Uint8Array(N);
    var stack = new Int32Array(N);
    var wagons = 0, clustered = 0;
    for (var i = 0; i < N; i++) {
      if (seen[i]) continue;
      var top = 0, size = 0;
      stack[top++] = i;
      seen[i] = 1;
      while (top > 0) {
        var v = stack[--top];
        size++;
        var row = S[v];
        for (var w = 0; w < N; w++) {
          if (!seen[w] && w !== v && row[w] >= thresh) { seen[w] = 1; stack[top++] = w; }
        }
      }
      if (size >= WAGON_MIN_SIZE) { wagons++; clustered += size; }
    }
    return { wagons: wagons, clustered: clustered };
  }

  /**
   * Pick the threshold that splits the haul into the most distinct wagons.
   * Too low and everything fuses into one blob; too high and every stone is
   * lone — the count peaks in between, and that peak is the interesting cut.
   * Ties go to the threshold that leaves more stones inside a wagon.
   */
  function bestWagonThresh(S, N) {
    var best = WAGON_THRESH, bestWagons = -1, bestClustered = -1;
    for (var pct = 50; pct <= 95; pct++) {
      var t = pct / 100;
      var r = countWagons(S, N, t);
      if (r.wagons > bestWagons ||
          (r.wagons === bestWagons && r.clustered > bestClustered)) {
        best = t; bestWagons = r.wagons; bestClustered = r.clustered;
      }
    }
    return best;
  }

  /**
   * Cluster order: threshold at `thresh` (default WAGON_THRESH), connected
   * components ≥ WAGON_MIN_SIZE.
   * Returns [order: [indices], components: [{indices:[], centralTitle:string}]]
   */
  function clusterOrder(stones, S, thresh) {
    var N = stones.length;
    var THRESH = thresh === undefined ? WAGON_THRESH : thresh;
    var MIN_SIZE = WAGON_MIN_SIZE;

    // Build adjacency for values >= THRESH
    var adj = new Array(N);
    for (var i = 0; i < N; i++) adj[i] = [];
    for (var i = 0; i < N; i++) {
      for (var j = i + 1; j < N; j++) {
        if (S[i][j] >= THRESH) {
          adj[i].push(j);
          adj[j].push(i);
        }
      }
    }

    // Connected components
    var visited = new Array(N).fill(false);
    var components = [];
    for (var i = 0; i < N; i++) {
      if (visited[i]) continue;
      var comp = [];
      var stack = [i];
      visited[i] = true;
      while (stack.length > 0) {
        var v = stack.pop();
        comp.push(v);
        for (var a = 0; a < adj[v].length; a++) {
          var w = adj[v][a];
          if (!visited[w]) { visited[w] = true; stack.push(w); }
        }
      }
      if (comp.length >= MIN_SIZE) components.push(comp);
    }

    // Find central member by max sum of within-component similarities
    var compInfo = [];
    for (var c = 0; c < components.length; c++) {
      var members = components[c];
      var bestIdx = members[0];
      var bestSum = -1;
      for (var mi = 0; mi < members.length; mi++) {
        var sum = 0;
        for (var mj = 0; mj < members.length; mj++) {
          if (mi !== mj) sum += S[members[mi]][members[mj]];
        }
        if (sum > bestSum) { bestSum = sum; bestIdx = members[mi]; }
      }
      compInfo.push({ indices: members, centralTitle: stones[bestIdx].title });
    }

    // Build order: clustered stones first, then remainder
    var clustered = [];
    var seen = new Set();
    for (var c2 = 0; c2 < components.length; c2++) {
      for (var mi = 0; mi < components[c2].length; mi++) {
        var idx = components[c2][mi];
        if (!seen.has(idx)) { seen.add(idx); clustered.push(idx); }
      }
    }
    var remainder = [];
    for (var r = 0; r < N; r++) {
      if (!seen.has(r)) remainder.push(r);
    }
    return { order: clustered.concat(remainder), components: compInfo };
  }

  /* ── Naming the wagons ─────────────────────────────────────────────
   *
   * A wagon knows what it contains and not what it is about. `centralTitle`
   * is the closest the clustering alone can get: the most central paper, which
   * is one paper's phrasing standing in for a dozen. Naming asks a model to
   * read the titles and say what they share.
   *
   * ON A BUTTON, NOT ON EVERY RECOMPUTE, and that is the whole cost design.
   * The threshold slider re-derives components on every input event, so wiring
   * naming into clusterOrder would turn one drag into dozens of call-sets
   * against a metered API. The user settles the threshold, then asks.
   *
   * Names are kept in `state.wagonNames`, keyed by membership rather than by
   * wagon number — so dragging the threshold away and back re-attaches the
   * names already paid for, with no request at all, and a wagon that survives
   * a small threshold change unchanged keeps its name.
   */

  /**
   * The wagon's cache key. MUST MATCH `wagonKey` in the function's naming.ts.
   *
   * A divergence here does not throw and does not look like anything: it files
   * every name under a hash the server never looks up, so naming silently stops
   * hitting cache and starts paying full price on every haul. The agreement is
   * pinned by a golden digest — these two stones, with exactly this dirty
   * whitespace, hash to
   *
   *   0cf357c0a944ef663d75fd37e3acd4fc8978aa386e05f90ea2a33e3725b578fb
   *
   *     {2608.01234, 'Valley  splitting in\nSi/SiGe quantum wells '}
   *     {2608.05678, 'Charge noise in silicon double quantum dots'}
   *
   * and `deno test supabase/functions/wagon-name/` asserts the same value from
   * the other side.
   */
  async function wagonKeyLocal(members) {
    var stones = state.stones;
    var lines = members.map(function (i) {
      var st = stones[i] || {};
      return String(st.arxiv_id || '').trim() + '\t' +
        String(st.title || '').replace(/\s+/g, ' ').trim().slice(0, 400);
    }).sort();
    var bytes = new TextEncoder().encode(lines.join('\n'));
    var digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.prototype.map.call(new Uint8Array(digest), function (b) {
      return ('0' + b.toString(16)).slice(-2);
    }).join('');
  }

  /**
   * Give every current component its key, and any name already known for it.
   * Returns true if a name got attached, so the caller knows to redraw.
   *
   * Silent on failure: no crypto.subtle (an http:// origin, say) means no
   * keys, which means no names and a train that reads exactly as it did
   * before naming existed.
   */
  async function attachWagonNames() {
    var comps = state.wagonComponents || [];
    if (!comps.length || !(crypto && crypto.subtle)) return false;
    var changed = false;
    for (var c = 0; c < comps.length; c++) {
      try {
        var key = await wagonKeyLocal(comps[c].indices);
        comps[c].key = key;
        var known = state.wagonNames[key];
        if (known && comps[c].name !== known.name) {
          comps[c].name = known.name;
          comps[c].gloss = known.gloss;
          changed = true;
        }
      } catch (_) {
        return false;
      }
    }
    return changed;
  }

  /**
   * Fire-and-forget re-attach after a re-cluster, redrawing only if something
   * actually got a name.
   *
   * Generation-guarded because the threshold slider fires on every input event
   * and hashing is async: without the guard, a slow hash from a threshold the
   * user has already dragged past would land late and repaint the train with a
   * stale set of names. `clusterOrder` itself is synchronous and always wins;
   * this only ever decorates whatever it left behind.
   */
  var wagonNameGen = 0;
  function reattachWagonNames() {
    var gen = ++wagonNameGen;
    attachWagonNames().then(function (changed) {
      if (changed && gen === wagonNameGen) renderWagonPanel();
    }).catch(function () { /* no names is the pre-naming train, which is fine */ });
  }

  /** The label a wagon goes by: its name once it has one, its number until then. */
  function wagonLabel(c) {
    var comp = (state.wagonComponents || [])[c];
    return (comp && comp.name) ? comp.name : 'Wagon ' + (c + 1);
  }

  function setNameStatus(msg, isError) {
    var el = byId('wagon-name-status');
    if (!el) return;
    el.textContent = msg || '';
    el.classList.toggle('is-error', !!isError);
  }

  /**
   * Ask the endpoint to name every wagon that has no name yet.
   *
   * One request for the whole train, not one per wagon: the endpoint reads its
   * cache in a single query and only the genuine misses cost anything, so
   * batching is both faster and cheaper. A failure of any kind leaves the
   * numbered wagons in place and says so in the status line — a name is a
   * garnish on a clustering that already happened locally, and it must never
   * be the reason a haul looks broken.
   */
  async function nameWagons() {
    var comps = state.wagonComponents || [];
    if (!NAME_URL || !comps.length || state.wagonNaming) return;

    await attachWagonNames();
    var pending = [];
    for (var c = 0; c < comps.length; c++) if (!comps[c].name) pending.push(c);
    if (!pending.length) {
      setNameStatus('Every wagon is named.');
      renderWagonPanel();
      return;
    }

    /* The endpoint refuses a request carrying more wagons than it will name,
       and refuses the *whole* request — so a low threshold that splits the haul
       into thirty components would otherwise name none of them. Send the
       biggest it will take and say what was left over.
       Sorted here rather than assumed: clusterOrder emits components in the
       order its DFS reached them, which is arXiv-listing order and has nothing
       to do with size. */
    var overflow = 0;
    if (pending.length > NAME_MAX_WAGONS) {
      pending.sort(function (a, b) {
        return comps[b].indices.length - comps[a].indices.length;
      });
      overflow = pending.length - NAME_MAX_WAGONS;
      pending = pending.slice(0, NAME_MAX_WAGONS);
    }

    state.wagonNaming = true;
    var btn = byId('wagon-name-btn');
    if (btn) btn.disabled = true;
    setNameStatus('Naming ' + pending.length + ' wagon' + (pending.length === 1 ? '' : 's') + '…');

    try {
      var payload = pending.map(function (c) {
        return {
          members: comps[c].indices.map(function (i) {
            var st = state.stones[i] || {};
            return { id: String(st.arxiv_id || ''), title: String(st.title || '') };
          }),
        };
      });
      var resp = await fetch(NAME_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wagons: payload }),
      });
      if (!resp.ok) {
        var detail = '';
        try { detail = (await resp.json()).error || ''; } catch (_) {}
        setNameStatus(detail || ('Naming failed (HTTP ' + resp.status + ').'), true);
        return;
      }
      var data = await resp.json();
      var names = data.names || {};
      Object.keys(names).forEach(function (k) { state.wagonNames[k] = names[k]; });

      await attachWagonNames();
      var named = 0;
      for (var i = 0; i < comps.length; i++) if (comps[i].name) named++;

      var tail = overflow
        ? ' The ' + overflow + ' smallest went unasked — name them by raising the threshold.'
        : '';

      /* A rate limit outranks the budget message: it clears in about a minute,
         and the names already generated are cached, so pressing again picks up
         exactly where this stopped. Telling someone to come back tomorrow when
         they could press again shortly is the worse of the two errors.
         "Every model" rather than "the model", because the endpoint only
         reports a wait once it has fallen through its whole ladder of them. */
      if (data.retryAfter) {
        setNameStatus(named + ' of ' + comps.length + ' named — every model is rate-limited. ' +
          'Press again in about ' + Math.ceil(data.retryAfter) + 's to name the rest.');
      /* `capped` is the one thing the page cannot work out for itself, and the
         one worth saying plainly: the missing names are a budget, not a bug,
         and they come back tomorrow. */
      } else if (data.capped) {
        setNameStatus(named + ' of ' + comps.length +
          ' named — the shared daily limit is spent. The rest keep their numbers.' + tail);
      } else if (!named) {
        /* Nothing named, nothing capped: the endpoint is up but has no key
           behind it. Saying "0 of 9 named" would read as a failure the user
           could retry, and it is not one. */
        setNameStatus('Naming is not configured on this deployment.', true);
      } else if (data.unnamed) {
        setNameStatus(named + ' of ' + comps.length + ' named.' + tail);
      } else {
        setNameStatus('Named ' + named + ' wagon' + (named === 1 ? '' : 's') +
          (data.generated ? '' : ' — all from cache') + '.' + tail);
      }
    } catch (err) {
      setNameStatus('Naming is unavailable right now.', true);
    } finally {
      state.wagonNaming = false;
      if (btn) btn.disabled = false;
      renderWagonPanel();
    }
  }

  // Pre-resolved ramp hexes — canvas can't resolve CSS var() strings.
  var ORE_HEX = [
    '#2b2620', '#45371c', '#5d4a1a', '#785f16',
    '#94760f', '#b18f08', '#d0a504', '#f5b301'
  ];

  /** Map cosine value to ore ramp hex. Normalized by [minOff, maxOff]
   *  so the weakest correlation gets the dimmest yellowish step
   *  and the strongest gets the brightest. */
  function wagonColor(val, minOff, maxOff) {
    var span = maxOff - minOff;
    if (span <= 0.001) return ORE_HEX[3];
    var norm = (val - minOff) / span;   // minOff→0, maxOff→1
    if (norm < 0) norm = 0; if (norm > 1) norm = 1;
    var idx = 3 + Math.round(norm * 4);
    if (idx > 7) idx = 7;
    return ORE_HEX[idx];
  }

  function drawWagonMap(canvas, S, order, stones, components, readoutFn) {
    var N = order.length;
    var cellSize = Math.max(3, Math.floor(240 / N));
    var width = N * cellSize;
    var height = N * cellSize;

    canvas.width = width;
    canvas.height = height;
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';

    var ctx = canvas.getContext('2d');
    ctx.fillStyle = getComputedStyle(canvas).getPropertyValue('--rock').trim() || '#21262e';
    ctx.fillRect(0, 0, width, height);

    // Find min/max off-diagonal — skip the 1.0 diagonal entries
    var minOff = Infinity, maxOff = 0;
    for (var oi = 0; oi < N; oi++) {
      for (var oj = oi + 1; oj < N; oj++) {
        var v = S[order[oi]][order[oj]];
        if (v < minOff) minOff = v;
        if (v > maxOff) maxOff = v;
      }
    }
    if (!isFinite(minOff)) minOff = 0;

    // Draw upper triangle in clustered order
    for (var oi = 0; oi < N; oi++) {
      for (var oj = oi + 1; oj < N; oj++) {
        var i = order[oi];
        var j = order[oj];
        var val = S[i][j];
        ctx.fillStyle = wagonColor(val, minOff, maxOff);
        ctx.fillRect(oi * cellSize, oj * cellSize, cellSize, cellSize);
      }
    }

    // Diagonal — same as background so it disappears
    ctx.fillStyle = getComputedStyle(canvas).getPropertyValue('--rock').trim() || '#21262e';
    for (var d = 0; d < N; d++) {
      ctx.fillRect(d * cellSize, d * cellSize, cellSize, cellSize);
    }

    // Mouse tracking. Hover previews; a click pins the readout so its two
    // links can actually be clicked (hover-only readouts vanish on the way there).
    var pinned = null;   // {row, col} or null

    function cellAt(e) {
      var rect = canvas.getBoundingClientRect();
      var col = Math.floor((e.clientX - rect.left) / cellSize);
      var row = Math.floor((e.clientY - rect.top) / cellSize);
      if (col < 0 || col >= N || row < 0 || row >= N) return null;
      return { row: row, col: col };
    }

    function emit(cell, isPinned) {
      if (!readoutFn) return;
      if (!cell) { readoutFn('', '', false); return; }
      var si = order[cell.row];
      var sj = order[cell.col];
      var val = cell.row === cell.col ? 1.0 : S[si][sj];
      var same = false;
      for (var c = 0; c < components.length; c++) {
        var members = new Set(components[c].indices);
        if (members.has(si) && members.has(sj)) { same = true; break; }
      }
      readoutFn(
        '<a href="' + stones[si].abs_url + '" target="_blank" rel="noopener">' +
          escapeHtml(stones[si].title) + '</a> — ' +
        '<a href="' + stones[sj].abs_url + '" target="_blank" rel="noopener">' +
          escapeHtml(stones[sj].title) + '</a>',
        val.toFixed(2) + (same ? ' · same wagon' : '') +
          (isPinned ? '  ·  <span class="wagon-pin-hint">pinned — click cell again to release</span>'
                    : '  ·  <span class="wagon-pin-hint">click to pin</span>'),
        !!isPinned
      );
    }

    canvas.onmousemove = function (e) {
      if (pinned) return;              // locked until the cell is clicked again
      emit(cellAt(e), false);
    };
    canvas.onmouseleave = function () {
      if (!pinned) emit(null, false);
    };
    canvas.onclick = function (e) {
      var cell = cellAt(e);
      if (!cell) return;
      if (pinned && pinned.row === cell.row && pinned.col === cell.col) {
        pinned = null;
        emit(cell, false);
      } else {
        pinned = cell;
        emit(cell, true);
      }
    };
    canvas.style.cursor = 'pointer';
  }

  // ── Wagon graph ──────────────────────────────────────────────────
  // The coupling map is an adjacency matrix, so it is also a graph: one node
  // per stone, an edge wherever cosine ≥ WAGON_THRESH. Same clustering,
  // drawn as a force-directed layout with one colour per wagon.

  // One hue per wagon, cycled if there are more wagons than colours.
  var WAGON_COLORS = [
    '#f5b301', '#5fb3a1', '#c96f4a', '#8f7fd4',
    '#7fa650', '#d98cb3', '#4f9ad6', '#c9a227',
    '#a8705a', '#6fbf73'
  ];
  var LONE_COLOR = '#6c6355';   // stones that joined no wagon

  /** [N] array of cluster ids, -1 for stones outside every wagon. */
  function clusterIds(n, components) {
    var cid = new Array(n).fill(-1);
    for (var c = 0; c < components.length; c++) {
      var members = components[c].indices;
      for (var m = 0; m < members.length; m++) cid[members[m]] = c;
    }
    return cid;
  }

  /**
   * Force-directed wagon graph on a canvas. Nodes are draggable, the view
   * pans and zooms, hover previews and click pins the readout.
   * Returns a handle with .stop() — call it when the canvas goes away.
   */
  function drawWagonGraph(canvas, S, stones, components, readoutFn, opts) {
    opts = opts || {};
    var N = stones.length;
    var W = opts.width || 640;
    var H = opts.height || 420;
    var THRESH = opts.thresh === undefined ? WAGON_THRESH : opts.thresh;
    var dpr = window.devicePixelRatio || 1;

    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    var ctx = canvas.getContext('2d');

    var cid = clusterIds(N, components);

    // Edges + degrees
    var edges = [];
    var deg = new Array(N).fill(0);
    var nbrs = new Array(N);
    for (var i = 0; i < N; i++) nbrs[i] = [];
    for (i = 0; i < N; i++) {
      for (var j = i + 1; j < N; j++) {
        var w = S[i][j];
        if (w >= THRESH) {
          edges.push({ a: i, b: j, w: w });
          deg[i]++; deg[j]++;
          nbrs[i].push(j); nbrs[j].push(i);
        }
      }
    }

    // Seed positions: each wagon on its own arc, lone stones on an outer ring.
    // Anchors sit further out than the seed offset — the simulation pulls each
    // wagon's own stones back to its anchor every tick, so wagons end up as
    // distinct blobs instead of melting into one ring under shared gravity.
    var nodes = new Array(N);
    var nComp = components.length;
    var ANCHOR_R = 130 + nComp * 24;
    var clusterAnchor = new Array(nComp);
    for (var ci = 0; ci < nComp; ci++) {
      var cbase = (ci / Math.max(1, nComp)) * Math.PI * 2;
      clusterAnchor[ci] = { x: Math.cos(cbase) * ANCHOR_R, y: Math.sin(cbase) * ANCHOR_R };
    }
    var wagonCount = {};
    for (i = 0; i < N; i++) {
      var c = cid[i];
      var r, ang;
      if (c >= 0) {
        wagonCount[c] = (wagonCount[c] || 0) + 1;
        var base = (c / Math.max(1, nComp)) * Math.PI * 2;
        ang = base + (wagonCount[c] % 17) * 0.37;
        r = 60 + (wagonCount[c] % 5) * 12;
      } else {
        ang = Math.random() * Math.PI * 2;
        r = 190 + Math.random() * 60;
      }
      nodes[i] = {
        i: i,
        x: Math.cos(ang) * r + (c >= 0 ? Math.cos(base) * 130 : 0),
        y: Math.sin(ang) * r + (c >= 0 ? Math.sin(base) * 130 : 0),
        vx: 0, vy: 0,
        r: 2.5 + Math.min(3.5, Math.sqrt(deg[i]) * 0.7)
      };
    }

    // ── Simulation ──
    var alpha = 1.0;
    var raf = null;
    var stopped = false;

    function tick() {
      if (alpha < 0.004) return false;
      var REP = 3200;
      var K = 0.045;

      // Repulsion — O(N²), fine for a day's haul (a few hundred stones)
      for (var a = 0; a < N; a++) {
        var na = nodes[a];
        for (var b = a + 1; b < N; b++) {
          var nb = nodes[b];
          var dx = na.x - nb.x, dy = na.y - nb.y;
          var d2 = dx * dx + dy * dy;
          if (d2 < 0.01) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 0.01; }
          if (d2 > 90000) continue;              // ignore far pairs
          var f = REP / d2;
          // Push different wagons apart harder, let one wagon's own stones
          // pack tighter — that's what turns a blurred ring into blobs.
          if (cid[a] !== cid[b]) f *= 1.7;
          else if (cid[a] >= 0) f *= 0.6;
          var d = Math.sqrt(d2);
          var ux = dx / d, uy = dy / d;
          na.vx += ux * f; na.vy += uy * f;
          nb.vx -= ux * f; nb.vy -= uy * f;
        }
      }

      // Springs — stronger, shorter for higher cosine
      for (var e = 0; e < edges.length; e++) {
        var ed = edges[e];
        var p = nodes[ed.a], q = nodes[ed.b];
        var t = (ed.w - THRESH) / Math.max(0.001, 1 - THRESH);
        var L = 92 - 46 * t;
        var ddx = q.x - p.x, ddy = q.y - p.y;
        var dd = Math.sqrt(ddx * ddx + ddy * ddy) || 0.01;
        var force = (dd - L) * K * (0.4 + t);
        var fx = (ddx / dd) * force, fy = (ddy / dd) * force;
        p.vx += fx; p.vy += fy;
        q.vx -= fx; q.vy -= fy;
      }

      // Gravity: clustered stones pull toward their own wagon's anchor point,
      // not the shared centre — that's what keeps wagons apart at rest instead
      // of drifting back into one ring once the springs settle.
      for (var g = 0; g < N; g++) {
        var ndg = nodes[g];
        var cg = cid[g];
        if (cg >= 0) {
          var an = clusterAnchor[cg];
          ndg.vx += (an.x - ndg.x) * 0.020;
          ndg.vy += (an.y - ndg.y) * 0.020;
        } else {
          ndg.vx -= ndg.x * 0.006;
          ndg.vy -= ndg.y * 0.006;
        }
      }

      // Integrate, with a speed cap — uncapped, a dense wagon's summed
      // repulsion throws nodes across the canvas and the layout flickers
      // instead of relaxing.
      var MAX_STEP = 14;
      for (var m = 0; m < N; m++) {
        var nd = nodes[m];
        if (nd === dragNode) { nd.vx = 0; nd.vy = 0; continue; }
        nd.vx *= 0.82; nd.vy *= 0.82;
        var sx = nd.vx * alpha, sy = nd.vy * alpha;
        var sp = Math.sqrt(sx * sx + sy * sy);
        if (sp > MAX_STEP) { sx = sx / sp * MAX_STEP; sy = sy / sp * MAX_STEP; }
        nd.x += sx;
        nd.y += sy;
      }

      alpha *= 0.985;
      return true;
    }

    // ── View transform ──
    var view = { k: 1, tx: W / 2, ty: H / 2 };
    function toScreen(n) { return { x: n.x * view.k + view.tx, y: n.y * view.k + view.ty }; }
    function toWorld(sx, sy) { return { x: (sx - view.tx) / view.k, y: (sy - view.ty) / view.k }; }

    /** Transform that would frame the whole layout right now. */
    function fitTarget() {
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (var i2 = 0; i2 < N; i2++) {
        if (nodes[i2].x < minX) minX = nodes[i2].x;
        if (nodes[i2].x > maxX) maxX = nodes[i2].x;
        if (nodes[i2].y < minY) minY = nodes[i2].y;
        if (nodes[i2].y > maxY) maxY = nodes[i2].y;
      }
      var pad = 34;
      var spanX = Math.max(1, maxX - minX), spanY = Math.max(1, maxY - minY);
      var k = Math.min((W - 2 * pad) / spanX, (H - 2 * pad) / spanY);
      if (k > 2) k = 2;
      return {
        k: k,
        tx: W / 2 - ((minX + maxX) / 2) * k,
        ty: H / 2 - ((minY + maxY) / 2) * k
      };
    }

    // The view tracks the layout while it relaxes — a one-shot fit snaps and
    // then lets the graph drift out of frame. Any manual pan/zoom stops it.
    var autoFit = true;
    function stepFit(ease) {
      if (!autoFit) return;
      var t = fitTarget();
      view.k += (t.k - view.k) * ease;
      view.tx += (t.tx - view.tx) * ease;
      view.ty += (t.ty - view.ty) * ease;
    }
    function snapFit() {
      var t = fitTarget();
      view.k = t.k; view.tx = t.tx; view.ty = t.ty;
    }

    // ── Interaction state ──
    var hoverNode = null;
    var pinnedNode = null;
    var dragNode = null;
    var panning = null;

    // Assay overlay — set once stage 3 has graded the stones. The layout never
    // changes with it: wagons come from the stones themselves, grades come from
    // the touchstones, and you want to see one against the other.
    var grades = null;      // Float32Array [N] or null
    var rank = null;        // [N] position in the grade order, 0 = best
    var payDirt = null;     // Set of indices in the pay-dirt cut

    function nodeColor(idx) {
      return cid[idx] >= 0 ? WAGON_COLORS[cid[idx] % WAGON_COLORS.length] : LONE_COLOR;
    }

    function draw() {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = getComputedStyle(canvas).getPropertyValue('--rock').trim() || '#21262e';
      ctx.fillRect(0, 0, W, H);

      var focus = pinnedNode !== null ? pinnedNode : hoverNode;
      // With a node pinned, hovering one of its own wagon-mates compares
      // against the pin. Unconnected stones don't react — the pin only
      // reads out against stones it actually shares a wagon with.
      var compareNode = (pinnedNode !== null && hoverNode !== null && hoverNode !== pinnedNode
        && nbrs[pinnedNode].indexOf(hoverNode) !== -1)
        ? hoverNode : null;
      var lit = null;
      if (focus !== null) {
        lit = new Set(nbrs[focus]);
        lit.add(focus);
        if (compareNode !== null) lit.add(compareNode);
      }

      // Edges
      for (var e = 0; e < edges.length; e++) {
        var ed = edges[e];
        var p = toScreen(nodes[ed.a]), q = toScreen(nodes[ed.b]);
        var touched = focus !== null && (ed.a === focus || ed.b === focus);
        var t = (ed.w - THRESH) / Math.max(0.001, 1 - THRESH);
        var alphaE = 0.12 + 0.5 * t;
        if (focus !== null) alphaE = touched ? 0.95 : alphaE * 0.25;
        ctx.globalAlpha = alphaE;
        ctx.strokeStyle = cid[ed.a] >= 0 && cid[ed.a] === cid[ed.b]
          ? nodeColor(ed.a) : '#7c7364';
        ctx.lineWidth = touched ? 1.6 : 0.8;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(q.x, q.y);
        ctx.stroke();
      }

      // Compare line: pin ↔ hovered wagon-mate.
      if (compareNode !== null) {
        var cp = toScreen(nodes[pinnedNode]), cq = toScreen(nodes[compareNode]);
        ctx.globalAlpha = 0.9;
        ctx.strokeStyle = '#f2ede3';
        ctx.lineWidth = 1.8;
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.moveTo(cp.x, cp.y);
        ctx.lineTo(cq.x, cq.y);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Nodes. Radius follows the zoom a little, so a tight wagon stays a
      // cloud of dots when zoomed out instead of one solid blob.
      var rScale = Math.min(1.3, Math.max(0.5, view.k));
      for (var n = 0; n < N; n++) {
        var s = toScreen(nodes[n]);
        var dim = focus !== null && !lit.has(n);
        ctx.globalAlpha = dim ? 0.18 : 1;
        ctx.fillStyle = nodeColor(n);
        ctx.beginPath();
        var rr = nodes[n].r * rScale * (n === focus ? 1.8 : 1);
        ctx.arc(s.x, s.y, rr, 0, Math.PI * 2);
        ctx.fill();
        if (payDirt && payDirt.has(n)) {
          // Pay dirt: gold ring, so the assay's picks are findable in the wagons
          ctx.globalAlpha = dim ? 0.35 : 1;
          ctx.strokeStyle = '#f5b301';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(s.x, s.y, rr + 3, 0, Math.PI * 2);
          ctx.stroke();
        }
        if (n === focus) {
          ctx.globalAlpha = 1;
          ctx.strokeStyle = '#f2ede3';
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.arc(s.x, s.y, rr, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
    }

    function loop() {
      if (stopped) return;
      var moving = tick();
      stepFit(0.12);
      draw();
      if (moving || dragNode !== null) raf = requestAnimationFrame(loop);
      else raf = null;
    }

    function wake(a) {
      if (a > alpha) alpha = a;
      if (raf === null && !stopped) raf = requestAnimationFrame(loop);
    }

    // ── Readout ── a tooltip naming the stone under the cursor. While it
    // trails the cursor its link can't be clicked, so a pinned stone parks
    // its tooltip on the node instead and lets the pointer reach the link.
    function tipHtml(idx) {
      var authors = (stones[idx].authors || []).join(', ');
      return '<div class="tt-title"><a href="' + stones[idx].abs_url +
        '" target="_blank" rel="noopener">' + escapeHtml(stones[idx].title) + '</a></div>' +
        /* Smaller than the title: who wrote it is the second question, and a
           twenty-author collaboration must not push the title off the node. */
        (authors ? '<div class="tt-authors">' + escapeHtml(authors) + '</div>' : '');
    }

    function emit(idx, isPinned, evt) {
      if (!readoutFn) return;
      if (idx === null) { readoutFn('', false, null); return; }
      readoutFn(tipHtml(idx), !!isPinned, evt);
    }

    /** Park the tooltip on the pinned node, clickable, wherever it has drifted. */
    function emitPinnedAnchor() {
      if (!readoutFn || pinnedNode === null) return;
      var rect = canvas.getBoundingClientRect();
      var s = toScreen(nodes[pinnedNode]);
      readoutFn(tipHtml(pinnedNode), true,
        { clientX: rect.left + s.x, clientY: rect.top + s.y });
    }

    // ── Mouse ──
    function pick(e) {
      var rect = canvas.getBoundingClientRect();
      var mx = e.clientX - rect.left, my = e.clientY - rect.top;
      var best = null, bestD = Infinity;
      var rScale = Math.min(1.3, Math.max(0.5, view.k));
      for (var n = 0; n < N; n++) {
        var s = toScreen(nodes[n]);
        var dx = s.x - mx, dy = s.y - my;
        var d = dx * dx + dy * dy;
        var hitR = nodes[n].r * rScale + 5;
        var hit = hitR * hitR;
        if (d < hit && d < bestD) { bestD = d; best = n; }
      }
      return { node: best, mx: mx, my: my };
    }

    canvas.onmousedown = function (e) {
      var p = pick(e);
      if (p.node !== null) {
        dragNode = nodes[p.node];
        dragNode.moved = false;
      } else {
        panning = { x: p.mx, y: p.my, tx: view.tx, ty: view.ty };
        autoFit = false;          // hands on the view: stop chasing the layout
      }
      wake(0.3);
    };

    canvas.onmousemove = function (e) {
      var rect = canvas.getBoundingClientRect();
      var mx = e.clientX - rect.left, my = e.clientY - rect.top;
      if (dragNode) {
        var wpt = toWorld(mx, my);
        dragNode.x = wpt.x; dragNode.y = wpt.y;
        dragNode.moved = true;
        wake(0.35);
        return;
      }
      if (panning) {
        view.tx = panning.tx + (mx - panning.x);
        view.ty = panning.ty + (my - panning.y);
        draw();
        return;
      }
      var p = pick(e);
      canvas.style.cursor = p.node !== null ? 'pointer' : 'grab';
      if (p.node !== hoverNode) {
        hoverNode = p.node;
        // Off every node with something pinned: hand the tooltip back to the
        // pin, parked and clickable, so the pointer can walk over to its link.
        if (hoverNode === null && pinnedNode !== null) emitPinnedAnchor();
        else if (hoverNode !== null && hoverNode === pinnedNode) emitPinnedAnchor();
        else emit(hoverNode, false, e);
        draw();
      } else if (hoverNode !== null && hoverNode !== pinnedNode) {
        readoutFn(null, false, e);   // reposition only
      }
    };

    canvas.onmouseup = function (e) {
      if (dragNode && !dragNode.moved) {
        var idx = dragNode.i;
        if (pinnedNode === idx) { pinnedNode = null; emit(idx, false, e); }
        else { pinnedNode = idx; emitPinnedAnchor(); }
        draw();
      }
      dragNode = null;
      panning = null;
    };

    canvas.onmouseleave = function () {
      dragNode = null;
      panning = null;
      hoverNode = null;
      // A pinned tooltip has to survive the cursor leaving the canvas — that
      // is exactly the trip the pointer makes to reach its link.
      if (pinnedNode !== null) emitPinnedAnchor();
      else emit(null, false, null);
      draw();
    };

    canvas.onwheel = function (e) {
      e.preventDefault();
      autoFit = false;
      var rect = canvas.getBoundingClientRect();
      var mx = e.clientX - rect.left, my = e.clientY - rect.top;
      var before = toWorld(mx, my);
      var factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      view.k = Math.max(0.15, Math.min(6, view.k * factor));
      var after = toWorld(mx, my);
      view.tx += (after.x - before.x) * view.k;
      view.ty += (after.y - before.y) * view.k;
      draw();
    };

    canvas.style.cursor = 'grab';

    // Warm up before the first paint. The opening frames are the ones where
    // wagons are still tearing themselves apart; showing them reads as flicker,
    // so run them silently and start the animation from a rough shape.
    var WARMUP = 90;
    for (var wu = 0; wu < WARMUP; wu++) {
      if (!tick()) break;
    }
    snapFit();
    draw();
    raf = requestAnimationFrame(loop);

    return {
      stop: function () {
        stopped = true;
        if (raf !== null) cancelAnimationFrame(raf);
        raf = null;
        canvas.onmousedown = canvas.onmousemove = canvas.onmouseup = null;
        canvas.onmouseleave = canvas.onwheel = null;
        pinnedNode = null;
        hoverNode = null;
        emit(null, false, null);
      },
      reheat: function () { autoFit = true; wake(1); },
      /** Drop the pin without touching the tooltip — the caller owns that. */
      unpin: function () {
        if (stopped) return;
        pinnedNode = null;
        draw();
      },
      /** Overlay the assay: gold rings on the pay-dirt cut, grades in the
       *  readout. Redraw only — the layout is left alone. */
      setAssay: function (g, order, topN) {
        if (!g || !order) { grades = null; rank = null; payDirt = null; }
        else {
          grades = g;
          rank = new Array(N);
          for (var o = 0; o < order.length; o++) rank[order[o]] = o;
          payDirt = new Set(order.slice(0, topN));
        }
        draw();
        var focus = pinnedNode !== null ? pinnedNode : hoverNode;
        if (focus !== null) emit(focus, pinnedNode !== null, null);
      }
    };
  }

  /** Wire a readout element to drawWagonMap's readoutFn contract. */
  function wagonReadoutSink(elId) {
    return function (full, detail, isPinned) {
      var el = byId(elId);
      el.innerHTML = full ? full + '  ·  ' + detail : '';
      el.classList.toggle('pinned', !!isPinned);
    };
  }

  /** Floating-tooltip sink for the wagon graph: (html, isPinned, evt).
   *  html === null repositions the open tooltip without rebuilding it. */
  function wagonTooltipSink() {
    var tip = byId('wagon-tooltip');
    return function (html, isPinned, evt) {
      if (html === null) {
        if (tip.style.display === 'block' && evt) positionTooltip(evt, tip);
        return;
      }
      if (!html) { tip.style.display = 'none'; tip.classList.remove('pinned'); return; }
      tip.innerHTML = html;
      // Only a pinned tooltip takes the pointer: a trailing one would sit
      // between the cursor and the canvas and swallow the next hover.
      tip.classList.toggle('pinned', !!isPinned);
      tip.style.display = 'block';
      if (evt) positionTooltip(evt, tip);
    };
  }

  /** Current matrix order, honouring the Clustered toggle. */
  function currentWagonOrder() {
    return byId('wagon-sort-toggle').checked
      ? state.wagonOrder
      : state.stones.map(function (_, i) { return i; });
  }

  var WAGON_GRAPH_HINT = 'drag a stone to move it · drag the rock to pan · ' +
    'scroll to zoom · click to pin, then hover its wagon-mates to compare';

  /** Wagon count and how many stones fell outside every wagon. Kept short —
   *  it shares the header row with the view switch and the threshold. */
  function updateWagonStats() {
    var comps = state.wagonComponents || [];
    var inWagon = 0;
    for (var c = 0; c < comps.length; c++) inWagon += comps[c].indices.length;
    var lone = state.stones.length - inWagon;
    byId('wagon-stats').innerHTML = comps.length
      ? '<strong>' + comps.length + '</strong> wagons · <strong>' + lone + '</strong> lone'
      : 'no wagons · <strong>' + state.stones.length + '</strong> lone';
  }

  /** Push the current grades onto any live wagon graph. No-op before stage 3. */
  function applyWagonAssay() {
    var topN = state.blend.paydirt_n;
    var hint = byId('wagon-graph-hint');
    if (hint) {
      hint.innerHTML = WAGON_GRAPH_HINT +
        (state.grades ? ' · <span class="wagon-paydirt-tag">gold ring</span> = pay dirt' : '');
    }
    var graphs = [state.wagonGraph, state.wagonModalGraph];
    for (var i = 0; i < graphs.length; i++) {
      if (!graphs[i]) continue;
      graphs[i].setAssay(state.grades, state.order, topN);
    }
    // The tables carry a Grade column that only exists once stage 3 has run.
    if (state.wagonView === 'table' && state.wagonMap) renderWagonTables();
  }

  /**
   * Table view: one table per wagon, plus a closing table of the lone stones.
   * Within a wagon, stones are ordered by centrality — the stone most like the
   * rest of its wagon first, so the head of each table reads as its subject.
   */
  function renderWagonTables() {
    var wrap = byId('wagon-table-wrap');
    var stones = state.stones;
    var S = state.wagonMap;
    var comps = state.wagonComponents || [];
    var colors = WAGON_COLORS;

    var inWagon = new Set();
    var html = '';

    for (var c = 0; c < comps.length; c++) {
      var members = comps[c].indices.slice();
      for (var m = 0; m < members.length; m++) inWagon.add(members[m]);

      // Centrality: mean similarity to the rest of the wagon.
      var central = {};
      for (var a = 0; a < members.length; a++) {
        var sum = 0;
        for (var b = 0; b < members.length; b++) {
          if (a !== b) sum += S[members[a]][members[b]];
        }
        central[members[a]] = members.length > 1 ? sum / (members.length - 1) : 1;
      }
      members.sort(function (x, y) { return central[y] - central[x]; });

      html += '<div class="wagon-table-block" id="wagon-block-' + c + '">' +
        '<div class="wagon-table-head">' +
          '<span class="wagon-swatch" style="background:' + colors[c % colors.length] + '"></span>' +
          '<span class="wagon-table-name">' + escapeHtml(wagonLabel(c)) + '</span>' +
          '<span class="wagon-table-count">' + members.length + ' stones</span>' +
          (comps[c].gloss
            ? '<span class="wagon-table-gloss">' + escapeHtml(comps[c].gloss) + '</span>'
            : '') +
        '</div>' +
        wagonTableRows(members, central);
      html += '</div>';
    }

    var lone = [];
    for (var i = 0; i < stones.length; i++) if (!inWagon.has(i)) lone.push(i);
    if (lone.length) {
      html += '<div class="wagon-table-block" id="wagon-block-lone">' +
        '<div class="wagon-table-head">' +
          '<span class="wagon-swatch" style="background:' + LONE_COLOR + '"></span>' +
          '<span class="wagon-table-name">Lone stones</span>' +
          '<span class="wagon-table-count">' + lone.length + ' stones</span>' +
        '</div>' +
        wagonTableRows(lone, null);
      html += '</div>';
    }

    wrap.innerHTML = html || '<p class="hint">No stones to show.</p>';
  }

  /** Rows for one wagon table. `central` null means the lone-stone table. */
  function wagonTableRows(members, central) {
    var stones = state.stones;
    var grades = state.grades;
    /* No arXiv-ID column: the title is the link to the abstract page, so the
       id was a second copy of the same click eating the width the title and
       the authors want. */
    var out = '<table class="wagon-table"><thead><tr>' +
      '<th>Title</th><th>Authors</th><th>Category</th>' +
      (central ? '<th>Centrality</th>' : '') +
      (grades ? '<th>Grade</th>' : '') +
      '</tr></thead><tbody>';
    for (var i = 0; i < members.length; i++) {
      var si = members[i];
      var st = stones[si];
      var authors = shortAuthors(st.authors);
      var authorsFull = (st.authors || []).map(unTex).join(', ');
      out += '<tr>' +
        /* One line, clipped, with the whole title in the native tooltip: a
           wrapped title makes rows of different heights and the table stops
           being scannable, which is the only thing it is for. */
        '<td class="wagon-td-title-cell"><a class="wagon-td-title" href="' + st.abs_url +
          '" target="_blank" rel="noopener" title="' + escapeHtml(st.title) + '">' +
          escapeHtml(st.title) + '</a></td>' +
        /* The scroller has to be a div: a td is a table-cell box and ignores
           overflow, so the names used to spill over the next column. */
        '<td class="wagon-td-authors" title="' + escapeHtml(authorsFull) + '">' +
          '<div class="wagon-authors-scroll">' + escapeHtml(authors) + '</div></td>' +
        '<td class="wagon-td-cat">' + escapeHtml(st.primary_category || '') + '</td>' +
        (central ? '<td class="num">' + central[si].toFixed(3) + '</td>' : '') +
        (grades ? '<td class="num">' + grades[si].toFixed(3) + '</td>' : '') +
        '</tr>';
    }
    return out + '</tbody></table>';
  }

  /* ── The train strip ───────────────────────────────────────────────
     One wagon per cluster, sitting above whichever view is selected. A
     wagon's width is its share of the haul — eight stones next to five
     draw 8:5 — so the shape of the night reads before a single table
     does, and dragging the threshold is watching wagons couple and split.
     Stones in no wagon ride the flatcar at the tail, which keeps the
     strip's full width equal to the whole haul. */

  /** Most common primary category among `members`, '' if none carry one. */
  function topCategory(members) {
    var stones = state.stones, counts = {}, best = '', bestN = 0;
    for (var i = 0; i < members.length; i++) {
      var cat = stones[members[i]].primary_category;
      if (!cat) continue;
      counts[cat] = (counts[cat] || 0) + 1;
      if (counts[cat] > bestN) { bestN = counts[cat]; best = cat; }
    }
    return best;
  }

  /** Tooltip body for one wagon. `central` null means the lone flatcar. */
  function wagonTipHtml(name, members, central, total, gloss) {
    var pct = total ? Math.round((members.length / total) * 100) : 0;
    var cat = topCategory(members);
    return '<div class="tt-title">' + escapeHtml(name) + '</div>' +
      '<div class="tt-row">' + members.length + ' stones · ' + pct + '% of the haul' +
        (cat ? ' · mostly ' + escapeHtml(cat) : '') + '</div>' +
      (gloss ? '<div class="tt-row tt-gloss">' + escapeHtml(gloss) + '</div>' : '') +
      (central ? '<div class="tt-row tt-central">' + escapeHtml(central) + '</div>' : '');
  }

  /**
   * Rebuild the strip from the current components. Cheap enough to run on
   * every slider input — it is a handful of divs, no canvas and no layout
   * of its own beyond flex.
   */
  function renderTrainStrip() {
    var strip = byId('train-strip');
    if (!strip) return;
    var comps = state.wagonComponents || [];
    var stones = state.stones || [];
    if (!stones.length) { strip.innerHTML = ''; return; }

    var inWagon = 0;
    for (var c = 0; c < comps.length; c++) inWagon += comps[c].indices.length;
    var lone = stones.length - inWagon;

    var html = '<span class="train-loco" aria-hidden="true"></span>';
    for (var w = 0; w < comps.length; w++) {
      var n = comps[w].indices.length;
      /* flex-grow carries the ratio and flex-basis is 0, so widths are the
         counts themselves rather than counts plus some content width. */
      html += '<button type="button" class="train-wagon" data-wagon="' + w + '"' +
        ' style="flex-grow:' + n + ';background:' +
        WAGON_COLORS[w % WAGON_COLORS.length] + '"' +
        /* aria-label, not title: the rich hover card already says all of this,
           and the native tooltip drew on top of it. */
        ' aria-label="' + escapeHtml(wagonLabel(w)) + ' — ' + n + ' stones">' +
        '<span class="train-wagon-n">' + n + '</span></button>';
    }
    if (lone) {
      html += '<button type="button" class="train-wagon is-lone" data-wagon="lone"' +
        ' style="flex-grow:' + lone + ';background:' + LONE_COLOR + '"' +
        ' aria-label="Lone stones — ' + lone + ' stones">' +
        '<span class="train-wagon-n">' + lone + '</span></button>';
    }
    strip.innerHTML = html;
  }

  /** Wagon under the pointer, or null. */
  function stripWagonAt(target) {
    return target && target.closest ? target.closest('.train-wagon') : null;
  }

  /* Hover reads the wagon out into its own floating tooltip — the graph's
     tooltip is tied up in that view's pin state, so the strip keeps a
     separate one and never fights it. */
  function wireTrainStrip() {
    var strip = byId('train-strip');
    var tip = byId('train-strip-tip');
    if (!strip || !tip) return;

    function hide() { tip.style.display = 'none'; }

    strip.addEventListener('mousemove', function (e) {
      var el = stripWagonAt(e.target);
      if (!el) { hide(); return; }
      var key = el.getAttribute('data-wagon');
      var comps = state.wagonComponents || [];
      var members, name, central, gloss = '';
      if (key === 'lone') {
        var inWagon = new Set();
        for (var c = 0; c < comps.length; c++) {
          for (var m = 0; m < comps[c].indices.length; m++) inWagon.add(comps[c].indices[m]);
        }
        members = [];
        for (var i = 0; i < state.stones.length; i++) if (!inWagon.has(i)) members.push(i);
        name = 'Lone stones';
        central = null;
      } else {
        var comp = comps[+key];
        if (!comp) { hide(); return; }
        members = comp.indices;
        name = wagonLabel(+key);
        central = comp.centralTitle;
        gloss = comp.gloss || '';
      }
      tip.innerHTML = wagonTipHtml(name, members, central, state.stones.length, gloss);
      tip.style.display = '';
      /* Clamp to the viewport so the last wagon's tooltip does not hang off
         the right edge of a narrow window. */
      var w = tip.offsetWidth || 260;
      var x = Math.min(e.clientX + 14, window.innerWidth - w - 8);
      tip.style.left = Math.max(8, x) + 'px';
      tip.style.top = (e.clientY + 16) + 'px';
    });
    strip.addEventListener('mouseleave', hide);

    /* A wagon is also a jump: click it and the table view opens on that
       wagon's own table. */
    strip.addEventListener('click', function (e) {
      var el = stripWagonAt(e.target);
      if (!el) return;
      hide();
      var key = el.getAttribute('data-wagon');
      if (state.wagonView !== 'table') {
        var btn = byId('wagon-view-switch').querySelector('.wagon-view-btn[data-view="table"]');
        if (btn) btn.click();
      }
      var block = byId('wagon-block-' + key);
      if (block && block.scrollIntoView) {
        block.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  }

  /** Render the inline wagon panel in whichever view is selected. */
  function renderWagonPanel() {
    if (!state.wagonMap || !state.stones.length) return;
    var view = state.wagonView;
    var isGraph = view === 'graph';
    var isTable = view === 'table';
    var isMatrix = view === 'matrix';

    // The strip stands whichever view is showing: it is the overview the
    // three views are details of.
    renderTrainStrip();

    byId('wagon-matrix-wrap').style.display = isMatrix ? '' : 'none';
    byId('wagon-graph-wrap').style.display = isGraph ? '' : 'none';
    byId('wagon-table-wrap').style.display = isTable ? '' : 'none';
    byId('wagon-sort-label').style.display = isMatrix ? '' : 'none';
    // Nothing to blow up about a table — it already uses the full width.
    byId('wagon-expand-btn').style.display = isTable ? 'none' : '';
    // Only the matrix reads out into the bar below it: the graph has its own
    // floating tooltip and the table says everything on its face.
    byId('wagon-readout').style.display = isMatrix ? '' : 'none';
    byId('wagon-readout').innerHTML = '';
    byId('wagon-readout').classList.remove('pinned');
    releaseWagonPin();

    if (state.wagonGraph) { state.wagonGraph.stop(); state.wagonGraph = null; }

    if (isGraph) {
      var wrap = byId('wagon-graph-wrap');
      var w = Math.max(320, wrap.clientWidth || 640);
      state.wagonGraph = drawWagonGraph(
        byId('wagon-graph-canvas'), state.wagonMap, state.stones, state.wagonComponents,
        wagonTooltipSink(), { width: w, height: 420, thresh: state.wagonThresh });
      applyWagonAssay();
    } else if (isTable) {
      renderWagonTables();
    } else {
      drawWagonMap(byId('wagon-canvas'), state.wagonMap, currentWagonOrder(), state.stones,
        state.wagonComponents, wagonReadoutSink('wagon-readout'));
    }
  }

  /* ── The haul train ────────────────────────────────────────────────
     Stage 1's progress read-out is a pixel-art mine train instead of a bar.
     A bar says how far along the haul is; the train says that and two
     things a bar cannot — how big the night is (one cart per six papers, so
     a fat announcement pulls a longer train) and how much of it is worth
     carrying up (stones drop in as the abstracts come back, mostly dull
     rock, gold now and then).

     Drawn on an integer art grid so it is as blocky as the cave walls in
     the gutters: the canvas transform is set to `scale` art-pixels per CSS
     pixel and every rect below is in whole art pixels. */
  var TRAIN = {
    ART_H: 26,       // art rows: chimney smoke at the top, sleepers at the bottom
    RAIL_Y: 21,      // the row the wheels rest on
    ENG_W: 20,
    CART_W: 14,      // 12 of body + 2 of coupling gap
    CART_CAP: 6,     // stones per cart: 3 across, 2 deep
    MIN_CARTS: 3,
    SCROLL: 15,      // art px/s the track slides under a standing train
  };

  // Cave palette, pre-resolved — canvas can't read var().
  var TRAIN_C = {
    tie: '#2a3038', rail: '#4a525e',
    iron: '#39414d', ironLit: '#525c6a', ironDark: '#1b1f26',
    wheel: '#2b313a', hub: '#6d7682',
    glass: '#b98a08', lamp: '#f5b301',
    hold: '#15181d',                        // unlit cart interior
    rock: '#3f3a33', rockLit: '#5e564a',    // dull stone, warm against the iron
    gold: '#f5b301', goldLit: '#ffd45e',
  };

  /* Which stones came up gold. Hashed off the slot index rather than rolled,
     so a stone keeps its colour across sixty redraws a second. */
  function trainStoneGold(i) {
    return (((i + 1) * 2654435761) >>> 0) % 100 < 22;
  }

  /**
   * Mount the train on `canvas`. Returns a handle:
   *   .set(done, total)  — done abstracts of total; relays the train when
   *                        the total changes, then fills toward done/total
   *   .stop()            — cancel the animation frame; call when the wrap hides
   * Returns null where there is no canvas to draw on (the test DOM shim).
   */
  function startHaulTrain(canvas) {
    if (!canvas || typeof canvas.getContext !== 'function') return null;
    var ctx = canvas.getContext('2d');
    if (!ctx) return null;

    var dpr = window.devicePixelRatio || 1;
    var still = !!(window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches);

    var scale = 3, artW = 0, carts = TRAIN.MIN_CARTS, capacity = carts * TRAIN.CART_CAP;
    var laidOutFor = -1; // the total the current train length was built for
    var target = 0;      // stones the haul has earned
    var shown = 0;       // stones drawn, chasing target so they land one by one
    var shownF = 0;      // …carried as a float, so a slow frame still lands the tail
    var lastDrop = -99;  // when the newest stone started falling
    var t = 0, prev = 0, raf = 0, alive = true;
    var puffs = [];
    var nextPuff = 0;

    function now() { return (window.performance || Date).now() / 1000; }

    /* Cart count follows the day's size, but the train has to fit the column:
       chunky 3× pixels first, 2× only when that is what buys the full train. */
    function relayout(total) {
      /* Measure the wrap, not the canvas: relayout pins the canvas to an
         exact pixel width, so measuring itself would ratchet the train
         shorter every time it is called. */
      var avail = Math.max(200,
        (canvas.parentNode && canvas.parentNode.clientWidth) || canvas.clientWidth || 480);
      var want = Math.max(TRAIN.MIN_CARTS, Math.ceil(total / TRAIN.CART_CAP));
      function fits(s) {
        return Math.floor((avail / s - TRAIN.ENG_W) / TRAIN.CART_W);
      }
      scale = (fits(3) < want && fits(2) >= want) ? 2 : 3;
      carts = Math.max(TRAIN.MIN_CARTS, Math.min(want, Math.max(TRAIN.MIN_CARTS, fits(scale))));
      capacity = carts * TRAIN.CART_CAP;
      artW = TRAIN.ENG_W + carts * TRAIN.CART_W;

      canvas.width = Math.round(artW * scale * dpr);
      canvas.height = Math.round(TRAIN.ART_H * scale * dpr);
      canvas.style.width = (artW * scale) + 'px';
      canvas.style.height = (TRAIN.ART_H * scale) + 'px';
      ctx.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0);
      ctx.imageSmoothingEnabled = false;
    }

    function px(x, y, w, h, color) {
      ctx.fillStyle = color;
      ctx.fillRect(x, y, w, h);
    }

    /* A dark tyre with a lit rim, and one spoke pixel walking around the hub
       — at four pixels across that is the whole vocabulary a wheel gets, and
       the walking pixel is what makes it read as turning rather than sliding. */
    function wheel(x, y, size, phase) {
      var e = size - 1;
      px(x, y, size, size, TRAIN_C.wheel);
      px(x + 1, y, e - 1, 1, TRAIN_C.rail);
      px(x + 1, y + e, e - 1, 1, TRAIN_C.rail);
      px(x, y + 1, 1, e - 1, TRAIN_C.rail);
      px(x + e, y + 1, 1, e - 1, TRAIN_C.rail);
      var spoke = size > 3
        ? [[1, 1], [2, 1], [2, 2], [1, 2]]
        : [[1, 0], [2, 1], [1, 2], [0, 1]];
      var s = spoke[Math.floor(phase * 4) % 4];
      px(x + s[0], y + s[1], 1, 1, TRAIN_C.hub);
    }

    function drawEngine(ex, yb, phase) {
      wheel(ex + 2, yb - 3, 4, phase);
      wheel(ex + 9, yb - 3, 4, phase);
      px(ex, yb - 5, 19, 2, TRAIN_C.iron);            // chassis
      px(ex + 1, yb - 12, 12, 7, TRAIN_C.iron);       // boiler
      px(ex + 1, yb - 12, 12, 1, TRAIN_C.ironLit);
      px(ex, yb - 11, 1, 5, TRAIN_C.ironLit);         // front plate
      px(ex + 2, yb - 16, 3, 4, TRAIN_C.iron);        // chimney
      px(ex + 1, yb - 16, 5, 1, TRAIN_C.ironLit);
      px(ex + 8, yb - 14, 2, 2, TRAIN_C.ironLit);     // steam dome
      px(ex + 13, yb - 15, 6, 10, TRAIN_C.iron);      // cab
      px(ex + 12, yb - 16, 8, 1, TRAIN_C.ironLit);    // roof
      px(ex + 15, yb - 13, 3, 3, TRAIN_C.glass);      // lit window
      px(ex - 1, yb - 10, 2, 2, TRAIN_C.lamp);        // headlamp
    }

    function drawCart(cx, yb, phase, firstSlot) {
      wheel(cx + 2, yb - 2, 3, phase);
      wheel(cx + 7, yb - 2, 3, phase);
      px(cx, yb - 11, 12, 9, TRAIN_C.iron);           // tub
      px(cx, yb - 11, 12, 1, TRAIN_C.ironLit);        // lit rim
      px(cx + 1, yb - 10, 10, 7, TRAIN_C.hold);       // the hold itself
      px(cx + 12, yb - 7, 2, 1, TRAIN_C.iron);        // coupling

      for (var s = 0; s < TRAIN.CART_CAP; s++) {
        var idx = firstSlot + s;
        if (idx >= shown) break;
        var col = [2, 5, 8][s % 3];
        var row = s < 3 ? yb - 5 : yb - 8;            // bottom row loads first
        /* The newest stone falls the last few pixels into its slot — from the
           rim, not above it, so it never reads as floating beside the cart. */
        var drop = 0;
        if (idx === shown - 1) {
          var p = (t - lastDrop) / 0.18;
          if (p < 1) drop = -Math.round((1 - Math.max(0, p)) * (row - (yb - 10)));
        }
        var gold = trainStoneGold(idx);
        px(cx + col, row + drop, 2, 2, gold ? TRAIN_C.gold : TRAIN_C.rock);
        px(cx + col, row + drop, 1, 1, gold ? TRAIN_C.goldLit : TRAIN_C.rockLit);
      }
    }

    function frame() {
      if (!alive) return;
      var n = now();
      var elapsed = prev ? n - prev : 0.016;
      // The wheels and the scrolling track want a clamped step, or a frame the
      // browser skipped turns into a jump. The load does not — see below.
      var dt = Math.min(0.05, elapsed);
      prev = n;
      t += dt;

      /* Stones land at a readable rate rather than snapping to the count, but
         the rate is per second, not per frame: the gap decays by a fixed
         factor of e⁻⁷ per second whatever the frame delivery. Frames are
         exactly what goes short here — the main thread is busy embedding while
         the haul runs, and a backgrounded tab gets a frame a second — and a
         per-frame step left the train stuck at a third of a load it had
         already earned. */
      if (shownF < target) {
        shownF = still ? target : target - (target - shownF) * Math.exp(-7 * elapsed);
        if (target - shownF < 0.5) shownF = target;
        var next = Math.min(target, Math.ceil(shownF));
        if (next !== shown) { shown = next; lastDrop = t; }
      } else if (shownF > target) {
        shownF = shown = target;   // a re-haul empties the carts
      }

      var moving = shown < capacity;
      var yb = TRAIN.RAIL_Y;
      var bob = moving && !still && Math.floor(t * 5) % 2 ? 1 : 0;
      var phase = still ? 0 : (moving ? t * 1.6 : 0);

      ctx.clearRect(0, 0, artW, TRAIN.ART_H);

      // Track. The train stands still and the sleepers run under it — the
      // alternative is a train that leaves the canvas.
      px(0, yb + 1, artW, 1, TRAIN_C.rail);
      var off = still || !moving ? 0 : Math.floor(t * TRAIN.SCROLL) % 7;
      for (var x = -7 + (7 - off); x < artW; x += 7) px(x, yb + 3, 4, 2, TRAIN_C.tie);

      // Smoke, only while there is still coal to burn.
      if (moving && !still) {
        if (t > nextPuff) {
          puffs.push({ x: TRAIN.ENG_W - 16, y: yb - 17, age: 0 });
          nextPuff = t + 0.42;
        }
        for (var i = puffs.length - 1; i >= 0; i--) {
          var p = puffs[i];
          p.age += dt;
          p.x -= 5 * dt; p.y -= 4.5 * dt;
          if (p.age > 1.4 || p.y < -3) { puffs.splice(i, 1); continue; }
          var size = 1 + Math.floor(p.age * 2.2);
          ctx.fillStyle = 'rgba(153,161,173,' + (0.42 * (1 - p.age / 1.4)).toFixed(3) + ')';
          ctx.fillRect(Math.round(p.x), Math.round(p.y), size, size);
        }
      }

      drawEngine(2, yb - bob, phase);
      for (var c = 0; c < carts; c++) {
        drawCart(TRAIN.ENG_W + c * TRAIN.CART_W, yb - bob, phase, c * TRAIN.CART_CAP);
      }

      // A loaded train stands still, and so does a reduced-motion one: stop
      // asking for frames rather than repainting an unchanging picture.
      if ((still || !moving) && shown === target) { raf = 0; return; }
      raf = requestAnimationFrame(frame);
    }

    function set(done, total) {
      total = total || 0;
      if (total !== laidOutFor) {
        laidOutFor = total;
        relayout(total);              // relayout clamps the length to the column
        if (shown > capacity) shownF = shown = capacity;
      }
      target = total > 0 ? Math.min(capacity, Math.round((done / total) * capacity)) : 0;
      if (!raf) { prev = 0; raf = requestAnimationFrame(frame); }
    }

    relayout(0);
    raf = requestAnimationFrame(frame);
    return {
      set: set,
      stop: function () { alive = false; if (raf) cancelAnimationFrame(raf); raf = 0; }
    };
  }

  async function runHaul() {
    var btn = byId('haul-btn');
    var statusEl = byId('haul-status');
    var progWrap = byId('haul-progress-wrap');
    var progLabel = byId('haul-label');
    var wagonPanel = byId('wagon-panel');

    btn.disabled = true;
    btn.classList.remove('is-done');
    btn.textContent = '🪨 Haul the stones';
    progWrap.style.display = 'flex';
    // Wrap has to be visible first: the train measures the column to decide
    // how chunky its pixels can be.
    if (state.haulTrain) state.haulTrain.stop();
    state.haulTrain = startHaulTrain(byId('haul-train'));
    progLabel.textContent = 'Scouting...';
    state.hauledFromCache = 0;
    statusEl.textContent = '';
    statusEl.style.color = '';
    wagonPanel.style.display = 'none';

    /* Last haul's assay is indexed by last haul's stones. A new haul with a
       different count would read past the end of it — drop it here and let
       computeGrades() below put a matching one back. */
    state.grades = null;
    state.order = null;
    byId('assay-table-wrap').style.display = 'none';
    byId('stage-3').style.display = 'none';

    try {
      // Scout
      statusEl.textContent = 'Scouting arXiv...';
      var stones = await scoutDay();
      state.stones = stones;

      // Embed abstracts
      statusEl.textContent = 'Embedding ' + stones.length + ' abstracts...';
      var texts = stones.map(function (s) { return s.abstract; });
      var vectors = await embedTextsCached(texts, function (done, total) {
        if (state.haulTrain) state.haulTrain.set(done, total);
        progLabel.textContent = 'Stones hauled: ' + done + ' / ' + total;
      }, function (misses, total, pickLoaded) {
        if (misses === 0) {
          statusEl.textContent = 'All ' + total + ' stones already cut — no cutting needed.';
        } else if (!pickLoaded) {
          // The one place a 32 MB download starts without the user asking for
          // it directly. Say so, with the number that justifies it.
          statusEl.textContent = misses + ' of ' + total +
            ' stones need cutting — sharpening the pick (~32 MB, once).';
        } else {
          statusEl.textContent = 'Cutting ' + misses + ' of ' + total + ' stones...';
        }
      });
      state.A = vectors;
      state.hauledFromCache = vectors.cached || 0;

      // Compute coupling map
      statusEl.textContent = 'Computing coupling map...';
      var S = computeWagonMap(vectors);
      state.wagonMap = S;

      // Start from the threshold that splits this haul into the most wagons,
      // rather than a fixed cut that suits one day's papers and not the next.
      state.wagonThresh = bestWagonThresh(S, stones.length);
      byId('wagon-thresh-slider').value = state.wagonThresh;
      byId('wagon-thresh-value').textContent = state.wagonThresh.toFixed(2);

      var cluster = clusterOrder(stones, S, state.wagonThresh);
      state.wagonOrder = cluster.order;
      state.wagonComponents = cluster.components;
      reattachWagonNames();

      updateWagonStats();
      byId('wagon-sort-toggle').checked = true;
      wagonPanel.style.display = '';

      // Draw whichever view is selected (panel must be visible first, so the
      // graph canvas can measure its own width)
      renderWagonPanel();

      // Mark done. The breakdown is worth showing: "why 55 and not 43" is the
      // cross-lists, and the number only makes sense next to the listing page
      // if the split is visible.
      var nNew = 0, nCross = 0, nEarlier = 0;
      stones.forEach(function (st) {
        if (st.announce === 'cross') nCross++;
        else if (st.announce === 'earlier') nEarlier++;
        else nNew++;
      });
      var parts = [nNew + ' new'];
      if (nCross) parts.push(nCross + ' cross-listed');
      if (nEarlier) parts.push(nEarlier + ' from earlier days');
      /* Say how many came down the shaft already cut. It is the difference
         between a minute and a second, and the user should be able to see
         which one they just got. */
      if (state.hauledFromCache) {
        parts.push(state.hauledFromCache + ' already cut (cached)');
      }
      statusEl.textContent = stones.length + ' stones hauled — ' + parts.join(', ') + '.';
      statusEl.style.color = 'var(--moss)';
      /* The loaded train stays on the page — it is the picture of the day's
         take, and the count next to the button reads as its caption. */
      if (state.haulTrain) state.haulTrain.set(stones.length, stones.length);
      progLabel.textContent = '';
      /* Stays clickable: a haul is a snapshot of one scout setting, and the
         scout is editable right above it, so re-hauling has to be possible. */
      btn.textContent = '✓ Hauled';
      btn.classList.add('is-done');
      btn.disabled = false;

      // If touchstones already exist from localStorage, embed them and show assay
      if (state.touchstones.length > 0 || state.cores.length > 0) {
        await maybeEmbedFeatures();
        computeGrades();
        renderAssay();
      }

    } catch (err) {
      statusEl.textContent = err.message;
      statusEl.style.color = 'var(--ember)';
      if (state.haulTrain) { state.haulTrain.stop(); state.haulTrain = null; }
      progWrap.style.display = 'none';
      btn.disabled = false;
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // STAGE 2 — Filter (touchstones + core samples)
  // ═══════════════════════════════════════════════════════════════════

  // Touchstone row management
  function findTouchstone(id) {
    for (var i = 0; i < state.touchstones.length; i++) {
      if (state.touchstones[i].id === id) return state.touchstones[i];
    }
    return null;
  }

  /* Render one existing record. The record already lives in state.touchstones
     — this only draws it and wires the inputs back to it. Nothing downstream
     ever reads these inputs; getWeights() reads the records. */
  function renderTouchstoneRow(t) {
    var list = byId('touchstones-list');
    var div = document.createElement('div');
    div.className = 'touchstone-row';
    div.dataset.id = t.id;
    div.innerHTML =
      '<input type="text" class="ts-text" value="' + escapeHtml(t.text || '') + '" placeholder="silicon spin qubits and exchange gates">' +
      '<button type="button" class="row-remove" title="Remove">×</button>';
    list.appendChild(div);

    div.querySelector('.row-remove').addEventListener('click', function () {
      div.remove();
      removeTouchstone(t.id);
    });
    div.querySelector('.ts-text').addEventListener('input', function () {
      onTouchstoneChanged(t.id, this.value);
    });
  }

  function addTouchstone(text, weight) {
    var rec = {
      id: 'ts-' + (++touchstoneCounter),
      text: text || '',
      weight: isFinite(weight) ? weight : 1.0,
      vector: null,
    };
    state.touchstones.push(rec);
    renderTouchstoneRow(rec);
    // A row with no provenance joins a loaded preset: that preset is now edited.
    syncPresetSelection();
    autosave();
    return rec;
  }

  function removeTouchstone(id) {
    state.touchstones = state.touchstones.filter(function (t) { return t.id !== id; });
    syncPresetSelection();
    autosave();
    reassay();
  }

  function onTouchstoneChanged(id, text) {
    var rec = findTouchstone(id);
    if (!rec) return;
    rec.text = text;
    rec.vector = null; // force re-embed
    /* The edited phrase is the user's now, whatever it started as, so it loses
       the preset's provenance and goes back down the local path. Dropped here,
       on the first keystroke, rather than on blur or on assay: between those
       moments is exactly where a typed phrase could reach the shared cache. */
    rec.preset = null;
    syncPresetSelection();
    autosave();
    reassay();
  }

  function onWeightChanged() {
    autosave();
    if (state.A && state.A.length > 0 && state.featureVectors) {
      computeGrades();
      renderAssay();
    }
  }

  // Core sample management
  function findCore(id) {
    for (var i = 0; i < state.cores.length; i++) {
      if (state.cores[i].id === id) return state.cores[i];
    }
    return null;
  }

  function coreRowEl(id) {
    return byId('cores-list').querySelector('.core-row[data-id="' + id + '"]');
  }

  function renderCoreRow(c) {
    var list = byId('cores-list');
    var div = document.createElement('div');
    div.className = 'core-row';
    div.dataset.id = c.id;
    div.innerHTML =
      '<input type="text" class="core-doi" value="' + escapeHtml(c.doi || '') + '" placeholder="10.1103/RevModPhys.95.025003">' +
      '<span class="row-status">' + escapeHtml(c.status || '') + '</span>' +
      '<button type="button" class="row-remove" title="Remove">×</button>';
    list.appendChild(div);

    div.querySelector('.row-remove').addEventListener('click', function () {
      div.remove();
      removeCore(c.id);
    });
    var input = div.querySelector('.core-doi');
    input.addEventListener('change', function () {
      var rec = findCore(c.id);
      if (!rec) return;
      rec.doi = this.value.trim();
      rec.title = '';
      rec.vector = null;
      delete this.dataset.doi;
      autosave();
      resolveCore(c.id);
    });
    /* The field shows the title once the paper is found, but the DOI is still
       what the field means — put it back while the cursor is in there, and
       show the title again on the way out if nothing was typed. */
    input.addEventListener('focus', function () {
      if (this.dataset.doi) this.value = this.dataset.doi;
    });
    input.addEventListener('blur', function () {
      var rec = findCore(c.id);
      if (rec && this.dataset.doi && this.value.trim() === rec.doi) {
        showCoreTitle(rec, this);
      }
    });
    if (c.title) showCoreTitle(c, input);
  }

  /* A DOI is a label nobody reads. Once the paper behind it is known, the row
     wears the title and keeps the DOI on the element, so the field still edits
     as a DOI and a claim still saves one. */
  function showCoreTitle(rec, input) {
    var el = input || (coreRowEl(rec.id) ? coreRowEl(rec.id).querySelector('.core-doi') : null);
    if (!el || !rec.title) return;
    if (document.activeElement === el) { el.dataset.doi = rec.doi; return; }
    el.dataset.doi = rec.doi;
    el.value = rec.title;
    el.title = rec.doi;
  }

  function addCore(doi, weight) {
    var rec = {
      id: 'core-' + (++coreCounter),
      doi: doi || '',
      weight: isFinite(weight) ? weight : 1.0,
      title: '', abstract: '', vector: null, status: '', weak: false,
    };
    state.cores.push(rec);
    renderCoreRow(rec);
    autosave();
    if (rec.doi) resolveCore(rec.id);
    return rec;
  }

  function removeCore(id) {
    state.cores = state.cores.filter(function (c) { return c.id !== id; });
    autosave();
    reassay();
  }

  /* Every core row that still has no vector — the parked ones from a claim
     loaded before the pick was sharpened, plus any that errored. */
  async function resolveAllCores() {
    for (var i = 0; i < state.cores.length; i++) {
      if (state.cores[i].doi && !state.cores[i].vector) {
        await resolveCore(state.cores[i].id);
      }
    }
  }

  /* OpenAlex 404s on a bare DOI — `/works/10.1038/nature02693` is not found,
     `/works/doi:10.1038/nature02693` is. The bare form is what everyone types
     and what every corpus record stores, so every core sample entered that way
     failed to resolve. Mirrored in scripts/warm-dig.mjs, which has the tests. */
  function doiKey(doi) {
    var bare = String(doi || '').trim()
      .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
      .replace(/^doi:/i, '');
    return bare ? 'doi:' + bare.toLowerCase() : '';
  }

  async function fetchCoreFromOpenAlex(doi) {
    var cacheKey = coreCacheKey(doi);
    if (state._coreCache && state._coreCache[cacheKey]) {
      return state._coreCache[cacheKey];
    }

    var url = 'https://api.openalex.org/works/' + encodeURIComponent(doiKey(doi)) + '?mailto=' + encodeURIComponent(OPENALEX_MAILTO);
    var resp = await fetch(url);
    if (!resp.ok) throw new Error('OpenAlex returned HTTP ' + resp.status);

    var data = await resp.json();
    var title = data.title || '';
    var abstract = '';
    var weak = false;

    var invIdx = data.abstract_inverted_index;
    if (invIdx) {
      // Reconstruct abstract from inverted index
      var posToWord = {};
      for (var word in invIdx) {
        if (invIdx.hasOwnProperty(word)) {
          var positions = invIdx[word];
          for (var p = 0; p < positions.length; p++) {
            posToWord[positions[p]] = word;
          }
        }
      }
      var words = [];
      for (var pos = 0; posToWord[pos] !== undefined; pos++) {
        words.push(posToWord[pos]);
      }
      abstract = words.join(' ');
    }

    if (!abstract) {
      abstract = title; // fallback
      weak = true;
    }

    // Embed title + abstract together
    var embedText = title + ' ' + abstract;
    /* Through the shared cache: a core sample is a paper other people keep
       too, so its vector is the most re-fetched text in the whole app. */
    var vectors = await embedTextsCached([embedText.trim()], null);
    var vector = vectors[0];

    var entry = { doi: doi, title: title, abstract: abstract, vector: vector, weak: weak };
    if (!state._coreCache) state._coreCache = {};
    state._coreCache[cacheKey] = entry;
    saveCoreCache();
    return entry;
  }

  /* Fill in a core sample's title/abstract/vector from its DOI. Runtime only —
     none of what this writes is saved in the claim, which is why loading a
     claim has to call it for every row that carries a DOI. */
  function coreCacheKey(doi) { return doi + '|' + LOCAL_MODEL + '|' + LOCAL_DIM; }

  async function resolveCore(id) {
    var rec = findCore(id);
    if (!rec || !rec.doi) return;
    var row = coreRowEl(id);
    var statusEl = row ? row.querySelector('.row-status') : null;

    /* A cache miss ends in embedTexts(), which now loads the pick on demand —
       and a claim restoring ten core samples on page load must not be what
       triggers a 32 MB download nobody asked for. So the parking stays: it is
       about not downloading unprompted, not about the extractor being absent.
       loadPick() calls resolveAllCores() when the pick does arrive, by any
       route, including the first touchstone. */
    if (!state.modelLoaded && !(state._coreCache || {})[coreCacheKey(rec.doi)]) {
      rec.status = 'waiting for the pick';
      if (statusEl) statusEl.textContent = rec.status;
      return;
    }

    rec.status = 'loading...';
    rec.vector = null;
    if (statusEl) statusEl.textContent = rec.status;

    try {
      var fetched = await fetchCoreFromOpenAlex(rec.doi);
      // The row may have been removed or re-pointed while the fetch was in
      // flight; drop a stale response rather than reviving a dead record.
      if (findCore(id) !== rec || rec.doi !== fetched.doi) return;
      rec.title = fetched.title;
      rec.abstract = fetched.abstract;
      rec.vector = fetched.vector;
      rec.weak = fetched.weak;
      /* Title moves into the field; the status keeps the DOI, so the row still
         says which record it resolved to. */
      showCoreTitle(rec, row ? row.querySelector('.core-doi') : null);
      rec.status = '✓ ' + rec.doi + (rec.weak ? ' (title only)' : '');
      if (statusEl) statusEl.textContent = rec.status;
    } catch (err) {
      if (findCore(id) !== rec) return;
      rec.status = '✗ ' + err.message;
      rec.weak = true;
      if (statusEl) statusEl.textContent = rec.status;
    }

    await reassay();
  }

  async function maybeEmbedFeatures() {
    var kk = state.touchstones.length;
    var kp = state.cores.length;

    // Collect texts that need embedding
    var textsToEmbed = [];
    var embedMap = []; // array of {type: 'touchstone'|'core', idx: number}

    for (var ti = 0; ti < state.touchstones.length; ti++) {
      var t = state.touchstones[ti];
      if (!t.vector && t.text.trim()) {
        t.vector = null; // mark for embedding
        textsToEmbed.push(t.text.trim());
        embedMap.push({ type: 'touchstone', idx: ti });
      }
    }
    for (var ci = 0; ci < state.cores.length; ci++) {
      var c = state.cores[ci];
      if (!c.vector && c.abstract) {
        textsToEmbed.push(c.abstract);
        embedMap.push({ type: 'core', idx: ci });
      }
    }
    if (state.cores.length > 0) {
      // check for cores that have vectors already
      for (var cj = 0; cj < state.cores.length; cj++) {
        if (state.cores[cj].vector && !textsToEmbed.length) break; // already embedded
      }
    }

    if (textsToEmbed.length === 0) {
      // Build featureVectors from existing vectors
      buildFeatureVectors();
      return;
    }

    /* Split by provenance, not by convenience. A core sample's abstract is a
       published paper's text and goes through the shared cache; a touchstone is
       the user's own words and never does — the page promises "nothing you type
       leaves this tab", and a sha256 of a short typed phrase is a dictionary
       lookup away from the phrase. See docs/dig-spec.md §6c.2. */
    var newVectors = new Array(textsToEmbed.length);
    var localIdx = [], sharedIdx = [];
    for (var p = 0; p < embedMap.length; p++) {
      /* Core samples are published papers; preset touchstones are phrases this
         repo published. Both are safe to hash against a server. A touchstone
         with no preset tag is the user's own words and never is. */
      var shareable = embedMap[p].type !== 'touchstone' ||
        !!state.touchstones[embedMap[p].idx].preset;
      (shareable ? sharedIdx : localIdx).push(p);
    }
    function textAt(i) { return textsToEmbed[i]; }
    if (sharedIdx.length) {
      var shared = await embedTextsCached(sharedIdx.map(textAt), null);
      for (var s = 0; s < sharedIdx.length; s++) newVectors[sharedIdx[s]] = shared[s];
    }
    if (localIdx.length) {
      var local = await embedTexts(localIdx.map(textAt), null);
      for (var l = 0; l < localIdx.length; l++) newVectors[localIdx[l]] = local[l];
    }

    for (var e = 0; e < embedMap.length; e++) {
      var em = embedMap[e];
      if (em.type === 'touchstone') {
        state.touchstones[em.idx].vector = newVectors[e];
      } else {
        state.cores[em.idx].vector = newVectors[e];
      }
    }
    buildFeatureVectors();
  }

  function buildFeatureVectors() {
    var rows = [];
    for (var ti = 0; ti < state.touchstones.length; ti++) {
      /* Always push — null for touchstones with no vector, so row indices stay
         aligned with getWeights() which reads every DOM row. */
      rows.push(state.touchstones[ti].vector || null);
    }
    for (var ci = 0; ci < state.cores.length; ci++) {
      rows.push(state.cores[ci].vector || null);
    }
    // Rush row: null (inactive)
    rows.push(null);
    state.featureVectors = rows;
  }

  // ═══════════════════════════════════════════════════════════════════
  // STAGE 3 — Assay (compute grades + render matrix)
  // ═══════════════════════════════════════════════════════════════════

  /* Weights come from the records, in record order — the same order
     buildFeatureVectors() walks. Reading the DOM here used to make that
     alignment an accident of render order; now it is the same array twice. */
  function getWeights() {
    var w = [];
    for (var r = 0; r < state.touchstones.length; r++) {
      var rw = state.touchstones[r].weight;
      w.push(isFinite(rw) ? rw : 1.0);
    }
    for (var c = 0; c < state.cores.length; c++) {
      var cw = state.cores[c].weight;
      w.push(isFinite(cw) ? cw : 1.0);
    }
    // Rush: null (inactive)
    w.push(null);
    return w;
  }

  function computeGrades() {
    var N = state.A.length;
    var F = state.featureVectors;
    if (!F || F.length === 0) return;

    var weights = getWeights();
    var grades = new Float32Array(N);

    for (var n = 0; n < N; n++) {
      var num = 0;
      var den = 0;
      for (var r = 0; r < F.length; r++) {
        var fv = F[r];
        var w = weights[r];
        if (fv === null || w === null || w <= 0) continue;
        var c = cosine(state.A[n], fv);
        num += w * c;
        den += w;
      }
      grades[n] = den > 0 ? num / den : 0;
    }

    state.grades = grades;

    // Build order: sorted by grade descending
    var indices = new Array(N);
    for (var i = 0; i < N; i++) indices[i] = i;
    indices.sort(function (a, b) { return grades[b] - grades[a]; });
    state.order = indices;
  }

  function getOreColor(val) {
    // Map [0.5, 1] to ore ramp steps 0..7. Below 0.5 = step 0.
    var norm = (val - 0.5) / 0.5;
    if (norm < 0) norm = 0; if (norm > 1) norm = 1;
    var idx = Math.round(norm * 7);
    return 'var(--ore-' + idx + ')';
  }

  function getLampColor(val) {
    // Map [0.5, 1] to lamp ramp steps 0..6. Below 0.5 = step 0.
    var norm = (val - 0.5) / 0.5;
    if (norm < 0) norm = 0; if (norm > 1) norm = 1;
    var idx = Math.round(norm * 6);
    return 'var(--lamp-' + idx + ')';
  }

  // ═══════════════════════════════════════════════════════════════════
  // The gate — how much of tonight would actually ship
  // ═══════════════════════════════════════════════════════════════════
  /*
   * The cut scripts/preset-feed.mjs makes when it builds a feed (`selectItems`
   * there), run here against the night already on screen. So the number beside
   * the slider is not a forecast: it is the same rule over the same grades, and
   * moving the slider says exactly how many papers a feed built from this claim
   * would have carried this morning.
   *
   * The cut is on z — grade minus the night's median, over 1.4826·MAD — and not
   * on grade, because grades are only comparable within one announcement. A
   * quiet night's best paper scores like a busy night's tenth, and a fixed
   * grade bar would either drown you on Tuesday or starve you on Friday.
   *
   * TWO IMPLEMENTATIONS OF ONE RULE, on purpose: the builder is a Node module
   * and this is a browser IIFE with no bundler, so sharing the code means
   * adding a build step to a site that has none. tests/js/gate.test.js runs
   * both over the same inputs and fails when they disagree — that test is what
   * makes this a promise instead of a resemblance.
   */

  /**
   * @returns null when there is nothing to gate, else
   *   {n, keptCount, hard, z, median, mad, degenerate, floored, softBar, opt}
   *   where `z` is indexed by stone, like state.grades.
   */
  function gateReport() {
    return gateOver(state.grades, state.order, state.select);
  }

  /* Pure, and kept that way so tests/js/gate.test.js can hand it the same
     grades it hands selectItems and compare the two answers. */
  function gateOver(g, order, opt) {
    if (!g || !order || !order.length) return null;
    var n = order.length;

    var sorted = Array.prototype.slice.call(g).sort(function (a, b) { return a - b; });
    var median = sorted[Math.floor(n / 2)];
    var devs = sorted.map(function (x) { return Math.abs(x - median); })
      .sort(function (a, b) { return a - b; });
    var mad = devs[Math.floor(n / 2)];

    /* No spread — every paper alike, or too few to have one. There is no
       baseline to be above, so the gate stands down to a plain top-N rather
       than shipping nothing or shipping everything. */
    if (!(mad > 0)) {
      return {
        n: n, keptCount: Math.min(opt.max_items, n), hard: 0, z: null,
        median: median, mad: 0, degenerate: true, floored: false,
        softBar: opt.soft_z, opt: opt,
      };
    }

    var scale = 1.4826 * mad;
    var z = new Float64Array(g.length);
    for (var i = 0; i < g.length; i++) z[i] = (g[i] - median) / scale;

    /* z is monotone in grade, so whatever clears a bar is a prefix of `order`.
       Counting the prefix is the same answer as filtering, without the copy. */
    function clearing(bar) {
      var c = 0;
      while (c < n && z[order[c]] >= bar) c++;
      return c;
    }

    var hard = clearing(opt.min_z);
    var floorN = Math.min(opt.min_items, opt.max_items);
    if (hard >= floorN) {
      return {
        n: n, keptCount: Math.min(hard, opt.max_items), hard: hard, z: z,
        median: median, mad: mad, degenerate: false, floored: false,
        softBar: opt.soft_z, opt: opt,
      };
    }
    /* The floor never overrides the ceiling and never reaches below soft z, so
       a day with two good papers ships two — not two and a padded third. */
    var softBar = Math.min(opt.soft_z, opt.min_z);
    return {
      n: n, keptCount: Math.min(clearing(softBar), floorN), hard: hard, z: z,
      median: median, mad: mad, degenerate: false, floored: true,
      softBar: softBar, opt: opt,
    };
  }

  function fmtZ(v) { return (Math.round(v * 100) / 100).toString(); }

  function renderGateInputs() {
    var s = state.select;
    if (byId('gate-z')) byId('gate-z').value = s.min_z;
    if (byId('gate-z-value')) byId('gate-z-value').textContent = s.min_z.toFixed(1);
    if (byId('gate-max-items')) byId('gate-max-items').value = s.max_items;
    if (byId('gate-min-items')) byId('gate-min-items').value = s.min_items;
    if (byId('gate-soft-z')) byId('gate-soft-z').value = s.soft_z;
  }

  function renderGate() {
    var block = byId('gate-block');
    var out = byId('gate-readout');
    if (!block || !out) return null;
    /* The z label, not the inputs: renderGate runs on every keystroke, and
       writing a sanitized number back into the field someone is halfway
       through typing takes the field away from them. renderGateInputs is for
       the claim-load path, where nobody is typing. */
    if (byId('gate-z-value')) {
      byId('gate-z-value').textContent = state.select.min_z.toFixed(1);
    }
    var r = gateReport();
    if (!r) { block.style.display = 'none'; out.textContent = ''; return null; }
    block.style.display = '';

    var msg;
    if (r.degenerate) {
      msg = 'No spread tonight — nothing to be an outlier against, so the gate ' +
        'stands down and the top ' + r.keptCount + ' by grade ship.';
    } else if (r.keptCount === 0) {
      msg = 'Nothing clears z ≥ ' + fmtZ(r.opt.min_z) + ' — this feed is empty today. ' +
        'Best on the night is z ' + fmtZ(r.z[state.order[0]]) + '.';
    } else {
      msg = r.keptCount + ' of ' + r.n + ' would ship';
      if (r.floored) {
        msg += ' — only ' + r.hard + ' clear z ≥ ' + fmtZ(r.opt.min_z) +
          ', so the floor reaches down to z ' + fmtZ(r.softBar);
      }
      var cut = state.order[r.keptCount - 1];
      msg += ' · last in at z ' + fmtZ(r.z[cut]) +
        ' (grade ' + state.grades[cut].toFixed(3) + ')' +
        ' · best z ' + fmtZ(r.z[state.order[0]]);
    }
    out.textContent = msg;
    out.classList.toggle('is-empty', !r.degenerate && r.keptCount === 0);
    return r;
  }

  function renderAssay() {
    var F = state.featureVectors;
    if (!F || state.order === null || state.grades === null) return;

    /* Nothing to rank against. Grades computed over no features are all zero
       and their order is arbitrary, so an assay here would be a matrix of
       noise — say nothing instead. This is the state Clear leaves behind. */
    if (!state.touchstones.length && !state.cores.length) {
      byId('stage-3').style.display = 'none';
      return;
    }

    var N = state.stones.length;
    var order = state.order;
    var grades = state.grades;
    var topN = state.blend.paydirt_n;

    // Stage 1's graph gains a gold ring per pay-dirt stone, so a re-blend
    // shows immediately which wagons the touchstones are actually picking from
    applyWagonAssay();

    // Show assay section
    byId('stage-3').style.display = '';
    /* Drawn before the matrix: the column marking the cut reads off it. */
    var gate = renderGate();
    var gateN = gate ? gate.keptCount : 0;
    byId('assay-stats').textContent =
      state.stones.length + ' stones · ' + (F.length - 1) + ' features (1 inactive)';

    // ── Matrix view ──
    var grid = byId('assay-grid');
    var rail = byId('assay-rail');
    var colTitles = byId('assay-column-titles');

    // Cell size shrinks as N grows: 18px at N≤90, down to 12px at N≥200
    var cellW = N <= 90 ? 18 : N <= 120 ? 16 : N <= 160 ? 14 : 12;
    // Rail row height floor — rows grow past it if the label needs the room,
    // and the cells follow, so the labels stay legible at any N
    var rowH = cellW; // matrix-cell has aspect-ratio: 1
    var colTitleHTML = '';
    for (var c = 0; c < N; c++) {
      var si = order[c];
      var cls = c < topN ? ' paydirt' : '';
      /* One line, on the last column the gate keeps — the feed's edge drawn
         where it falls, rather than a second highlight competing with pay dirt. */
      if (gateN > 0 && c === gateN - 1) cls += ' gate-cut';
      colTitleHTML += '<div class="col-title' + cls + '" style="width:' + cellW + 'px" title="' +
        escapeHtml(state.stones[si].title) + '">' +
        ((c % 10 === 0 || c < topN) ? (c + 1) : '') +
        '</div>';
    }
    colTitles.innerHTML = colTitleHTML;
    colTitles.style.display = 'flex';

    // Set grid columns
    grid.style.setProperty('--assay-cols', N);
    grid.style.gridTemplateColumns = 'repeat(' + N + ', ' + cellW + 'px)';

    // Rail. First row is a spacer for the column-number bar that sits above
    // the grid — without it every rail row is off by one against its cells.
    var railHTML = '<div class="rail-row rail-head-spacer"></div>';
    var rowIdx = 0;
    var kk = state.touchstones.length;
    var kp = state.cores.length;

    // Touchstones group header
    if (kk > 0) {
      railHTML += '<div class="rail-row group-header">Touchstones</div>';
    }
    for (var ti = 0; ti < kk; ti++) {
      var t = state.touchstones[ti];
      var tLabel = t.text || 'touchstone ' + (ti + 1);
      railHTML += '<div class="rail-row">' +
        '<span class="rail-label" title="' + escapeHtml(tLabel) + '">' + escapeHtml(tLabel.substring(0, 20)) + '</span>' +
        '<span class="rail-weight">' + t.weight.toFixed(2) + '</span>' +
        '<input type="range" class="rail-weight-slider" min="0" max="1" step="0.01" value="' + t.weight +
        '" data-kind="touchstone" data-id="' + t.id + '">' +
        '</div>';
      rowIdx++;
    }

    // Core samples group header (skip if empty)
    if (kp > 0) {
      railHTML += '<div class="rail-row group-header">Core samples</div>';
    }
    for (var ci = 0; ci < kp; ci++) {
      var c = state.cores[ci];
      var cLabel = c.title || c.doi || 'core sample ' + (ci + 1);
      railHTML += '<div class="rail-row">' +
        '<span class="rail-label" title="' + escapeHtml(cLabel) + '">' + escapeHtml(cLabel.substring(0, 20)) + '</span>' +
        '<span class="rail-weight">' + c.weight.toFixed(2) + '</span>' +
        '<input type="range" class="rail-weight-slider" min="0" max="1" step="0.01" value="' + c.weight +
        '" data-kind="core" data-id="' + c.id + '">' +
        '</div>';
      rowIdx++;
    }

    // The rush — sits right before GRADE, no separate header
    railHTML += '<div class="rail-row" style="opacity:0.4; border-bottom:none">' +
      '<span class="rail-label">Scirate scites (inactive)</span>' +
      '<span class="rail-weight">—</span>' +
      '</div>';
    rowIdx++;

    // Grade row — right after rush
    railHTML += '<div class="rail-row grade-row">' +
      '<span class="rail-label">GRADE</span>' +
      '</div>';

    rail.innerHTML = railHTML;
    attachRailWeightSliders(rail);

    // Grid cells — must match rail rows exactly, including group-header spacers
    var gridHTML = '';

    // Spacer row matching "Touchstones" group header
    if (kk > 0) {
      gridHTML += '<div class="matrix-row">';
      for (var c = 0; c < N; c++) {
        gridHTML += '<div class="matrix-cell null-cell" style="opacity:0" data-val="null"></div>';
      }
      gridHTML += '</div>';
    }

    // Touchstone rows
    for (var ti = 0; ti < kk; ti++) {
      gridHTML += '<div class="matrix-row">';
      for (var c = 0; c < N; c++) {
        var si = order[c];
        var fv = F[ti];
        var val, isNull = false;
        if (fv === null) { isNull = true; val = null; }
        else val = cosine(state.A[si], fv);
        var cellCls = 'matrix-cell';
        if (isNull) cellCls += ' null-cell';
        if (c < topN) cellCls += ' paydirt-col';
        gridHTML += '<div class="' + cellCls + '" style="background:' + (isNull ? '' : getOreColor(val)) +
          '" data-row="' + ti + '" data-col="' + c +
          '" data-val="' + (val !== null ? val.toFixed(3) : 'null') + '" tabindex="0"></div>';
      }
      gridHTML += '</div>';
    }

    // Spacer row matching "Core samples" group header
    if (kp > 0) {
      gridHTML += '<div class="matrix-row">';
      for (var c = 0; c < N; c++) {
        gridHTML += '<div class="matrix-cell null-cell" style="opacity:0" data-val="null"></div>';
      }
      gridHTML += '</div>';
    }

    // Core sample rows
    var coreBase = kk;
    for (var ci = 0; ci < kp; ci++) {
      gridHTML += '<div class="matrix-row">';
      for (var c = 0; c < N; c++) {
        var si = order[c];
        var fv = F[coreBase + ci];
        var val, isNull = false;
        if (fv === null) { isNull = true; val = null; }
        else val = cosine(state.A[si], fv);
        var cellCls = 'matrix-cell';
        if (isNull) cellCls += ' null-cell';
        if (c < topN) cellCls += ' paydirt-col';
        gridHTML += '<div class="' + cellCls + '" style="background:' + (isNull ? '' : getOreColor(val)) +
          '" data-row="' + (coreBase + ci) + '" data-col="' + c +
          '" data-val="' + (val !== null ? val.toFixed(3) : 'null') + '" tabindex="0"></div>';
      }
      gridHTML += '</div>';
    }

    // Rush row — null cells, right before grade
    gridHTML += '<div class="matrix-row">';
    for (var c = 0; c < N; c++) {
      var cellCls = 'matrix-cell null-cell';
      if (c < topN) cellCls += ' paydirt-col';
      gridHTML += '<div class="' + cellCls + '" data-row="rush" data-col="' + c +
        '" data-val="null" tabindex="0"></div>';
    }
    gridHTML += '</div>';

    // Grade row
    gridHTML += '<div class="matrix-row">';
    for (var gc = 0; gc < N; gc++) {
      var gsi = order[gc];
      var gv = grades[gsi];
      var gCls = 'matrix-cell grade-cell';
      if (gc < topN) gCls += ' paydirt-col';
      gridHTML += '<div class="' + gCls + '" style="background:' + getLampColor(gv) +
        '" data-row="grade" data-col="' + gc +
        '" data-val="' + gv.toFixed(3) + '" tabindex="0"></div>';
    }
    gridHTML += '</div>';

    grid.innerHTML = gridHTML;

    // Rail rows and grid rows are separate DOM trees, so alignment can only be
    // guaranteed by measuring: spacer takes the column-bar height, then every
    // grid row is forced to its rail row's measured height.
    syncRailToGrid(rail, grid, colTitles, rowH);

    // Attach hover/focus handlers
    attachCellHandlers(order, kk, kp, topN);

    // ── Table view (update if visible) ──
    if (byId('table-view-toggle').checked) {
      renderTable(order, kk, kp, topN);
    }
  }

  /** Wire the per-row weight sliders in the assay rail. `input` just updates
   *  the live readout (cheap — no rerender, or dragging would lose its own
   *  DOM node mid-drag); `change` (drag end / arrow key) commits the weight
   *  and re-blends, which does rerender the rail from scratch. */
  function attachRailWeightSliders(rail) {
    rail.querySelectorAll('.rail-weight-slider').forEach(function (slider) {
      var readout = slider.previousElementSibling;
      slider.addEventListener('input', function () {
        if (readout && readout.classList.contains('rail-weight')) {
          readout.textContent = parseFloat(this.value).toFixed(2);
        }
      });
      slider.addEventListener('change', function () {
        var rec = this.dataset.kind === 'touchstone' ? findTouchstone(this.dataset.id) : findCore(this.dataset.id);
        if (rec) rec.weight = parseFloat(this.value);
        onWeightChanged();
      });
    });
  }

  /** Make rail row i line up with grid row i.
   *  rail children: [head-spacer, ...rows]   grid children: [...rows]  */
  function syncRailToGrid(rail, grid, colTitles, rowH) {
    var spacer = rail.querySelector('.rail-head-spacer');
    if (spacer) spacer.style.height = colTitles.getBoundingClientRect().height + 'px';

    var railRows = rail.querySelectorAll('.rail-row');
    var gridRows = grid.querySelectorAll('.matrix-row');

    // Data rows get the cell height as a floor; header rows and any label that
    // needs more than rowH keep their natural (text) height. The grid rows are
    // pushed to whatever the rail actually measures, below, so they stay aligned.
    for (var i = 1; i < railRows.length; i++) {
      if (!railRows[i].classList.contains('group-header')) {
        railRows[i].style.minHeight = rowH + 'px';
      }
    }

    // Then push each measured rail height onto the matching grid row's cells
    for (var r = 0; r < gridRows.length; r++) {
      var railRow = railRows[r + 1];
      if (!railRow) break;
      var h = railRow.getBoundingClientRect().height;
      var cells = gridRows[r].children;
      for (var c = 0; c < cells.length; c++) {
        cells[c].style.height = h + 'px';
      }
    }
  }

  // Pin survives re-renders' worth of listeners: document-level wiring happens once
  var pinnedCell = null;
  var cellDismissWired = false;

  function attachCellHandlers(order, kk, kp, topN) {
    var grid = byId('assay-grid');
    var tooltip = byId('cell-tooltip');

    pinnedCell = null;
    tooltip.classList.remove('pinned');
    tooltip.style.display = 'none';

    function showTooltip(e, cell, isPinned) {
      var col = parseInt(cell.dataset.col, 10);
      var si = order[col];
      var stone = state.stones[si];
      var val = cell.dataset.val;

      tooltip.innerHTML =
        '<div class="tt-value">' + (val === 'null' ? '—' : parseFloat(val).toFixed(2)) + '</div>' +
        '<div class="tt-title">' + escapeHtml(stone.title) + '</div>' +
        '<div class="tt-row"><a href="' + stone.abs_url + '" target="_blank" rel="noopener">open on arXiv →</a></div>' +
        '<div class="tt-pin-hint">' + (isPinned ? 'pinned — click the cell again to release' : 'click to pin') + '</div>';
      // pointer-events only while pinned, so an unpinned tooltip never eats hovers
      tooltip.classList.toggle('pinned', !!isPinned);
      tooltip.style.display = 'block';
      positionTooltip(e, tooltip);
    }

    grid.querySelectorAll('.matrix-cell').forEach(function (cell) {
      cell.addEventListener('mouseenter', function (e) {
        if (pinnedCell) return; // locked on a cell until click elsewhere
        showTooltip(e, cell, false);
      });

      cell.addEventListener('click', function (e) {
        if (pinnedCell === cell) {
          // unpin
          pinnedCell = null;
          tooltip.classList.remove('pinned');
          tooltip.style.display = 'none';
        } else {
          pinnedCell = cell;
          showTooltip(e, cell, true);
        }
        e.stopPropagation();
      });
    });

    if (!cellDismissWired) {
      cellDismissWired = true;

      // Click outside grid and tooltip dismisses the pin — clicks *inside* the
      // tooltip must survive or its arXiv link never fires
      document.addEventListener('click', function (e) {
        if (!grid.contains(e.target) && !tooltip.contains(e.target)) {
          pinnedCell = null;
          tooltip.classList.remove('pinned');
          tooltip.style.display = 'none';
        }
      });

      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && pinnedCell) {
          pinnedCell = null;
          tooltip.classList.remove('pinned');
          tooltip.style.display = 'none';
        }
      });

      grid.addEventListener('mouseleave', function () {
        if (!pinnedCell) tooltip.style.display = 'none';
      });
    }
  }

  function positionTooltip(e, tooltip) {
    var x = e.clientX + 12;
    var y = e.clientY - 10;
    if (x + 330 > window.innerWidth) x = x - 340;
    if (y + 80 > window.innerHeight) y = y - 80;
    tooltip.style.left = x + 'px';
    tooltip.style.top = y + 'px';
  }

  function renderTable(order, kk, kp, topN) {
    var F = state.featureVectors;
    var grades = state.grades;
    var N = state.stones.length;
    var weights = getWeights();

    var head = byId('assay-table-head');
    var body = byId('assay-table-body');

    // Header
    var headHTML = '<tr><th>Rank</th><th>Title</th>';
    for (var f = 0; f < kk + kp + 1; f++) {
      var flabel;
      if (f >= kk + kp) flabel = 'Rush';
      else if (f >= kk) flabel = 'Core ' + (f - kk + 1);
      else flabel = 'TS ' + (f + 1);
      headHTML += '<th>' + escapeHtml(flabel) + '</th>';
    }
    headHTML += '<th>Grade</th><th title="Grades above the night\'s median, in MAD units — what the gate cuts on">z</th><th>arXiv ID</th></tr>';
    head.innerHTML = headHTML;

    /* The gate, again from state — the table is drawn on its own on the view
       toggle, not only from renderAssay, so it cannot take the value by argument. */
    var gate = gateReport();
    var gateN = gate ? gate.keptCount : 0;

    // Body
    var bodyHTML = '';
    for (var n = 0; n < N; n++) {
      var si = order[n];
      var stone = state.stones[si];
      var rowClasses = [];
      if (n < topN) rowClasses.push('paydirt-row');
      if (gateN > 0 && n === gateN - 1) rowClasses.push('gate-cut-row');
      var rowCls = rowClasses.length ? ' class="' + rowClasses.join(' ') + '"' : '';
      bodyHTML += '<tr' + rowCls + '>';
      bodyHTML += '<td>' + (n + 1) + '</td>';
      bodyHTML += '<td>' + escapeHtml(stone.title) + '</td>';
      for (var fr = 0; fr < kk + kp + 1; fr++) {
        var fv = F[fr];
        if (fv === null) {
          bodyHTML += '<td>—</td>';
        } else {
          var cv = cosine(state.A[si], fv);
          bodyHTML += '<td>' + cv.toFixed(2) + '</td>';
        }
      }
      bodyHTML += '<td>' + grades[si].toFixed(2) + '</td>';
      bodyHTML += '<td>' + (gate && gate.z ? gate.z[si].toFixed(2) : '—') + '</td>';
      bodyHTML += '<td>' + escapeHtml(stone.arxiv_id) + '</td>';
      bodyHTML += '</tr>';
    }
    body.innerHTML = bodyHTML;

    byId('assay-table-wrap').style.display = '';
  }

  // ═══════════════════════════════════════════════════════════════════
  // Event bindings — the pick (Stage 2 gate)
  // ═══════════════════════════════════════════════════════════════════

  byId('sharpen-btn').addEventListener('click', async function () {
    try { await ensurePick(); }
    catch (err) { byId('sharpen-status').textContent = err.message; byId('sharpen-status').style.color = 'var(--ember)'; }
  });

  // ═══════════════════════════════════════════════════════════════════
  // Event bindings — Stage 1
  // ═══════════════════════════════════════════════════════════════════

  byId('haul-btn').addEventListener('click', async function () {
    try { await runHaul(); }
    catch (err) { /* already handled */ }
  });

  wireTrainStrip();

  // Wagon sort toggle (matrix view only)
  byId('wagon-sort-toggle').addEventListener('change', function () {
    if (!state.wagonMap || !state.stones.length) return;
    drawWagonMap(byId('wagon-canvas'), state.wagonMap, currentWagonOrder(), state.stones,
      state.wagonComponents, wagonReadoutSink('wagon-readout'));
  });

  /** Release the pin on both wagon graphs and hide the tooltip. */
  function releaseWagonPin() {
    var tip = byId('wagon-tooltip');
    tip.style.display = 'none';
    tip.classList.remove('pinned');
    if (state.wagonGraph) state.wagonGraph.unpin();
    if (state.wagonModalGraph) state.wagonModalGraph.unpin();
  }

  document.addEventListener('click', function (e) {
    if (e.target.id === 'wagon-graph-canvas' || e.target.id === 'wagon-modal-graph-canvas') return;
    // Clicks inside the tooltip must survive, or its arXiv link never fires.
    if (byId('wagon-tooltip').contains(e.target)) return;
    releaseWagonPin();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') releaseWagonPin();
  });

  /** Re-cluster at a new threshold and redraw whichever view is live. */
  function recomputeWagonThresh(thresh) {
    if (!state.wagonMap || !state.stones.length) return;
    state.wagonThresh = thresh;
    var cluster = clusterOrder(state.stones, state.wagonMap, thresh);
    state.wagonOrder = cluster.order;
    state.wagonComponents = cluster.components;
    reattachWagonNames();
    updateWagonStats();
    renderWagonPanel();
    // Modal is a separate live graph — refresh it too if it's open.
    if (state.wagonModalGraph && byId('wagon-modal').style.display !== 'none') {
      byId('wagon-expand-btn').click();
    }
  }

  // Wagon threshold slider
  byId('wagon-thresh-slider').addEventListener('input', function () {
    var v = parseFloat(this.value);
    byId('wagon-thresh-value').textContent = v.toFixed(2);
    recomputeWagonThresh(v);
  });

  // Matrix ↔ graph switch
  byId('wagon-view-switch').addEventListener('click', function (e) {
    var btn = e.target.closest('.wagon-view-btn');
    if (!btn) return;
    var view = btn.getAttribute('data-view');
    if (view === state.wagonView) return;
    state.wagonView = view;
    Array.prototype.forEach.call(this.querySelectorAll('.wagon-view-btn'), function (b) {
      b.classList.toggle('is-active', b.getAttribute('data-view') === view);
    });
    byId('wagon-modal-header-title').textContent =
      view === 'graph' ? 'Train graph' : view === 'table' ? 'Wagons' : 'Coupling map';
    renderWagonPanel();
  });

  // Name the wagons. Hidden outright when naming is switched off, so the page
  // never offers a button that cannot do anything.
  if (!NAME_URL) {
    var nameBtn = byId('wagon-name-btn');
    if (nameBtn) nameBtn.style.display = 'none';
  } else {
    byId('wagon-name-btn').addEventListener('click', nameWagons);
  }

  // Wagon expand
  byId('wagon-expand-btn').addEventListener('click', function () {
    if (!state.wagonMap) return;
    var modal = byId('wagon-modal');
    var matrixCanvas = byId('wagon-modal-canvas');
    var graphCanvas = byId('wagon-modal-graph-canvas');
    var isGraph = state.wagonView === 'graph';

    matrixCanvas.style.display = isGraph ? 'none' : 'block';
    graphCanvas.style.display = isGraph ? 'block' : 'none';
    byId('wagon-modal-readout').innerHTML = '';
    modal.style.display = 'flex';

    if (state.wagonModalGraph) { state.wagonModalGraph.stop(); state.wagonModalGraph = null; }
    if (isGraph) {
      var w = Math.min(1100, Math.round(window.innerWidth * 0.86));
      var h = Math.min(760, Math.round(window.innerHeight * 0.74));
      state.wagonModalGraph = drawWagonGraph(graphCanvas, state.wagonMap, state.stones,
        state.wagonComponents, wagonTooltipSink(),
        { width: w, height: h, thresh: state.wagonThresh });
      applyWagonAssay();
    } else {
      drawWagonMap(matrixCanvas, state.wagonMap, currentWagonOrder(), state.stones,
        state.wagonComponents, wagonReadoutSink('wagon-modal-readout'));
    }
  });

  function closeWagonModal() {
    byId('wagon-modal').style.display = 'none';
    releaseWagonPin();
    if (state.wagonModalGraph) { state.wagonModalGraph.stop(); state.wagonModalGraph = null; }
  }

  byId('wagon-modal').addEventListener('click', function (e) {
    if (e.target === byId('wagon-modal-backdrop') || e.target.classList.contains('wagon-modal-close')) {
      closeWagonModal();
    }
  });
  byId('wagon-modal-close').addEventListener('click', closeWagonModal);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && byId('wagon-modal').style.display !== 'none') closeWagonModal();
  });

  // ═══════════════════════════════════════════════════════════════════
  // Presets — curated claims the repo ships
  // ═══════════════════════════════════════════════════════════════════

  function presetsBase() {
    return window.ARXAVE_PRESETS_BASE || '/presets/';
  }

  function feedsBase() {
    return window.ARXAVE_FEEDS_BASE || '/feeds/';
  }

  /* slug → chip, filled once the catalogue loads. Selection is derived, never
     stored, so this map is the only preset state the UI keeps. */
  var presetChips = {};
  var presetBlurbs = {};

  /**
   * Which preset is on screen — read off the rows rather than remembered.
   *
   * Row provenance (`t.preset`) is already exact: applyPreset stamps it and the
   * first keystroke in a row clears it (onTouchstoneChanged). Deriving from it
   * means the chip cannot disagree with the matrix below it, and "edited" comes
   * out for free. Two presets mixed into one claim belongs to neither.
   */
  function activePreset() {
    var ts = state.touchstones;
    if (!ts.length) return null;
    var slug = null;
    var edited = false;
    for (var i = 0; i < ts.length; i++) {
      var p = (typeof ts[i].preset === 'string' && ts[i].preset) || null;
      if (!p) { edited = true; continue; }
      if (slug && p !== slug) return null;
      slug = p;
    }
    return slug ? { slug: slug, edited: edited } : null;
  }

  function syncPresetSelection() {
    var cur = activePreset();
    var any = false;
    for (var slug in presetChips) {
      if (!Object.prototype.hasOwnProperty.call(presetChips, slug)) continue;
      any = true;
      var chip = presetChips[slug];
      var on = !!cur && cur.slug === slug;
      chip.classList.toggle('is-active', on);
      chip.classList.toggle('is-edited', on && cur.edited);
      chip.setAttribute('aria-pressed', on ? 'true' : 'false');
      var mark = chip.querySelector('.preset-state');
      if (mark) mark.textContent = on ? (cur.edited ? 'edited' : '✓') : '';
    }
    if (!any) return;
    var line = byId('presets-blurb');
    if (!line) return;
    if (cur && presetBlurbs[cur.slug]) {
      line.textContent = presetBlurbs[cur.slug] + (cur.edited ? ' — edited since. ' : ' ');
      line.style.display = '';
    } else {
      line.textContent = '';
      line.style.display = 'none';
    }
  }

  /* The feed manifest is written by preset-feed.mjs and says which feeds exist
     and what shipped in them. Linking off it rather than off the preset slug is
     what stops a preset added today from pointing at a 404 until tonight. */
  function renderFeedsMenu(list, manifest) {
    var wrap = byId('preset-feeds');
    var btn = byId('preset-feeds-btn');
    var menu = byId('preset-feeds-menu');
    if (!wrap || !btn || !menu) return;

    var feeds = (manifest && manifest.feeds) || {};
    var built = 0;
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      var f = feeds[p.slug];
      var name = p.name || p.slug;
      var row;
      if (f) {
        built++;
        row = document.createElement('a');
        row.className = 'feeds-item';
        row.href = feedsBase() + encodeURIComponent(p.slug) + '.xml';
        row.title = 'Daily feed for ' + name + ', at the preset\'s default weights';
      } else {
        /* A preset with no feed yet is not an error and not a dead link — it is
           a feed that builds tonight. Say that instead of offering the 404. */
        row = document.createElement('span');
        row.className = 'feeds-item is-pending';
      }
      row.setAttribute('role', 'menuitem');
      var n = f && isFinite(f.items) ? f.items : null;
      var note = !f ? 'builds tonight'
        : n === 0 ? 'nothing today'
        : n === 1 ? '1 today'
        : n === null ? '' : n + ' today';
      row.innerHTML = '<span class="feeds-name">' + escapeHtml(name) + '</span>' +
        '<span class="feeds-note">' + escapeHtml(note) + '</span>';
      menu.appendChild(row);
    }
    if (!built) return;   // nothing to subscribe to yet; no button at all
    wrap.style.display = '';

    /* Openness is tracked here rather than read back off the style, so the
       menu's state is one thing and not two that can disagree. */
    var open = false;
    function setMenu(next) {
      open = next;
      menu.style.display = next ? '' : 'none';
      btn.setAttribute('aria-expanded', next ? 'true' : 'false');
    }
    setMenu(false);
    btn.addEventListener('click', function (e) {
      if (e && e.stopPropagation) e.stopPropagation();
      setMenu(!open);
    });
    document.addEventListener('click', function (e) {
      if (open && e && e.target && !wrap.contains(e.target)) setMenu(false);
    });
    document.addEventListener('keydown', function (e) {
      if (open && e.key === 'Escape') setMenu(false);
    });
  }

  /**
   * Load a preset over the current rows.
   *
   * Goes through applyClaim, so a preset is not a second kind of thing: it is
   * a claim with a `preset` slug on it, and the slug is what marks its
   * touchstones as repo-published (see maybeEmbedFeatures). Stage 1's hauled
   * stones survive, so this re-assays the day already on screen.
   */
  async function applyPreset(slug) {
    var resp = await fetch(presetsBase() + encodeURIComponent(slug) + '.json', { cache: 'no-cache' });
    if (!resp.ok) throw new Error('preset ' + slug + ': HTTP ' + resp.status);
    var preset = await resp.json();
    preset.preset = slug;           // trust the file we fetched, not its contents
    applyClaim(preset);
    autosave();
    await reassay();
  }

  /* Absent, unreachable, or malformed presets leave the page exactly as it was.
     They are a shortcut, never a dependency — the same rule the cache follows. */
  async function renderPresets() {
    var wrap = byId('presets-list');
    var group = byId('presets-group');
    var hint = byId('presets-hint');
    // The test harness mounts a subset of the page; absent nodes are not an error.
    if (!wrap || !group || !hint || typeof fetch !== 'function') return;
    var list;
    try {
      var resp = await fetch(presetsBase() + 'index.json', { cache: 'no-cache' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      list = ((await resp.json()) || {}).presets || [];
    } catch (_) {
      group.style.display = 'none';
      return;
    }
    if (!list.length) {
      group.style.display = 'none';
      return;
    }
    /* Missing manifest = no feeds offered, presets still work. Same rule as the
       catalogue itself: a shortcut, never a dependency. */
    var manifest = null;
    try {
      var mResp = await fetch(feedsBase() + 'index.json', { cache: 'no-cache' });
      if (mResp.ok) manifest = await mResp.json();
    } catch (_) { /* no feeds menu */ }

    for (var i = 0; i < list.length; i++) {
      (function (p) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'preset-btn';
        btn.setAttribute('aria-pressed', 'false');
        /* One line per preset. The blurb moves to the hint below, where only
           the selected preset's shows — four wrapped blurbs side by side is
           what made the row unreadable, and the one you picked is the one you
           need to read. */
        btn.innerHTML = '<span class="preset-name">' + escapeHtml(p.name || p.slug) + '</span>' +
          '<span class="preset-state"></span>';
        if (p.blurb) {
          btn.title = p.blurb;
          presetBlurbs[p.slug] = p.blurb;
        }
        btn.addEventListener('click', async function () {
          btn.disabled = true;
          btn.classList.add('is-loading');
          try {
            await applyPreset(p.slug);
          } catch (err) {
            btn.title = err.message;
          } finally {
            btn.disabled = false;
            btn.classList.remove('is-loading');
            syncPresetSelection();
          }
        });
        presetChips[p.slug] = btn;
        wrap.appendChild(btn);
      })(list[i]);
    }
    renderFeedsMenu(list, manifest);
    hint.style.display = '';
    /* Catalogue arrives after the claim is already on screen — an autosaved
       preset must light its chip without a click. */
    syncPresetSelection();
  }

  renderPresets();

  // ═══════════════════════════════════════════════════════════════════
  // Event bindings — Stage 2
  // ═══════════════════════════════════════════════════════════════════

  byId('add-touchstone').addEventListener('click', function () {
    addTouchstone('');
  });

  byId('add-core').addEventListener('click', function () {
    addCore('');
  });

  // .bib upload → extract DOIs and add as core samples
  byId('bib-file').addEventListener('change', function (e) {
    var file = e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var text = reader.result;
      var dois = extractBibDois(text);
      if (dois.length === 0) {
        byId('bib-status').textContent = 'No DOI entries found in .bib file.';
        byId('bib-status').style.display = '';
        return;
      }
      byId('bib-status').textContent = 'Found ' + dois.length + ' entries. Adding as core samples...';
      byId('bib-status').style.display = '';
      for (var d = 0; d < dois.length; d++) {
        addCore(dois[d]);
      }
      byId('bib-status').textContent = '✓ Added ' + dois.length + ' core samples from .bib.';
    };
    reader.readAsText(file);
  });

  function extractBibDois(text) {
    var dois = [];
    var re = /doi\s*=\s*\{([^}]+)\}/gi;
    var m;
    while ((m = re.exec(text)) !== null) {
      var d = m[1].replace(/\s+/g, '').trim();
      if (d.length > 5) dois.push(d);
    }
    return dois;
  }

  // ═══════════════════════════════════════════════════════════════════
  // Event bindings — Stage 3
  // ═══════════════════════════════════════════════════════════════════

  byId('paydirt-n').addEventListener('input', function () {
    state.blend.paydirt_n = parseInt(this.value, 10) || 10;
    autosave();
    if (state.order !== null) renderAssay();
  });

  /* The gate's four controls, all the same shape: write state, save, redraw.
     Redrawing the whole assay on a slider drag is what `paydirt-n` already
     does at the same N, and the count in the readout has to come from the
     same pass that marks the cut column — one path, never two. */
  function wireGateControl(id, apply) {
    var el = byId(id);
    if (!el) return;
    el.addEventListener('input', function () {
      apply(this.value);
      state.select = parseSelect(state.select);
      autosave();
      if (state.order !== null) renderAssay(); else renderGate();
    });
    /* On blur, put the sanitized value on screen — a field left empty or out of
       range kept its text while state had already fallen back to the default. */
    el.addEventListener('change', renderGateInputs);
  }
  wireGateControl('gate-z', function (v) { state.select.min_z = parseFloat(v); });
  wireGateControl('gate-max-items', function (v) { state.select.max_items = parseInt(v, 10); });
  wireGateControl('gate-min-items', function (v) { state.select.min_items = parseInt(v, 10); });
  wireGateControl('gate-soft-z', function (v) { state.select.soft_z = parseFloat(v); });

  byId('table-view-toggle').addEventListener('change', function () {
    var show = this.checked;
    byId('assay-matrix-wrap').style.display = show ? 'none' : '';
    byId('assay-legends').style.display = show ? 'none' : '';
    byId('assay-table-wrap').style.display = show ? '' : 'none';
    if (show && state.order !== null) {
      var kk = state.touchstones.length;
      var kp = state.cores.length;
      var topN = state.blend.paydirt_n;
      renderTable(state.order, kk, kp, topN);
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // Event bindings — Scout + claims
  // ═══════════════════════════════════════════════════════════════════

  /* #categories is hidden and written only by the picker (setCategoryList),
     which updates state and autosaves itself — so there is no input event to
     listen for here. */
  byId('lookback').addEventListener('input', function () {
    state.scout.lookback = parseInt(this.value, 10) || 1;
    markHaulStale();
    autosave();
  });
  byId('max-results').addEventListener('input', function () {
    state.scout.max_results = parseInt(this.value, 10) || 200;
    markHaulStale();
    autosave();
  });

  byId('claim-select').addEventListener('change', function () {
    var map = loadClaims();
    var slug = this.value;
    if (!map[slug]) return;
    state.claimSlug = slug;
    try { localStorage.setItem(CURRENT_KEY, slug); } catch (_) {}
    applyClaim(map[slug]);
    renderClaimPicker();
    reassay();
  });

  byId('claim-save-as').addEventListener('click', function () {
    var name = window.prompt('Name this claim', 'Spin qubits');
    if (name === null) return;
    name = name.trim();
    if (!name) return;
    var map = loadClaims();
    var slug = slugify(name);
    // Distinct name, distinct slot: never silently overwrite a claim the user
    // named earlier just because the slug collides.
    var base = slug, n = 2;
    while (map[slug] && map[slug].name !== name) { slug = base + '-' + (n++); }
    map[slug] = serializeClaim(name);
    writeClaims(map);
    state.claimSlug = slug;
    try { localStorage.setItem(CURRENT_KEY, slug); } catch (_) {}
    renderClaimPicker();
    setClaimStatus('Saved as “' + name + '”.');
  });

  /* Clear empties the setup; Delete removes the slot. Keeping them apart is the
     point — "start over" is the common move and must not cost someone the claim
     they named. The scout settings and the hauled stones stay, so clearing is
     the start of a second dig through the same night, not a fifth haul of it. */
  byId('claim-clear').addEventListener('click', function () {
    if (!state.touchstones.length && !state.cores.length) {
      setClaimStatus('Nothing to clear.');
      return;
    }
    if (!window.confirm(
      'Clear this setup? Touchstones, core samples, and the gate go back to ' +
      'empty. Your categories and the stones you hauled stay.')) return;
    state.touchstones = [];
    state.cores = [];
    state.featureVectors = null;
    state.grades = null;
    state.order = null;
    state.blend = { paydirt_n: 10 };
    state.select = parseSelect(null);
    renderClaimIntoDom();
    autosave();
    byId('stage-3').style.display = 'none';
    byId('gate-block').style.display = 'none';
    applyWagonAssay();   // drop the gold rings the old assay left on the train
    setClaimStatus('Cleared.');
  });

  byId('claim-delete').addEventListener('click', function () {
    if (state.claimSlug === WORKING_SLUG) return;
    var map = loadClaims();
    var name = (map[state.claimSlug] || {}).name || state.claimSlug;
    if (!window.confirm('Delete the claim “' + name + '”? The setup it holds is gone for good.')) return;
    delete map[state.claimSlug];
    writeClaims(map);
    state.claimSlug = WORKING_SLUG;
    if (!map[WORKING_SLUG]) { map[WORKING_SLUG] = serializeClaim(WORKING_NAME); writeClaims(map); }
    try { localStorage.setItem(CURRENT_KEY, WORKING_SLUG); } catch (_) {}
    applyClaim(map[WORKING_SLUG]);
    renderClaimPicker();
    reassay();
    setClaimStatus('Deleted “' + name + '”.');
  });

  byId('claim-export').addEventListener('click', function () {
    exportClaim();
  });

  byId('claim-import').addEventListener('click', function () {
    byId('claim-import-input').click();
  });

  byId('claim-import-input').addEventListener('change', function () {
    var file = this.files && this.files[0];
    this.value = '';
    if (file) importClaimFile(file);
  });

  var _claimStatusTimer = null;
  function setClaimStatus(msg) {
    var el = byId('claim-status');
    if (!el) return;
    el.textContent = msg;
    if (_claimStatusTimer) clearTimeout(_claimStatusTimer);
    _claimStatusTimer = setTimeout(function () { el.textContent = ''; }, 4000);
  }

  // ═══════════════════════════════════════════════════════════════════
  // Init
  // ═══════════════════════════════════════════════════════════════════

  loadCoreCache();
  wireCategoryPicker();

  var claims = migrateLegacyState();
  var current = null;
  try { current = localStorage.getItem(CURRENT_KEY); } catch (_) {}
  if (!current || !claims[current]) current = WORKING_SLUG;
  if (!claims[current]) {
    claims[current] = serializeClaim(WORKING_NAME);
    writeClaims(claims);
  }
  state.claimSlug = current;
  try { localStorage.setItem(CURRENT_KEY, current); } catch (_) {}
  applyClaim(claims[current]);
  renderClaimPicker();

  // Show the app
  var app = byId('app');
  if (app) app.style.display = '';

  // Initially hide Stage 3
  byId('stage-3').style.display = 'none';

  /* Test hook. The gate is one rule with two implementations — this one and
     `selectItems` in scripts/preset-feed.mjs — and tests/js/gate.test.js runs
     both over the same grades to prove they agree. Nothing on the page reads
     it, and it exposes a pure function, not state. */
  window.ARXAVE_GATE_OVER = gateOver;

})();