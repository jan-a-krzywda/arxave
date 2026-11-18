---
layout: page
title: Feeds
permalink: /feeds/
gloss: topics
nav_icon: haul
---

<!-- The list is built from `cave-launch.mjs` by `assets/feeds-page.mjs`, so a
     launch can never be in the table and missing from this room. Nothing below
     is a link list to keep by hand: the intro, a container, and the module. -->

<p class="feeds-intro">Pick a topic. Each one digs tonight's arXiv and ranks it for you.</p>

<div id="feeds-list" class="feeds"></div>

<noscript>
  <div class="feeds-noscript">
    JavaScript is disabled, so this page cannot build its list of topics. The
    <a href="{{ '/' | relative_url }}">Dig</a> still works without it: pick your
    categories there and it ranks the night the same way.
  </div>
</noscript>

<link rel="stylesheet" href="{{ '/assets/feeds.css' | relative_url }}?v={{ site.time | date: '%s' }}">
<script type="module">
  import { mountFeeds } from "{{ '/assets/feeds-page.mjs' | relative_url }}";
  mountFeeds(document.getElementById('feeds-list'));
</script>
