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

<!-- The staged Cave: seven cards top to bottom, one rail, one side wall per
     gutter. The markup here is the part that does not move — the hero, the
     rail's container, one section per stage with its head and body, and the
     notice line. `assets/cave.js` draws the rail inside #cave-rail, mounts
     each stage's module into its body, and classes the sections done / open /
     locked. Stage modules own everything inside their own body. -->

<!-- The walls are #cave-app's siblings, as on the old Dig — not its children.
     Positioned against .page-content they land in the page gutters, outside the
     content box; inside the wrapper they were sized against it and painted over
     the rail and the cards. `cave-wall-dig` is the hook that lets cave.css widen
     them and narrow the centre for this page alone. -->
<div class="cave-wall cave-wall-left cave-wall-dig" aria-hidden="true"></div>
<div class="cave-wall cave-wall-right cave-wall-dig" aria-hidden="true"></div>

<div id="cave-app">

  <header class="cave-hero">
    <p class="cave-lede">
      arXiv drops hundreds of papers a night. Dig tonight's announcement, watch
      the haul train fill, then read the night as wagons — and keep what is
      worth reading.
    </p>
    <p class="cave-sub">Seven stages, top to bottom. Each opens once the one before it is done.</p>
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

    <section class="cave-stage" id="stage-priorities" data-stage="priorities">
      <button type="button" class="cave-stage-head" aria-expanded="false">
        <span class="cave-stage-n">4</span><span class="cave-stage-name">Priorities</span>
        <span class="cave-stage-summary"></span>
      </button>
      <div class="cave-stage-body"></div>
    </section>

    <section class="cave-stage" id="stage-ranking" data-stage="ranking">
      <button type="button" class="cave-stage-head" aria-expanded="false">
        <span class="cave-stage-n">5</span><span class="cave-stage-name">Ranking</span>
        <span class="cave-stage-summary"></span>
      </button>
      <div class="cave-stage-body"></div>
    </section>

    <section class="cave-stage" id="stage-act" data-stage="act">
      <button type="button" class="cave-stage-head" aria-expanded="false">
        <span class="cave-stage-n">6</span><span class="cave-stage-name">Act</span>
        <span class="cave-stage-summary"></span>
      </button>
      <div class="cave-stage-body"></div>
    </section>

    <section class="cave-stage" id="stage-story" data-stage="story">
      <button type="button" class="cave-stage-head" aria-expanded="false">
        <span class="cave-stage-n">7</span><span class="cave-stage-name">Story</span>
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
<!-- The same ?v= for every module cave.js pulls in. Without it the browser
     keeps a stale cave-flow.mjs or stage module for up to ten minutes after a
     deploy, and the new shell runs against the old flow (a stage list that no
     longer matches the page). The map must come before the first module. -->
<script type="importmap">
{ "imports": {
{%- for f in site.static_files -%}{%- if f.extname == '.mjs' and f.path contains '/assets/' %}
  "{{ f.path | relative_url }}": "{{ f.path | relative_url }}?v={{ site.time | date: '%s' }}",
{%- endif -%}{%- endfor %}
  "{{ '/assets/cave.js' | relative_url }}": "{{ '/assets/cave.js' | relative_url }}?v={{ site.time | date: '%s' }}"
} }
</script>
<script type="module" src="{{ '/assets/cave.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
