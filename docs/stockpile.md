---
layout: page
title: Stockpile
permalink: /stockpile/
---

<div class="status-banner">
  <strong>Every night, every seam, what it yielded.</strong> Everything ever
  hauled up and kept, browsable by month and day. A row is the record — the
  day, the seam, the grade band — and opening one brings back the whole card
  that shipped that morning: the figure, the finding, the caveat, the abstract.
</div>

<div id="stockpile-view" style="display:none">
  <div class="stockpile-controls">
    <label>
      Filter by seam
      <select id="stockpile-seam-filter">
        <option value="">All seams</option>
      </select>
    </label>
    <label>
      Filter by band
      <select id="stockpile-band-filter">
        <option value="">All bands</option>
        <option value="paydirt">Pay dirt</option>
        <option value="look">Worth a look</option>
        <option value="longshot">Long shot</option>
      </select>
    </label>
  </div>

  <div id="stockpile-months" class="stockpile-months"></div>
  <div id="stockpile-empty" class="stockpile-empty" style="display:none">
    No results match the filters.
  </div>
</div>

<noscript>
  <div class="warn-banner">
    JavaScript is disabled. This page builds the stockpile view from archive
    JSON files. Please enable JavaScript to browse the archive.
  </div>
</noscript>

<script>
(function() {
  const feedsBase = (window.ARXAVE_FEEDS_BASE || '/feeds/');
  const archivePath = feedsBase + 'archive/index.json';
  
  let allItems = { months: [], items: {} };
  let seams = new Set();
  let state = { seam: '', band: '' };
  /* The same three names the feed uses. Copied rather than imported: this page
     has no build step and the archive stores the slug, not the label. */
  const BAND_LABEL = {
    paydirt: 'Pay dirt', look: 'Worth a look', longshot: 'Long shot',
  };
  
  /* THE ROW IS THE PAPER, CLOSED. A stockpile row is a record that something
     was hauled up on a given day — the title, when, out of which seam, and how
     the assay graded it. Everything else, including the finding and the author
     list, is behind the row: this page exists to hold a whole month at once,
     and a month of open cards is not a page anyone scrolls.

     Under an open row sits the same six drawers the feed card has, built from
     the same archived fields, so a paper read here reads exactly as it did the
     morning it shipped. */
  function fold(label, build) {
    const d = document.createElement('details');
    d.className = 'fold';
    const sum = document.createElement('summary');
    sum.textContent = label;
    d.appendChild(sum);
    const inner = build();
    if (!inner) return null;
    d.appendChild(inner);
    return d;
  }

  function para(text, cls) {
    const p = document.createElement('p');
    p.className = 'fold-body' + (cls ? ' ' + cls : '');
    p.textContent = text;
    return p;
  }

  function figureFold(item) {
    if (!item.figure) return null;
    const wrap = document.createElement('div');
    wrap.className = 'fold-body';
    const holder = document.createElement('p');
    holder.className = 'figure';
    const img = document.createElement('img');
    img.src = item.figure;
    img.alt = item.caption || 'Figure';
    img.loading = 'lazy';
    /* The overlay reads the caption off the image it was handed, so the two
       can never drift apart the way a shared variable would let them. */
    img.dataset.caption = item.caption || '';
    holder.appendChild(img);
    wrap.appendChild(holder);
    if (item.caption) {
      const cap = document.createElement('p');
      cap.className = 'figure-caption';
      cap.textContent = item.caption;
      wrap.appendChild(cap);
    }
    return wrap;
  }

  function toolsFold(item) {
    if (!item.tools && !item.code) return null;
    const wrap = document.createElement('div');
    wrap.className = 'fold-body';
    if (item.tools) {
      const p = document.createElement('p');
      p.textContent = item.tools;
      wrap.appendChild(p);
    }
    if (item.code) {
      const p = document.createElement('p');
      const lead = document.createElement('strong');
      lead.textContent = 'Code. ';
      const a = document.createElement('a');
      a.href = item.code;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = item.code;
      p.appendChild(lead);
      p.appendChild(a);
      wrap.appendChild(p);
    }
    return wrap;
  }

  function detailCell(item) {
    const box = document.createElement('div');
    box.className = 'stockpile-detail';

    if (item.authors) {
      const by = document.createElement('p');
      by.className = 'byline';
      by.textContent = item.authors;
      box.appendChild(by);
    }
    if (item.result) {
      const r = document.createElement('p');
      r.className = 'result';
      r.textContent = item.result;
      box.appendChild(r);
    }

    const row = document.createElement('div');
    row.className = 'folds';
    const drawers = [
      fold('Figure', () => figureFold(item)),
      fold('Asks', () => (item.question ? para(item.question) : null)),
      fold('Before', () => (item.prior ? para(item.prior) : null)),
      fold('But', () => (item.limits ? para(item.limits, 'but') : null)),
      fold('Tools', () => toolsFold(item)),
      fold('Abstract', () => (item.abstract ? para(item.abstract) : null)),
    ].filter(Boolean);
    drawers.forEach(d => row.appendChild(d));

    /* Nothing to unfold on a record from before the archive carried the card —
       and a button that opens nothing is worse than no button. */
    if (drawers.length) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'unfold';
      btn.textContent = 'Unfold all';
      row.appendChild(btn);
      box.appendChild(row);
    } else {
      box.appendChild(para('Nothing archived for this one beyond the ranking.'));
    }
    return box;
  }

  function render() {
    const container = document.getElementById('stockpile-months');
    if (!container) return;
    container.innerHTML = '';

    let anyShown = false;
    for (const month of (allItems.months || [])) {
      const monthDiv = document.createElement('div');
      monthDiv.className = 'stockpile-month';
      const heading = document.createElement('h2');
      heading.textContent = month.month;
      monthDiv.appendChild(heading);

      const table = document.createElement('table');
      table.className = 'stockpile-table';

      const thead = table.createTHead();
      const hrow = thead.insertRow();
      ['Date', 'Paper', 'Seam', 'Band'].forEach(h => {
        const th = document.createElement('th');
        th.textContent = h;
        hrow.appendChild(th);
      });

      const tbody = table.createTBody();
      let monthHasItems = false;

      // Days already come newest-first from the index; list every matching
      // paper in that order so the table reads as one chronological feed.
      for (const day of month.days) {
        for (const [slug, counts] of Object.entries(day.feeds || {})) {
          if (state.seam && slug !== state.seam) continue;

          const filtered = filterItems(allItems.items?.[day.date]?.[slug]?.items || [], state.band);
          for (const item of filtered) {
            monthHasItems = anyShown = true;

            const row = tbody.insertRow();
            row.className = 'band-' + (item.band || 'longshot');
            row.insertCell().textContent = day.date;

            const paperCell = row.insertCell();
            const link = document.createElement('a');
            link.href = item.link;
            link.target = '_blank';
            link.rel = 'noopener';
            link.textContent = item.title;
            paperCell.appendChild(link);
            /* The row itself opens the card; the title still goes to arXiv, so
               the toggle is its own control rather than the whole row, which
               would make every click on a title ambiguous. */
            const toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.className = 'row-toggle';
            toggle.textContent = 'Open';
            paperCell.appendChild(toggle);

            row.insertCell().textContent = slug;
            row.insertCell().textContent = BAND_LABEL[item.band] || item.band || '';

            const detailRow = tbody.insertRow();
            detailRow.className = 'stockpile-detail-row';
            detailRow.style.display = 'none';
            const cell = detailRow.insertCell();
            cell.colSpan = 4;
            cell.appendChild(detailCell(item));

            toggle.addEventListener('click', () => {
              const open = detailRow.style.display === 'none';
              detailRow.style.display = open ? '' : 'none';
              toggle.textContent = open ? 'Close' : 'Open';
            });
          }
        }
      }

      if (monthHasItems) {
        monthDiv.appendChild(table);
        container.appendChild(monthDiv);
      }
    }

    document.getElementById('stockpile-empty').style.display = anyShown ? 'none' : '';
  }

  function filterItems(items, band) {
    if (!band) return items;
    return items.filter(i => i.band === band);
  }
  
  fetch(archivePath)
    .then(r => {
      if (!r.ok) throw new Error('Archive index: ' + r.status);
      return r.json();
    })
    .then(index => {
      allItems.months = index.months || [];
      
      // Collect all seams
      for (const month of allItems.months) {
        for (const day of month.days) {
          for (const slug of Object.keys(day.feeds || {})) {
            seams.add(slug);
          }
        }
      }
      
      // The index carries the calendar and the counts; the cards themselves
      // live in each month's own file, under `days`, since a month is the unit
      // the page loads at once.
      return Promise.all(allItems.months.map(month =>
        fetch(feedsBase + 'archive/' + month.month + '.json')
          .then(r => r.ok ? r.json() : null)
          .then(data => {
            if (data && data.days) Object.assign(allItems.items, data.days);
          })
          .catch(() => {})
      ));
    })
    .then(() => {
      
      // Populate seam filter
      const seamSelect = document.getElementById('stockpile-seam-filter');
      if (seamSelect && seams.size > 0) {
        Array.from(seams).sort().forEach(slug => {
          const opt = document.createElement('option');
          opt.value = slug;
          opt.textContent = slug;
          seamSelect.appendChild(opt);
        });
      }
      
      // Wire filters
      const seamFilter = document.getElementById('stockpile-seam-filter');
      const bandFilter = document.getElementById('stockpile-band-filter');
      if (seamFilter) {
        seamFilter.addEventListener('change', e => {
          state.seam = e.target.value;
          render();
        });
      }
      if (bandFilter) {
        bandFilter.addEventListener('change', e => {
          state.band = e.target.value;
          render();
        });
      }
      
      document.getElementById('stockpile-view').style.display = '';
      render();
    })
    .catch(err => {
      const view = document.getElementById('stockpile-view');
      if (view) {
        view.innerHTML = '<div class="warn-banner">Could not load stockpile: ' + err.message + '</div>';
        view.style.display = '';
      }
    });

  /* One handler for the whole table rather than one per card: the table is
     rebuilt on every filter change, and per-card listeners would have to be
     rebuilt with it. */
  document.addEventListener('click', function (ev) {
    const btn = ev.target.closest && ev.target.closest('.unfold');
    if (!btn) return;
    const folds = btn.parentNode.querySelectorAll('details.fold');
    let anyClosed = false;
    folds.forEach(f => { if (!f.open) anyClosed = true; });
    folds.forEach(f => { f.open = anyClosed; });
    btn.textContent = anyClosed ? 'Fold all' : 'Unfold all';
  });

  /* A plot at column width is a thumbnail of a plot — these are drawn for a
     printed page. Click throws it up full-screen, as on the feed page. */
  const box = document.createElement('div');
  box.className = 'lightbox';
  const boxImg = document.createElement('img');
  const boxCap = document.createElement('p');
  box.appendChild(boxImg);
  box.appendChild(boxCap);
  document.body.appendChild(box);
  function closeBox() { box.classList.remove('open'); boxImg.src = ''; }
  document.addEventListener('click', function (ev) {
    const img = ev.target.closest && ev.target.closest('.stockpile-detail .figure img');
    if (!img) return;
    boxImg.src = img.src;
    boxImg.alt = img.alt || '';
    boxCap.textContent = img.dataset.caption || '';
    box.classList.add('open');
  });
  box.addEventListener('click', closeBox);
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') closeBox();
  });
})();
</script>

