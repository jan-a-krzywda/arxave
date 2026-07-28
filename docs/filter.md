---
layout: page
title: Filter
permalink: /filter/
---

<noscript>
  <div class="warn-banner">
    JavaScript is disabled. This page needs it to run the filter. Please enable JavaScript and reload.
  </div>
</noscript>

<div id="app" style="display:none">
  <div class="safety-banner">
    <strong>🔒 Everything happens in your browser.</strong>
    API keys are never sent anywhere except to the embedding provider you
    configure. No arxave server. <a href="#cors-note">Read about CORS</a>.
  </div>

  <form id="filter-form" autocomplete="off">

    <!-- ── Topics ── -->
    <fieldset>
      <legend>📋 Topics</legend>
      <p class="hint">One per line. Be specific — "quantum computing" lets everything through.</p>
      <textarea id="topics" rows="6" placeholder="silicon spin qubits and exchange gates
charge noise and decoherence in quantum dots
cryogenic control of quantum processors"></textarea>
    </fieldset>

    <!-- ── Corpus (.bib upload) ── -->
    <fieldset>
      <legend>📚 Corpus <span class="sub">— optional, enables corpus_cos signal</span></legend>
      <p class="hint">Upload a <code>.bib</code> file of papers you already read. Titles are embedded
      and compared to each candidate abstract. v1: titles only (offline).</p>
      <label class="bib-upload">
        <input type="file" id="bib-file" accept=".bib">
      </label>
      <div id="corpus-status" class="hint" style="margin-top:0.25rem"></div>
    </fieldset>

    <!-- ── Scout ── -->
    <fieldset>
      <legend>🔭 Scout</legend>
      <div class="role-grid scout-grid">
        <label>
          arXiv categories
          <input type="text" id="categories" value="cond-mat.mes-hall, quant-ph"
                 placeholder="cond-mat.mes-hall, quant-ph">
        </label>
        <label>
          Lookback (days)
          <input type="number" id="lookback" value="1" min="1" max="7">
        </label>
        <label>
          Max results
          <input type="number" id="max-results" value="200" min="10" max="1000">
        </label>
      </div>
    </fieldset>

    <!-- ── Embedding provider ── -->
    <fieldset>
      <legend>🧮 Embedding provider</legend>
      <div class="role-grid">
        <label>
          Provider
          <select id="embed-provider">
            <option value="openai">OpenAI</option>
            <option value="ollama">Ollama</option>
            <option value="lm-studio" selected>LM Studio</option>
            <option value="custom">Custom</option>
          </select>
        </label>
        <label>
          Model
          <input type="text" id="embed-model" value="text-embedding-3-small">
        </label>
        <label class="base-url-label" id="embed-base-url-label">
          Base URL
          <input type="text" id="embed-base-url" placeholder="http://127.0.0.1:1234/v1">
        </label>
        <label>
          API key
          <input type="password" id="embed-key" placeholder="sk-...">
        </label>
      </div>
    </fieldset>

    <!-- ── CORS proxy ── -->
    <fieldset>
      <legend>🌐 CORS proxy <span class="sub">— optional</span></legend>
      <p class="hint" id="cors-note">
        arXiv and Scirate may block cross-origin browser requests. If the scout
        or scite fetch fails, paste a CORS proxy URL here (e.g.
        <code>http://127.0.0.1:8765/proxy</code> from <code>arxave serve</code>,
        or a public one like <code>https://corsproxy.io/?</code>). Leave blank
        for direct requests — they work with LM Studio / Ollama on localhost.
      </p>
      <label>
        <input type="text" id="cors-proxy" placeholder="http://127.0.0.1:8765/proxy" style="width:100%">
      </label>
    </fieldset>

    <!-- ── Weight sliders (w1–w4) ── -->
    <fieldset id="weights-fieldset">
      <legend>⚖️ Ranking weights <span class="sub">— move a slider; ranking updates instantly</span></legend>
      <div class="weight-sliders">
        <div class="weight-row" id="w1-row">
          <label>
            <span class="weight-label">Topic match <code>w1</code></span>
            <span class="weight-desc">Semantic fit to your topics</span>
          </label>
          <input type="range" id="w1" min="0" max="1" step="0.05" value="0.50">
          <span class="weight-val" id="w1-val">0.50</span>
          <span class="weight-pct" id="w1-pct"></span>
        </div>

        <div class="weight-row" id="w2-row">
          <label>
            <span class="weight-label">Corpus fit <code>w2</code></span>
            <span class="weight-desc">Closeness to your library</span>
          </label>
          <input type="range" id="w2" min="0" max="1" step="0.05" value="0.25">
          <span class="weight-val" id="w2-val">0.25</span>
          <span class="weight-pct" id="w2-pct"></span>
          <span class="weight-unavailable" id="w2-unavailable" style="display:none">— signal unavailable (upload .bib)</span>
        </div>

        <div class="weight-row" id="w3-row">
          <label>
            <span class="weight-label">Citation overlap <code>w3</code></span>
            <span class="weight-desc">Shared references <em>(deferred)</em></span>
          </label>
          <input type="range" id="w3" min="0" max="1" step="0.05" value="0.15" disabled>
          <span class="weight-val" id="w3-val">0.15</span>
          <span class="weight-pct" id="w3-pct"></span>
          <span class="weight-unavailable" id="w3-unavailable">— signal unavailable (deferred)</span>
        </div>

        <div class="weight-row" id="w4-row">
          <label>
            <span class="weight-label">Crowd attention <code>w4</code></span>
            <span class="weight-desc">Scirate scites</span>
          </label>
          <input type="range" id="w4" min="0" max="1" step="0.05" value="0.10">
          <span class="weight-val" id="w4-val">0.10</span>
          <span class="weight-pct" id="w4-pct"></span>
          <span class="weight-unavailable" id="w4-unavailable" style="display:none">— signal unavailable (scirate fetch failed)</span>
        </div>
      </div>

      <div class="weight-summary" id="weight-summary">
        Normalized influence: <span id="weight-pct-readout"></span>
      </div>
    </fieldset>

    <!-- ── Top N ── -->
    <fieldset>
      <legend>📊 Output</legend>
      <div class="role-grid" style="grid-template-columns: 1fr 1fr auto;">
        <label>
          Top N
          <input type="number" id="top-n" value="10" min="1" max="50">
        </label>
        <label>
          LLM provider (optional refine)
          <select id="refine-provider">
            <option value="openai">OpenAI</option>
            <option value="ollama">Ollama</option>
            <option value="lm-studio" selected>LM Studio</option>
            <option value="custom">Custom</option>
          </select>
        </label>
        <label style="align-self:end">
          <button type="button" id="refine-btn" disabled style="margin-top:0">
            Refine top-N with LLM
          </button>
        </label>
      </div>
      <div class="role-grid" id="refine-extra" style="display:none; margin-top:0.75rem">
        <label>
          Refine model
          <input type="text" id="refine-model" value="gpt-4o-mini">
        </label>
        <label>
          Refine base URL
          <input type="text" id="refine-base-url" placeholder="https://api.openai.com/v1">
        </label>
        <label>
          Refine API key
          <input type="password" id="refine-key" placeholder="sk-...">
        </label>
      </div>
    </fieldset>

    <div class="button-bar">
      <button type="button" id="run-filter">🔍 Run filter</button>
      <span id="run-status" class="run-status" style="display:none"></span>
    </div>

  </form>

  <!-- ── Results ── -->
  <div id="results" style="display:none">
    <h2>Results</h2>
    <p class="hint" id="results-summary"></p>
    <div class="table-wrap">
      <table id="results-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Title</th>
            <th>Score</th>
            <th>Signals</th>
            <th>Category</th>
            <th>Date</th>
          </tr>
        </thead>
        <tbody id="results-body"></tbody>
      </table>
    </div>
  </div>
</div>

<link rel="stylesheet" href="{{ '/assets/filter.css' | relative_url }}">
<script src="{{ '/assets/filter.js' | relative_url }}"></script>