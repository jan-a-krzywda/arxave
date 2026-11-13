/**
 * cave — the v4 page shell: one rail, seven stage cards, and the modules each
 * card mounts.
 *
 * WHAT THIS FILE OWNS. The flow (from `cave-flow.mjs`), the shared `ctx` the
 * stage modules read and write, the corpus / topics / axes load, the rail, the
 * fold state of every card, and the dynamic import that puts a stage module into
 * its body. It does not own a single control inside a stage: stages own their
 * own markup, the way `cave-stage-dig.mjs` owns the form and `cave-stage-map.mjs`
 * owns the wagons.
 *
 * A MISSING MODULE IS NOT AN ERROR. K6–K15 land after this card, so most stage
 * modules do not exist yet; the import is wrapped and a stage whose file or
 * mount is absent gets a "Coming soon" body instead of a broken page. That also
 * covers a deploy where the module 404s, which is the same shape of failure.
 *
 * THE PURE HALF IS EXPORTED. `stageRailHtml` is the rail as a string, so the
 * height of the stepper can be tested without a document — `scripts/
 * cave-stages-dig-map.test.mjs` holds it to the three states and the order. The
 * page itself is behind one `typeof document` guard, exactly as v3's cave.js
 * was, because `node --test` imports this file.
 *
 * THE RAIL IS A SHAFT. Going down the stages is going down a mine, so from
 * 900 px up the stepper is a lift shaft: a ledge per floor, and one cage parked
 * at the floor being worked on (`--lift-floor`, moved by cave.css). Nothing in
 * the markup is stateful — the shell keeps the one `.cave-lift` element and
 * rewrites its floor, which is what lets the cage slide instead of jump.
 */
import { STAGES, createFlow } from './cave-flow.mjs';
import { loadAxes, loadCorpus, loadTopics } from './sieve-core.mjs';
import { escapeHtml, joinUrl, loadCorpusFrom } from './sieve-ui.mjs';

/** The words the stage heads and the rail use, in `STAGES` order. */
export const STAGE_NAMES = Object.freeze({
  dig: 'Dig',
  train: 'Train',
  map: 'Map',
  priorities: 'Priorities',
  ranking: 'Ranking',
  act: 'Act',
  story: 'Story',
});

/** The module each stage mounts, and the export to call from it. */
export const STAGE_MODULES = Object.freeze({
  dig: { file: './cave-stage-dig.mjs', mount: 'mountDig' },
  train: { file: './cave-stage-dig.mjs', mount: 'mountTrain' },
  map: { file: './cave-stage-map.mjs', mount: 'mount' },
  priorities: { file: './cave-stage-priorities.mjs', mount: 'mount' },
  ranking: { file: './cave-stage-ranking.mjs', mount: 'mount' },
  act: { file: './cave-stage-act.mjs', mount: 'mount' },
  story: { file: './cave-stage-story.mjs', mount: 'mount' },
});

/** The cage drawing: site-root, like `cave-art.mjs`, so any page path works. */
const LIFT_ART = '/assets/cave-art/lift.svg';

/**
 * The rail, as markup, from a flow snapshot (`{ done: { id: summary }, … }`)
 * and the stage order.
 *
 * A stage is done when the snapshot says so, open when it is the first one not
 * done, and locked otherwise — the same three answers `flow.status` gives, derived
 * again here so the stepper never has to hold a second copy of the machine.
 * A done step carries its summary line, which is what makes the rail a whole
 * night at a glance rather than seven ledges.
 *
 * The list is wrapped in the shaft that cave.css draws the rails and sleepers
 * on, and the one lift carries the floor the cage rests at. The cage's drawing
 * is decoration: the floor's name and state are already in the link beside it.
 */
export function stageRailHtml(snapshot, stages = STAGES) {
  return '<div class="cave-lift-shaft">' +
      '<ol class="cave-rail-list">' + stageRailStepsHtml(snapshot, stages) + '</ol>' +
      '<div class="cave-lift" style="--lift-floor: ' + liftFloor(snapshot, stages) + '" aria-hidden="true">' +
        '<span class="cave-lift-cable"></span>' +
        '<img class="cave-lift-cage" src="' + LIFT_ART + '" width="48" height="48" alt="">' +
      '</div>' +
    '</div>';
}

/**
 * The floors: one `<li>` per stage, in `stages` order.
 *
 * Split out because the shell repaints the list on every flow change while the
 * lift beside it has to survive the repaint to keep its transition.
 */
