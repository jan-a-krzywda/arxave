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
  <p class="hint">
    Wash a night of arXiv and keep the few stones worth a careful look.
    Everything scores in this tab — nothing about your topics leaves it.
    <a href="#small-print">Small print</a>.
  </p>

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
      <legend>📚 Corpus <span class="wip">WIP</span> <span class="sub">— optional, enables the corpus signal</span></legend>
      <p class="hint">Upload a <code>.bib</code> file of papers you already read. Titles are embedded
      and compared to each candidate abstract.</p>
      <p class="hint wip-note"><strong>Work in progress:</strong> only the
      <em>titles</em> in your <code>.bib</code> are embedded — not abstracts, not
      full text — so a match is looser than it should be. The parser is a regex
      over <code>title = {…}</code> and has not been tested against messy
      real-world <code>.bib</code> files. Usable, but treat the corpus score as
      indicative.</p>
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

    <!-- ── Embeddings ── -->
    <fieldset>
      <legend>🧮 Embeddings</legend>
      <div class="embed-mode">
        <label class="radio-row">
          <input type="radio" name="embed-mode" value="local" checked>
          <span><strong>In-browser</strong> — open-source
          <code>bge-small-en-v1.5</code> runs in this tab. No key, no account,
          nothing billed, nothing sent anywhere. Downloads ~32 MB the first time,
          then the browser caches it. Slow but free: measured 75 s for 130
          abstracts in Chrome. Pick <strong>Hosted</strong> below if you would
          rather wait a second than a minute.</span>
        </label>
        <label class="radio-row">
          <input type="radio" name="embed-mode" value="hosted">
          <span><strong>Hosted</strong> — arxave's embedding endpoint. No
          download, ~1 s per run; abstracts are sent to the endpoint.</span>
        </label>
        <label class="radio-row">
          <input type="radio" name="embed-mode" value="own">
          <span><strong>Own key</strong> — any OpenAI-compatible
          <code>/v1/embeddings</code>. Your key stays in this form.</span>
        </label>
      </div>

      <div class="role-grid" id="embed-own-fields" style="display:none; margin-top:0.75rem">
        <label>
          Provider
          <select id="embed-provider">
            <option value="openai" selected>OpenAI</option>
            <option value="ollama">Ollama</option>
            <option value="lm-studio">LM Studio</option>
            <option value="custom">Custom</option>
          </select>
        </label>
        <label>
          Model
          <input type="text" id="embed-model" value="text-embedding-3-small">
        </label>
        <label class="base-url-label" id="embed-base-url-label">
          Base URL
          <input type="text" id="embed-base-url" placeholder="https://api.openai.com/v1">
        </label>
        <label>
          API key
          <input type="password" id="embed-key" placeholder="sk-...">
        </label>
      </div>
    </fieldset>

    <!-- ── Weight sliders (w1–w4) ── -->
    <fieldset id="weights-fieldset">
      <legend>⚖️ Assay <span class="sub">— how each stone is weighed. Move a slider, ranking updates instantly.</span></legend>
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

        <div class="weight-row is-dead" id="w2-row">
          <label>
            <span class="weight-label">Corpus fit <code>w2</code> <span class="wip">WIP</span></span>
            <span class="weight-desc">Closeness to your own bag — titles only</span>
          </label>
          <input type="range" id="w2" min="0" max="1" step="0.05" value="0.25" disabled>
          <span class="weight-val" id="w2-val">0.25</span>
          <span class="weight-pct" id="w2-pct"></span>
          <span class="weight-unavailable" id="w2-unavailable">— no signal (upload a .bib)</span>
        </div>

        <div class="weight-row is-dead" id="w3-row">
          <label>
            <span class="weight-label">Citation overlap <code>w3</code> <span class="wip">WIP</span></span>
            <span class="weight-desc">Veins shared with your bag</span>
          </label>
          <input type="range" id="w3" min="0" max="1" step="0.05" value="0.15" disabled>
          <span class="weight-val" id="w3-val">0.15</span>
          <span class="weight-pct" id="w3-pct"></span>
          <span class="weight-unavailable" id="w3-unavailable">— no signal (needs a backend)</span>
        </div>

        <div class="weight-row is-dead" id="w4-row">
          <label>
            <span class="weight-label">Crowd attention <code>w4</code> <span class="wip">WIP</span></span>
            <span class="weight-desc">Scirate scites — blocked by Cloudflare</span>
          </label>
          <input type="range" id="w4" min="0" max="1" step="0.05" value="0.10" disabled>
          <span class="weight-val" id="w4-val">0.10</span>
          <span class="weight-pct" id="w4-pct"></span>
          <span class="weight-unavailable" id="w4-unavailable">— no signal (Scirate answers 403 to non-browser fetches)</span>
        </div>
      </div>

      <div class="weight-summary" id="weight-summary">
        Normalized influence: <span id="weight-pct-readout"></span>
      </div>
    </fieldset>

    <!-- ── Top N ── -->
    <fieldset>
      <legend>🪨 Carry up <span class="sub">— the stones you read carefully</span></legend>
      <p class="hint">Everything below the cut line is still scored and still
      listed; it just does not come up the shaft with you.</p>
      <div class="role-grid" style="grid-template-columns: 1fr 2fr;">
        <label>
          How many
          <input type="number" id="top-n" value="10" min="1" max="50">
        </label>
      </div>
    </fieldset>

    <div class="button-bar">
      <button type="button" id="run-filter">⛏ Dig</button>
      <span id="run-status" class="run-status" style="display:none"></span>
    </div>

    <!-- ── Second pass, not built ── -->
    <details class="advanced">
      <summary>Second pass with an LLM <span class="wip">WIP</span></summary>
      <p class="hint">Re-reads what you carried up and argues each one. Not wired
      yet — the controls are here so the shape is visible, and they stay dead
      until the step is real.</p>
      <div class="role-grid">
        <label>
          Provider
          <select id="refine-provider" disabled>
            <option value="openai" selected>OpenAI</option>
            <option value="ollama">Ollama</option>
            <option value="lm-studio">LM Studio</option>
            <option value="custom">Custom</option>
          </select>
        </label>
        <label>
          Model
          <input type="text" id="refine-model" value="gpt-4o-mini" disabled>
        </label>
        <label>
          Base URL
          <input type="text" id="refine-base-url" placeholder="https://api.openai.com/v1" disabled>
        </label>
        <label>
          API key
          <input type="password" id="refine-key" placeholder="sk-..." disabled>
        </label>
      </div>
      <div class="button-bar">
        <button type="button" id="refine-btn" disabled>Second pass</button>
      </div>
    </details>

    <!-- ── Relay ── -->
    <details class="advanced">
      <summary>Relay <span class="sub">— advanced, leave blank</span></summary>
      <p class="hint" id="cors-note">
        Browsers refuse to read a response from a site that does not opt in, and
        arXiv does not opt in (checked 2026-07-28). So the arXiv request is sent
        for you by <a href="https://github.com/jan-a-krzywda/arxave/blob/main/supabase/functions/relay/index.ts">arxave's relay</a>,
        which forwards to <code>arxiv.org</code> and <code>scirate.com</code> and
        nowhere else. It carries a category list and public paper IDs — never
        your topics, your library, or a key. Put your own relay URL here to skip
        arxave's.
      </p>
      <input type="text" id="cors-proxy" placeholder="(blank = arxave relay)">
    </details>

  </form>

  <!-- ── Results ── -->
  <div id="results" style="display:none">
    <h2>The haul</h2>
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

  <!-- ── Small print ── -->
  <div class="cave-footnote" id="small-print">
    <p><strong>Where things go.</strong> Topics, library and keys stay in this
    tab. With in-browser embeddings nothing is billed and nothing is sent; only
    the arXiv fetch leaves, through the relay above.</p>
    <p><strong>What is real today.</strong> Scouting arXiv, embedding abstracts
    and topics in your browser, and ranking on topic match, re-ranked live as you
    move a slider. Everything marked <span class="wip">WIP</span> has no signal
    behind it yet: corpus fit reads titles only, citation overlap needs a
    backend, Scirate answers 403 to non-browser fetches, and the second pass is
    not wired. Those sliders stay dead rather than pretending — ranking
    renormalizes over the signals actually present, so a missing one redistributes
    its weight instead of scoring a paper as worthless.</p>
  </div>
</div>

<link rel="stylesheet" href="{{ '/assets/style.css' | relative_url }}">
<link rel="stylesheet" href="{{ '/assets/filter.css' | relative_url }}">
<script src="{{ '/assets/filter.js' | relative_url }}"></script>