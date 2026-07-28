/**
 * arxave filter — browser-side pipeline for ranking arXiv papers.
 *
 * Implements the filter-spec.md pipeline:
 *   1. scout  — arXiv API (Atom XML), via CORS proxy if configured
 *   2. embed  — batched /v1/embeddings call (OpenAI-compatible)
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

  // ── Embedding provider presets ────────────────────────────────────
  var EMBED_PRESETS = {
    openai:      { base_url: 'https://api.openai.com/v1', model: 'text-embedding-3-small' },
    ollama:      { base_url: 'http://localhost:11434/v1', model: 'nomic-embed-text' },
    'lm-studio': { base_url: 'http://127.0.0.1:1234/v1', model: 'text-embedding-nomic-embed-text-v1.5' },
    custom:      { base_url: '', model: '' },
  };

  function onEmbedProviderChange() {
    var prov = byId('embed-provider').value;
    var preset = EMBED_PRESETS[prov];
    byId('embed-model').value = preset.model;
    byId('embed-base-url').value = preset.base_url;
    var lbl = byId('embed-base-url-label');
    lbl.style.display = (prov === 'custom' || prov === 'ollama' || prov === 'lm-studio') ? '' : 'none';
  }
  byId('embed-provider').addEventListener('change', onEmbedProviderChange);
  onEmbedProviderChange();

  // ── Refine provider ───────────────────────────────────────────────
  byId('refine-provider').addEventListener('change', function () {
    var prov = this.value;
    var extra = byId('refine-extra');
    if (prov === 'custom') {
      extra.style.display = '';
    } else {
      // fill in defaults
      if (prov === 'openai') {
        byId('refine-model').value = 'gpt-4o-mini';
        byId('refine-base-url').value = 'https://api.openai.com/v1';
      } else if (prov === 'ollama') {
        byId('refine-model').value = 'llama3.2';
        byId('refine-base-url').value = 'http://localhost:11434/v1';
      } else if (prov === 'lm-studio') {
        byId('refine-model').value = 'liquid/lfm2.5-1.2b';
        byId('refine-base-url').value = 'http://127.0.0.1:1234/v1';
      }
      extra.style.display = (prov === 'ollama' || prov === 'lm-studio') ? '' : 'none';
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

  // ── CORS proxy helper ─────────────────────────────────────────────
  function proxyUrl(url) {
    var p = byId('cors-proxy').value.trim();
    if (!p) return url;
    // If proxy ends with ?, append URL directly; otherwise assume it's a prefix
    if (p.endsWith('?') || p.endsWith('=')) return p + encodeURIComponent(url);
    // assume arxave serve style: /proxy?url=...
    if (p.indexOf('?') === -1) return p + '?url=' + encodeURIComponent(url);
    return p + encodeURIComponent(url);
  }

  function fetchWithProxy(url, opts) {
    opts = opts || {};
    // Try direct first, fall back to proxy if CORS blocks
    return fetch(url, opts).catch(function (directErr) {
      var p = byId('cors-proxy').value.trim();
      if (!p) throw directErr;
      return fetch(proxyUrl(url), opts);
    });
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
      resp = await fetchWithProxy(url);
    } catch (err) {
      if (err instanceof TypeError && err.message === 'Failed to fetch') {
        throw new Error(
          'Cannot reach arXiv API. This is a CORS issue — arXiv does not send ' +
          'Access-Control-Allow-Origin headers, and the browser blocks the request. ' +
          'Fix: paste a CORS proxy URL in the "CORS proxy" field above ' +
          '(e.g. https://corsproxy.io/?) or run arxave serve locally.'
        );
      }
      throw err;
    }
    if (!resp.ok) {
      throw new Error('arXiv API returned HTTP ' + resp.status + '. ' +
        'Try setting a CORS proxy in the field above.');
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

  function getEmbedConfig() {
    var baseUrl = byId('embed-base-url').value.trim();
    var key = byId('embed-key').value.trim();
    var model = byId('embed-model').value.trim();

    if (!model) throw new Error('Embedding model is required.');
    if (!baseUrl) throw new Error('Embedding base URL is required.');

    // Normalize: strip trailing slash
    baseUrl = baseUrl.replace(/\/+$/, '');

    return { baseUrl: baseUrl, key: key, model: model };
  }

  async function runEmbed(candidates, topics, corpusTitles) {
    var cfg = getEmbedConfig();
    var endpoint = cfg.baseUrl + '/v1/embeddings';

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

    var headers = { 'Content-Type': 'application/json' };
    if (cfg.key) headers['Authorization'] = 'Bearer ' + cfg.key;

    var resp;
    try {
      resp = await fetch(endpoint, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({
          model: cfg.model,
          input: texts,
        }),
      });
    } catch (err) {
      if (err instanceof TypeError && err.message === 'Failed to fetch') {
        var isMixedContent = cfg.baseUrl.startsWith('http://') &&
          window.location.protocol === 'https:';
        if (isMixedContent) {
          throw new Error(
            'Cannot reach embedding provider at ' + cfg.baseUrl + '. ' +
            'This page is served over HTTPS (GitHub Pages), but your embedding ' +
            'provider is on HTTP — browsers block this as mixed content. ' +
            'Options: (1) run the page locally with `bundle exec jekyll serve`, ' +
            '(2) use HTTPS for the provider, or (3) use a CORS proxy.'
          );
        }
        throw new Error(
          'Cannot reach embedding provider at ' + cfg.baseUrl + '. ' +
          'Check that the provider is running and the base URL is correct. ' +
          'If using a remote provider, you may need a CORS proxy.'
        );
      }
      throw err;
    }

    if (!resp.ok) {
      var errBody = '';
      try { errBody = await resp.text(); } catch (_) {}
      throw new Error('Embedding API returned HTTP ' + resp.status +
        (errBody ? ': ' + errBody.substring(0, 200) : '') +
        '. Check provider, model, base URL, and API key.');
    }

    var data = await resp.json();
    var embeddings = data.data; // [{index, embedding: [float]}]

    // Sort by index (API should return ordered, but be safe)
    embeddings.sort(function (a, b) { return a.index - b.index; });

    // Split back into abstract, topic, corpus vectors
    var N = candidates.length;
    var T = topics.length;
    var K = corpusTitles ? corpusTitles.length : 0;

    var abstractVectors = embeddings.slice(0, N).map(function (e) { return e.embedding; });
    var topicVectors = embeddings.slice(topicIdx, topicIdx + T).map(function (e) { return e.embedding; });
    var corpusVectors = (K > 0)
      ? embeddings.slice(corpusIdx, corpusIdx + K).map(function (e) { return e.embedding; })
      : [];

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
      var resp = await fetchWithProxy(url, { signal: AbortSignal.timeout(5000) });
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

    async function worker() {
      while (i < arxivIds.length) {
        var idx = i++;
        var aid = arxivIds[idx];
        results[aid] = await fetchSciteCount(aid);
      }
    }

    // Launch `concurrency` workers
    var workers = [];
    for (var w = 0; w < concurrency; w++) {
      workers.push(worker());
    }
    await Promise.all(workers);

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
        state.sciteAvailable = true;
        byId('w4-unavailable').style.display = 'none';
        byId('w4').disabled = false;
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