function stageRailStepsHtml(snapshot, stages) {
  const done = snapshot && typeof snapshot.done === 'object' && snapshot.done ? snapshot.done : {};
  const steps = [];
  let seenOpen = false;
  for (const id of stages) {
    const isDone = Object.prototype.hasOwnProperty.call(done, id);
    let state = 'locked';
    if (isDone) state = 'done';
    else if (!seenOpen) {
      state = 'open';
      seenOpen = true;
    }
    const name = STAGE_NAMES[id] || id;
    const summary = isDone ? String(done[id] ?? '') : '';
    steps.push(
      '<li class="cave-rail-step is-' + state + '">' +
        '<a class="cave-rail-link" href="#stage-' + escapeHtml(id) + '"' +
          (state === 'open' ? ' aria-current="step"' : '') + '>' +
          '<span class="cave-rail-dot" aria-hidden="true"></span>' +
          '<span class="cave-rail-name">' + escapeHtml(name) + '</span>' +
          (summary ? '<span class="cave-rail-summary">' + escapeHtml(summary) + '</span>' : '') +
        '</a>' +
      '</li>',
    );
  }
  return steps.join('');
}

/**
 * The floor the cage parks at: the index of the open stage, or the bottom floor
 * once the whole night is done (`0` for a rail with nothing done yet).
 */
function liftFloor(snapshot, stages) {
  const done = snapshot && typeof snapshot.done === 'object' && snapshot.done ? snapshot.done : {};
  const open = stages.findIndex((id) => !Object.prototype.hasOwnProperty.call(done, id));
  return open === -1 ? Math.max(0, stages.length - 1) : open;
}

/** The one way this file asks the document for an element. */
const byId = (id) => document.getElementById(id);

if (typeof document !== 'undefined') startPage();

