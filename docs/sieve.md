---
layout: page
title: Sieve
permalink: /sieve/
gloss: new
nav_wip: true
nav_icon: dig
---

<noscript>
  <div class="warn-banner">
    JavaScript is disabled. This page needs it to rank the night. Please enable JavaScript and reload.
  </div>
</noscript>

<!-- Above the fold: one sentence, one box, the six biggest topics, two sliders,
     one button. Everything else is folded away, because the rest of the page is
     settings and the page is one decision. Sliders and results are drawn by
     assets/sieve.js; the text here is the parts that do not move. -->
<div class="sv-app" id="sv-app">

  <p class="sv-lede">
    arXiv drops hundreds of papers a night. Say what you care about, and this
    page ranks the whole night against a corpus of papers that already mattered.
  </p>

  <label class="sv-field" for="sv-touch">
    <span class="sv-label">What do you care about?</span>
    <textarea id="sv-touch" class="sv-touch" rows="3"
              placeholder="A phrase, a sentence, or an abstract you liked"></textarea>
  </label>

  <div class="sv-topics" id="sv-topics" role="group" aria-label="Topics"></div>

  <div class="sv-sliders">
    <label class="sv-slider" for="sv-gate">
      <span class="sv-slider-name">Strictness</span>
      <span class="sv-slider-val" id="sv-gate-val">1.0</span>
      <input type="range" id="sv-gate" min="0" max="3" step="0.1" value="1">
      <span class="sv-ends" aria-hidden="true"><span>only close matches</span><span>cast a wide net</span></span>
    </label>
    <label class="sv-slider" for="sv-surprise">
      <span class="sv-slider-name">Surprise</span>
      <span class="sv-slider-val" id="sv-surprise-val">0.40</span>
      <input type="range" id="sv-surprise" min="0" max="1" step="0.05" value="0.4">
      <span class="sv-ends" aria-hidden="true"><span>proven</span><span>surprising</span></span>
    </label>
  </div>

  <button type="button" id="sv-dig" class="sv-dig">Dig</button>
  <p class="sv-status" id="sv-status" role="status" aria-live="polite">Loading the corpus…</p>

  <details class="sv-more">
    <summary>More topics</summary>
    <div class="sv-more-body" id="sv-topics-more"></div>
  </details>

  <details class="sv-more">
    <summary>More touchstones</summary>
    <div class="sv-more-body">
      <p class="sv-hint">Each one is embedded and matched instead of the topic sliders.</p>
      <div id="sv-touch-rows"></div>
      <button type="button" id="sv-add-touch" class="sv-add">+ Add a touchstone</button>
    </div>
  </details>

  <details class="sv-more">
    <summary>Categories and date</summary>
    <div class="sv-more-body">
      <div class="sv-chips" id="sv-cats"></div>
      <div class="sv-row2">
        <label class="sv-field" for="sv-cat-add">
          <span class="sv-label">Add a category</span>
          <select id="sv-cat-add" class="sv-cat-add"></select>
        </label>
        <label class="sv-field" for="sv-lookback">
          <span class="sv-label">Lookback (days)</span>
          <input type="number" id="sv-lookback" min="1" max="7" value="1">
        </label>
      </div>
    </div>
  </details>

  <details class="sv-more">
    <summary>Use my own API key</summary>
    <div class="sv-more-body">
      <label class="sv-field" for="sv-key">
        <span class="sv-label">Key for Refine with AI</span>
        <input type="password" id="sv-key" autocomplete="off" spellcheck="false" placeholder="sk-…">
      </label>
      <p class="sv-key-note">
        Kept in this tab only — never saved, and sent to nothing but the refiner.
      </p>
    </div>
  </details>

  <details class="sv-more">
    <summary>How this works</summary>
    <div class="sv-more-body">
      <ul class="sv-how">
        <li>The corpus is a fixed window of recent arXiv papers, embedded and grouped into topics.</li>
        <li>Fit is how close a paper sits to your words, or to the topics you weighted.</li>
        <li>Impact is how well cited its nearest proven papers turned out to be.</li>
        <li>Surprise trades that against how unlike anything proven it is.</li>
        <li>Strictness is the fit a paper must clear to be listed at all.</li>
        <li>Your words are embedded, not stored; no account, no key.</li>
      </ul>
    </div>
  </details>

  <section class="sv-results" id="sv-results" aria-label="Results"></section>
</div>

<!-- ?v=<build time>, for the reason _includes/head.html gives: a browser that
     holds the old script against new markup shows a page styled by rules that no
     longer match its HTML. -->
<link rel="stylesheet" href="{{ '/assets/style.css' | relative_url }}?v={{ site.time | date: '%s' }}">
<link rel="stylesheet" href="{{ '/assets/sieve.css' | relative_url }}?v={{ site.time | date: '%s' }}">
<!-- Where the corpus lives, handed over by Jekyll rather than guessed in JS: the
     page's permalink is /sieve/, so a relative fetch works today and breaks the
     day this site gains a baseurl. -->
<script>
  window.ARXAVE_CORPUS_BASE = "{{ '/assets/corpus/' | relative_url }}";
</script>
<script type="module" src="{{ '/assets/sieve.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
