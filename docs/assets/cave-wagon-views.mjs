/**
 * cave-wagon-views — K3b: the wagon table, the train strip, and the naming
 * client.
 *
 * Transcribed from docs/assets/filter.js (`renderWagonTables`, `wagonTableRows`,
 * `renderTrainStrip`, `wireTrainStrip`, `wagonTipHtml`, `wagonLabel`,
 * `wagonKeyLocal`, `nameWagons`) with the page's `state.*` / `byId` reads turned
 * into parameters. Same markup and classes, so filter.css still styles it: the
 * caller owns the element, this file returns the string to put in it.
 *
 * WHAT CHANGED BECAUSE v4 HAS NO ASSAY IN STAGE 3: the reference's table carried
 * a Grade column filled in after the assay stage. v4 shows wagons before any
 * grading happens, so the column is gone rather than a column of dashes.
 *
 * CENTRALITY. `wagonTableHtml`'s `central` is the N×N coupling matrix the wagons
 * were cut from (the reference's `state.wagonMap`). Given it, each wagon's rows
 * are ordered by mean similarity to their wagon-mates — the head of the table
 * reads as the wagon's subject — and the Centrality column appears. Without it
 * the rows keep the order `clusterOrder` emitted and the column is absent,
 * because a caller with only components has no centrality to report.
 *
 * A WAGON'S NAME IS A GARNISH. Naming can fail for a dozen reasons that are not
 * bugs (no key on the deployment, a spent daily budget, a rate limit, an http://
 * origin with no crypto.subtle), and a clustering that already happened locally
 * must not look broken because of it: every builder here falls back to
 * "Wagon 3", which is what the train read before naming existed.
 */
import { escapeHtml } from './sieve-ui.mjs';

/* One hue per wagon, cycled if there are more wagons than colours. Shared with
   the graph (K3a) by value, not by import, so neither view depends on the
   other. */
export const WAGON_COLORS = Object.freeze([
  '#f5b301', '#5fb3a1', '#c96f4a', '#8f7fd4',
  '#7fa650', '#d98cb3', '#4f9ad6', '#c9a227',
  '#a8705a', '#6fbf73',
]);

/* Stones that joined no wagon ride the flatcar at the tail. */
export const LONE_COLOR = '#6c6355';


/* ── authors ──────────────────────────────────────────────────────────────
   Copied from filter.js: the table's Author column is short initials with the
   full list in the cell's tooltip, and the two TeX-stripping helpers are what
   makes that narrow. */