function startPage() {
  /* The same endpoints and overrides docs/assets/sieve.js and filter.js carry,
     so a reader who pointed one page at their own pick gets it here too. */
  const FUNCTIONS_BASE = 'https://ugxxakguqgpxpdfhgtsb.supabase.co/functions/v1';
  const CORPUS_BASE = window.ARXAVE_CORPUS_BASE || '/assets/corpus/';

  const config = {
    functionsBase: FUNCTIONS_BASE,
    relayUrl: window.ARXAVE_RELAY || (FUNCTIONS_BASE + '/relay'),
    embedUrl: window.ARXAVE_EMBED || (FUNCTIONS_BASE + '/embed'),
    cacheUrl: window.ARXAVE_DIG_CACHE === false
      ? null
      : (window.ARXAVE_DIG_CACHE || (FUNCTIONS_BASE + '/dig-cache')),
    nameUrl: window.ARXAVE_WAGON_NAME === false
      ? null
      : (window.ARXAVE_WAGON_NAME || (FUNCTIONS_BASE + '/wagon-name')),
    discussionsRepo: window.ARXAVE_DISCUSSIONS_REPO || '',
    discussionsCategory: window.ARXAVE_DISCUSSIONS_CATEGORY || '',
  };

  let storage = null;
  try {
    storage = window.localStorage;
  } catch (_) {
    /* private mode: the page works, it just forgets between visits */
  }

  const flow = createFlow({ storage });

  const ctx = {
    flow,
    bus: new EventTarget(),
    config,
    corpus: null,     // null when the corpus failed to load — stages must cope
    topics: null,
    axes: null,
    night: null,
    prefs: null,
    ranked: [],
    picks: new Set(),
    storage,
  };

  /* ── the rail and the folds ─────────────────────────────────────────── */

  function paint() {
    for (const id of STAGES) {
      const section = byId('stage-' + id);
      if (!section) continue;
      const state = flow.status(id);
      const openNow = flow.expanded(id);
      section.classList.toggle('is-done', state === 'done');
      section.classList.toggle('is-open', state === 'open');
      section.classList.toggle('is-locked', state === 'locked');
      section.classList.toggle('is-expanded', openNow);
      const head = section.querySelector('.cave-stage-head');
      if (head) head.setAttribute('aria-expanded', String(openNow));
      const summary = section.querySelector('.cave-stage-summary');
      if (summary) summary.textContent = flow.summary(id) || '';
    }
    /* The fire is lit from Priorities down: that card is the first one in the
       glow, so its becoming reachable is the moment the page warms up. The
       wash itself lives in cave-priorities.css. */
    const app = byId('cave-app');
    if (app) app.classList.toggle('cave-lit', flow.status('priorities') !== 'locked');
    paintRail(flow.snapshot());
  }

  /**
   * The rail is redrawn on every flow change, but the lift is not.
   *
   * Replacing the rail's innerHTML would hand the page a brand-new `.cave-lift`
   * already sitting at its new floor, and a fresh element has no previous
   * transform to animate from — the cage would jump. So the list is rewritten
   * and the one lift is kept, with only its `--lift-floor` updated: CSS does
   * the rest of the descent, and the cable shortens with it.
   */
  function paintRail(snapshot) {
    const rail = byId('cave-rail');
    if (!rail) return;
    const lift = rail.querySelector('.cave-lift');
    if (!lift) {
      rail.innerHTML = stageRailHtml(snapshot, STAGES);
      return;
    }
    lift.style.setProperty('--lift-floor', String(liftFloor(snapshot, STAGES)));
    const list = rail.querySelector('.cave-rail-list');
    if (list) list.innerHTML = stageRailStepsHtml(snapshot, STAGES);
  }

  function wireFolds() {
    for (const id of STAGES) {
      const section = byId('stage-' + id);
      if (!section) continue;
      const head = section.querySelector('.cave-stage-head');
      if (head) {
        head.addEventListener('click', () => {
          if (flow.status(id) === 'locked') return;
          flow.toggle(id);
        });
      }
    }

    /* The rail is a shortcut into the page, not a second set of state: it
       scrolls to the card and opens it if it was folded. A locked card is not
       a destination yet. */
    const rail = byId('cave-rail');
    if (rail) {
      rail.addEventListener('click', (event) => {
        const link = event.target.closest ? event.target.closest('.cave-rail-link') : null;
        if (!link) return;
        event.preventDefault();
        const id = String(link.getAttribute('href') || '').replace(/^#stage-/, '');
        if (!STAGES.includes(id) || flow.status(id) === 'locked') return;
        if (!flow.expanded(id)) flow.toggle(id);
        const section = byId('stage-' + id);
        if (section && section.scrollIntoView) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
  }

  /* ── the small notice under the cards ───────────────────────────────── */

  function notice(text) {
    const el = byId('cave-notice');
    if (!el) return;
    el.textContent = text || '';
    el.hidden = !text;
  }

  /* A stage that has something small and page-level to say (a category feed
     that failed while the rest of the night arrived) says it here, above the
     cards, instead of burying it in a card that just folded. */
  ctx.notice = notice;

  /* ── corpus, topics, axes ───────────────────────────────────────────── */

  async function fetchJson(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(url + ' answered HTTP ' + resp.status);
    return resp.json();
  }

  async function loadWorld() {
    const [files, topicsJson, axesJson] = await Promise.all([
      loadCorpusFrom(CORPUS_BASE).catch((err) => ({ error: err })),
      fetchJson(joinUrl(CORPUS_BASE, 'topics.json')).catch(() => null),
      fetchJson(joinUrl(CORPUS_BASE, 'axes.json')).catch(() => null),
    ]);

    if (files && files.error) {
      ctx.corpus = null;
      notice('No corpus on this build, so ranking and landmarks wait — the dig and the map still work. '
        + ((files.error && files.error.message) || ''));
    } else {
      try {
        ctx.corpus = loadCorpus(files.json, files.bin);
        if (Array.isArray(files.json.topic)) ctx.corpus.topic = Int32Array.from(files.json.topic);
        if (Array.isArray(files.json.topic2)) ctx.corpus.topic2 = Int32Array.from(files.json.topic2);
      } catch (err) {
        ctx.corpus = null;
        notice('The corpus would not load: ' + ((err && err.message) || err));
      }
    }

    if (topicsJson) {
      try {
        ctx.topics = loadTopics(topicsJson);
      } catch (err) {
        ctx.topics = null;
        notice('topics.json would not load, so the night cannot be filed by topic: '
          + ((err && err.message) || err));
      }
    }

    if (axesJson) {
      try {
        ctx.axes = loadAxes(axesJson);
      } catch (_) {
        ctx.axes = null;   // both axes then ship:false, which is the safe silence
      }
    }
  }

  /* ── mounting ───────────────────────────────────────────────────────── */

  async function mountStage(id) {
    const section = byId('stage-' + id);
    const body = section && section.querySelector('.cave-stage-body');
    if (!body) return;
    const spec = STAGE_MODULES[id];
    try {
      const mod = await import(spec.file);
      const mount = mod[spec.mount];
      if (typeof mount !== 'function') throw new Error('no ' + spec.mount + ' export');
      mount(body, ctx);
    } catch (err) {
      /* Not built yet, or not deployed. Either way the page goes on. */
      body.innerHTML = '<p class="cave-stage-coming">Coming soon.</p>';
    }
  }

  /* ── boot ───────────────────────────────────────────────────────────── */

  wireFolds();
  flow.onChange(paint);
  paint();

  /* Sequential on purpose: the dig mounts before the train it hands progress
     to, and stage order is what a reader sees if a mount is slow. */
  loadWorld().finally(async () => {
    for (const id of STAGES) await mountStage(id);
  });
}

