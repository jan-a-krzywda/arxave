/**
 * cave-stage-map — stage 3: tonight's papers as wagons.
 *
 * THIS IS DIG'S TRAIN, WITHOUT THE ASSAY. The coupling map, the average-linkage
 * dendrogram, the best threshold, the strip, the table, the graph and the
 * naming client are all K1–K3b, copied from `filter.js` and used unchanged;
 * the threshold slider sweeps the same 0.20–0.70 band at the same 0.005 step
 * and starts wherever `bestWagonThresh` says this haul splits best. What is new
 * is the topic bar above the strip and the fallback label below it.
 *
 * THE BAR IS THE NIGHT'S SHAPE IN TWELVE TOPICS. Each parent's width is the
 * count of tonight's papers whose *primary* topic is one of its leaves, and
 * hovering (or tapping, or focusing) it lists the leaves underneath. With it,
 * an unnamed wagon still reads: "Wagon 3" is at least in Computing.
 *
 * AN UNNAMED WAGON IS NOT A BLANK. `fallbackWagonName` labels it with its most
 * common leaf label, so the strip, the table and the graph say "Quantum machine
 * learning" before anyone spends a call on naming, and keep the LLM's name once
 * there is one. Names are cached by `wagonKey` in localStorage, the same key the
 * endpoint caches under, so a re-cut or a reload does not pay twice.
 */
import { escapeHtml, readStore, writeStore } from './sieve-ui.mjs';
import {
  WAGON_THRESH, bestWagonThresh, buildDendrogram, clusterOrder, computeWagonMap,
} from './cave-wagons.mjs';
import {
  nameWagons, trainStripHtml, wagonKey, wagonTableHtml, wireTrainStrip,
} from './cave-wagon-views.mjs';
import { WAGON_GRAPH_HINT, mountWagonGraph } from './cave-wagon-graph.mjs';

/** Where named wagons are remembered, keyed by `wagonKey`. */
const NAMES_KEY = 'arxave-cave-wagon-names';

/**
 * Tonight's papers counted per topic parent, largest first.
 *
 * `night.topic` is a leaf index per stone (`-1` when nothing was assigned), and
 * `topics.parentOf` maps a leaf to its parent. A paper counts once, for its
 * primary topic's parent — the secondary is the runner-up and counting it again
 * would make the bar sum to more papers than the night has. Leaves carry their
 * own counts so the bar can say where inside a parent the night actually is;
 * leaves with nothing in them are left out rather than padding the list.
 */
export function topicBar(night, topics) {
  if (!night || !night.stones || !night.topic || !topics) return [];
  if (!Array.isArray(topics.parents) || !topics.parents.length) return [];
  /* No leaves means nothing can carry a topic, so there is no bar to draw. */
  if (!Array.isArray(topics.leaves) || !topics.leaves.length) return [];

  const rows = new Map();
  for (const parent of topics.parents) {
    rows.set(parent.id, { parent: parent.id, label: parent.label, count: 0, leaves: [] });
  }
  const leafRow = new Map();
  for (let i = 0; i < topics.leaves.length; i += 1) {
    const leaf = topics.leaves[i];
    const row = rows.get(leaf.parent);
    if (!row) continue;
    const entry = { id: leaf.id, label: leaf.label, count: 0 };
    row.leaves.push(entry);
    leafRow.set(i, entry);
  }

  const total = Math.min(night.stones.length, night.topic.length);
  for (let i = 0; i < total; i += 1) {
    const index = night.topic[i];
    if (index == null || index < 0) continue;
    const entry = leafRow.get(index);
    if (!entry) continue;
    rows.get(topics.leaves[index].parent).count += 1;
    entry.count += 1;
  }

  return [...rows.values()]
    .map((row) => ({
      parent: row.parent,
      label: row.label,
      count: row.count,
      leaves: row.leaves
        .filter((leaf) => leaf.count > 0)
        .sort((a, b) => b.count - a.count),
    }))
    .sort((a, b) => b.count - a.count);
}

/**
 * The label a wagon falls back to when the LLM has not named it: its most
 * common leaf among its members' primary topics. Ties keep the first label
 * reached, the same rule `topCategory` uses, so the label is stable across
 * re-renders. '' when nothing inside the wagon carries a topic.
 */
export function fallbackWagonName(members, night, topics) {
  if (!night || !night.topic || !topics || !members || !members.length) return '';
  const counts = new Map();
  for (const member of members) {
    const index = night.topic[member];
    if (index == null || index < 0) continue;
    const leaf = topics.leaves[index];
    if (!leaf) continue;
    counts.set(leaf.label, (counts.get(leaf.label) || 0) + 1);
  }
  let best = '';
  let bestN = 0;
  for (const [label, count] of counts) {
    if (count > bestN) {
      best = label;
      bestN = count;
    }
  }
  return best;
}

