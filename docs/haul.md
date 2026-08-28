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
  <strong>Tonight's haul, one wagon per seam.</strong> Each wagon came up loaded
  with what its seam turned over, ranked by grade. Read the wagon here, or point
  a reader at the feed and it lands on your desk each morning — no fetch, no
  setup.
</div>

<div id="wagons" class="wagons" style="display:none"></div>

<p id="wagons-note" class="wagons-note" style="display:none">
  Each wagon is a preset — a claim about what matters in its tunnel. The
  <a href="{{ '/' | relative_url }}">Dig</a> lets you tune the weights and move
  the gate, and feeds built from it will cut and band where you set it. A wagon
  here is the preset's own default.
</p>

<noscript>
  <div class="warn-banner">
    JavaScript is disabled. This page builds the wagons from the feed manifest.
    Please enable JavaScript to see tonight's haul.
  </div>
</noscript>

<script>
(function() {
  const feedsBase = (window.ARXAVE_FEEDS_BASE || '{{ "/feeds/" | relative_url }}');
  const digBase = '{{ "/" | relative_url }}';
  const NS = 'https://arxave.com/ns/feed';

  const board = document.getElementById('wagons');
  const note = document.getElementById('wagons-note');

  function fail(msg) {
    board.innerHTML = '<div class="warn-banner">Could not load tonight’s haul: ' + msg + '</div>';
    board.style.display = '';
  }

  // The namespaced fields are what the wagon actually shows — title and
  // authors and band, not the rendered card the reader gets in their reader.
  function ns(item, tag) {
    const byNs = item.getElementsByTagNameNS(NS, tag);
    if (byNs.length) return byNs[0].textContent.trim();
    const byName = item.getElementsByTagName('arxave:' + tag);
    return byName.length ? byName[0].textContent.trim() : '';
  }

  function plain(item, tag) {
    const el = item.getElementsByTagName(tag);
    return el.length ? el[0].textContent.trim() : '';
  }

  // A full author list is a paragraph, and the column is a glance. First two
  // and a count keeps the one thing a reader scans for — is this a group I
  // know — without turning the row into prose.
  function shortAuthors(raw) {
    if (!raw) return '';
    const names = raw.split(',').map(s => s.trim()).filter(Boolean);
    if (names.length <= 3) return names.join(', ');
    return names.slice(0, 2).join(', ') + ' + ' + (names.length - 2) + ' more';
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // Pixel barrow, same hand as the room sprites in the nav bar: the wagon is
  // the unit on this page, so it gets a face.
  function wagonMark() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '20');
    svg.setAttribute('height', '20');
    svg.setAttribute('shape-rendering', 'crispEdges');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.setAttribute('class', 'wagon-mark');
    svg.innerHTML =
      '<g fill="var(--gold)">' +
      '<rect x="4" y="4" width="2" height="2"/>' +
      '<rect x="7" y="3" width="2" height="3"/>' +
      '<rect x="10" y="4" width="2" height="2"/>' +
      '</g>' +
      '<g fill="currentColor">' +
      '<rect x="2" y="6" width="12" height="2"/>' +
      '<rect x="3" y="8" width="10" height="2"/>' +
      '<rect x="4" y="10" width="8" height="1"/>' +
      '<rect x="3" y="12" width="3" height="2"/>' +
      '<rect x="10" y="12" width="3" height="2"/>' +
      '</g>';
    return svg;
  }

  function tally(feed) {
    const items = feed.items || 0;
    const paydirt = feed.paydirt || 0;
    const look = items - paydirt;
    const parts = [];
    if (paydirt) parts.push(paydirt + ' pay dirt');
    if (look > 0) parts.push(look + ' worth a look');
    return items + ' tonight' + (parts.length ? ' · ' + parts.join(' · ') : '');
  }

  function paperRow(item) {
    const row = el('li', 'paper');

    const band = ns(item, 'band') || 'longshot';
    const bandName = ns(item, 'bandname') || '';
    const grade = ns(item, 'grade');

    const head = el('div', 'paper-head');
    const link = el('a', 'paper-title', plain(item, 'title') || 'Untitled');
    link.href = plain(item, 'link');
    link.rel = 'noopener';
    head.appendChild(link);
    row.appendChild(head);

    const authors = shortAuthors(ns(item, 'authors'));
    if (authors) row.appendChild(el('div', 'paper-authors', authors));

    const meta = el('div', 'paper-meta');
    if (bandName) meta.appendChild(el('span', 'band band-' + band, bandName));
    if (grade) meta.appendChild(el('span', 'paper-grade', grade));
    row.appendChild(meta);

    return row;
  }

  function wagon(slug, feed) {
    const card = el('section', 'wagon');

    const head = el('header', 'wagon-head');
    const title = el('h2', 'wagon-name');
    title.appendChild(wagonMark());
    const nameLink = el('a', null, feed.name || slug);
    nameLink.href = digBase + '?preset=' + encodeURIComponent(slug);
    title.appendChild(nameLink);
    head.appendChild(title);
    head.appendChild(el('p', 'wagon-tally', tally(feed)));

    const take = el('a', 'wagon-feed', '📡 Take the feed');
    take.href = feedsBase + slug + '.xml';
    head.appendChild(take);
    card.appendChild(head);

    const list = el('ul', 'wagon-papers');
    list.appendChild(el('li', 'wagon-loading', 'Unloading…'));
    card.appendChild(list);

    fetch(feedsBase + slug + '.xml')
      .then(r => {
        if (!r.ok) throw new Error(r.status);
        return r.text();
      })
      .then(text => {
        const doc = new DOMParser().parseFromString(text, 'application/xml');
        if (doc.getElementsByTagName('parsererror').length) throw new Error('bad feed');
        const items = doc.querySelectorAll('item');
        list.innerHTML = '';
        if (!items.length) {
          list.appendChild(el('li', 'wagon-empty', 'Came up empty tonight.'));
          return;
        }
        items.forEach(item => list.appendChild(paperRow(item)));
      })
      .catch(err => {
        list.innerHTML = '';
        list.appendChild(el('li', 'wagon-empty', 'Could not read this wagon (' + err.message + '). The feed link still works.'));
      });

    return card;
  }

  fetch(feedsBase + 'index.json')
    .then(r => {
      if (!r.ok) throw new Error('feed manifest: ' + r.status);
      return r.json();
    })
    .then(manifest => {
      const feeds = manifest.feeds || {};
      const slugs = Object.keys(feeds);
      if (!slugs.length) { fail('no feeds in the manifest'); return; }
      slugs.forEach(slug => board.appendChild(wagon(slug, feeds[slug])));
      board.style.display = '';
      note.style.display = '';
    })
    .catch(err => fail(err.message));
})();
</script>

