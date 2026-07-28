/**
 * arxave filter — browser-side pipeline for ranking arXiv papers.
 *
 * Implements the filter-spec.md pipeline:
 *   1. scout  — arXiv API (Atom XML), always via the relay (arXiv sends no CORS)
 *   2. embed  — one batched call: hosted function by default, or the user's key
 *   3. cosine — topic_cos + corpus_cos (pure arithmetic)
 *   4. signals — scirate scite (best-effort), citation_overlap = null
 *   5. rank   — blend() with renormalization over present signals
 *   6. present — ranked table with per-signal breakdown
 *   7. refine — optional LLM call over top-N
 *
 * Dependencies: none.  Runs in the browser, no bundler.
 */
(function () {
  'use strict';

  // ── Hosted endpoints (supabase/functions/) ────────────────────────
  // arXiv and Scirate send no Access-Control-Allow-Origin header, so a browser
  // can never fetch them directly — every external GET goes through the relay.
  // The embed function holds the API key server-side so the page is one click.
  const FUNCTIONS_BASE = 'https://ugxxakguqgpxpdfhgtsb.supabase.co/functions/v1';
  // scripts/dev_filter.py sets window.ARXAVE_RELAY so the local preview relays
  // through itself instead of the deployed function.
  const RELAY_URL = window.ARXAVE_RELAY || (FUNCTIONS_BASE + '/relay');
  const HOSTED_EMBED_URL = FUNCTIONS_BASE + '/embed';

  // ── In-browser embeddings (default) ───────────────────────────────
  // transformers.js runs the model in this tab: no key, no bill, no request
  // per run. Cost is a one-time ~32 MB model download, cached by the browser.
  // Pinned: the browser ESM build. `pipeline` and `env` are both named exports.
  const TRANSFORMERS_URL =
    'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.6/dist/transformers.web.js';
  const LOCAL_MODEL = 'Xenova/bge-small-en-v1.5';   // 384-dim, MTEB ~62
  const LOCAL_BATCH = 16;

  // ── Constants (match Python rank.py) ──────────────────────────────
  const SCITE_SATURATION = 20.0;   // rank.SCITE_SATURATION
  const DEFAULT_WEIGHTS = { w1: 0.50, w2: 0.25, w3: 0.15, w4: 0.10 };
  const DEFAULT_TOP_N = 10;

  // ── DOM refs ──────────────────────────────────────────────────────
  function byId(id) { return document.getElementById(id); }

  const app = byId('app');
  if (app) app.style.display = '';

  // ── State ─────────────────────────────────────────────────────────
  const state = {
    candidates: [],      // [{arxiv_id, title, abstract, authors, primary_category, published, abs_url, pdf_url}]
    topicVectors: null,  // [d] × num_topics  (column vectors)
    corpusVectors: null, // [d] × num_corpus   (column vectors)
    abstractVectors: null, // [N × d]  row-major
    ranked: [],           // [{...candidate, signals:{topic_cos, corpus_cos, citation_overlap, scite}, scite_count, importance, matched_topic}]
    corpusTitles: [],     // parsed .bib titles
    sciteAvailable: true,  // becomes false if scirate fetch fails
    bibLoaded: false,
  };

  // ── Persistence ───────────────────────────────────────────────────
  function loadWeights() {
    try {
      var raw = localStorage.getItem('arxave-filter-weights');
      if (raw) return JSON.parse(raw);
    } catch (_) { /* ignore */ }
    return { w1: DEFAULT_WEIGHTS.w1, w2: DEFAULT_WEIGHTS.w2, w3: DEFAULT_WEIGHTS.w3, w4: DEFAULT_WEIGHTS.w4 };
  }

  function saveWeights(w) {
    try {
      localStorage.setItem('arxave-filter-weights', JSON.stringify(w));
    } catch (_) { /* ignore */ }
  }

  // ── Weight slider init ────────────────────────────────────────────
  var weights = loadWeights();

  function setSlider(id, val) {
    var el = byId(id);
    el.value = val;
    byId(id + '-val').textContent = val.toFixed(2);
  }

  function initSlider(id, key) {
    setSlider(id, weights[key]);
    byId(id).addEventListener('input', function () {
      var v = parseFloat(this.value);
      weights[key] = v;
      byId(id + '-val').textContent = v.toFixed(2);
      updateWeightPct();
      saveWeights(weights);
      if (state.ranked.length > 0) {
        reRank();
        renderResults();
      }
    });
  }

  ['w1', 'w2', 'w4'].forEach(function (id) {
    initSlider(id, id);
  });

  // w3 is disabled (deferred); keep the value for localStorage but slider is frozen
  setSlider('w3', weights.w3);
  // w3 slider stays disabled in HTML

  function updateWeightPct() {
    var w = weights;
    var total = w.w1 + w.w2 + w.w3 + w.w4;
    if (total <= 0) total = 1;
    function pct(k) { return ((w[k] / total) * 100).toFixed(0) + '%'; }
    byId('w1-pct').textContent = pct('w1');
    byId('w2-pct').textContent = pct('w2');
    byId('w3-pct').textContent = pct('w3');
    byId('w4-pct').textContent = pct('w4');
    byId('weight-pct-readout').textContent =
      'topic ' + pct('w1') + ' · corpus ' + pct('w2') +
      ' · citation ' + pct('w3') + ' · scite ' + pct('w4');
  }
  updateWeightPct();

  // ── Embedding mode: hosted (default, zero setup) or own key ───────
  var EMBED_PRESETS = {
    openai:      { base_url: 'https://api.openai.com/v1', model: 'text-embedding-3-small' },
    ollama:      { base_url: 'http://localhost:11434/v1', model: 'nomic-embed-text' },
    'lm-studio': { base_url: 'http://127.0.0.1:1234/v1', model: 'text-embedding-nomic-embed-text-v1.5' },
    custom:      { base_url: '', model: '' },
  };

  function embedMode() {
    var el = document.querySelector('input[name="embed-mode"]:checked');
    return el ? el.value : 'local';
  }

  function onEmbedModeChange() {
    byId('embed-own-fields').style.display = (embedMode() === 'own') ? '' : 'none';
  }

  Array.prototype.forEach.call(
    document.querySelectorAll('input[name="embed-mode"]'),
    function (el) { el.addEventListener('change', onEmbedModeChange); }
  );

  function onEmbedProviderChange() {
    var prov = byId('embed-provider').value;
    var preset = EMBED_PRESETS[prov];
    byId('embed-model').value = preset.model;
    byId('embed-base-url').value = preset.base_url;
  }
  byId('embed-provider').addEventListener('change', onEmbedProviderChange);
  onEmbedProviderChange();
  onEmbedModeChange();

  // ── Refine provider ───────────────────────────────────────────────
  // Refine stays bring-your-own-key: it is the only stage that spends a large
  // model, and it is off by default. The fields are always visible — hiding the
  // key box for OpenAI left no way to enter the key it requires.
  var REFINE_PRESETS = {
    openai:      { base_url: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    ollama:      { base_url: 'http://localhost:11434/v1', model: 'llama3.2' },
    'lm-studio': { base_url: 'http://127.0.0.1:1234/v1', model: 'liquid/lfm2.5-1.2b' },
  };

  byId('refine-provider').addEventListener('change', function () {
    var preset = REFINE_PRESETS[this.value];
    if (preset) {
      byId('refine-model').value = preset.model;
      byId('refine-base-url').value = preset.base_url;
    }
  });

  // ── .bib upload → extract titles ──────────────────────────────────
  byId('bib-file').addEventListener('change', function (e) {
    var file = e.target.files[0];
    if (!file) return;

    var reader = new FileReader();
    reader.onload = function () {
      var text = reader.result;
      var titles = extractBibTitles(text);
      state.corpusTitles = titles;
      state.bibLoaded = titles.length > 0;

      var status = byId('corpus-status');
      if (titles.length === 0) {
        status.textContent = 'No titles found in .bib file.';
        byId('w2-unavailable').style.display = '';
        byId('w2').disabled = true;
      } else {
        status.textContent = '✓ ' + titles.length + ' entries loaded (titles only, v1).';
        byId('w2-unavailable').style.display = 'none';
        byId('w2').disabled = false;
      }
      updateWeightPct();
    };
    reader.readAsText(file);
  });

  function extractBibTitles(text) {
    var titles = [];
    // Match @article{...} blocks and extract title fields
    var re = /title\s*=\s*\{([^}]+)\}/gi;
    var m;
    while ((m = re.exec(text)) !== null) {
      var t = m[1].replace(/\{[^}]*\}/g, '').replace(/\s+/g, ' ').trim();
      if (t.length > 5) titles.push(t);
    }
    return titles;
  }

  // ── Relay helper ──────────────────────────────────────────────────
  // Never try direct first: arXiv and Scirate send no CORS header, so the
  // direct attempt is a guaranteed failure that costs a round-trip and litters
  // the console. Always go through a relay; the field just picks which one.
  function relayBase() {
    var custom = byId('cors-proxy').value.trim();
    return custom || RELAY_URL;
  }

  function relayUrl(url) {
    var p = relayBase();
    // Prefix style: "https://corsproxy.io/?" or "…?target="
    if (p.endsWith('?') || p.endsWith('=')) return p + encodeURIComponent(url);
    // Query style: the arxave relay and `arxave serve` both take ?url=
    if (p.indexOf('?') === -1) return p + '?url=' + encodeURIComponent(url);
    return p + '&url=' + encodeURIComponent(url);
  }

  function fetchViaRelay(url, opts) {
    return fetch(relayUrl(url), opts || {});
  }

  // ── Status display ────────────────────────────────────────────────
  function setStatus(msg, isError) {
    var el = byId('run-status');
    el.style.display = '';
    el.textContent = msg;
    el.className = 'run-status ' + (isError ? 'error' : 'info');
  }

  function clearStatus() {
    var el = byId('run-status');
    el.style.display = 'none';
  }

  // ═══════════════════════════════════════════════════════════════════
  // STAGE 1 — scout (arXiv API → candidates)
  // ═══════════════════════════════════════════════════════════════════

  function scoutCategories() {
    var raw = byId('categories').value;
    var cats = raw.split(',').map(function (c) { return c.trim(); }).filter(Boolean);
    if (cats.length === 0) throw new Error('No arXiv categories configured.');
    return cats;
  }

  /**
   * Parse arXiv Atom XML into candidate objects.
   * Uses DOMParser — no external XML library needed.
   */
  function parseAtomXML(xmlText) {
    var parser = new DOMParser();
    var doc = parser.parseFromString(xmlText, 'application/xml');
    var entries = doc.querySelectorAll('entry');
    var candidates = [];

    entries.forEach(function (entry) {
      var idEl = entry.querySelector('id');
      if (!idEl) return;
      var fullId = idEl.textContent.trim();
      // Strip http://arxiv.org/abs/ prefix to get bare ID
      var arxivId = fullId.replace(/^.*\/abs\//, '');

      var titleEl = entry.querySelector('title');
      var title = titleEl ? titleEl.textContent.replace(/\s+/g, ' ').trim() : '';

      var summaryEl = entry.querySelector('summary');
      var abstract = summaryEl ? summaryEl.textContent.replace(/\s+/g, ' ').trim() : '';

      var authorEls = entry.querySelectorAll('author name');
      var authors = [];
      authorEls.forEach(function (a) {
        var n = a.textContent.trim();
        if (n) authors.push(n);
      });

      var catEl = entry.querySelector('category[term]');
      var primaryCat = catEl ? catEl.getAttribute('term') : '';

      var pubEl = entry.querySelector('published');
      var published = pubEl ? pubEl.textContent.trim().substring(0, 10) : '';

      candidates.push({
        arxiv_id: arxivId,
        title: title,
        abstract: abstract,
        authors: authors,
        primary_category: primaryCat,
        published: published,
        abs_url: 'https://arxiv.org/abs/' + arxivId,
        pdf_url: 'https://arxiv.org/pdf/' + arxivId,
      });
    });

    return candidates;
  }

  async function runScout() {
    var cats = scoutCategories();
    var lookback = parseInt(byId('lookback').value, 10) || 1;
    var maxResults = parseInt(byId('max-results').value, 10) || 200;

    // Build arXiv API query
    var query = cats.map(function (c) { return 'cat:' + c; }).join('+OR+');
    var url = 'https://export.arxiv.org/api/query?' +
      'search_query=' + query +
      '&sortBy=submittedDate&sortOrder=descending' +
      '&max_results=' + maxResults +
      '&start=0';

    setStatus('Scouting arXiv (' + cats.join(', ') + ')…');

    var resp;
    try {
      resp = await fetchViaRelay(url);
    } catch (err) {
      if (err instanceof TypeError && err.message === 'Failed to fetch') {
        throw new Error(
          'Cannot reach the relay at ' + relayBase() + '. arXiv itself sends no ' +
          'CORS headers, so the browser can only reach it through a relay. ' +
          'Check that the relay is deployed and reachable, or paste a different ' +
          'one in the "Relay" field above.'
        );
      }
      throw err;
    }
    if (!resp.ok) {
      var relayErr = '';
      try { relayErr = (await resp.text()).substring(0, 200); } catch (_) {}
      throw new Error('arXiv scout failed: HTTP ' + resp.status +
        (relayErr ? ' — ' + relayErr : '') + ' (via ' + relayBase() + ').');
    }

    var xmlText = await resp.text();
    var candidates = parseAtomXML(xmlText);

    if (candidates.length === 0) {
      throw new Error('No papers found. Check categories or try a larger lookback.');
    }

    return candidates;
  }

  // ═══════════════════════════════════════════════════════════════════
  // STAGE 2 — embed (batched /v1/embeddings)
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Three backends, one return shape (`[[float]]`, parallel to the input texts):
   *   local  — transformers.js in this tab. No key, no bill, no network after
   *            the one-time model download. The default.
   *   hosted — POST to the arxave embed function; key lives server-side.
   *   own    — POST to any OpenAI-compatible /v1/embeddings with the user's key.
   * The hosted function answers in OpenAI's {data:[{index,embedding}]} shape
   * precisely so the two remote backends share one code path.
   */
  function getEmbedConfig() {
    var mode = embedMode();
    if (mode === 'local') {
      return { mode: 'local', hosted: false };
    }
    if (mode === 'hosted') {
      return { mode: 'hosted', hosted: true, endpoint: HOSTED_EMBED_URL, key: '', model: null };
    }

    var baseUrl = byId('embed-base-url').value.trim();
    var key = byId('embed-key').value.trim();
    var model = byId('embed-model').value.trim();

    if (!model) throw new Error('Embedding model is required.');
    if (!baseUrl) throw new Error('Embedding base URL is required.');

    baseUrl = baseUrl.replace(/\/+$/, '');

    return { mode: 'own', hosted: false, endpoint: baseUrl + '/v1/embeddings', key: key, model: model };
  }

  // ── Local backend (transformers.js, WASM/WebGPU) ──────────────────
  // Loaded on first use only — nobody pays 32 MB for a page they're reading.
  var localExtractor = null;

  async function getLocalExtractor() {
    if (localExtractor) return localExtractor;

    setStatus('Loading the embedding model (' + LOCAL_MODEL + ', ~32 MB, first run only)…');

    var mod;
    try {
      mod = await import(TRANSFORMERS_URL);
    } catch (err) {
      throw new Error(
        'Could not load the in-browser embedding runtime from ' + TRANSFORMERS_URL + '. ' +
        'Check your connection, or switch the embedding mode to "Hosted".'
      );
    }

    mod.env.allowLocalModels = false;   // always fetch from the CDN, never guess a local path

    // WebGPU is roughly an order of magnitude faster; WASM is the fallback that
    // works everywhere. Both run entirely in this tab.
    var device = ('gpu' in navigator) ? 'webgpu' : 'wasm';

    try {
      localExtractor = await mod.pipeline('feature-extraction', LOCAL_MODEL, {
        dtype: 'q8',
        device: device,
        progress_callback: function (p) {
          if (p && p.status === 'progress' && p.file && typeof p.progress === 'number') {
            setStatus('Downloading model: ' + p.file + ' — ' + p.progress.toFixed(0) + '%' +
              ' (one time, then cached by the browser)');
          }
        },
      });
    } catch (err) {
      if (device === 'webgpu') {
        // Some browsers advertise navigator.gpu but fail to get an adapter.
        setStatus('WebGPU unavailable, falling back to WASM…');
        localExtractor = await mod.pipeline('feature-extraction', LOCAL_MODEL, {
          dtype: 'q8',
          device: 'wasm',
        });
      } else {
        throw err;
      }
    }

    return localExtractor;
  }

  async function embedLocal(texts) {
    var extractor = await getLocalExtractor();
    var vectors = [];

    // Chunked so the status line moves and peak memory stays modest.
    for (var i = 0; i < texts.length; i += LOCAL_BATCH) {
      var chunk = texts.slice(i, i + LOCAL_BATCH);
      setStatus('Embedding locally: ' + Math.min(i + LOCAL_BATCH, texts.length) +
        ' / ' + texts.length + ' texts…');
      // mean pooling + L2 normalize is the standard recipe for these models;
      // cosine() renormalizes anyway, so this is belt and braces.
      var out = await extractor(chunk, { pooling: 'mean', normalize: true });
      var rows = out.tolist();
      for (var r = 0; r < rows.length; r++) vectors.push(rows[r]);
      // Yield to the event loop so the status line actually repaints.
      await new Promise(function (res) { setTimeout(res, 0); });
    }

    return vectors;
  }

  // ── Remote backends (hosted function or user's own endpoint) ──────
  async function embedRemote(texts, cfg) {
    var endpoint = cfg.endpoint;

    // The hosted function caps a call at 400 texts; say so before spending it.
    if (cfg.hosted && texts.length > 400) {
      throw new Error(
        'Hosted embeddings take at most 400 texts per run; this run needs ' +
        texts.length + '. Lower "Max results", trim the .bib, or switch to ' +
        '"In-browser", which has no cap.'
      );
    }

    var headers = { 'Content-Type': 'application/json' };
    if (cfg.key) headers['Authorization'] = 'Bearer ' + cfg.key;

    var payload = { input: texts };
    if (cfg.model) payload.model = cfg.model;   // hosted picks its own model

    var resp;
    try {
      resp = await fetch(endpoint, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(payload),
      });
    } catch (err) {
      if (err instanceof TypeError && err.message === 'Failed to fetch') {
        if (cfg.hosted) {
          throw new Error(
            'Cannot reach the hosted embedding service at ' + endpoint + '. ' +
            'Check your connection, or switch to "In-browser" — it needs no server.'
          );
        }
        var isMixedContent = endpoint.startsWith('http://') &&
          window.location.protocol === 'https:';
        if (isMixedContent) {
          throw new Error(
            'Cannot reach embedding provider at ' + endpoint + '. ' +
            'This page is served over HTTPS (GitHub Pages), but your embedding ' +
            'provider is on HTTP — browsers block this as mixed content. ' +
            'Options: (1) switch to "In-browser", (2) run the page locally ' +
            'with `bundle exec jekyll serve`, or (3) serve the provider over HTTPS.'
          );
        }
        throw new Error(
          'Cannot reach embedding provider at ' + endpoint + '. ' +
          'Check that the provider is running, the base URL is correct, and that ' +
          'it allows browser (CORS) requests — many do not. "In-browser" mode ' +
          'sidesteps both.'
        );
      }
      throw err;
    }

    if (!resp.ok) {
      var errBody = '';
      try { errBody = await resp.text(); } catch (_) {}
      throw new Error('Embedding request returned HTTP ' + resp.status +
        (errBody ? ': ' + errBody.substring(0, 200) : '') +
        (cfg.hosted ? '' : '. Check provider, model, base URL, and API key.'));
    }

    var data = await resp.json();
    var embeddings = data.data; // [{index, embedding: [float]}]

    // Sort by index (API should return ordered, but be safe)
    embeddings.sort(function (a, b) { return a.index - b.index; });

    return embeddings.map(function (e) { return e.embedding; });
  }

  async function runEmbed(candidates, topics, corpusTitles) {
    var cfg = getEmbedConfig();

    // Collect all texts to embed in ONE batch:
    // - all abstracts
    // - all topic strings
    // - all corpus titles (if any)
    var texts = [];

    // Abstracts
    candidates.forEach(function (c) { texts.push(c.abstract); });

    // Topics
    var topicIdx = texts.length;
    topics.forEach(function (t) { texts.push(t); });

    // Corpus
    var corpusIdx = texts.length;
    if (corpusTitles && corpusTitles.length > 0) {
      corpusTitles.forEach(function (t) { texts.push(t); });
    }

    setStatus('Embedding ' + candidates.length + ' abstracts + ' +
      topics.length + ' topics + ' + (corpusTitles ? corpusTitles.length : 0) + ' corpus entries…');

    var vectors = (cfg.mode === 'local')
      ? await embedLocal(texts)
      : await embedRemote(texts, cfg);

    if (vectors.length !== texts.length) {
      throw new Error('Embedding backend returned ' + vectors.length +
        ' vectors for ' + texts.length + ' texts.');
    }

    // Split back into abstract, topic, corpus vectors
    var N = candidates.length;
    var T = topics.length;
    var K = corpusTitles ? corpusTitles.length : 0;

    var abstractVectors = vectors.slice(0, N);
    var topicVectors = vectors.slice(topicIdx, topicIdx + T);
    var corpusVectors = (K > 0) ? vectors.slice(corpusIdx, corpusIdx + K) : [];

    return {
      abstractVectors: abstractVectors,
      topicVectors: topicVectors,
      corpusVectors: corpusVectors,
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  // STAGE 3 — cosine (vectorized over all papers)
  // ═══════════════════════════════════════════════════════════════════

  function dot(a, b) {
    var s = 0;
    for (var i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
  }

  function norm(v) {
    var s = 0;
    for (var i = 0; i < v.length; i++) s += v[i] * v[i];
    return Math.sqrt(s);
  }

  function cosine(a, b) {
    var d = dot(a, b);
    var na = norm(a);
    var nb = norm(b);
    if (na === 0 || nb === 0) return 0;
    var cos = d / (na * nb);
    return cos < 0 ? 0 : cos;  // clamp negatives to 0
  }

  /**
   * topic_cos = max over all topic vectors of cosine(abstract, topic).
   * corpus_cos = max over all corpus vectors of cosine(abstract, corpus_entry).
   * Returns arrays parallel to candidates.
   */
  function computeCosines(abstractVectors, topicVectors, corpusVectors) {
    var N = abstractVectors.length;
    var topicCos = new Array(N);
    var corpusCos = new Array(N);

    for (var i = 0; i < N; i++) {
      var av = abstractVectors[i];

      // topic_cos = max_j cos(av, topicVectors[j])
      var bestTopic = 0;
      for (var j = 0; j < topicVectors.length; j++) {
        var c = cosine(av, topicVectors[j]);
        if (c > bestTopic) bestTopic = c;
      }
      topicCos[i] = topicVectors.length > 0 ? bestTopic : null;

      // corpus_cos = max_k cos(av, corpusVectors[k])
      if (corpusVectors.length > 0) {
        var bestCorpus = 0;
        for (var k = 0; k < corpusVectors.length; k++) {
          var cc = cosine(av, corpusVectors[k]);
          if (cc > bestCorpus) bestCorpus = cc;
        }
        corpusCos[i] = bestCorpus;
      } else {
        corpusCos[i] = null;
      }
    }

    return { topicCos: topicCos, corpusCos: corpusCos };
  }

  // Find best-matching topic string for each paper
  function computeMatchedTopics(abstractVectors, topicVectors, topics) {
    return abstractVectors.map(function (av) {
      if (topicVectors.length === 0) return null;
      var bestJ = 0;
      var bestCos = -1;
      for (var j = 0; j < topicVectors.length; j++) {
        var c = cosine(av, topicVectors[j]);
        if (c > bestCos) { bestCos = c; bestJ = j; }
      }
      return topics[bestJ];
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // STAGE 4 — signals (scirate scite + citation_overlap=null)
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Scrape scite count from scirate.com HTML.
   * Matches the Python scirate.py contract: returns int or null.
   */
  async function fetchSciteCount(arxivId) {
    try {
      var url = 'https://scirate.com/arxiv/' + arxivId;
      var resp = await fetchViaRelay(url, { signal: AbortSignal.timeout(5000) });
      if (!resp.ok) return null;
      var html = await resp.text();

      // Look for patterns like "Scited by 7" or "7 scites"
      // Try multiple regexes to be robust against markup changes
      var patterns = [
        /Scited by\s+(\d+)/i,
        /(\d+)\s+scites?/i,
        /scited-count[^>]*>\s*(\d+)/i,
        /class="scited-count"[^>]*>\s*(\d+)/i,
      ];

      for (var i = 0; i < patterns.length; i++) {
        var m = html.match(patterns[i]);
        if (m) {
          var count = parseInt(m[1], 10);
          if (!isNaN(count) && count >= 0) return count;
        }
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  /**
   * Fetch scite counts with limited concurrency.
   * Returns { arxivId: int | null }.
   */
  async function fetchScites(arxivIds, concurrency) {
    concurrency = concurrency || 3;
    var results = {};
    var i = 0;
    var attempted = 0;
    var gaveUp = false;

    // Scirate sits behind a Cloudflare challenge, so a server-side fetch is
    // usually 403 (measured 2026-07-28). Probe a few, and if none answer, stop
    // hammering it — 130 doomed requests help nobody.
    async function worker() {
      while (i < arxivIds.length && !gaveUp) {
        var idx = i++;
        var aid = arxivIds[idx];
        results[aid] = await fetchSciteCount(aid);
        attempted++;
        if (attempted >= 5 && Object.keys(results).every(function (k) { return results[k] === null; })) {
          gaveUp = true;
        }
      }
    }

    // Launch `concurrency` workers
    var workers = [];
    for (var w = 0; w < concurrency; w++) {
      workers.push(worker());
    }
    await Promise.all(workers);

    // Anything not reached (because we gave up) is unavailable, i.e. null —
    // never 0. Same contract as scirate.py.
    arxivIds.forEach(function (aid) {
      if (!(aid in results)) results[aid] = null;
    });

    return results;
  }

  // ═══════════════════════════════════════════════════════════════════
  // STAGE 5 — rank (blend with renormalization)
  // ═══════════════════════════════════════════════════════════════════

  /**
   * blend() — weighted mean over present signals only.
   *
   * Matches Python rank.blend() exactly:
   *   - Missing (null) signals are dropped from numerator AND denominator.
   *   - Signals with weight <= 0 are also dropped.
   *   - Returns 0.0 when nothing is present.
   */
  function blend(signals, w) {
    var num = 0;
    var den = 0;

    var keys = ['topic_cos', 'corpus_cos', 'citation_overlap', 'scite'];
    var wk = ['w1', 'w2', 'w3', 'w4'];

    for (var i = 0; i < keys.length; i++) {
      var val = signals[keys[i]];
      var weight = w[wk[i]] || 0;
      if (val !== null && val !== undefined && weight > 0) {
        num += weight * val;
        den += weight;
      }
    }

    return den > 0 ? num / den : 0;
  }

  function rankPapers(candidates, topicCos, corpusCos, scites, matchedTopics) {
    var w = weights;
    var ranked = [];

    for (var i = 0; i < candidates.length; i++) {
      var rawScites = scites[candidates[i].arxiv_id];
      var sciteSignal = (rawScites !== null && rawScites !== undefined)
        ? Math.min(rawScites / SCITE_SATURATION, 1.0)
        : null;

      var signals = {
        topic_cos: topicCos[i],
        corpus_cos: corpusCos[i],
        citation_overlap: null,  // deferred
        scite: sciteSignal,
      };

      var importance = blend(signals, w);

      ranked.push({
        arxiv_id: candidates[i].arxiv_id,
        title: candidates[i].title,
        abstract: candidates[i].abstract,
        authors: candidates[i].authors,
        primary_category: candidates[i].primary_category,
        published: candidates[i].published,
        abs_url: candidates[i].abs_url,
        pdf_url: candidates[i].pdf_url,
        signals: signals,
        scite_count: rawScites,
        importance: importance,
        matched_topic: matchedTopics[i],
        llm: null,  // filled by refine stage
      });
    }

    // Sort descending by importance
    ranked.sort(function (a, b) { return b.importance - a.importance; });
    return ranked;
  }

  /**
   * Re-rank without re-fetching anything — just re-blend with current weights.
   * Called on every slider move.
   */
  function reRank() {
    var w = weights;
    for (var i = 0; i < state.ranked.length; i++) {
      state.ranked[i].importance = blend(state.ranked[i].signals, w);
    }
    state.ranked.sort(function (a, b) { return b.importance - a.importance; });
  }

  // ═══════════════════════════════════════════════════════════════════
  // STAGE 6 — present (render ranked table)
  // ═══════════════════════════════════════════════════════════════════

  function signalBadge(sig, key, sciteCount) {
    if (key === 'scite') {
      if (sig === null) return '<span class="sig-null">scite —</span>';
      return '<span>scite <span class="sig-val">' + sciteCount + '</span></span>';
    }
    if (key === 'citation_overlap') {
      return '<span class="sig-null">cit —</span>';
    }
    if (sig === null) {
      return '<span class="sig-null">—</span>';
    }
    return '<span class="sig-val">' + sig.toFixed(2) + '</span>';
  }

  function scoreBar(signals, w) {
    // Show each signal's weighted contribution relative to the total weighted sum
    var keys = ['topic_cos', 'corpus_cos', 'citation_overlap', 'scite'];
    var wk = ['w1', 'w2', 'w3', 'w4'];
    var classes = ['topic', 'corpus', 'citation', 'scite'];

    var parts = [];
    var totalWeighted = 0;

    for (var i = 0; i < keys.length; i++) {
      var val = signals[keys[i]];
      var weight = w[wk[i]] || 0;
      if (val !== null && val !== undefined && weight > 0) {
        parts.push({ cls: classes[i], wv: weight * val });
        totalWeighted += weight * val;
      }
    }

    if (totalWeighted <= 0) return '';

    var html = '<div class="score-bar">';
    for (var j = 0; j < parts.length; j++) {
      var pct = (parts[j].wv / totalWeighted * 100).toFixed(1);
      html += '<div class="score-bar-seg ' + parts[j].cls + '" style="width:' + pct + '%" title="' + parts[j].cls + '"></div>';
    }
    html += '</div>';
    return html;
  }

  function renderResults() {
    var topN = parseInt(byId('top-n').value, 10) || DEFAULT_TOP_N;
    var w = weights;
    var ranked = state.ranked;

    byId('results').style.display = '';
    byId('results-summary').textContent = ranked.length + ' papers ranked. Top ' + Math.min(topN, ranked.length) + ' shown above the line.';

    var tbody = byId('results-body');
    var rows = '';

    for (var i = 0; i < ranked.length; i++) {
      var p = ranked[i];
      var isTopN = i < topN;
      var rowClass = (i === topN - 1 && ranked.length > topN) ? ' class="top-n-cutoff"' : '';

      rows += '<tr' + rowClass + '>';

      // Rank
      rows += '<td>' + (i + 1) + '</td>';

      // Title
      rows += '<td><a href="' + p.abs_url + '" target="_blank" rel="noopener">' +
        escapeHtml(p.title) + '</a>';
      if (p.llm) {
        var annClass = p.llm.relevant ? 'relevant' : 'irrelevant';
        rows += '<div class="llm-annotation ' + annClass + '">' +
          (p.llm.relevant ? '✓ ' : '✗ ') + escapeHtml(p.llm.reason || '') + '</div>';
      }
      rows += '</td>';

      // Score
      rows += '<td>' +
        scoreBar(p.signals, w) +
        '<span class="score-num">' + p.importance.toFixed(2) + '</span>' +
        '</td>';

      // Signals
      rows += '<td class="signal-badges">' +
        'topic ' + signalBadge(p.signals.topic_cos, 'topic_cos') +
        ' · corpus ' + signalBadge(p.signals.corpus_cos, 'corpus_cos') +
        ' · ' + signalBadge(p.signals.scite, 'scite', p.scite_count) +
        ' · ' + signalBadge(p.signals.citation_overlap, 'citation_overlap') +
        '</td>';

      // Category
      rows += '<td>' + escapeHtml(p.primary_category) + '</td>';

      // Date
      rows += '<td>' + escapeHtml(p.published) + '</td>';

      rows += '</tr>';
    }

    tbody.innerHTML = rows;

    // Enable refine button if we have results
    byId('refine-btn').disabled = false;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>')
      .replace(/"/g, '"').replace(/'/g, '&#39;');
  }

  // ═══════════════════════════════════════════════════════════════════
  // STAGE 7 — refine (optional LLM call over top-N)
  // ═══════════════════════════════════════════════════════════════════

  async function runRefine() {
    var topN = parseInt(byId('top-n').value, 10) || DEFAULT_TOP_N;
    var top = state.ranked.slice(0, topN);
    if (top.length === 0) return;

    var prov = byId('refine-provider').value;
    var model = byId('refine-model').value.trim();
    var baseUrl = byId('refine-base-url').value.trim();
    var key = byId('refine-key').value.trim();

    if (!model) throw new Error('Refine model is required.');

    // Build defaults for known providers
    if (prov === 'openai') {
      if (!baseUrl) baseUrl = 'https://api.openai.com/v1';
    } else if (prov === 'ollama') {
      if (!baseUrl) baseUrl = 'http://localhost:11434/v1';
    } else if (prov === 'lm-studio') {
      if (!baseUrl) baseUrl = 'http://127.0.0.1:1234/v1';
    }
    baseUrl = baseUrl.replace(/\/+$/, '');

    var topics = byId('topics').value.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
    var topicList = topics.map(function (t) { return '- ' + t; }).join('\n');

    // Build a prompt with all top-N papers
    var papersText = top.map(function (p, i) {
      return '[' + (i + 1) + '] arXiv:' + p.arxiv_id + '\n' +
        'Title: ' + p.title + '\n' +
        'Abstract: ' + p.abstract + '\n' +
        'Importance: ' + p.importance.toFixed(2) + '\n';
    }).join('\n---\n');

    var prompt = 'You are a research filter. Your topics of interest:\n' + topicList + '\n\n' +
      'Below are ' + top.length + ' papers ranked by a cheap embedding-based score. ' +
      'For EACH paper, judge whether it is genuinely relevant to the topics above. ' +
      'Respond with a JSON array, one object per paper, in the SAME order:\n' +
      '[{"arxiv_id": "...", "relevant": true/false, "reason": "one short sentence why"}]\n\n' +
      'Papers:\n' + papersText;

    // Use the text only — papers already numbered
    // We ask for JSON in response

    var headers = { 'Content-Type': 'application/json' };
    if (key) headers['Authorization'] = 'Bearer ' + key;
    // Some local providers don't require auth
    var useAuth = !!(key || prov === 'openai');

    setStatus('Refining top-' + top.length + ' with LLM…');

    // Build messages differently for instruct vs chat models
    var messages;
    // For Ollama/LM Studio, use raw prompt as user message
    messages = [{ role: 'user', content: prompt }];

    var body = {
      model: model,
      messages: messages,
      temperature: 0.1,
      max_tokens: 2048,
    };

    var resp = await fetch(baseUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      var errBody = '';
      try { errBody = await resp.text(); } catch (_) {}
      throw new Error('LLM refine returned HTTP ' + resp.status +
        (errBody ? ': ' + errBody.substring(0, 200) : ''));
    }

    var data = await resp.json();
    var content = data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : '';

    // Parse JSON from the response (may be wrapped in ```json fences)
    var jsonStr = content.trim();
    var fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) jsonStr = fenceMatch[1].trim();
    // Try to find a JSON array
    var arrMatch = jsonStr.match(/\[[\s\S]*\]/);
    if (!arrMatch) throw new Error('LLM response did not contain a JSON array.');

    var judgments = JSON.parse(arrMatch[0]);

    // Annotate papers with LLM verdicts
    var byIdMap = {};
    judgments.forEach(function (j) { byIdMap[j.arxiv_id] = j; });

    for (var i = 0; i < state.ranked.length; i++) {
      var pid = state.ranked[i].arxiv_id;
      if (byIdMap[pid]) {
        state.ranked[i].llm = { relevant: byIdMap[pid].relevant, reason: byIdMap[pid].reason };
      }
    }

    // Re-sort: bring relevant papers to top, preserving importance order within each group
    state.ranked.sort(function (a, b) {
      var aRel = a.llm ? (a.llm.relevant ? 0 : 1) : 2;
      var bRel = b.llm ? (b.llm.relevant ? 0 : 1) : 2;
      if (aRel !== bRel) return aRel - bRel;
      return b.importance - a.importance;
    });

    renderResults();
    setStatus('Refined: LLM annotated top-' + judgments.length + ' papers.');
  }

  // ── Refine button ─────────────────────────────────────────────────
  byId('refine-btn').addEventListener('click', async function () {
    var btn = this;
    btn.disabled = true;
    try {
      await runRefine();
    } catch (err) {
      setStatus('Refine failed: ' + err.message, true);
    } finally {
      btn.disabled = false;
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // MAIN — run filter
  // ═══════════════════════════════════════════════════════════════════

  byId('run-filter').addEventListener('click', async function () {
    var btn = this;
    btn.disabled = true;
    clearStatus();
    byId('results').style.display = 'none';

    try {
      // ── Extract inputs ──
      var topics = byId('topics').value
        .split('\n')
        .map(function (l) { return l.trim(); })
        .filter(Boolean);

      if (topics.length === 0) throw new Error('Add at least one topic.');

      // ── Stage 1: Scout ──
      state.candidates = await runScout();

      // ── Stage 2: Embed ──
      var vectors = await runEmbed(state.candidates, topics, state.corpusTitles);
      state.topicVectors = vectors.topicVectors;
      state.corpusVectors = vectors.corpusVectors;
      state.abstractVectors = vectors.abstractVectors;

      // ── Stage 3: Cosine ──
      setStatus('Computing cosine similarities…');
      var cosResults = computeCosines(
        vectors.abstractVectors,
        vectors.topicVectors,
        vectors.corpusVectors
      );
      var matchedTopics = computeMatchedTopics(vectors.abstractVectors, vectors.topicVectors, topics);

      // ── Stage 4: Signals (scirate, best-effort) ──
      setStatus('Fetching scite counts (best-effort)…');
      var scites;
      try {
        var arxivIds = state.candidates.map(function (c) { return c.arxiv_id; });
        scites = await fetchScites(arxivIds, 3);
        // "No error thrown" is not the same as "we got counts": Scirate answers
        // 403 to server-side fetches, which reads as every count being null.
        // Say so on the slider instead of pretending w4 is doing work.
        state.sciteAvailable = arxivIds.some(function (aid) { return scites[aid] !== null; });
        byId('w4-unavailable').style.display = state.sciteAvailable ? 'none' : '';
        byId('w4').disabled = !state.sciteAvailable;
      } catch (_) {
        // Scirate wholly unreachable
        scites = {};
        state.candidates.forEach(function (c) { scites[c.arxiv_id] = null; });
        state.sciteAvailable = false;
        byId('w4-unavailable').style.display = '';
        byId('w4').disabled = true;
        setStatus('Scirate unreachable — scite signal unavailable. Ranking proceeds on other signals.', true);
      }

      // ── Stage 5: Rank ──
      state.ranked = rankPapers(state.candidates, cosResults.topicCos, cosResults.corpusCos, scites, matchedTopics);

      // ── Stage 6: Present ──
      renderResults();
      setStatus('Done. ' + state.ranked.length + ' papers ranked. Move sliders to re-rank instantly.');

    } catch (err) {
      setStatus(err.message, true);
      console.error(err);
    } finally {
      btn.disabled = false;
    }
  });

})();