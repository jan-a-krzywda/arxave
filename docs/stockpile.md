---
layout: page
title: Stockpile
permalink: /stockpile/
---

<div class="status-banner">
  <strong>Every night, every seam, what it yielded.</strong> Everything ever
  hauled up and kept, browsable by month and day. The abstract is one hop away
  on arXiv; what lives here is the decision — the rank and the verdict — so the
  page can hold a whole month in memory.
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
  
  let allItems = {};
  let seams = new Set();
  let state = { seam: '', band: '' };
  
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
      
      let monthHasItems = false;
      for (const day of month.days) {
        let dayHasItems = false;
        const table = document.createElement('table');
        table.className = 'stockpile-table';
        
        const thead = table.createTHead();
        const hrow = thead.insertRow();
        ['Date', 'Seam', 'Items', 'Pay dirt', 'Worth a look'].forEach(h => {
          const th = document.createElement('th');
          th.textContent = h;
          hrow.appendChild(th);
        });
        
        const tbody = table.createTBody();
        for (const [slug, counts] of Object.entries(day.feeds || {})) {
          if (state.seam && slug !== state.seam) continue;
          
          const filtered = filterItems(allItems.items?.[day.date]?.[slug] || [], state.band);
          if (!filtered.length) continue;
          dayHasItems = monthHasItems = anyShown = true;
          
          const row = tbody.insertRow();
          row.className = 'band-' + (filtered[0]?.band || 'longshot');
          row.insertCell().textContent = day.date;
          row.insertCell().textContent = slug;
          row.insertCell().textContent = counts.items;
          row.insertCell().textContent = counts.paydirt || '—';
          row.insertCell().textContent = counts.items - (counts.paydirt || 0) + ' other';
        }
        
        if (dayHasItems) {
          monthDiv.appendChild(table);
        }
      }
      
      if (monthHasItems) {
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
      allItems = index;
      
      // Collect all seams
      for (const month of (index.months || [])) {
        for (const day of month.days) {
          for (const slug of Object.keys(day.feeds || {})) {
            seams.add(slug);
          }
        }
      }
      
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

.stockpile-empty {
  padding: 2rem;
  text-align: center;
  color: var(--text-dim);
  border: 1px dashed var(--rock-lit);
  border-radius: 6px;
}
</style>

<link rel="stylesheet" href="{{ '/assets/style.css' | relative_url }}">
