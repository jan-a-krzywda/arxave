---
layout: page
title: Dig
permalink: /
gloss: new
nav_icon: dig
---

<noscript>
  <div class="warn-banner">
    JavaScript is disabled. This page needs it to dig tonight's arXiv. Please enable JavaScript and reload.
  </div>
</noscript>

<!-- The staged Cave: eight cards top to bottom, one rail, one side wall per
     gutter. The markup here is the part that does not move — the hero, the
     rail's container, one section per stage with its head and body, and the
     notice line. `assets/cave.js` draws the rail inside #cave-rail, mounts
     each stage's module into its body, and classes the sections done / open /
     locked. Stage modules own everything inside their own body. -->

<div id="cave-app">

  <div class="cave-wall cave-wall-left" aria-hidden="true"></div>
  <div class="cave-wall cave-wall-right" aria-hidden="true"></div>

  <header class="cave-hero">
    <p class="cave-lede">
      arXiv drops hundreds of papers a night. Dig tonight's announcement, watch
      the haul train fill, then read the night as wagons — and keep what is
      worth reading.
    </p>
    <p class="cave-sub">Eight stages, top to bottom. Each opens once the one before it is done.</p>
  </header>

  <nav class="cave-rail" id="cave-rail" aria-label="Tonight's stages"></nav>

  <div class="cave-stages">

    <section class="cave-stage" id="stage-dig" data-stage="dig">
      <button type="button" class="cave-stage-head" aria-expanded="true">
        <span class="cave-stage-n">1</span><span class="cave-stage-name">Dig</span>
        <span class="cave-stage-summary"></span>
      </button>
      <div class="cave-stage-body"></div>
    </section>

    <section class="cave-stage" id="stage-train" data-stage="train">
      <button type="button" class="cave-stage-head" aria-expanded="false">
        <span class="cave-stage-n">2</span><span class="cave-stage-name">Train</span>
        <span class="cave-stage-summary"></span>
      </button>
      <div class="cave-stage-body"></div>
    </section>

    <section class="cave-stage" id="stage-map" data-stage="map">
      <button type="button" class="cave-stage-head" aria-expanded="false">
        <span class="cave-stage-n">3</span><span class="cave-stage-name">Map</span>
        <span class="cave-stage-summary"></span>
      </button>
      <div class="cave-stage-body"></div>
    </section>

    <section class="cave-stage" id="stage-fire" data-stage="fire">
      <button type="button" class="cave-stage-head" aria-expanded="false">
        <span class="cave-stage-n">4</span><span class="cave-stage-name">Enter the cave</span>
        <span class="cave-stage-summary"></span>
      </button>
      <div class="cave-stage-body"></div>
    </section>

    <section class="cave-stage" id="stage-priorities" data-stage="priorities">
      <button type="button" class="cave-stage-head" aria-expanded="false">
        <span class="cave-stage-n">5</span><span class="cave-stage-name">Priorities</span>
        <span class="cave-stage-summary"></span>
      </button>
      <div class="cave-stage-body"></div>
    </section>

    <section class="cave-stage" id="stage-ranking" data-stage="ranking">
      <button type="button" class="cave-stage-head" aria-expanded="false">
        <span class="cave-stage-n">6</span><span class="cave-stage-name">Ranking</span>
        <span class="cave-stage-summary"></span>
      </button>
      <div class="cave-stage-body"></div>
    </section>

    <section class="cave-stage" id="stage-act" data-stage="act">
      <button type="button" class="cave-stage-head" aria-expanded="false">
        <span class="cave-stage-n">7</span><span class="cave-stage-name">Act</span>
        <span class="cave-stage-summary"></span>
      </button>
      <div class="cave-stage-body"></div>
    </section>

    <section class="cave-stage" id="stage-story" data-stage="story">
      <button type="button" class="cave-stage-head" aria-expanded="false">
        <span class="cave-stage-n">8</span><span class="cave-stage-name">Story</span>
        <span class="cave-stage-summary"></span>
      </button>
      <div class="cave-stage-body"></div>
    </section>

  </div>

  <p class="cave-notice" id="cave-notice" role="status" hidden></p>

</div>

<!-- ?v=<build time>, for the reason _includes/head.html gives: a browser holding
     the old script against the new markup shows a page styled by rules that no
     longer match its HTML. style.css and filter.css come along because the
     stages reuse Dig's components (the chips, the train, the wagon table). -->
<link rel="stylesheet" href="{{ '/assets/style.css' | relative_url }}?v={{ site.time | date: '%s' }}">
<link rel="stylesheet" href="{{ '/assets/filter.css' | relative_url }}?v={{ site.time | date: '%s' }}">
<link rel="stylesheet" href="{{ '/assets/cave.css' | relative_url }}?v={{ site.time | date: '%s' }}">
<!-- Where the corpus lives, and which repo the Discussions threads hang on.
     Handed over by Jekyll rather than guessed in JS: the page's permalink is
     /cave/, so a relative fetch works today and breaks the day this site gains
     a baseurl. `site.discussions_repo` is unset everywhere today, so the
     `default` filter is what fills it. -->
<script>
  window.ARXAVE_CORPUS_BASE = "{{ '/assets/corpus/' | relative_url }}";
  window.ARXAVE_DISCUSSIONS_REPO = "{{ site.discussions_repo | default: site.github_repo }}";
</script>
<script type="module" src="{{ '/assets/cave.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