/** `\'Alvaro`, `Mo{\o}s`, `{\v s}` → the bare letter. */
function unTex(name) {
  return String(name)
    .replace(/\\[`'^"~=.uvHrcbdk]\s*\{?([A-Za-z])\}?/g, '$1')
    .replace(/\\ss\b/g, 'ss')
    .replace(/\\(aa|AA|o|O|l|L|ae|AE|oe|OE)\b/g, function (_, c) { return c; })
    .replace(/[{}\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/* "Álvaro Navarrete" → "Á. Navarrete", "Duarte, A. H." → "A. H. Duarte". */
function shortAuthor(name) {
  var n = unTex(name);
  if (!n) return '';
  var given, last;
  if (n.indexOf(',') !== -1) {
    var parts = n.split(',');
    last = parts.shift().trim();
    given = parts.join(' ').trim();
  } else {
    var words = n.split(' ');
    last = words.pop();
    /* Keep the particle with the surname: "van Dijk", not "v. Dijk". */
    while (words.length &&
           /^(van|von|der|den|de|del|della|di|da|dos|du|la|le|ter|ten|bin|ibn|al|st\.?)$/i
             .test(words[words.length - 1])) {
      last = words.pop() + ' ' + last;
    }
    given = words.join(' ');
  }
  if (!given) return last;
  var inits = given.split(' ').map(function (w) {
    /* Jean-Pierre → J.-P. */
    return w.split('-').map(function (p) {
      return p ? p.charAt(0).toUpperCase() + '.' : '';
    }).filter(Boolean).join('-');
  }).filter(Boolean).join(' ');
  return inits ? inits + ' ' + last : last;
}

function shortAuthors(list) {
  return (list || []).map(shortAuthor).filter(Boolean).join(', ');
}

/* ── pure helpers ───────────────────────────────────────────────────────── */

/** Stones in no component, in stone order — the flatcar's load. */
function loneMembers(stones, components) {
  var inWagon = new Set();
  for (var c = 0; c < components.length; c++) {
    for (var m = 0; m < components[c].indices.length; m++) inWagon.add(components[c].indices[m]);
  }
  var lone = [];
  for (var i = 0; i < stones.length; i++) if (!inWagon.has(i)) lone.push(i);
  return lone;
}

/** Most common primary category among `members`, '' if none carry one. */
export function topCategory(members, stones) {
  var counts = {}, best = '', bestN = 0;
  for (var i = 0; i < (members || []).length; i++) {
    var cat = (stones[members[i]] || {}).primary_category;
    if (!cat) continue;
    counts[cat] = (counts[cat] || 0) + 1;
    /* Strictly greater, as in the reference: the first category to reach a
       count wins a tie, so the label is stable across re-renders. */
    if (counts[cat] > bestN) { bestN = counts[cat]; best = cat; }
  }
  return best;
}

/** The label a wagon goes by: its name once it has one, its number until then. */
export function wagonLabel(names, i) {
  var name = names && names[i];
  return name ? String(name) : 'Wagon ' + (i + 1);
}

/**
 * Tooltip body for one wagon. `central` is the wagon's central *title* (the
 * reference's `centralTitle`), or null for the lone flatcar.
 */
export function wagonTipHtml({ name, members, stones, total, central = null, gloss = '' }) {
  var pct = total ? Math.round((members.length / total) * 100) : 0;
  var cat = topCategory(members, stones);
  return '<div class="tt-title">' + escapeHtml(name) + '</div>' +
    '<div class="tt-row">' + members.length + ' stones · ' + pct + '% of the haul' +
      (cat ? ' · mostly ' + escapeHtml(cat) : '') + '</div>' +
    (gloss ? '<div class="tt-row tt-gloss">' + escapeHtml(gloss) + '</div>' : '') +
    (central ? '<div class="tt-row tt-central">' + escapeHtml(central) + '</div>' : '');
}

/* ── the table ──────────────────────────────────────────────────────────── */

/** Rows for one wagon table. `central` null means no Centrality column. */
function wagonTableRows(members, stones, central) {
  /* No arXiv-ID column: the title is the link to the abstract page, so the id
     was a second copy of the same click eating width the title and the authors
     want. */
  var out = '<table class="wagon-table"><thead><tr>' +
    '<th>Title</th><th>Authors</th><th>Category</th>' +
    (central ? '<th>Centrality</th>' : '') +
    '</tr></thead><tbody>';
  for (var i = 0; i < members.length; i++) {
    var si = members[i];
    var st = stones[si] || {};
    var authors = shortAuthors(st.authors);
    var authorsFull = (st.authors || []).map(unTex).join(', ');
    out += '<tr>' +
      /* One line, clipped, whole title in the native tooltip: a wrapped title
         makes rows of different heights and the table stops being scannable,
         which is the only thing it is for. */
      '<td class="wagon-td-title-cell"><a class="wagon-td-title" href="' +
        escapeHtml(st.abs_url || '') + '" target="_blank" rel="noopener" title="' +
        escapeHtml(st.title) + '">' + escapeHtml(st.title) + '</a></td>' +
      /* The scroller has to be a div: a td is a table-cell box and ignores
         overflow, so long author lists spilled into the next column. */
      '<td class="wagon-td-authors" title="' + escapeHtml(authorsFull) + '">' +
        '<div class="wagon-authors-scroll">' + escapeHtml(authors) + '</div></td>' +
      '<td class="wagon-td-cat">' + escapeHtml(st.primary_category || '') + '</td>' +
      (central ? '<td class="num">' + (central[si] ?? 0).toFixed(3) + '</td>' : '') +
      '</tr>';
  }
  return out + '</tbody></table>';
}

/**
 * Table view: one table per wagon, plus a closing table of the lone stones.
 * Within a wagon, stones are ordered by centrality when `central` is given.
 *
 * `names` is parallel to `components` — the name or null for each, exactly as
 * `nameWagons` returns it. A component may carry its own `gloss`, which the
 * header prints under the name.
 */
export function wagonTableHtml({ stones = [], components = [], names = [], central = null } = {}) {
  var inWagon = new Set();
  var html = '';

  for (var c = 0; c < components.length; c++) {
    var comp = components[c];
    var members = comp.indices.slice();
    for (var m = 0; m < members.length; m++) inWagon.add(members[m]);

    var centre = null;
    if (central) {
      /* Mean similarity to the rest of the wagon; a sole member is trivially
         central, and the reference says so with 1 rather than a 0/0. */
      centre = {};
      for (var a = 0; a < members.length; a++) {
        var sum = 0;
        for (var b = 0; b < members.length; b++) {
          if (a !== b) sum += central[members[a]][members[b]];
        }
        centre[members[a]] = members.length > 1 ? sum / (members.length - 1) : 1;
      }
      members.sort(function (x, y) { return centre[y] - centre[x]; });
    }

    html += '<div class="wagon-table-block" id="wagon-block-' + c + '">' +
      '<div class="wagon-table-head">' +
        '<span class="wagon-swatch" style="background:' +
          WAGON_COLORS[c % WAGON_COLORS.length] + '"></span>' +
        '<span class="wagon-table-name">' + escapeHtml(wagonLabel(names, c)) + '</span>' +
        '<span class="wagon-table-count">' + members.length + ' stones</span>' +
        (comp.gloss ? '<span class="wagon-table-gloss">' + escapeHtml(comp.gloss) + '</span>' : '') +
      '</div>' +
      wagonTableRows(members, stones, centre) +
      '</div>';
  }

  var lone = loneMembers(stones, components);
  if (lone.length) {
    html += '<div class="wagon-table-block" id="wagon-block-lone">' +
      '<div class="wagon-table-head">' +
        '<span class="wagon-swatch" style="background:' + LONE_COLOR + '"></span>' +
        '<span class="wagon-table-name">Lone stones</span>' +
        '<span class="wagon-table-count">' + lone.length + ' stones</span>' +
      '</div>' +
      wagonTableRows(lone, stones, null) +
      '</div>';
  }

  return html || '<p class="hint">No stones to show.</p>';
}

/* ── the train strip ──────────────────────────────────────────────────────
   One wagon per cluster, sitting above whichever view is selected. A wagon's
   width is its share of the haul — eight stones next to five draw 8:5 — so the
   shape of the night reads before a single table does, and dragging the
   threshold is watching wagons couple and split. Stones in no wagon ride the
   flatcar at the tail, which keeps the strip's full width equal to the whole
   haul. */

export function trainStripHtml({ stones = [], components = [], names = [] } = {}) {
  if (!stones.length) return '';

  var inWagon = 0;
  for (var c = 0; c < components.length; c++) inWagon += components[c].indices.length;
  var lone = stones.length - inWagon;

  var html = '<span class="train-loco" aria-hidden="true"></span>';
  for (var w = 0; w < components.length; w++) {
    var n = components[w].indices.length;
    /* flex-grow carries the ratio and flex-basis is 0 (filter.css), so widths
       are the counts themselves rather than counts plus some content width. */
    html += '<button type="button" class="train-wagon" data-wagon="' + w + '"' +
      ' style="flex-grow:' + n + ';background:' +
      WAGON_COLORS[w % WAGON_COLORS.length] + '"' +
      /* aria-label, not title: the rich hover card already says all of this,
         and the native tooltip drew on top of it. */
      ' aria-label="' + escapeHtml(wagonLabel(names, w)) + ' — ' + n + ' stones">' +
      '<span class="train-wagon-n">' + n + '</span></button>';
  }
  if (lone) {
    html += '<button type="button" class="train-wagon is-lone" data-wagon="lone"' +
      ' style="flex-grow:' + lone + ';background:' + LONE_COLOR + '"' +
      ' aria-label="Lone stones — ' + lone + ' stones">' +
      '<span class="train-wagon-n">' + lone + '</span></button>';
  }
  return html;
}

/** Wagon under the pointer, or null. */
function stripWagonAt(target) {
  return target && target.closest ? target.closest('.train-wagon') : null;
}

/**
 * Hover reads a wagon out into the floating tooltip; a click hands its key to
 * `onPick` ('0', '1', … or 'lone'), which is the caller's cue to open that
 * wagon's table. The strip keeps its own tooltip, separate from the graph's
 * pinned one, so the two views never fight over it.
 *
 * `stones`, `components` and `names` are the same three the HTML was built
 * from. Wire once, after mounting: the element is reused across re-renders and
 * a second wire would double every handler.
 */
export function wireTrainStrip(strip, tip, { stones = [], components = [], names = [], onPick = null } = {}) {
  if (!strip || !tip) return;

  function hide() { tip.style.display = 'none'; }

  strip.addEventListener('mousemove', function (e) {
    var el = stripWagonAt(e.target);
    if (!el) { hide(); return; }
    var key = el.getAttribute('data-wagon');
    var members, name, central = null, gloss = '';
    if (key === 'lone') {
      members = loneMembers(stones, components);
      name = 'Lone stones';
    } else {
      var comp = components[+key];
      if (!comp) { hide(); return; }
      members = comp.indices;
      name = wagonLabel(names, +key);
      central = comp.centralTitle || null;
      gloss = comp.gloss || '';
    }
    tip.innerHTML = wagonTipHtml({ name, members, stones, total: stones.length, central, gloss });
    tip.style.display = '';
    /* Clamp to the viewport so the last wagon's tooltip does not hang off the
       right edge of a narrow window. */
    var w = tip.offsetWidth || 260;
    var x = Math.min(e.clientX + 14, window.innerWidth - w - 8);
    tip.style.left = Math.max(8, x) + 'px';
    tip.style.top = (e.clientY + 16) + 'px';
  });
  strip.addEventListener('mouseleave', hide);

  strip.addEventListener('click', function (e) {
    var el = stripWagonAt(e.target);
    if (!el) return;
    hide();
    if (onPick) onPick(el.getAttribute('data-wagon'));
  });
}

/* ── naming ─────────────────────────────────────────────────────────────── */

/**
 * The shared key for a wagon: its members' `id\ttitle` lines, sorted, hashed.
 *
 * A DIVERGENCE HERE DOES NOT THROW AND DOES NOT LOOK LIKE ANYTHING: it files
 * every name under a hash the server never looks up, so naming silently stops
 * hitting the cache and starts paying full price on every haul. The agreement
 * is pinned by a golden digest shared with `supabase/functions/wagon-name/`
 * (asserted in scripts/cave-wagon-views.test.mjs):
 *
 *   {2608.01234, 'Valley  splitting in\nSi/SiGe quantum wells '}
 *   {2608.05678, 'Charge noise in silicon double quantum dots'}
 *     → 0cf357c0a944ef663d75fd37e3acd4fc8978aa386e05f90ea2a33e3725b578fb
 *
 * Needs a secure context: no `crypto.subtle` (an http:// origin) means no keys,
 * so the caller should treat that as "unnamed", not as an error to show.
 */
export async function wagonKey(members, stones) {
  var list = stones || [];
  var lines = (members || []).map(function (i) {
    var st = list[i] || {};
    return String(st.arxiv_id || '').trim() + '\t' +
      String(st.title || '').replace(/\s+/g, ' ').trim().slice(0, 400);
  }).sort();
  if (!globalThis.crypto || !globalThis.crypto.subtle) {
    throw new Error('cave-wagon-views: wagonKey needs crypto.subtle (a secure context)');
  }
  var digest = await globalThis.crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(lines.join('\n')),
  );
  return Array.from(new Uint8Array(digest), function (b) {
    return ('0' + b.toString(16)).slice(-2);
  }).join('');
}

/**
 * Ask the endpoint to name every wagon, in one request.
 *
 * Returns names parallel to `components`: the name where the endpoint answered,
 * null where it did not (unnamed, unasked, or the reply has no entry for that
 * key). Failures throw — the endpoint's own contract is that every *naming*
 * failure is a missing name, never an HTTP error, so a thrown one means the
 * request itself failed (offline, HTTP 500, a spent request budget) and the
 * caller decides whether to say so. Nothing here touches the DOM.
 *
 * The endpoint refuses a request carrying more wagons than it will name, and
 * refuses the *whole* request, so a low threshold that splits the haul into
 * thirty components would otherwise name none of them: send the biggest
 * `maxWagons` and let the rest keep their numbers. Sorted here rather than
 * assumed — `clusterOrder` emits components in DFS order (arXiv listing
 * order), which has nothing to do with size.
 *
 * Request body, per `supabase/functions/wagon-name/index.ts`:
 *   { wagons: [{ members: [{ id, title }, ...] }, ...] }
 */
export async function nameWagons({ url, stones = [], components = [], fetchImpl = fetch, maxWagons = 24 } = {}) {
  if (!url) throw new Error('cave-wagon-views: nameWagons needs a url');
  var names = components.map(function () { return null; });
  if (!components.length) return names;

  var asked = components.map(function (_, i) { return i; });
  if (asked.length > maxWagons) {
    asked = asked.slice().sort(function (a, b) {
      return components[b].indices.length - components[a].indices.length;
    }).slice(0, maxWagons);
  }

  /* The keys are computed here rather than read from the reply's `keys`: the
     hash is the client's to own, and one definition (this one) is what keeps
     the cache warm across deploys. */
  var keys = [];
  for (var k = 0; k < asked.length; k++) keys.push(await wagonKey(components[asked[k]].indices, stones));

  var payload = asked.map(function (c) {
    return {
      members: components[c].indices.map(function (i) {
        var st = stones[i] || {};
        return { id: String(st.arxiv_id || ''), title: String(st.title || '') };
      }),
    };
  });

  var resp = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wagons: payload }),
  });
  if (!resp.ok) {
    var detail = '';
    try { detail = (await resp.json()).error || ''; } catch (_) { /* not json */ }
    throw new Error(detail || ('Naming failed (HTTP ' + resp.status + ').'));
  }
  var data = await resp.json();
  var got = data.names || {};
  for (var i = 0; i < asked.length; i++) {
    var hit = got[keys[i]];
    if (hit && hit.name) names[asked[i]] = String(hit.name);
  }
  return names;
}

