---
layout: page
title: Dig
permalink: /
---

<noscript>
  <div class="warn-banner">
    JavaScript is disabled. This page needs it to run the filter. Please enable JavaScript and reload.
  </div>
</noscript>

<div class="cave-wall cave-wall-left" aria-hidden="true"></div>
<div class="cave-wall cave-wall-right" aria-hidden="true"></div>

<div id="app" style="display:none">

  <!-- ── Masthead: what this page is, before anything else ── -->
  <header class="dig-hero">
    <h1 class="dig-title">The Dig</h1>
    <p class="dig-lede">
      arXiv drops hundreds of papers every night. Tell this page what you care
      about, and it scores the whole night against it and hands back the few
      worth a careful look.
    </p>
    <ol class="dig-steps">
      <li>
        <span class="dig-step-n">0</span>
        <span class="dig-step-name">Sharpen the pick</span>
        <span class="dig-step-say">Load the scoring model — 32 MB, once.</span>
      </li>
      <li>
        <span class="dig-step-n">1</span>
        <span class="dig-step-name">Haul the stones</span>
        <span class="dig-step-say">Fetch the night's papers, read them into numbers.</span>
      </li>
      <li>
        <span class="dig-step-n">2</span>
        <span class="dig-step-name">Set the touchstones</span>
        <span class="dig-step-say">Say what interests you — words, or papers you like.</span>
      </li>
      <li>
        <span class="dig-step-n">3</span>
        <span class="dig-step-name">Assay</span>
        <span class="dig-step-say">Read the ranked matrix, keep the pay dirt.</span>
      </li>
    </ol>
    <p class="dig-privacy">
      Everything runs in this tab — nothing about your topics leaves it.
      <a href="#small-print">Small print</a>.
    </p>
  </header>

  <!-- ── Claim bar ── -->
  <div class="claim-bar">
    <label class="claim-pick">
      Claim
      <select id="claim-select"></select>
    </label>
    <button type="button" id="claim-save-as" class="claim-btn">Save as…</button>
    <button type="button" id="claim-delete" class="claim-btn claim-btn-danger" disabled>Delete</button>
    <button type="button" id="claim-export" class="claim-btn">Export…</button>
    <button type="button" id="claim-import" class="claim-btn">Import…</button>
    <input type="file" id="claim-import-input" accept=".json,application/json" style="display:none">
    <span class="claim-status" id="claim-status"></span>
  </div>
  <p class="hint claim-hint">
    A claim is one dig setup. Edits save themselves.
  </p>

  <!-- ── Stage 0: Sharpen the pick ── -->
  <fieldset id="stage-0">
    <legend>0. Sharpen the pick</legend>
    <p class="hint">~32 MB, downloaded once, then cached by your browser. Nothing you type leaves this tab.</p>
    <div class="button-bar">
      <button type="button" id="sharpen-btn">⛏ Sharpen the pick</button>
      <span class="stage-status" id="sharpen-status"></span>
    </div>
    <div class="progress-wrap" id="sharpen-progress-wrap" style="display:none">
      <progress id="sharpen-progress" value="0" max="100"></progress>
      <span class="progress-label" id="sharpen-label"></span>
    </div>
    <div class="stage-done" id="sharpen-done" style="display:none">
      Pick sharpened — <code>bge-small-en-v1.5</code>, 384-dim
    </div>
  </fieldset>

  <!-- ── Stage 1: Haul the stones (scout settings live here — they are what
       the haul is about, and nothing else reads them) ── -->
  <fieldset id="stage-1">
    <legend>1. Haul the stones</legend>
    <p class="hint">Fetch tonight's arXiv announcement — new papers and cross-lists, the same set the listing page shows — and read them into numbers. The seam map below shows how they cluster.</p>

    <div class="scout-block">
      <div class="cat-field">
        <span class="field-label">arXiv categories</span>
        <div class="cat-chips" id="cat-chips"></div>
        <select id="cat-add" class="cat-add"></select>
        <!-- Source of truth stays this field: the picker writes into it, and
             claim save/restore keeps reading it. -->
        <input type="hidden" id="categories" value="cond-mat.mes-hall, quant-ph">
      </div>
      <div class="role-grid scout-grid">
        <label>
          Lookback (days)
          <input type="number" id="lookback" value="1" min="1" max="7">
        </label>
        <label>
          Max results
          <input type="number" id="max-results" value="200" min="10" max="1000">
        </label>
      </div>
    </div>

    <div class="button-bar">
      <button type="button" id="haul-btn" disabled>🪨 Haul the stones</button>
      <span class="stage-status" id="haul-status"></span>
    </div>
    <div class="progress-wrap" id="haul-progress-wrap" style="display:none">
      <progress id="haul-progress" value="0" max="100"></progress>
      <span class="progress-label" id="haul-label"></span>
    </div>
    <!-- Seam map panel -->
    <div id="seam-panel" style="display:none">
      <div class="seam-header">
        <span class="seam-title">Seam map</span>
        <span class="seam-stats" id="seam-stats"></span>
        <div class="seam-view-switch" id="seam-view-switch">
          <button type="button" class="seam-view-btn is-active" data-view="table">Table</button>
          <button type="button" class="seam-view-btn" data-view="graph">Graph</button>
          <button type="button" class="seam-view-btn" data-view="matrix">Matrix</button>
        </div>
        <label class="toggle-label" id="seam-sort-label">
          <input type="checkbox" id="seam-sort-toggle" checked> Clustered
        </label>
        <label class="seam-thresh-label" id="seam-thresh-label">
          Threshold
          <input type="range" id="seam-thresh-slider" min="0.5" max="0.95" step="0.01" value="0.75">
          <span id="seam-thresh-value">0.75</span>
        </label>
        <button type="button" class="seam-expand-btn" id="seam-expand-btn">Expand</button>
      </div>
      <div class="seam-canvas-wrap" id="seam-matrix-wrap" style="display:none">
        <canvas id="seam-canvas"></canvas>
      </div>
      <div class="seam-graph-wrap" id="seam-graph-wrap" style="display:none">
        <canvas id="seam-graph-canvas"></canvas>
        <div class="seam-graph-hint" id="seam-graph-hint">drag a stone to move it · drag the rock to pan · scroll to zoom · click to pin, then hover its seam-mates to compare</div>
      </div>
      <div class="seam-table-wrap" id="seam-table-wrap"></div>
      <div class="seam-readout" id="seam-readout"></div>
    </div>
  </fieldset>

  <!-- ── Stage 2: Set the touchstones ── -->
  <fieldset id="stage-2">
    <legend>2. Set the touchstones</legend>
    <p class="hint">What you care about: a word, a phrase, a sentence — or papers you already like.</p>

    <!-- Touchstones (free text) -->
    <div id="touchstones-group">
      <div class="group-label">Touchstones <span class="sub">— free text, one per row</span></div>
      <div id="touchstones-list"></div>
      <button type="button" id="add-touchstone" class="add-row-btn" disabled>+ Add touchstone</button>
    </div>

    <hr class="group-rule">

    <!-- Core samples -->
    <div id="cores-group">
      <div class="group-label">Core samples <span class="sub">— a few reference papers</span></div>
      <p class="hint">A DOI or arXiv ID per row, or upload a <code>.bib</code>. Abstracts come from OpenAlex.</p>
      <div id="cores-list"></div>
      <button type="button" id="add-core" class="add-row-btn" disabled>+ Add core sample</button>
      <label class="bib-upload" style="margin-top: 0.4rem; display: block;">
        <input type="file" id="bib-file" accept=".bib" style="display:none">
        <span class="add-row-btn" style="display:inline-block; cursor:pointer" onclick="document.getElementById('bib-file').click()">Upload .bib (select entries)</span>
      </label>
      <div id="bib-status" class="hint" style="margin-top:0.25rem; display:none"></div>
    </div>

    <hr class="group-rule">

    <!-- The rush (Scirate, inactive) -->
    <div id="rush-group" class="inactive-group">
      <div class="group-label">The rush <span class="wip">WIP</span> <span class="sub">— crowd attention, Scirate scites</span></div>
      <div class="rush-row">
        <span class="rush-name">Scirate scites</span>
        <span class="rush-unavailable">signal unavailable</span>
        <span class="rush-weight">—</span>
      </div>
    </div>
  </fieldset>

  <!-- ── Stage 3: Assay ── -->
  <fieldset id="stage-3">
    <legend>3. Assay</legend>
    <div class="assay-header">
      <div class="assay-stats" id="assay-stats"></div>
      <div class="assay-controls">
        <label>Pay dirt <input type="number" id="paydirt-n" value="10" min="1" max="50"></label>
        <label class="toggle-label">
          <input type="checkbox" id="table-view-toggle"> Table view
        </label>
      </div>
    </div>

    <!-- Matrix view -->
    <div id="assay-matrix-wrap">
      <div class="assay-rail" id="assay-rail"></div>
      <div class="assay-scroll">
        <div id="assay-column-titles"></div>
        <div class="assay-grid" id="assay-grid"></div>
      </div>
    </div>

    <!-- Legend -->
    <div class="assay-legends" id="assay-legends">
      <div class="scale-legend" id="ore-legend">
        <span class="legend-label">Feature cells</span>
        <div class="scale-bar ore-scale"></div>
        <span class="legend-end">0</span>
        <span class="legend-end">1</span>
      </div>
      <div class="scale-legend" id="lamp-legend">
        <span class="legend-label">Grade</span>
        <div class="scale-bar lamp-scale"></div>
        <span class="legend-end">0</span>
        <span class="legend-end">1</span>
      </div>
    </div>

    <!-- Table view (hidden by default) -->
    <div id="assay-table-wrap" style="display:none">
      <div class="table-wrap">
        <table id="assay-table">
          <thead id="assay-table-head"></thead>
          <tbody id="assay-table-body"></tbody>
        </table>
      </div>
    </div>

    <!-- Tooltip -->
    <div id="cell-tooltip" class="cell-tooltip" style="display:none" role="tooltip"></div>
  </fieldset>

  <!-- Seam graph tooltip — shared by the inline and modal graphs -->
  <div id="seam-tooltip" class="cell-tooltip seam-tooltip" style="display:none" role="tooltip"></div>

  <!-- ── Seam map modal ── -->
  <div id="seam-modal" class="seam-modal" style="display:none">
    <div class="seam-modal-backdrop" id="seam-modal-backdrop"></div>
    <div class="seam-modal-content">
      <div class="seam-modal-header">
        <span class="seam-title" id="seam-modal-header-title">Seam map</span>
        <button type="button" class="seam-modal-close" id="seam-modal-close">×</button>
      </div>
      <canvas id="seam-modal-canvas"></canvas>
      <canvas id="seam-modal-graph-canvas" style="display:none"></canvas>
      <div class="seam-modal-readout" id="seam-modal-readout"></div>
    </div>
  </div>

  <!-- ── Relay ── -->
  <details class="advanced">
    <summary>Relay <span class="sub">— advanced, leave blank</span></summary>
    <p class="hint">
      Browsers refuse to read a response from a site that does not opt in, and
      arXiv does not opt in. So the arXiv request is sent for you by
      <a href="https://github.com/jan-a-krzywda/arxave/blob/main/supabase/functions/relay/index.ts">arxave's relay</a>.
      It carries a category list and public paper IDs — never your topics,
      your library, or a key.
    </p>
    <input type="text" id="cors-proxy" placeholder="(blank = arxave relay)">
  </details>

  <!-- ── Small print ── -->
  <div class="cave-footnote" id="small-print">
    <p><strong>Where things go.</strong> Touchstones, core samples, and weights stay in this tab. With in-browser embeddings nothing is billed and nothing is sent; only the arXiv fetch leaves, through the relay above.</p>
    <p><strong>Touchstone length.</strong> A one-word touchstone and a paragraph-long one are not directly comparable — longer text is more specific. The per-row weights in the assay are the mitigation.</p>
    <p><strong>What is real today.</strong> Scouting arXiv, embedding abstracts in your browser (staged, with the seam map as intermediate output), and ranking on touchstone similarity with live re-blending. The rush (Scirate) is parked behind a Cloudflare challenge and stays inactive until a path exists.</p>
  </div>
</div>

<link rel="stylesheet" href="{{ '/assets/style.css' | relative_url }}">
<link rel="stylesheet" href="{{ '/assets/filter.css' | relative_url }}">
<script src="{{ '/assets/filter.js' | relative_url }}"></script>