---
layout: page
title: Dig
permalink: /
gloss: new
nav_icon: dig
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
        <span class="dig-step-n">1</span>
        <span class="dig-step-name">Haul the stones</span>
        <span class="dig-step-say">Fetch the night's papers, read them into numbers.</span>
      </li>
      <li>
        <span class="dig-step-n">2</span>
        <span class="dig-step-name">Filter</span>
        <span class="dig-step-say">Say what interests you — words, or papers you like.</span>
      </li>
      <li>
        <span class="dig-step-n">3</span>
        <span class="dig-step-name">Assay</span>
        <span class="dig-step-say">Read the ranked matrix, keep the pay dirt.</span>
      </li>
    </ol>
    <p class="dig-privacy">
      Runs in this tab. Text you want scored is sent to the pick to be embedded,
      and is not stored. <a href="#small-print">Small print</a>.
    </p>
  </header>


  <!-- ── Stage 1: Haul the stones (scout settings live here — they are what
       the haul is about, and nothing else reads them) ── -->
  <fieldset id="stage-1">
    <legend>1. Haul the stones</legend>
    <p class="hint">Fetch tonight's arXiv announcement — new papers and cross-lists, the same set the listing page shows — and read them into numbers. The train below shows how they cluster — one wagon per cluster.</p>

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
      <button type="button" id="haul-btn">🪨 Haul the stones</button>
      <span class="stage-status" id="haul-status"></span>
    </div>
    <!-- The haul's progress is a mine train, not a bar: its length is the
         size of the night's announcement and its load is how far along the
         embedding is. Drawn in filter.js. -->
    <div class="progress-wrap train-wrap" id="haul-progress-wrap" style="display:none">
      <canvas id="haul-train" class="haul-train" aria-hidden="true"></canvas>
      <span class="progress-label" id="haul-label" role="status"></span>
    </div>
    <!-- The train — one wagon per cluster -->
    <div id="wagon-panel" style="display:none">
      <div class="wagon-header">
        <span class="wagon-title">The train</span>
        <span class="wagon-stats" id="wagon-stats"></span>
        <div class="wagon-view-switch" id="wagon-view-switch">
          <button type="button" class="wagon-view-btn is-active" data-view="table">Table</button>
          <button type="button" class="wagon-view-btn" data-view="graph">Graph</button>
          <button type="button" class="wagon-view-btn" data-view="matrix">Matrix</button>
        </div>
        <label class="toggle-label" id="wagon-sort-label">
          <input type="checkbox" id="wagon-sort-toggle" checked> Clustered
        </label>
        <label class="wagon-thresh-label" id="wagon-thresh-label">
          Threshold
          <!-- Range and step are measured, not conventional. Wagons are
               average-linkage groups over centred vectors, so the slider is a
               cut on mean similarity between groups — not an edge weight
               between two papers, and not on the same scale as either of the
               numbers this control carried before. Measured band is 0.35-0.55;
               below 0.25 groups swallow each other, above 0.60 they crumble.
               The range is a little wider than the band so both ends are
               visibly ends. See WAGON_THRESH and buildDendrogram in
               assets/filter.js for the measurements. -->
          <input type="range" id="wagon-thresh-slider" min="0.20" max="0.70" step="0.005" value="0.46">
          <span id="wagon-thresh-value">0.46</span>
        </label>
        <!-- Naming is on a button, not automatic: it calls a metered API, and
             the threshold slider re-forms the wagons on every nudge. Settle
             the threshold, then ask. -->
        <button type="button" class="wagon-name-btn" id="wagon-name-btn"
                title="Ask what each wagon is about, from its titles">Name the wagons</button>
        <button type="button" class="wagon-expand-btn" id="wagon-expand-btn">Expand</button>
      </div>
      <div class="wagon-name-status" id="wagon-name-status" role="status"></div>
      <!-- Train strip: always on, whichever view is selected. Wagon width is
           its share of the haul, so the shape of the night reads at a glance
           and re-forms live as the threshold moves. -->
      <div class="train-strip" id="train-strip"></div>
      <div class="wagon-canvas-wrap" id="wagon-matrix-wrap" style="display:none">
        <canvas id="wagon-canvas"></canvas>
      </div>
      <div class="wagon-graph-wrap" id="wagon-graph-wrap" style="display:none">
        <canvas id="wagon-graph-canvas"></canvas>
        <div class="wagon-graph-hint" id="wagon-graph-hint">drag a stone to move it · drag the rock to pan · scroll to zoom · click to pin, then hover its wagon-mates to compare</div>
      </div>
      <div class="wagon-table-wrap" id="wagon-table-wrap"></div>
      <div class="wagon-readout" id="wagon-readout"></div>
    </div>
  </fieldset>

  <!-- ── Stage 2: Filter ── -->
  <fieldset id="stage-2">
    <legend>2. Filter</legend>
    <p class="hint">What you care about: a word, a phrase, a sentence — or papers you already like.</p>

    <!-- ── Before the dig ───────────────────────────────────────────────────
         This used to be two columns. The left one was "Sharpen the pick": a
         32 MB model download, behind a button, with a progress bar and a
         one-time-only promise, which every visitor paid before their own words
         could be scored — and which a restored claim's core samples sat
         waiting on, reading "waiting for the pick".

         The pick is hosted now. Nothing downloads, nothing parks, and the
         column that existed to explain the wait went with the wait. -->
    <div class="setup-cols">

      <!-- What to dig for. Two groups, because there are two kinds of
           setup — ones this repo publishes and ones you made. -->
      <section class="setup-col" id="setup-claim">
        <!-- Presets: a curated claim, loaded in one click. Their phrases and core
             abstracts are warmed nightly, so a preset costs no embedding — which is
             also why they are offered above your own slots rather than below. -->
        <div id="presets-group" class="setup-group">
          <div class="group-label label-with-action">
            <span>Catalogue <span class="sub">— curated, already cut</span></span>
            <!-- One RSS control for the whole catalogue, not one per preset: the
                 feeds are a list you browse, and a button beside every chip is what
                 broke the row. Hidden until the feed manifest says what exists. -->
            <span class="feeds-wrap" id="preset-feeds" style="display:none">
              <button type="button" id="preset-feeds-btn" class="feeds-btn"
                      aria-haspopup="true" aria-expanded="false">RSS <span aria-hidden="true">▾</span></button>
              <div class="feeds-menu" id="preset-feeds-menu" role="menu" style="display:none"></div>
            </span>
          </div>
          <div id="presets-list" class="preset-buttons"></div>
          <p class="hint" id="presets-hint" style="display:none">
            <span id="presets-blurb" class="preset-blurb-line"></span>
            Replaces the rows below. Edit any row afterwards — an edited phrase is
            yours again, and is cut without being cached, like anything else you type.
          </p>
        </div>

        <div class="setup-group">
          <div class="group-label">Mine <span class="sub">— setups you saved</span></div>
          <div class="claim-bar">
            <label class="claim-pick">
              Claim
              <select id="claim-select"></select>
            </label>
            <!-- Clear empties the setup; Delete removes the slot. Two different
                 things, so two buttons — "start over" must not cost you the named
                 claim. Delete sits in the overflow with the file moves: six equal
                 buttons in one row is what made this bar read as clutter. -->
            <button type="button" id="claim-save-as" class="claim-btn">Save as…</button>
            <button type="button" id="claim-clear" class="claim-btn">Clear</button>
            <details class="claim-more">
              <summary>More</summary>
              <div class="claim-more-menu">
                <button type="button" id="claim-export" class="claim-btn">Export…</button>
                <button type="button" id="claim-import" class="claim-btn">Import…</button>
                <button type="button" id="claim-delete" class="claim-btn claim-btn-danger" disabled>Delete</button>
              </div>
            </details>
            <input type="file" id="claim-import-input" accept=".json,application/json" style="display:none">
          </div>
          <span class="claim-status" id="claim-status"></span>
          <p class="hint claim-hint">
            A claim is one dig setup. Edits save themselves. Clear empties the
            touchstones, cores, and gate — the stones you hauled stay put.
          </p>
        </div>
      </section>
    </div>

    <hr class="group-rule">

    <!-- Touchstones (free text) -->
    <div id="touchstones-group">
      <div class="group-label">Touchstones <span class="sub">— free text, one per row</span></div>
      <div id="touchstones-list"></div>
      <button type="button" id="add-touchstone" class="add-row-btn">+ Add touchstone</button>
    </div>

    <hr class="group-rule">

    <!-- Core samples -->
    <div id="cores-group">
      <div class="group-label">Core samples <span class="sub">— a few reference papers</span></div>
      <p class="hint">A DOI or arXiv ID per row, or upload a <code>.bib</code>. Abstracts come from OpenAlex.</p>
      <div id="cores-list"></div>
      <button type="button" id="add-core" class="add-row-btn">+ Add core sample</button>
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

    <!-- The gate. Pay dirt above is how much of the matrix is highlighted; the
         gate is where a feed draws its bands, and it is on z rather than grade
         because absolute grades are not comparable between days. The counts
         beside it are measured on the night on screen, not estimated.

         THE TWO CONTROLS UP FRONT ARE THE TWO DECISIONS SOMEONE ACTUALLY HAS.
         How much do you want to read, and what should happen on a thin night —
         pad the load with weak stones, or send fewer. Both are answerable
         without knowing what a z is. The z lines are still what does the
         cutting and they are still editable, one fold down, because they are
         the thing that travels in a preset file. -->
    <div class="gate-block" id="gate-block" style="display:none">
      <div class="gate-main">
        <label class="gate-label">
          Carry up
          <input type="range" id="gate-load" min="1" max="25" step="1" value="8">
          <span class="gate-load-value" id="gate-load-value">8 a night</span>
        </label>
        <label class="gate-strict-label">
          <input type="checkbox" id="gate-strict">
          Rather ship fewer than pad with long shots
        </label>
        <span class="gate-readout" id="gate-readout" role="status"></span>
      </div>
      <!-- The three-line pick. Same five numbers as the advanced grid below,
           just handed over as a stance instead of a spreadsheet — someone who
           has never heard of a z-score can still say whether they want only
           the sure things, a middle load, or nothing missed. Clicking one
           writes the five fields below it; typing in those fields is what
           breaks a stance back into numbers, and the pick shows no highlight
           once it no longer matches any of the three. -->
      <div class="gate-presets" role="group" aria-label="Pick a stance">
        <button type="button" class="gate-preset" id="gate-preset-shiny" data-preset="shiny">
          <span class="gate-gem gate-gem-diamond" aria-hidden="true"></span>
          <span class="gate-preset-text">
            <span class="gate-preset-name">Most shiny ones</span>
            <span class="gate-preset-sub">only the sure things — small, hard cut</span>
          </span>
        </button>
        <div class="gate-preset-sep"><span class="gate-gem gate-gem-diamond" aria-hidden="true"></span></div>
        <button type="button" class="gate-preset" id="gate-preset-carry" data-preset="carry">
          <span class="gate-gem gate-gem-gold" aria-hidden="true"></span>
          <span class="gate-preset-text">
            <span class="gate-preset-name">Reasonable carry</span>
            <span class="gate-preset-sub">the default balance</span>
          </span>
        </button>
        <div class="gate-preset-sep"><span class="gate-gem gate-gem-gold" aria-hidden="true"></span></div>
        <button type="button" class="gate-preset" id="gate-preset-any" data-preset="any">
          <span class="gate-gem gate-gem-copper" aria-hidden="true"></span>
          <span class="gate-preset-text">
            <span class="gate-preset-name">Do not miss any</span>
            <span class="gate-preset-sub">loose lines, floor fills the night's load</span>
          </span>
        </button>
      </div>
      <details class="gate-adv">
        <summary>Where the lines fall <span class="sub">— the three bands and the floor</span></summary>
        <p class="hint">
          Every stone gets a <em>z</em>: how far its grade sits above the night's
          median, in MAD units, over the whole announcement. A feed ships
          everything above the <em>ship line</em> and labels it by the
          <em>pay dirt line</em> — <strong>Pay dirt</strong> above, <strong>Worth
          a look</strong> between the two, <strong>Long shot</strong> below. The
          bar is low on purpose and the chip is what makes that honest: an
          unmarked z-1.2 paper claims to be a z-3 one, a labelled one does not,
          and a feed nobody can skim is a feed nobody opens. The floor is the
          escape hatch: if fewer than <em>floor</em> stones reach the ship line,
          it reaches down to <em>long shot z</em> and ships that many — never
          past the ceiling.
        </p>
        <div class="role-grid gate-grid">
          <label>
            Pay dirt line <span class="sub">min z</span>
            <input type="number" id="gate-z" value="2" min="0" max="4" step="0.1">
          </label>
          <label>
            Ceiling <span class="sub">max items — the slider above</span>
            <input type="number" id="gate-max-items" value="8" min="1" max="50">
          </label>
          <label>
            Floor <span class="sub">min items — 0 when shipping fewer</span>
            <input type="number" id="gate-min-items" value="3" min="0" max="50">
          </label>
          <label>
            Ship line <span class="sub">soft z</span>
            <input type="number" id="gate-soft-z" value="1.5" min="0" max="4" step="0.1">
          </label>
          <label>
            Long shot z <span class="sub">how far the floor reaches</span>
            <input type="number" id="gate-long-z" value="0.5" min="0" max="4" step="0.1">
          </label>
        </div>
        <p class="hint">
          These five numbers are the <code>select</code> block of a preset file —
          export this claim and they travel with it, so a feed built from it cuts
          and bands where you set it here. The two controls above write two of
          them: the slider is the ceiling, and the tick-box is the floor going to
          zero. Pull <em>long shot z</em> up to the ship line to switch the floor
          off that way instead.
        </p>
      </details>
    </div>

    <!-- The report. The feed is what arrives unasked; this is what you ask for
         once you have moved the weights, and it says which of the two produced
         each paper — a band is the assay's confidence, hand-picked is yours. -->
    <div class="report-bar" id="report-bar" style="display:none">
      <label class="report-source">
        Report on
        <select id="report-source">
          <option value="gate">what the feed would ship</option>
          <option value="paydirt">the pay dirt cut (top N)</option>
          <option value="picked">hand-picked only</option>
        </select>
      </label>
      <!-- A whole page of papers is not a panel wedged under a slider: it opens
           in its own tab, self-contained, so it can be read beside the Dig,
           saved with ⌘S, or printed. Copy stays here, where the clipboard
           works without a permission prompt from a blob-origin page. -->
      <button type="button" id="report-btn" class="report-btn">Prepare report ↗</button>
      <button type="button" id="report-copy" class="claim-btn">Copy as Markdown</button>
      <span class="report-note" id="report-note"></span>
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
    <!-- The ends are the ramp domains, not 0..1: a centred cosine tops out
         well below 1, and labelling the bar 0..1 would say the brightest cell
         on the page was a perfect match when it was about 0.55. See ORE_MAX
         in assets/filter.js. The grade ends are filled in per render — that
         ramp measures the night it is drawing (lampDomain there) — so the
         numbers below are only a placeholder until the first assay. -->
    <div class="assay-legends" id="assay-legends">
      <div class="scale-legend" id="ore-legend">
        <span class="legend-label">Feature cells</span>
        <div class="scale-bar ore-scale"></div>
        <span class="legend-end">0</span>
        <span class="legend-end">0.55</span>
      </div>
      <div class="scale-legend" id="lamp-legend">
        <span class="legend-label">Grade</span>
        <div class="scale-bar lamp-scale"></div>
        <span class="legend-end" id="lamp-legend-lo">0</span>
        <span class="legend-end" id="lamp-legend-hi">0.45</span>
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

  <!-- Train graph tooltip — shared by the inline and modal graphs -->
  <div id="wagon-tooltip" class="cell-tooltip wagon-tooltip" style="display:none" role="tooltip"></div>

  <!-- Train strip tooltip — its own, so it never fights the graph's pin -->
  <div id="train-strip-tip" class="cell-tooltip wagon-tooltip" style="display:none" role="tooltip"></div>

  <!-- ── Train modal ── -->
  <div id="wagon-modal" class="wagon-modal" style="display:none">
    <div class="wagon-modal-backdrop" id="wagon-modal-backdrop"></div>
    <div class="wagon-modal-content">
      <div class="wagon-modal-header">
        <span class="wagon-title" id="wagon-modal-header-title">Coupling map</span>
        <button type="button" class="wagon-modal-close" id="wagon-modal-close">×</button>
      </div>
      <canvas id="wagon-modal-canvas"></canvas>
      <canvas id="wagon-modal-graph-canvas" style="display:none"></canvas>
      <div class="wagon-modal-readout" id="wagon-modal-readout"></div>
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
    <p><strong>Where things go.</strong> Touchstones, core samples and weights are stored only in this tab — they are never uploaded, and they survive a reload because they sit in your browser, not on a server.</p>
    <p><strong>What is sent, and what is kept.</strong> The pick — the model that turns text into a vector — runs on a server rather than in your browser, so any text you want scored is sent there to be embedded. It is used for that request and not stored. Published text (arXiv abstracts, core-sample abstracts, and the touchstones this repo ships as presets) additionally goes into a <em>shared vector cache</em>, keyed by a hash of the text, so nobody has to pay for the same cut twice. <strong>A touchstone you typed yourself never enters that cache</strong> — reads on it are public, and a hash of a short phrase is one dictionary away from the phrase. Earlier versions of this page embedded in the browser and promised that nothing you typed left the tab; that is no longer how it works, and this paragraph replaces that promise.</p>
    <p><strong>Touchstone length.</strong> A one-word touchstone and a paragraph-long one are not directly comparable — longer text is more specific. The per-row weights in the assay are the mitigation.</p>
    <p><strong>What is real today.</strong> Scouting arXiv, embedding abstracts through the hosted pick (staged, with the train as intermediate output), and ranking on touchstone similarity with live re-blending. The rush (Scirate) is parked behind a Cloudflare challenge and stays inactive until a path exists.</p>
  </div>
</div>

<!-- ?v=<build time> on every asset below. Without it a browser keeps serving
     the filter.js it cached on an earlier visit, so a deploy appears to change
     nothing and the page quietly runs old code against new markup. -->
<link rel="stylesheet" href="{{ '/assets/style.css' | relative_url }}?v={{ site.time | date: '%s' }}">
<link rel="stylesheet" href="{{ '/assets/filter.css' | relative_url }}?v={{ site.time | date: '%s' }}">
<!-- Where the preset claims live. Handed over by Jekyll rather than guessed in
     JS: the page's permalink is `/`, so a relative fetch works today and breaks
     the day this site gains a baseurl or moves under a path. -->
<script>
  window.ARXAVE_PRESETS_BASE = "{{ '/presets/' | relative_url }}";
  window.ARXAVE_FEEDS_BASE = "{{ '/feeds/' | relative_url }}";
</script>
<script src="{{ '/assets/filter.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>