/**
 * The contract's stones (id / title / authors / cat / link) in the shape the
 * K2–K3 wagon modules read (`arxiv_id`, `abs_url`, `primary_category`), which
 * is `filter.js`'s stone. One mapping per night, not per render.
 */
function wagonStones(night) {
  return night.stones.map((stone) => ({
    ...stone,
    arxiv_id: stone.id,
    abs_url: stone.link,
    primary_category: stone.cat,
  }));
}


/* ── the stage ──────────────────────────────────────────────────────────── */

export function mount(body, ctx) {
  if (!body || !ctx) return;

  body.innerHTML =
    '<div class="cave-map">' +
      '<div class="cave-topic-bar" role="group" aria-label="Tonight by topic"></div>' +
      '<p class="hint cave-map-empty">Dig first — tonight\'s papers arrive here as wagons.</p>' +
      '<div class="wagon-header">' +
        '<span class="wagon-title">The train</span>' +
        '<span class="wagon-stats"></span>' +
        '<div class="wagon-view-switch">' +
          '<button type="button" class="wagon-view-btn is-active" data-view="table">Table</button>' +
          '<button type="button" class="wagon-view-btn" data-view="graph">Graph</button>' +
        '</div>' +
        '<label class="wagon-thresh-label">Threshold' +
          '<input type="range" class="wagon-thresh-slider" min="0.20" max="0.70" step="0.005" value="' +
            WAGON_THRESH + '">' +
          '<span id="wagon-thresh-value">' + WAGON_THRESH.toFixed(2) + '</span>' +
        '</label>' +
        '<button type="button" class="wagon-name-btn">Name the wagons</button>' +
      '</div>' +
      '<div class="wagon-name-status" role="status"></div>' +
      '<div class="cave-strip"></div>' +
      '<div class="wagon-graph-wrap" style="display:none">' +
        '<canvas></canvas>' +
        '<div class="wagon-graph-hint">' + escapeHtml(WAGON_GRAPH_HINT) + '</div>' +
      '</div>' +
      '<div class="wagon-table-wrap"></div>' +
      '<div class="wagon-readout"></div>' +
      '<div class="button-bar cave-map-continue">' +
        '<button type="button" class="cave-continue-btn cave-primary" disabled>Continue to the fire</button>' +
      '</div>' +
    '</div>';

  /* The strip's tooltip: one per page, fixed-position (filter.css), driven by
     `wireTrainStrip`. Appended next to the map rather than inside the strip,
     which clips its overflow. */
  const tip = document.createElement('div');
  tip.className = 'cell-tooltip wagon-tooltip';
  tip.setAttribute('role', 'tooltip');
  tip.style.display = 'none';
  body.appendChild(tip);

  const topicBarEl = body.querySelector('.cave-topic-bar');
  const emptyEl = body.querySelector('.cave-map-empty');
  const statsEl = body.querySelector('.wagon-stats');
  const switchEl = body.querySelector('.wagon-view-switch');
  const sliderEl = body.querySelector('.wagon-thresh-slider');
  const valueEl = body.querySelector('#wagon-thresh-value');
  const nameBtn = body.querySelector('.wagon-name-btn');
  const nameStatus = body.querySelector('.wagon-name-status');
  const stripWrap = body.querySelector('.cave-strip');
  const graphWrap = body.querySelector('.wagon-graph-wrap');
  const graphCanvas = graphWrap.querySelector('canvas');
  const tableWrap = body.querySelector('.wagon-table-wrap');
  const readoutEl = body.querySelector('.wagon-readout');
  const continueBtn = body.querySelector('.cave-continue-btn');

  if (!ctx.config.nameUrl) nameBtn.style.display = 'none';

  const state = {
    night: null,
    stones: [],
    S: null,
    merges: null,
    thresh: WAGON_THRESH,
    components: [],
    names: [],          // the LLM's names, parallel to components
    keys: [],           // this cut's wagonKeys, parallel to components
    labels: [],         // what the views print: name, else the topic fallback
    view: 'table',
    graph: null,
    gen: 0,             // guards the async name lookups against a newer cut
    naming: false,
  };

  /* Names already paid for, keyed by `wagonKey` — the same hash the endpoint
     itself caches under, so a name is fetched once across cuts, reloads and
     nights. Read once, written after every naming. */
  const named = new Map(Object.entries(readStore(ctx.storage, NAMES_KEY, {}) || {}));

  /* ponytail: the map is bounded at 400 wagons rather than indexed by date —
     an old name costs one string, and 400 of them is still a few kB. If this
     ever becomes a storage problem, key it by night date instead. */
  function rememberName(key, name) {
    if (!key || !name) return;
    named.set(key, name);
    while (named.size > 400) named.delete(named.keys().next().value);
    writeStore(ctx.storage, NAMES_KEY, Object.fromEntries(named));
  }

  /** What each wagon prints: its name, else its most common topic, else null. */
  function labelsFor(components, names) {
    return components.map((comp, i) => names[i]
      || fallbackWagonName(comp.indices, state.night, ctx.topics)
      || null);
  }

  function topicBarHtml(rows) {
    const shown = rows.filter((row) => row.count > 0);
    if (!shown.length) return '';
    const total = shown.reduce((sum, row) => sum + row.count, 0);
    return shown.map((row) =>
      '<button type="button" class="cave-topic-seg" style="flex-grow:' + row.count + '"' +
        ' data-topic="' + escapeHtml(row.parent) + '"' +
        ' aria-label="' + escapeHtml(row.label) + ' — ' + row.count + ' of ' + total + ' papers">' +
        '<span class="cave-topic-name">' + escapeHtml(row.label) + '</span>' +
        '<span class="cave-topic-count">' + row.count + '</span>' +
        '<span class="cave-topic-leaves">' +
          (row.leaves.map((leaf) => escapeHtml(leaf.label) + ' ' + leaf.count).join(' · ') || 'no papers') +
        '</span>' +
      '</button>').join('');
  }



  function readoutSink(html, pinned) {
    readoutEl.innerHTML = html || '';
    readoutEl.classList.toggle('pinned', !!pinned);
  }

  /* A fresh strip per render, so the tooltip wiring can never be doubled and
     never describes the previous cut. The element is cheap; a stale handler is
     not. */
  function renderStrip() {
    const strip = document.createElement('div');
    strip.className = 'train-strip';
    strip.innerHTML = trainStripHtml({
      stones: state.stones,
      components: state.components,
      names: state.labels,
    });
    stripWrap.replaceChildren(strip);
    wireTrainStrip(strip, tip, {
      stones: state.stones,
      components: state.components,
      names: state.labels,
      onPick: pickWagon,
    });
  }

  function renderView() {
    if (state.graph) {
      state.graph.destroy();
      state.graph = null;
    }
    const isGraph = state.view === 'graph';
    graphWrap.style.display = isGraph ? '' : 'none';
    tableWrap.style.display = isGraph ? 'none' : '';

    if (isGraph) {
      tableWrap.innerHTML = '';
      /* Width from the wrap, as Dig does: the canvas is sized in pixels, so it
         has to be told the column's width rather than guessing 640. */
      const width = Math.max(320, graphWrap.clientWidth || 640);
      state.graph = mountWagonGraph(graphCanvas, {
        S: state.S,
        stones: state.stones,
        components: state.components,
        names: state.labels,
        readout: readoutSink,
        opts: { width, height: 420, thresh: state.thresh },
      });
    } else {
      readoutSink('', false);
      tableWrap.innerHTML = wagonTableHtml({
        stones: state.stones,
        components: state.components,
        names: state.labels,
        central: state.S,
      });
    }
  }

  /** Repaint everything from state, and tell the page the wagons moved. */
  function paint() {
    if (!state.night) return;
    topicBarEl.innerHTML = topicBarHtml(topicBar(state.night, ctx.topics));
    const k = state.components.length;
    statsEl.textContent = k + ' wagon' + (k === 1 ? '' : 's') + ' · ' +
      state.stones.length + ' papers · cut at ' + state.thresh.toFixed(2);
    renderStrip();
    renderView();
    state.night.components = state.components;
    state.night.names = state.labels;
    ctx.bus.dispatchEvent(new CustomEvent('wagons', {
      detail: { components: state.components, names: state.labels },
    }));
  }

  /** Click a wagon on the strip → its table, open at that wagon. */
  function pickWagon(key) {
    state.view = 'table';
    for (const btn of switchEl.querySelectorAll('.wagon-view-btn')) {
      btn.classList.toggle('is-active', btn.getAttribute('data-view') === 'table');
    }
    paint();

  /**
   * Cut the dendrogram at the current threshold, repaint, then quietly look
   * the new wagons up in the name cache.
   *
   * The look-up is async (SHA-256) and generation-guarded: a reader dragging
   * the threshold produces a cut per input event, and only the newest one's
   * names may land.
   */
  function cut() {
    const cluster = clusterOrder(state.stones, state.S, state.merges, state.thresh);
    state.components = cluster.components;
    state.names = cluster.components.map(() => null);
    state.keys = cluster.components.map(() => null);
    state.labels = labelsFor(state.components, state.names);
    state.gen += 1;
    paint();
    attachNames(state.gen);
  }

  async function attachNames(gen) {
    if (!state.components.length) return;
    /* An http:// origin has no crypto.subtle: no keys, so no cached names, so
       the wagons keep their topic labels. Not an error — a fallback. */
    if (!globalThis.crypto || !globalThis.crypto.subtle) return;
    const keys = [];
    const names = [];
    for (const comp of state.components) {
      let key = null;
      try {
        key = await wagonKey(comp.indices, state.stones);
      } catch (_) {
        key = null;
      }
      keys.push(key);
      names.push(key ? (named.get(key) || null) : null);
    }
    if (gen !== state.gen) return;
    state.keys = keys;
    state.names = names;
    state.labels = labelsFor(state.components, names);
    paint();
  }

  /** A new night: cluster it once, at the threshold that suits this haul. */
  function setNight(night) {
    if (!night || !Array.isArray(night.stones) || !night.stones.length) return;
    state.night = night;
    state.stones = wagonStones(night);
    emptyEl.hidden = true;
    continueBtn.disabled = false;

    if (state.stones.length < 2) {
      /* One paper has no coupling to anyone: nothing to cut, nothing to name.
         The previous night's matrix must not linger behind it. */
      state.S = null;
      state.merges = null;
      state.components = [];
      state.labels = [];
      paint();
      return;
    }

    state.S = computeWagonMap(night.vecs);
    state.merges = buildDendrogram(state.S, state.stones.length);
    state.thresh = bestWagonThresh(state.merges, state.stones.length);
    sliderEl.value = String(state.thresh);
    valueEl.textContent = state.thresh.toFixed(2);
    cut();
  }

  /** Ask the endpoint to name every wagon, then cache the names by key. */
  async function nameThem() {
    const url = ctx.config.nameUrl;
    if (!url || state.naming || !state.components.length) return;
    state.naming = true;
    nameBtn.disabled = true;
    nameStatus.classList.remove('is-error');
    nameStatus.textContent = 'Asking what each wagon is about…';
    const gen = state.gen;
    try {
      const got = await nameWagons({ url, stones: state.stones, components: state.components });
      if (gen !== state.gen) return;      // re-cut while the request was out
      let found = 0;
      for (let i = 0; i < got.length; i += 1) {
        if (!got[i]) continue;
        state.names[i] = got[i];
        found += 1;
        const key = state.keys[i] || await wagonKey(state.components[i].indices, state.stones);
        rememberName(key, got[i]);
      }
      state.labels = labelsFor(state.components, state.names);
      paint();
      nameStatus.textContent = found ? '' : 'No names came back — the wagons keep their topics.';
    } catch (err) {
      nameStatus.classList.add('is-error');
      nameStatus.textContent = (err && err.message) || String(err);
    } finally {
      state.naming = false;
      nameBtn.disabled = false;
    }
  }

  /* ── wiring ────────────────────────────────────────────────────────── */

  switchEl.addEventListener('click', (event) => {
    const btn = event.target.closest ? event.target.closest('.wagon-view-btn') : null;
    if (!btn) return;
    const view = btn.getAttribute('data-view');
    if (view === state.view) return;
    state.view = view;
    for (const other of switchEl.querySelectorAll('.wagon-view-btn')) {
      other.classList.toggle('is-active', other === btn);
    }
    renderView();
  });

  sliderEl.addEventListener('input', () => {
    state.thresh = Number(sliderEl.value);
    valueEl.textContent = state.thresh.toFixed(2);
    if (state.night) cut();
  });

  nameBtn.addEventListener('click', nameThem);

  continueBtn.addEventListener('click', () => {
    if (!state.night || ctx.flow.status('map') === 'locked') return;
    const k = state.components.length;
    const top = topicBar(state.night, ctx.topics)[0];
    ctx.flow.complete('map', k + ' wagon' + (k === 1 ? '' : 's') + ' · ' +
      (top ? top.label : 'no topic'));
  });

  ctx.bus.addEventListener('night', (event) => setNight(event.detail));
  if (ctx.night) setNight(ctx.night);
}

    const block = body.querySelector('#wagon-block-' + key);
    if (block && block.scrollIntoView) block.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