<style>
/* One column per wagon on a desk, stacked on a phone. Three is what the Dig
   ships today; auto-fit means a fourth seam does not need this file edited. */
.wagons {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 1rem;
  margin: 1.5rem 0 1.5rem;
  align-items: start;
}

.wagon {
  background: var(--rock-deep);
  border: 1px solid var(--rock-edge);
  border-radius: 6px;
  overflow: hidden;
}

.wagon-head {
  padding: 0.7rem 0.85rem 0.75rem;
  background: var(--rock);
  border-bottom: 1px solid var(--rock-edge);
}

.wagon-name {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  margin: 0;
  font-size: 1rem;
  line-height: 1.25;
}
.wagon-name a {
  color: var(--text);
  text-decoration: none;
}
.wagon-name a:hover { color: var(--lamp); }
.wagon-mark { flex: none; image-rendering: pixelated; color: var(--text-dim); }

.wagon-tally {
  margin: 0.3rem 0 0.55rem;
  font-size: 0.8rem;
  color: var(--text-dim);
}

.wagon-feed {
  display: inline-block;
  padding: 0.3rem 0.55rem;
  background: var(--rock-lit);
  border: 1px solid var(--rock-edge);
  border-radius: 4px;
  color: var(--text);
  text-decoration: none;
  font-size: 0.78rem;
  white-space: nowrap;
  transition: background 0.15s ease, color 0.15s ease;
}
.wagon-feed:hover {
  background: var(--rock-edge);
  color: var(--lamp);
  text-decoration: none;
}

.wagon-papers {
  list-style: none;
  margin: 0;
  padding: 0;
}

.paper {
  padding: 0.6rem 0.85rem;
  border-bottom: 1px solid var(--rock-edge);
}
.paper:last-child { border-bottom: 0; }

.paper-title {
  color: var(--text);
  font-size: 0.9rem;
  line-height: 1.35;
  text-decoration: none;
}
.paper-title:hover { color: var(--lamp); }

.paper-authors {
  margin-top: 0.25rem;
  font-size: 0.78rem;
  line-height: 1.4;
  color: var(--text-dim);
}

.paper-meta {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin-top: 0.35rem;
}
.paper-grade {
  font-size: 0.72rem;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}

/* Same two bands the card in the feed uses, so a row here and a card there
   read as the same verdict. */
.paper-meta .band {
  display: inline-block;
  padding: 0 0.32em;
  border-radius: 3px;
  font-size: 0.66rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.band-paydirt { background: var(--gold); color: #1b1f26; }
.band-look { border: 1px solid var(--gold-dim); color: var(--gold-dim); }
.band-longshot { border: 1px solid var(--rock-lit); color: var(--text-faint); }

.wagon-loading,
.wagon-empty {
  padding: 0.7rem 0.85rem;
  font-size: 0.82rem;
  color: var(--text-faint);
}

.wagons-note {
  font-size: 0.9rem;
  color: var(--text-dim);
  margin: 0;
}
</style>

<link rel="stylesheet" href="{{ '/assets/style.css' | relative_url }}?v={{ site.time | date: '%s' }}">
