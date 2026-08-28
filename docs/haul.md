---
layout: page
title: Haul
permalink: /haul/
gloss: today
nav_icon: haul
---

<div class="cave-wall cave-wall-left cave-wall-haul" aria-hidden="true"></div>
<div class="cave-wall cave-wall-right cave-wall-haul" aria-hidden="true"></div>

<div class="status-banner">
  <strong>Tonight's haul, split by seam.</strong> Point a reader at one and it
  drops the night's pay dirt on your desk each morning — no fetch, no setup, just
  the papers that matched, ranked by grade.
</div>

<div id="seams-catalogue" style="display:none">
  <div class="seams-intro">
    <p>
      Below is every seam that this Dig feeds. Take as many as you want. The
      count beside each is tonight's haul, split by band so you can see what a
      thin morning looks like before you add it.
    </p>
  </div>

  <div id="seams-list" class="seams-list"></div>

  <p class="seams-note">
    Each seam is a preset — a claim about what matters in its tunnel. The
    <a href="{{ '/' | relative_url }}">Dig</a> lets you tune the weights and
    move the gate, and feeds built from it will cut and band where you set it.
    A seam link here is the preset's own default.
  </p>
</div>

<noscript>
  <div class="warn-banner">
    JavaScript is disabled. This page builds the seam list from the feed
    manifest. Please enable JavaScript to see the seams.
  </div>
</noscript>

<script>
(function() {
  const feedsBase = (window.ARXAVE_FEEDS_BASE || '/feeds/');
  const digestPath = feedsBase + 'index.json';
  
  fetch(digestPath)
    .then(r => {
      if (!r.ok) throw new Error('Feed manifest: ' + r.status);
      return r.json();
    })
    .then(manifest => {
      const catalogue = document.getElementById('seams-catalogue');
      if (!catalogue) return;
      catalogue.style.display = '';
      
      const list = document.getElementById('seams-list');
      if (!list) return;
      
      for (const slug in (manifest.feeds || {})) {
        const feed = manifest.feeds[slug];
        const item = document.createElement('div');
        item.className = 'seam-card';
        
        const bandCounts = [];
        if (feed.paydirt) bandCounts.push(feed.paydirt + ' pay dirt');
        const look = (feed.items || 0) - (feed.paydirt || 0);
        if (look > 0) bandCounts.push(look + ' worth a look');
        const counts = bandCounts.join(' · ') || feed.items + ' long shots';
        
        item.innerHTML = 
          '<div class="seam-head">' +
          '  <h2><a href="{{ "/" | relative_url }}?preset=' + encodeURIComponent(slug) + '">' + 
          (feed.name || slug) + '</a></h2>' +
          '  <span class="seam-counts">' + feed.items + ' tonight · ' + counts + '</span>' +
          '</div>' +
          '<div class="seam-feed">' +
          '  <a class="seam-link" href="' + feedsBase + slug + '.xml">' +
          '    📡 Take the feed' +
          '  </a>' +
          '</div>';
        list.appendChild(item);
      }
    })
    .catch(err => {
      const catalogue = document.getElementById('seams-catalogue');
      if (catalogue) {
        catalogue.innerHTML = '<div class="warn-banner">Could not load feeds: ' + err.message + '</div>';
        catalogue.style.display = '';
      }
    });
})();
</script>

<style>
#seams-catalogue { margin-top: 1.5rem; }
.seams-intro { margin-bottom: 1.8rem; }
.seams-intro p { margin: 0; }

.seams-list {
  display: grid;
  gap: 0.8rem;
  margin-bottom: 2rem;
}

.seam-card {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 1rem;
  padding: 0.7rem 0.9rem;
  background: var(--rock);
  border: 1px solid var(--rock-edge);
  border-radius: 6px;
}

.seam-head {
  flex: 1;
}

.seam-head h2 {
  font-size: 1rem;
  margin: 0 0 0.3rem;
  line-height: 1.3;
}

.seam-head a {
  color: var(--text);
  text-decoration: none;
}

.seam-head a:hover {
  color: var(--lamp);
}

.seam-counts {
  display: block;
  font-size: 0.85rem;
  color: var(--text-dim);
  margin-top: 0.2rem;
}

.seam-feed {
  flex: none;
  display: flex;
  gap: 0.4rem;
  align-items: center;
}

.seam-link {
  padding: 0.35rem 0.6rem;
  background: var(--rock-lit);
  border: 1px solid var(--rock-edge);
  border-radius: 4px;
  color: var(--text-dim);
  text-decoration: none;
  font-size: 0.8rem;
  white-space: nowrap;
  transition: all 0.15s ease;
}

.seam-link:hover {
  background: var(--rock-edge);
  color: var(--lamp);
}

.seams-note {
  font-size: 0.9rem;
  color: var(--text-dim);
  margin: 0;
}
</style>

<link rel="stylesheet" href="{{ '/assets/style.css' | relative_url }}?v={{ site.time | date: '%s' }}">