<style>
#stockpile-view { margin-top: 1.5rem; }

.stockpile-controls {
  display: flex;
  gap: 1.2rem;
  flex-wrap: wrap;
  margin-bottom: 2rem;
  padding: 0.8rem;
  background: var(--rock);
  border: 1px solid var(--rock-edge);
  border-radius: 6px;
}

.stockpile-controls label {
  display: flex;
  gap: 0.4rem;
  align-items: center;
  font-size: 0.9rem;
  color: var(--text-dim);
}

.stockpile-controls select {
  padding: 0.3rem 0.5rem;
  border: 1px solid var(--rock-edge);
  border-radius: 3px;
  background: var(--rock-lit);
  color: var(--text);
  font-size: 0.9rem;
}

.stockpile-months { margin-bottom: 2rem; }

.stockpile-month {
  margin-bottom: 2rem;
}

.stockpile-month h2 {
  font-size: 1.1rem;
  margin: 1.2rem 0 0.6rem;
  color: var(--text);
}

.stockpile-table {
  width: 100%;
  border-collapse: collapse;
  margin-bottom: 1rem;
  font-size: 0.85rem;
}

.stockpile-table th {
  text-align: left;
  padding: 0.5rem 0.6rem;
  background: var(--rock);
  border: 1px solid var(--rock-edge);
  color: var(--text-dim);
  font-weight: 600;
  text-transform: uppercase;
  font-size: 0.75rem;
  letter-spacing: 0.05em;
}

