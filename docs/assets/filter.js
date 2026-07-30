/**
 * arxave filter — staged Dig pipeline.
 *
 * Four stages, each with its own button, output, and resumable state:
 *   0. Sharpen the pick  — load the in-browser embedding model
 *   1. Haul the stones   — scout arXiv + embed abstracts + seam map
 *   2. Set the touchstones — free text + core samples (OpenAlex)
 *   3. Assay             — (k+1)×N matrix with live re-blend
 *
 * Dependencies: none. Runs in the browser, no bundler.
 */
(function () {
  'use strict';

  // ── Constants ────────────────────────────────────────────────────
  const FUNCTIONS_BASE = 'https://ugxxakguqgpxpdfhgtsb.supabase.co/functions/v1';
  const RELAY_URL = window.ARXAVE_RELAY || (FUNCTIONS_BASE + '/relay');
  const TRANSFORMERS_VERSION = '3.7.6';
  const TRANSFORMERS_URLS = [
    'https://cdn.jsdelivr.net/npm/@huggingface/transformers@' + TRANSFORMERS_VERSION,
    'https://unpkg.com/@huggingface/transformers@' + TRANSFORMERS_VERSION,
    'https://esm.sh/@huggingface/transformers@' + TRANSFORMERS_VERSION,
  ];
  const LOCAL_MODEL = 'Xenova/bge-small-en-v1.5';
  const LOCAL_DIM = 384;
  const LOCAL_BATCH = 16;
  const OPENALEX_MAILTO = 'arxiv-filter@example.com';

  // ── DOM helpers ──────────────────────────────────────────────────
  function byId(id) { return document.getElementById(id); }

  // ── State ─────────────────────────────────────────────────────────
  const state = {
    extractor: null,        // transformers.js pipeline
    modelLoaded: false,
    stones: [],             // [{arxiv_id, title, abstract, authors, primary_category, published, abs_url, pdf_url}]
    A: null,                // [N × d] abstract vectors, row-major, L2-normalized
    touchstones: [],        // [{id, text, vector}]  free text
    cores: [],              // [{id, doi, title, abstract, vector, status, weak}]
    featureVectors: null,   // [k × d] row-major, unit vectors
    /* featureVectors rows are: touchstones[0..kk-1], then cores[0..kp-1], then rush (null) */
    grades: null,           // [N] blended scores
    order: null,            // [N] indices into stones, sorted by grade desc
    seamOrder: null,        // [N] indices into stones, sorted by cluster
    seamMap: null,          // [N×N] cosine matrix (upper triangle populated)
    seamComponents: null,   // [{indices: [int], centralTitle: string}]
  };

  // ── Persistence ───────────────────────────────────────────────────
  function lsKey(base) { return 'arxave-dig-' + base; }

  function loadState() {
    function j(k) {
      try { var r = localStorage.getItem(lsKey(k)); return r ? JSON.parse(r) : null; }
      catch (_) { return null; }
    }
    var ts = j('touchstones');
    if (ts) state.touchstones = ts;
    var cs = j('cores');
    if (cs) state.cores = cs;
    // cached core vectors
    try {
      var cv = localStorage.getItem(lsKey('core-cache'));
      if (cv) { var parsed = JSON.parse(cv); state._coreCache = parsed; }
    } catch (_) { state._coreCache = {}; }
    if (!state._coreCache) state._coreCache = {};
  }

  function saveTouchstones() {
    // Don't persist vectors — they get re-embedded from text
    var slim = state.touchstones.map(function (t) { return { id: t.id, text: t.text }; });
    try { localStorage.setItem(lsKey('touchstones'), JSON.stringify(slim)); } catch (_) {}
  }

  function saveCores() {
    var slim = state.cores.map(function (c) {
      return { id: c.id, doi: c.doi, title: c.title, abstract: c.abstract, status: c.status, weak: c.weak };
    });
    try { localStorage.setItem(lsKey('cores'), JSON.stringify(slim)); } catch (_) {}
  }

  function saveCoreCache() {
    try { localStorage.setItem(lsKey('core-cache'), JSON.stringify(state._coreCache || {})); } catch (_) {}
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
    return str.replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>')
      .replace(/"/g, '"').replace(/'/g, '&#39;');
  }

  // ═══════════════════════════════════════════════════════════════════
  // STAGE 0 — Sharpen the pick
  // ═══════════════════════════════════════════════════════════════════

  async function runSharpen() {
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
      statusEl.textContent = 'Failed to load from any CDN.';
      statusEl.style.color = 'var(--ember)';
      progWrap.style.display = 'none';
      btn.disabled = false;
      throw new Error('Could not load transformers.js from any CDN: ' + failures.join(' | '));
    }

    mod.env.allowLocalModels = false;

    var lastFile = '';
    state.extractor = await mod.pipeline('feature-extraction', LOCAL_MODEL, {
      dtype: 'q8',
      device: 'wasm',
      progress_callback: function (p) {
        if (p && p.status === 'progress' && p.file && typeof p.progress === 'number') {
          var pct = Math.round(p.progress);
          progBar.value = pct;
          if (p.file !== lastFile) {
            progLabel.textContent = p.file + ' — ' + pct + '%';
            lastFile = p.file;
          } else {
            progLabel.textContent = p.file + ' — ' + pct + '%';
          }
        }
      },
    });

    state.modelLoaded = true;
    progWrap.style.display = 'none';
    doneEl.style.display = '';
    btn.style.display = 'none';
    statusEl.textContent = '';

    // Enable next stage
    byId('haul-btn').disabled = false;
    byId('add-touchstone').disabled = false;
    byId('add-core').disabled = false;
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

  function parseAtomXML(xmlText) {
    var parser = new DOMParser();
    var doc = parser.parseFromString(xmlText, 'application/xml');
    var entries = doc.querySelectorAll('entry');
    var candidates = [];
    entries.forEach(function (entry) {
      var idEl = entry.querySelector('id');
      if (!idEl) return;
      var arxivId = idEl.textContent.trim().replace(/^.*\/abs\//, '');
      var titleEl = entry.querySelector('title');
      var title = titleEl ? titleEl.textContent.replace(/\s+/g, ' ').trim() : '';
      var summaryEl = entry.querySelector('summary');
      var abstract = summaryEl ? summaryEl.textContent.replace(/\s+/g, ' ').trim() : '';
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

  async function scoutDay() {
    var cats = byId('categories').value.split(',').map(function (c) { return c.trim(); }).filter(Boolean);
    if (cats.length === 0) throw new Error('No arXiv categories configured.');
    var lookback = parseInt(byId('lookback').value, 10) || 1;
    var maxResults = parseInt(byId('max-results').value, 10) || 200;
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
    var xmlText = await resp.text();
    var candidates = parseAtomXML(xmlText);
    var cutoff = cutoffDate(new Date(), lookback);
    var windowed = [];
    for (var i = 0; i < candidates.length; i++) {
      if (candidates[i].published && candidates[i].published < cutoff) break;
      windowed.push(candidates[i]);
    }
    if (windowed.length === 0) throw new Error('No papers found. Check categories or try a larger lookback.');
    return windowed;
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

  async function embedTexts(texts, statusFn) {
    var extractor = state.extractor;
    var vectors = [];
    for (var i = 0; i < texts.length; i += LOCAL_BATCH) {
      var chunk = texts.slice(i, i + LOCAL_BATCH);
      if (statusFn) statusFn(Math.min(i + LOCAL_BATCH, texts.length), texts.length);
      var out = await extractor(chunk, { pooling: 'mean', normalize: true });
      var rows = out.tolist();
      for (var r = 0; r < rows.length; r++) {
        normalize(rows[r]);  // defensive: ensure unit vector
        vectors.push(rows[r]);
      }
      await new Promise(function (res) { setTimeout(res, 0); });
    }
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

  function computeSeamMap(A) {
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

  /**
   * Cluster order: threshold at 0.80, connected components ≥3.
   * Returns [order: [indices], components: [{indices:[], centralTitle:string}]]
   */
  function clusterOrder(stones, S) {
    var N = stones.length;
    var THRESH = 0.70;
    var MIN_SIZE = 3;

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

  // Pre-resolved ramp hexes — canvas can't resolve CSS var() strings.
  var ORE_HEX = [
    '#2b2620', '#45371c', '#5d4a1a', '#785f16',
    '#94760f', '#b18f08', '#d0a504', '#f5b301'
  ];

  /** Map cosine value to ore ramp hex. Normalized by [minOff, maxOff]
   *  so the weakest correlation gets the dimmest yellowish step
   *  and the strongest gets the brightest. */
  function seamColor(val, minOff, maxOff) {
    var span = maxOff - minOff;
    if (span <= 0.001) return ORE_HEX[3];
    var norm = (val - minOff) / span;   // minOff→0, maxOff→1
    if (norm < 0) norm = 0; if (norm > 1) norm = 1;
    var idx = 3 + Math.round(norm * 4);
    if (idx > 7) idx = 7;
    return ORE_HEX[idx];
  }

  function drawSeamMap(canvas, S, order, stones, components, readoutFn) {
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
        ctx.fillStyle = seamColor(val, minOff, maxOff);
        ctx.fillRect(oi * cellSize, oj * cellSize, cellSize, cellSize);
      }
    }

    // Diagonal — same as background so it disappears
    ctx.fillStyle = getComputedStyle(canvas).getPropertyValue('--rock').trim() || '#21262e';
    for (var d = 0; d < N; d++) {
      ctx.fillRect(d * cellSize, d * cellSize, cellSize, cellSize);
    }

    // Mouse tracking
    canvas.onmousemove = function (e) {
      var rect = canvas.getBoundingClientRect();
      var mx = e.clientX - rect.left;
      var my = e.clientY - rect.top;
      var col = Math.floor(mx / cellSize);
      var row = Math.floor(my / cellSize);
      if (col < 0 || col >= N || row < 0 || row >= N) {
        if (readoutFn) readoutFn('', '');
        return;
      }
      var si = order[row];
      var sj = order[col];
      var val = row === col ? 1.0 : S[si][sj];
      var same = false;
      for (var c = 0; c < components.length; c++) {
        var members = new Set(components[c].indices);
        if (members.has(si) && members.has(sj)) { same = true; break; }
      }
      if (readoutFn) readoutFn(
        '<a href="' + stones[si].abs_url + '" target="_blank" rel="noopener">' +
          escapeHtml(stones[si].title) + '</a> — ' +
        '<a href="' + stones[sj].abs_url + '" target="_blank" rel="noopener">' +
          escapeHtml(stones[sj].title) + '</a>',
        val.toFixed(2) + (same ? ' · same seam' : '')
      );
    };
    canvas.onmouseleave = function () {
      if (readoutFn) readoutFn('', '');
    };
  }

  async function runHaul() {
    var btn = byId('haul-btn');
    var statusEl = byId('haul-status');
    var progWrap = byId('haul-progress-wrap');
    var progBar = byId('haul-progress');
    var progLabel = byId('haul-label');
    var seamPanel = byId('seam-panel');

    btn.disabled = true;
    progWrap.style.display = 'flex';
    progBar.value = 0;
    progLabel.textContent = 'Scouting...';
    statusEl.textContent = '';
    seamPanel.style.display = 'none';

    try {
      // Scout
      statusEl.textContent = 'Scouting arXiv...';
      var stones = await scoutDay();
      state.stones = stones;

      // Embed abstracts
      statusEl.textContent = 'Embedding ' + stones.length + ' abstracts...';
      var texts = stones.map(function (s) { return s.abstract; });
      var vectors = await embedTexts(texts, function (done, total) {
        progBar.value = Math.round((done / total) * 100);
        progLabel.textContent = 'Stones hauled: ' + done + ' / ' + total;
      });
      state.A = vectors;

      // Compute seam map
      statusEl.textContent = 'Computing seam map...';
      var S = computeSeamMap(vectors);
      state.seamMap = S;

      var cluster = clusterOrder(stones, S);
      state.seamOrder = cluster.order;
      state.seamComponents = cluster.components;

      // Draw seam map
      var canvas = byId('seam-canvas');
      drawSeamMap(canvas, S, cluster.order, stones, cluster.components, function (full, detail) {
        byId('seam-readout').innerHTML = full ? full + '  ·  ' + detail : '';
      });

      // Stats
      var compText = cluster.components.map(function (c) {
        return c.indices.length + ' stones from one seam';
      }).join(', ');
      byId('seam-stats').textContent = compText || 'No large seams detected';
      byId('seam-sort-toggle').checked = true;
      seamPanel.style.display = '';

      // Mark done
      statusEl.textContent = stones.length + ' stones hauled.';
      statusEl.style.color = 'var(--moss)';
      progWrap.style.display = 'none';
      btn.textContent = '✓ Hauled';
      btn.style.color = 'var(--moss)';
      btn.style.borderColor = 'var(--moss)';

      // Enable Stage 2 controls
      byId('touchstones-weight').disabled = false;
      byId('cores-weight').disabled = false;
      // If touchstones already exist from localStorage, embed them and show assay
      if (state.touchstones.length > 0 || state.cores.length > 0) {
        await maybeEmbedFeatures();
        computeGrades();
        renderAssay();
      }

    } catch (err) {
      statusEl.textContent = err.message;
      statusEl.style.color = 'var(--ember)';
      progWrap.style.display = 'none';
      btn.disabled = false;
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // STAGE 2 — Set the touchstones
  // ═══════════════════════════════════════════════════════════════════

  // Touchstone row management
  var touchstoneCounter = 0;
  function addTouchstoneRow(text, id) {
    if (!id) id = 'ts-' + (++touchstoneCounter);
    var list = byId('touchstones-list');
    var div = document.createElement('div');
    div.className = 'touchstone-row';
    div.dataset.id = id;
    div.innerHTML =
      '<input type="text" class="ts-text" value="' + escapeHtml(text || '') + '" placeholder="silicon spin qubits and exchange gates">' +
      '<span class="row-weight"><input type="number" class="ts-weight" value="1.0" min="0" max="1" step="0.05"></span>' +
      '<button type="button" class="row-remove" title="Remove">×</button>';
    list.appendChild(div);

    div.querySelector('.row-remove').addEventListener('click', function () {
      div.remove();
      removeTouchstone(id);
    });
    div.querySelector('.ts-text').addEventListener('input', function () {
      onTouchstoneChanged(id, this.value);
    });
    div.querySelector('.ts-weight').addEventListener('input', function () {
      onWeightChanged();
    });
  }

  function removeTouchstone(id) {
    state.touchstones = state.touchstones.filter(function (t) { return t.id !== id; });
    saveTouchstones();
    if (state.A && state.A.length > 0) {
      maybeEmbedFeatures().then(function () {
        computeGrades();
        renderAssay();
      });
    }
  }

  function onTouchstoneChanged(id, text) {
    var found = false;
    for (var i = 0; i < state.touchstones.length; i++) {
      if (state.touchstones[i].id === id) {
        state.touchstones[i].text = text;
        state.touchstones[i].vector = null; // force re-embed
        found = true; break;
      }
    }
    if (!found) {
      state.touchstones.push({ id: id, text: text, vector: null });
    }
    saveTouchstones();
    if (state.A && state.A.length > 0) {
      maybeEmbedFeatures().then(function () {
        computeGrades();
        renderAssay();
      });
    }
  }

  function onWeightChanged() {
    if (state.A && state.A.length > 0 && state.featureVectors) {
      computeGrades();
      renderAssay();
    }
  }

  // Core sample management
  var coreCounter = 0;
  function addCoreRow(doi, id) {
    if (!id) id = 'core-' + (++coreCounter);
    var list = byId('cores-list');
    var div = document.createElement('div');
    div.className = 'core-row';
    div.dataset.id = id;
    div.innerHTML =
      '<input type="text" class="core-doi" value="' + escapeHtml(doi || '') + '" placeholder="10.1103/RevModPhys.95.025003">' +
      '<span class="row-weight"><input type="number" class="core-weight" value="1.0" min="0" max="1" step="0.05"></span>' +
      '<span class="row-status"></span>' +
      '<button type="button" class="row-remove" title="Remove">×</button>';
    list.appendChild(div);

    div.querySelector('.row-remove').addEventListener('click', function () {
      div.remove();
      removeCore(id);
    });
    div.querySelector('.core-doi').addEventListener('change', function () {
      onCoreChanged(id, this.value, div);
    });
    div.querySelector('.core-weight').addEventListener('input', function () {
      onWeightChanged();
    });

    // If doi is provided, fetch it
    if (doi) onCoreChanged(id, doi, div);
  }

  function removeCore(id) {
    state.cores = state.cores.filter(function (c) { return c.id !== id; });
    saveCores();
    if (state.A && state.A.length > 0) {
      maybeEmbedFeatures().then(function () {
        computeGrades();
        renderAssay();
      });
    }
  }

  async function fetchCoreFromOpenAlex(doi) {
    var cacheKey = doi + '|' + LOCAL_MODEL + '|' + LOCAL_DIM;
    if (state._coreCache && state._coreCache[cacheKey]) {
      return state._coreCache[cacheKey];
    }

    var url = 'https://api.openalex.org/works/' + encodeURIComponent(doi) + '?mailto=' + encodeURIComponent(OPENALEX_MAILTO);
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
    var vectors = await embedTexts([embedText.trim()], null);
    var vector = vectors[0];

    var entry = { doi: doi, title: title, abstract: abstract, vector: vector, weak: weak };
    if (!state._coreCache) state._coreCache = {};
    state._coreCache[cacheKey] = entry;
    saveCoreCache();
    return entry;
  }

  async function onCoreChanged(id, doi, rowDiv) {
    var statusEl = rowDiv.querySelector('.row-status');
    var existing = null;
    for (var i = 0; i < state.cores.length; i++) {
      if (state.cores[i].id === id) { existing = state.cores[i]; break; }
    }
    if (!existing) {
      existing = { id: id, doi: doi, title: '', abstract: '', vector: null, status: 'loading...', weak: false };
      state.cores.push(existing);
    }
    existing.doi = doi;
    existing.status = 'loading...';
    existing.vector = null;
    statusEl.textContent = 'loading...';

    try {
      var fetched = await fetchCoreFromOpenAlex(doi);
      existing.title = fetched.title;
      existing.abstract = fetched.abstract;
      existing.vector = fetched.vector;
      existing.status = '✓ ' + (existing.title || doi).substring(0, 40);
      existing.weak = fetched.weak;
      statusEl.textContent = existing.status + (existing.weak ? ' (title only)' : '');
    } catch (err) {
      existing.status = '✗ ' + err.message;
      existing.weak = true;
      statusEl.textContent = existing.status;
    }

    saveCores();
    if (state.A && state.A.length > 0) {
      await maybeEmbedFeatures();
      computeGrades();
      renderAssay();
    }
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

    var newVectors = await embedTexts(textsToEmbed, null);
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

  function getWeights() {
    var w = [];
    var groupTsW = parseFloat(byId('touchstones-weight').value) || 0;
    var groupCoreW = parseFloat(byId('cores-weight').value) || 0;

    // Per-row weights from the DOM
    var tsRows = byId('touchstones-list').querySelectorAll('.touchstone-row');
    for (var r = 0; r < tsRows.length; r++) {
      var rw = parseFloat(tsRows[r].querySelector('.ts-weight').value);
      if (isNaN(rw)) rw = 1.0;
      w.push(groupTsW * rw);
    }
    var coreRows = byId('cores-list').querySelectorAll('.core-row');
    for (var c = 0; c < coreRows.length; c++) {
      var cw = parseFloat(coreRows[c].querySelector('.core-weight').value);
      if (isNaN(cw)) cw = 1.0;
      w.push(groupCoreW * cw);
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

  function renderAssay() {
    var F = state.featureVectors;
    if (!F || state.order === null || state.grades === null) return;

    var N = state.stones.length;
    var order = state.order;
    var grades = state.grades;
    var topN = parseInt(byId('paydirt-n').value, 10) || 10;
    var weights = getWeights();

    // Show assay section
    byId('stage-3').style.display = '';
    byId('assay-stats').textContent =
      state.stones.length + ' stones · ' + (F.length - 1) + ' features (1 inactive)';

    // ── Matrix view ──
    var grid = byId('assay-grid');
    var rail = byId('assay-rail');
    var colTitles = byId('assay-column-titles');

    // Cell size shrinks as N grows: 16px at N≤90, down to 10px at N≥200
    var cellW = N <= 90 ? 16 : N <= 120 ? 14 : N <= 160 ? 12 : 10;
    // Rail row height must match grid cell height so rows align
    var rowH = cellW; // matrix-cell has aspect-ratio: 1
    var colTitleHTML = '';
    for (var c = 0; c < N; c++) {
      var si = order[c];
      var cls = c < topN ? ' paydirt' : '';
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

    // Rail
    var railHTML = '';
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
      var spark = computeSpark(t.vector);
      railHTML += '<div class="rail-row">' +
        '<span class="rail-label" title="' + escapeHtml(tLabel) + '">' + escapeHtml(tLabel.substring(0, 20)) + '</span>' +
        '<span class="rail-weight">' + (weights[rowIdx] || 0).toFixed(2) + '</span>' +
        '<span class="rail-sparkline"><span class="rail-sparkline-bar" style="width:' + Math.round(spark * 100) + '%"></span></span>' +
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
      var cspark = computeSpark(c.vector);
      railHTML += '<div class="rail-row">' +
        '<span class="rail-label" title="' + escapeHtml(cLabel) + '">' + escapeHtml(cLabel.substring(0, 20)) + '</span>' +
        '<span class="rail-weight">' + (weights[rowIdx] || 0).toFixed(2) + '</span>' +
        '<span class="rail-sparkline"><span class="rail-sparkline-bar" style="width:' + Math.round(cspark * 100) + '%"></span></span>' +
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

    // Attach hover/focus handlers
    attachCellHandlers(order, kk, kp, topN);

    // ── Table view (update if visible) ──
    if (byId('table-view-toggle').checked) {
      renderTable(order, kk, kp, topN);
    }
  }

  function computeSpark(vector) {
    if (!vector || !state.A || state.A.length === 0) return 0;
    var min = Infinity, max = -Infinity;
    for (var i = 0; i < state.A.length; i++) {
      var c = cosine(state.A[i], vector);
      if (c < min) min = c;
      if (c > max) max = c;
    }
    if (max <= min) return 0;
    // How wide the top half of the distribution is — rough measure of discrimination
    var spread = max - min;
    return Math.min(1, spread);
  }

  function attachCellHandlers(order, kk, kp, topN) {
    var grid = byId('assay-grid');
    var tooltip = byId('cell-tooltip');
    var N = state.stones.length;
    var F = state.featureVectors;
    var grades = state.grades;

    var pinnedCell = null;

    function showTooltip(e, cell) {
      var row = cell.dataset.row;
      var col = parseInt(cell.dataset.col, 10);
      var si = order[col];
      var stone = state.stones[si];
      var val = cell.dataset.val;
      var isGrade = row === 'grade';

      tooltip.innerHTML =
        '<div class="tt-value">' + (val === 'null' ? '—' : parseFloat(val).toFixed(2)) + '</div>' +
        '<div class="tt-title">' + escapeHtml(stone.title) + '</div>' +
        '<div class="tt-row"><a href="' + stone.abs_url + '" target="_blank" rel="noopener">open on arXiv →</a></div>';
      tooltip.style.display = 'block';
      positionTooltip(e, tooltip);
    }

    grid.querySelectorAll('.matrix-cell').forEach(function (cell) {
      cell.addEventListener('mouseenter', function (e) {
        if (pinnedCell) return; // locked on a cell until click elsewhere
        showTooltip(e, cell);
      });

      cell.addEventListener('click', function (e) {
        if (pinnedCell === cell) {
          // unpin
          pinnedCell = null;
          tooltip.style.display = 'none';
        } else {
          pinnedCell = cell;
          showTooltip(e, cell);
        }
        e.stopPropagation();
      });
    });

    // Click anywhere outside the grid dismisses the pinned tooltip
    document.addEventListener('click', function (e) {
      if (!grid.contains(e.target)) {
        pinnedCell = null;
        tooltip.style.display = 'none';
      }
    });

    grid.addEventListener('mouseleave', function () {
      if (!pinnedCell) tooltip.style.display = 'none';
    });
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
    headHTML += '<th>Grade</th><th>arXiv ID</th></tr>';
    head.innerHTML = headHTML;

    // Body
    var bodyHTML = '';
    for (var n = 0; n < N; n++) {
      var si = order[n];
      var stone = state.stones[si];
      var rowCls = n < topN ? ' class="paydirt-row"' : '';
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
      bodyHTML += '<td>' + escapeHtml(stone.arxiv_id) + '</td>';
      bodyHTML += '</tr>';
    }
    body.innerHTML = bodyHTML;

    byId('assay-table-wrap').style.display = '';
  }

  // ═══════════════════════════════════════════════════════════════════
  // Event bindings — Stage 0
  // ═══════════════════════════════════════════════════════════════════

  byId('sharpen-btn').addEventListener('click', async function () {
    try { await runSharpen(); }
    catch (err) { byId('sharpen-status').textContent = err.message; byId('sharpen-status').style.color = 'var(--ember)'; }
  });

  // ═══════════════════════════════════════════════════════════════════
  // Event bindings — Stage 1
  // ═══════════════════════════════════════════════════════════════════

  byId('haul-btn').addEventListener('click', async function () {
    try { await runHaul(); }
    catch (err) { /* already handled */ }
  });

  // Seam sort toggle
  byId('seam-sort-toggle').addEventListener('change', function () {
    if (!state.seamMap || !state.stones.length) return;
    var clustered = this.checked;
    var order = clustered ? state.seamOrder : state.stones.map(function (_, i) { return i; });
    drawSeamMap(byId('seam-canvas'), state.seamMap, order, state.stones, state.seamComponents, function (full, detail) {
      byId('seam-readout').textContent = full ? full + '  ·  ' + detail : '';
    });
  });

  // Seam expand
  byId('seam-expand-btn').addEventListener('click', function () {
    if (!state.seamMap) return;
    var modal = byId('seam-modal');
    var canvas = byId('seam-modal-canvas');
    var order = byId('seam-sort-toggle').checked ? state.seamOrder : state.stones.map(function (_, i) { return i; });
    drawSeamMap(canvas, state.seamMap, order, state.stones, state.seamComponents, function (full, detail) {
      byId('seam-modal-readout').textContent = full ? full + '  ·  ' + detail : '';
    });
    modal.style.display = 'flex';
  });

  byId('seam-modal').addEventListener('click', function (e) {
    if (e.target === byId('seam-modal-backdrop') || e.target.classList.contains('seam-modal-close')) {
      byId('seam-modal').style.display = 'none';
    }
  });
  byId('seam-modal-close').addEventListener('click', function () {
    byId('seam-modal').style.display = 'none';
  });

  // ═══════════════════════════════════════════════════════════════════
  // Event bindings — Stage 2
  // ═══════════════════════════════════════════════════════════════════

  byId('add-touchstone').addEventListener('click', function () {
    addTouchstoneRow('');
  });

  byId('add-core').addEventListener('click', function () {
    addCoreRow('');
  });

  // Group weights
  byId('touchstones-weight').addEventListener('input', function () {
    onWeightChanged();
  });
  byId('cores-weight').addEventListener('input', function () {
    onWeightChanged();
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
        addCoreRow(dois[d]);
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
    if (state.order !== null) renderAssay();
  });

  byId('table-view-toggle').addEventListener('change', function () {
    var show = this.checked;
    byId('assay-matrix-wrap').style.display = show ? 'none' : '';
    byId('assay-legends').style.display = show ? 'none' : '';
    byId('assay-table-wrap').style.display = show ? '' : 'none';
    if (show && state.order !== null) {
      var kk = state.touchstones.length;
      var kp = state.cores.length;
      var topN = parseInt(byId('paydirt-n').value, 10) || 10;
      renderTable(state.order, kk, kp, topN);
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // Init
  // ═══════════════════════════════════════════════════════════════════

  // Load persisted touchstones and cores
  loadState();

  // Restore touchstone rows from localStorage
  if (state.touchstones.length > 0) {
    for (var ti = 0; ti < state.touchstones.length; ti++) {
      addTouchstoneRow(state.touchstones[ti].text, state.touchstones[ti].id);
    }
    // Mark vectors as null — they'll be re-embedded
    for (var tj = 0; tj < state.touchstones.length; tj++) {
      state.touchstones[tj].vector = null;
    }
  }

  // Restore core rows from localStorage
  if (state.cores.length > 0) {
    for (var ci = 0; ci < state.cores.length; ci++) {
      addCoreRow(state.cores[ci].doi, state.cores[ci].id);
    }
  }

  // Show the app
  var app = byId('app');
  if (app) app.style.display = '';

  // Initially hide Stage 3
  byId('stage-3').style.display = 'none';

})();