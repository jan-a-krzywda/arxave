---
layout: page
title: Cave
permalink: /cave/
gloss: new
nav_icon: dig
---

<noscript>
  <div class="warn-banner">
    JavaScript is disabled. This page needs it to rank the night. Please enable JavaScript and reload.
  </div>
</noscript>

<!-- The merged Dig + Sieve page. The markup here is the parts that do not move:
     the header band, the box, the three sliders, the tree's containers and the
     results area. The tree rows, the chips and the cards are drawn by
     assets/cave.js from topics.json and tonight's haul; the text in this file is
     what a browser can draw before a byte of JavaScript has run.

     The header SVG is included rather than pointed at with <img> so `.cv-flame`
     can animate — cave-art.mjs says as much, and CSS cannot reach inside an
     <img>. Everything after the layout is one script and two stylesheets. -->
<div class="cv-page" id="cv-app">

  <div class="cv-band">
    {% include_relative assets/cave-art/cave-header.svg %}
  </div>

  <div class="cv-layout">

    <!-- ── left column: what you care about, how much, and which topics ── -->
    <div class="cv-side">

      <p class="cv-lede">
        arXiv drops hundreds of papers a night. Say what you care about, or let
        the topics do it, and this page ranks the whole night against a corpus of
        papers that already mattered.
      </p>

      <label class="cv-field" for="cv-text">
        <span class="cv-label">What do you care about?</span>
        <textarea id="cv-text" class="cv-text" rows="3"
                  placeholder="A phrase, a sentence, or an abstract you liked"></textarea>
      </label>
      <p class="cv-hint">Empty is fine — the topics and the sliders still rank the night.</p>

      <div class="cv-sliders" role="group" aria-label="Ranking sliders">

        <div class="cv-control">
          <div class="cv-control-head">
            <label class="cv-control-name" for="cv-match">Topic match</label>
            <output class="cv-control-val" id="cv-match-val" for="cv-match">50</output>
          </div>
          <input class="cv-slider" type="range" id="cv-match" min="0" max="100" step="1" value="50"
                 aria-valuetext="Topic match: 50 of 100">
          <div class="cv-ends" aria-hidden="true"><span>any topic</span><span>only close matches</span></div>
        </div>

        <div class="cv-control">
          <div class="cv-control-head">
            <label class="cv-control-name" for="cv-surprise">Surprise</label>
            <output class="cv-control-val" id="cv-surprise-val" for="cv-surprise">50</output>
          </div>
          <input class="cv-slider" type="range" id="cv-surprise" min="0" max="100" step="1" value="50"
                 aria-valuetext="Surprise: 50 of 100">
          <div class="cv-ends" aria-hidden="true"><span>proven</span><span>surprising</span></div>
        </div>

        <!-- Hidden by cave.js when axes.json says exp_theory did not ship. -->
        <div class="cv-control" id="cv-exptheory-row">
          <div class="cv-control-head">
            <label class="cv-control-name" for="cv-exptheory">Experiment ↔ Theory</label>
            <output class="cv-control-val" id="cv-exptheory-val" for="cv-exptheory">no preference</output>
          </div>
          <input class="cv-slider" type="range" id="cv-exptheory" min="-100" max="100" step="1" value="0"
                 aria-valuetext="Experiment to theory: no preference">
          <div class="cv-ends" aria-hidden="true"><span>experiment</span><span>theory</span></div>
        </div>

      </div>

      <div class="cv-chipbar">
        <button type="button" class="cv-chip cv-chip--topics" id="cv-topics-btn"
                aria-haspopup="dialog" aria-expanded="false" aria-controls="cv-sheet">Topics</button>
        <button type="button" class="cv-chip" id="cv-ml4q" aria-pressed="false">ML for quantum</button>
        <div class="cv-chips" id="cv-chips"></div>
        <button type="button" class="cv-link" id="cv-clear">Clear filters</button>
      </div>

      <!-- Desktop: a static panel in this column. Phone: the same element as a
           modal bottom sheet, opened by the Topics chip. cave.js decides which,
           because `showModal` is where the focus trap and Esc come from. -->
      <dialog id="cv-sheet" class="cv-sheet" aria-labelledby="cv-sheet-title">
        <div class="cv-sheet-head">
          <h2 class="cv-h3" id="cv-sheet-title">Topics</h2>
          <button type="button" class="cv-link" id="cv-reset-topics">Reset topics</button>
        </div>
        <p class="cv-hint">Equal reads everything · Prefer lifts a topic · Avoid quiets it · Off drops it.</p>
        <div class="cv-tree" id="cv-tree"></div>
        <div class="cv-sheet-actions">
          <button type="button" class="cv-btn cv-btn--ghost" id="cv-sheet-clear">Clear</button>
          <button type="button" class="cv-btn" id="cv-sheet-apply">Apply</button>
        </div>
      </dialog>

    </div>

    <!-- ── right column: the night, ranked ── -->
    <div class="cv-main">
      <p class="cv-status" id="cv-status" role="status" aria-live="polite">Loading the corpus…</p>
      <section class="cv-results" id="cv-results" aria-label="Results"></section>

      <details class="cv-advanced" id="cv-advanced">
        <summary>Refine settings, corpus window, export</summary>
        <div class="cv-advanced-body">
          <label class="cv-field" for="cv-key">
            <span class="cv-label">Key for Refine with AI</span>
            <input type="password" id="cv-key" autocomplete="off" spellcheck="false" placeholder="sk-…">
          </label>
          <p class="cv-hint">Kept in this tab only — never saved, sent to nothing but the refiner.</p>

          <p class="cv-window" id="cv-window">Corpus window —</p>
          <label class="cv-field" for="cv-lookback">
            <span class="cv-label">How far back to dig</span>
            <select id="cv-lookback">
              <option value="1">Tonight</option>
              <option value="2">The last two nights</option>
              <option value="3">The last three nights</option>
            </select>
          </label>

          <button type="button" class="cv-btn cv-btn--ghost" id="cv-export">Export results (JSON)</button>
        </div>
      </details>
    </div>

  </div>
</div>

<!-- ?v=<build time>, for the reason _includes/head.html gives: a browser holding
     the old script against the new markup shows a page styled by rules that no
     longer match its HTML. -->
<link rel="stylesheet" href="{{ '/assets/cave-tokens.css' | relative_url }}?v={{ site.time | date: '%s' }}">
<link rel="stylesheet" href="{{ '/assets/cave.css' | relative_url }}?v={{ site.time | date: '%s' }}">
<!-- Where the corpus lives, handed over by Jekyll rather than guessed in JS: the
     page's permalink is /cave/, so a relative fetch works today and breaks the
     day this site gains a baseurl. -->
<script>
  window.ARXAVE_CORPUS_BASE = "{{ '/assets/corpus/' | relative_url }}";
</script>
<script type="module" src="{{ '/assets/cave.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>