.stockpile-table td {
  padding: 0.5rem 0.6rem;
  border: 1px solid var(--rock-edge);
  color: var(--text);
}

.stockpile-table tr.band-paydirt td:first-child {
  border-left: 3px solid #f5b301;
}

.stockpile-table tr.band-look td:first-child {
  border-left: 3px solid #f5b301;
  opacity: 0.8;
}

.stockpile-table tr.band-longshot td:first-child {
  border-left: 3px solid var(--rock-edge);
  opacity: 0.65;
}

/* THE ROW STAYS A ROW. Everything the card carries is under it, closed, so a
   month of papers is still a table you can run your eye down. */
.row-toggle {
  margin-left: 0.6rem;
  background: none;
  border: 1px solid var(--rock-edge);
  border-radius: 3px;
  padding: 0.05rem 0.4rem;
  color: var(--text-dim);
  font: inherit;
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  cursor: pointer;
}

.row-toggle:hover { color: #f5b301; border-color: #f5b301; }

.stockpile-detail-row td { background: var(--rock); }

.stockpile-detail { padding: 0.4rem 0.2rem; }

.stockpile-detail .byline {
  margin: 0 0 0.3rem;
  color: var(--text-dim);
  font-size: 0.85rem;
}

.stockpile-detail .result {
  margin: 0 auto 0.6rem;
  max-width: 42rem;
  text-align: center;
  font-size: 0.95rem;
  line-height: 1.55;
}

/* Closed drawers sit in a row; an open one takes the full width and pushes the
   others down, so two open drawers never read as columns. */
.stockpile-detail .folds {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem 0.5rem;
  border-top: 1px solid var(--rock-edge);
  padding-top: 0.5rem;
}

.stockpile-detail .fold { flex: none; }
.stockpile-detail .fold[open] { flex: 1 0 100%; }

.stockpile-detail .fold > summary {
  cursor: pointer;
  list-style: none;
  color: var(--text-dim);
  font-size: 0.78rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-weight: 700;
}

.stockpile-detail .fold > summary::-webkit-details-marker { display: none; }

.stockpile-detail .fold > summary::before {
  content: "\25B8";
  display: inline-block;
  margin-right: 0.4rem;
  transition: transform 0.12s ease;
}

.stockpile-detail .fold[open] > summary::before { transform: rotate(90deg); }
.stockpile-detail .fold[open] > summary { color: #f5b301; }

.stockpile-detail .fold-body {
  margin: 0.45rem 0 0;
  color: var(--text-dim);
  font-size: 0.85rem;
  line-height: 1.6;
}

.stockpile-detail .unfold {
  margin-left: auto;
  background: none;
  border: 1px solid var(--rock-edge);
  border-radius: 3px;
  padding: 0.05rem 0.45rem;
  color: var(--text-dim);
  font: inherit;
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-weight: 700;
  cursor: pointer;
}

.stockpile-detail .unfold:hover { color: #f5b301; border-color: #f5b301; }

/* The pale plate matters: most of these are line art on transparent SVG, which
   on a dark page is invisible. */
.stockpile-detail .figure { margin: 0.6rem 0; text-align: center; }

.stockpile-detail .figure img {
  display: inline-block;
  width: 100%;
  max-width: 34rem;
  height: auto;
  border-radius: 3px;
  background: #f4f1ea;
  padding: 0.5rem;
  cursor: zoom-in;
}

.stockpile-detail .figure-caption {
  margin: 0.5rem auto 0;
  max-width: 34rem;
  text-align: center;
  color: var(--text-dim);
  font-size: 0.8rem;
}

.lightbox {
  display: none;
  position: fixed;
  inset: 0;
  z-index: 50;
  background: rgba(10, 12, 15, 0.94);
  padding: 2rem;
  cursor: zoom-out;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

.lightbox.open { display: flex; }

.lightbox img {
  max-width: 100%;
  max-height: 86vh;
  width: auto;
  height: auto;
  border-radius: 4px;
  background: #f4f1ea;
  padding: 1rem;
}

.lightbox p {
  margin: 1rem 0 0;
  max-width: 48rem;
  text-align: center;
  color: var(--text-dim);
  font-size: 0.9rem;
}

.stockpile-empty {
  padding: 2rem;
  text-align: center;
  color: var(--text-dim);
  border: 1px dashed var(--rock-lit);
  border-radius: 6px;
}
</style>

<link rel="stylesheet" href="{{ '/assets/style.css' | relative_url }}">
