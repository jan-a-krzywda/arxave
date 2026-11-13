/**
 * cave-stage-priorities — stage 5: what you care about, how much, and which
 * topics tonight is allowed to be about.
 *
 * THIS IS v3'S LEFT COLUMN, GIVEN THE NIGHT'S NUMBERS. The box, the three
 * sliders, the four-way topic dropdowns, the chips and the settings codec are
 * v3's (`docs/assets/cave.js` on `origin/main`), copied rather than imported
 * because this stage owns its markup the same way every other v4 stage does.
 * What is new is the tree: a parent row shows how many of tonight's papers are
 * filed under it, a leaf overrides its parent, and clicking a leaf opens the
 * wagons that landed there. A weight bar beside each dropdown draws what the
 * choice actually weighs (1.5 / 1 / 0.5 / 0), so "Prefer" is not a word the
 * reader has to take on trust.
 *
 * COUNTS ARE PRIMARY-ONLY, on purpose. `night.topic` is one leaf per paper;
 * counting `topic2` as well would make the tree's numbers add up to more
 * papers than the night has. The map's topic bar makes the same call.
 *
 * THE BOX IS THE ONLY THING THAT CAN COST A CALL. Its words are embedded with
 * `embedTexts` (no shared cache — typed text is not a corpus paper) 600 ms
 * after the last keystroke, and only when the collapsed words changed. The
 * vectors are centred with the corpus mean and handed on as touchstones; they
 * are persisted beside the settings so a reload does not pay for the same
 * sentence twice. If the words are unchanged, nothing is fetched.
 *
 * A MISSING WORLD IS A SENTENCE, NOT A CRASH. Without the corpus or
 * `topics.json` there is nothing to weigh, and the stage says so in one muted
 * line. Without a night the tree still works — counts read "—" until Dig
 * hands a `night` over the bus.
 *
 * MORE LIKE THIS / LESS LIKE THIS lives here too, because it is a priority the
 * reader sets, not a paper they pick. The Act stage dispatches a `nudge`
 * ({ id, sign }); `applyNudge` from `cave-nudge.mjs` keeps `prefs.more` and
 * `prefs.less` disjoint and this stage draws them as removable chips beside the
 * topic chips. The lists persist with the rest of the prefs, so a dislike
 * survives a reload the way a topic weight does.
 *
 * Pure helpers sit above `mount` so `node --test` can hold the arithmetic and
 * the codec: counts, leaf → wagons, weights, the one-line summary, and the
 * serialise/parse pair v3's tests already covered.
 */
import { applyNudge } from './cave-nudge.mjs';
import { centreUnit, defaultSetting } from './sieve-core.mjs';
import {
  cacheKeyText, embedTexts, escapeHtml, readStore, writeStore,
} from './sieve-ui.mjs';

/** The stage's entry in `ctx.storage`. */
export const STORE_KEY = 'arxave-cave-v4-prefs';

/** The four dropdown settings, in the order topics.json uses. */
export const CHOICES = Object.freeze(['equal', 'prefer', 'avoid', 'off']);
export const CHOICE_LABEL = Object.freeze({
  equal: 'Equal', prefer: 'Prefer', avoid: 'Avoid', off: 'Off',
});

/** The sliders' ranges and defaults, shared by the page and the codec. */
export const SLIDERS = Object.freeze({
  match: Object.freeze({ min: 0, max: 100, value: 50 }),
  surprise: Object.freeze({ min: 0, max: 100, value: 50 }),
  expTheory: Object.freeze({ min: -100, max: 100, value: 0 }),
});

/** The spec's four weights: equal 1, prefer 1.5, avoid 0.5, off 0. */
const WEIGHT = Object.freeze({ equal: 1, prefer: 1.5, avoid: 0.5, off: 0 });

/** A choice → its scoring weight. An unknown choice is equal, never deleted. */
export function weightOf(choice) {
  return WEIGHT[choice] ?? WEIGHT.equal;
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** A stored/typed number, clamped; anything unreadable falls back. '' is not 0. */
function number(raw, fallback, lo, hi) {
  if (raw === null || raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? clamp(n, lo, hi) : fallback;
}

/** A setting string we did not write is `equal` (see sieve-core's topicWeights). */
const choiceOf = (raw) => (CHOICES.includes(raw) ? raw : 'equal');

/** topics null is not a reason to throw a codec; it just has no tree. */
const settingFor = (topics) => (topics ? defaultSetting(topics) : { leaves: {} });

/**
 * The state a first visit starts from: the tree's own default (Computing
 * prefer, everything else equal), the sliders at their middles, no words.
 */
export function defaultPrefs(topics) {
  return {
    setting: settingFor(topics),
    sliders: {
      match: SLIDERS.match.value,
      surprise: SLIDERS.surprise.value,
      expTheory: SLIDERS.expTheory.value,
    },
    touchstones: [],
    text: '',
    ml4q: false,
  };
}

/** Every parent equal and no leaf overrides — "clear", not "reset". */
export function clearSetting(topics) {
  const setting = { leaves: {} };
  for (const parent of topics?.parents ?? []) setting[parent.id] = 'equal';
  return setting;
}

/**
 * Prefs → query string. Every parent differing from its own default, then
 * every leaf override, then the scalars. Text and vectors stay out: an
 * abstract in a query string is a privacy leak, and 768 floats are not a URL.
 */
export function serialisePrefs(topics, prefs) {
  const parts = [];
  const leaves = prefs?.setting?.leaves ?? {};
  for (const parent of topics?.parents ?? []) {
    const fallback = parent.default ?? 'equal';
    const choice = choiceOf(prefs?.setting?.[parent.id] ?? fallback);
    if (choice !== fallback) parts.push(`${parent.id}:${choice}`);
  }
  for (const leaf of topics?.leaves ?? []) {
    if (CHOICES.includes(leaves[leaf.id])) parts.push(`${leaf.id}:${leaves[leaf.id]}`);
  }

  const q = new URLSearchParams();
  q.set('topics', parts.join(','));
  q.set('match', String(number(prefs?.sliders?.match, SLIDERS.match.value, SLIDERS.match.min, SLIDERS.match.max)));
  q.set('surprise', String(number(prefs?.sliders?.surprise, SLIDERS.surprise.value, SLIDERS.surprise.min, SLIDERS.surprise.max)));
  q.set('exp', String(number(prefs?.sliders?.expTheory, SLIDERS.expTheory.value, SLIDERS.expTheory.min, SLIDERS.expTheory.max)));
  if (prefs?.ml4q) q.set('ml4q', '1');
  return q.toString();
}

/**
 * Query string → prefs. Anything missing, malformed or out of range falls
 * back; this string can come from a hand-edited URL or an older build.
 */
export function parsePrefs(topics, raw) {
  const q = new URLSearchParams(String(raw ?? ''));
  const prefs = defaultPrefs(topics);

  for (const entry of (q.get('topics') || '').split(',')) {
    const at = entry.indexOf(':');
    if (at < 0) continue;
    const id = entry.slice(0, at).trim();
    const value = entry.slice(at + 1).trim();
    if (!CHOICES.includes(value)) continue;
    if ((topics?.parents ?? []).some((p) => p.id === id)) prefs.setting[id] = value;
    else if (topics?.leafIndex?.has(id)) prefs.setting.leaves[id] = value;
  }

  prefs.sliders.match = number(q.get('match'), SLIDERS.match.value, SLIDERS.match.min, SLIDERS.match.max);
  prefs.sliders.surprise = number(q.get('surprise'), SLIDERS.surprise.value, SLIDERS.surprise.min, SLIDERS.surprise.max);
  prefs.sliders.expTheory = number(q.get('exp'), SLIDERS.expTheory.value, SLIDERS.expTheory.min, SLIDERS.expTheory.max);
  prefs.ml4q = q.get('ml4q') === '1';
  return prefs;
}

/**
 * A setting → the chips under the box. Every parent that is not `equal`
 * (the default tree already shows Computing · Prefer) and every leaf that
 * overrides its parent with a different value; a leaf repeating its parent
 * changes nothing, so it earns no chip.
 */
export function chipsFromSetting(topics, setting) {
  const out = [];
  for (const parent of topics?.parents ?? []) {
    const choice = choiceOf(setting?.[parent.id] ?? parent.default);
    if (choice !== 'equal') {
      out.push({ scope: 'parent', id: parent.id, label: parent.label, choice });
    }
  }

  const leaves = setting?.leaves ?? {};
  for (const leaf of topics?.leaves ?? []) {
    const choice = leaves[leaf.id];
    if (!CHOICES.includes(choice)) continue;
    const parent = topics.parents[topics.parentOf[topics.leafIndex.get(leaf.id)]];
    const inherited = choiceOf(setting?.[parent.id] ?? parent.default);
    if (choice === inherited) continue;
    out.push({ scope: 'leaf', id: leaf.id, parent: parent.id, label: leaf.label, choice });
  }
  return out;
}

/**
 * Dropping a chip undoes exactly that choice: a parent chip returns the parent
 * to `equal`, a leaf chip deletes the override so the leaf inherits again.
 * Nothing is mutated.
 */
export function removeChip(topics, setting, chip) {
  const next = { ...setting, leaves: { ...(setting?.leaves ?? {}) } };
  if (chip.scope === 'parent') next[chip.id] = 'equal';
  else delete next.leaves[chip.id];
  return next;
}

/**
 * A paper's title, cut to something a chip can hold at 360 px. Word boundaries
 * where there is one, an ellipsis always, and the empty string stays empty so
 * the caller can fall back to the id.
 */
export const NUDGE_TITLE_MAX = 40;

export function shortTitle(raw, max = NUDGE_TITLE_MAX) {
  const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
  const limit = Number.isFinite(Number(max)) && Number(max) > 4 ? Math.floor(Number(max)) : NUDGE_TITLE_MAX;
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit - 1);
  const space = cut.lastIndexOf(' ');
  const kept = space > limit * 0.5 ? cut.slice(0, space) : cut;
  return kept.replace(/[,.;:]+$/, '') + '…';
}

/**
 * The nudge chips, more first, then less: `[{ sign, id, label, title }]`.
 * `titleOf` is a function (id → full title) so the page can look in tonight's
 * stones and the ranking, and a test can hand over a plain lookup.
 */
export function nudgeChips(prefs, titleOf) {
  const titleFor = typeof titleOf === 'function' ? titleOf : () => '';
  const out = [];
  for (const [sign, ids] of [[1, prefs?.more], [-1, prefs?.less]]) {
    for (const raw of Array.isArray(ids) ? ids : []) {
      const id = String(raw ?? '').trim();
      if (!id) continue;
      const full = String(titleFor(id) ?? '');
      out.push({ sign, id, label: sign > 0 ? 'more like' : 'less like', title: shortTitle(full) || id });
    }
  }
  return out;
}

/**
 * Tonight's primary topics counted per parent and per leaf, keyed by id.
 *
 * `night.topic` is a leaf index per stone (-1 when nothing was assigned), so
 * the secondary `topic2` is deliberately ignored: a paper belongs to one
 * parent in this count. Every known topic is present at 0, which is a count.
 */
export function treeCounts(night, topics) {
  const parents = {};
  const leaves = {};
  for (const parent of topics?.parents ?? []) parents[parent.id] = 0;
  for (const leaf of topics?.leaves ?? []) leaves[leaf.id] = 0;

  const assigned = night?.topic;
  if (!assigned || !Array.isArray(topics?.leaves)) return { parents, leaves };

  const total = night.stones && Array.isArray(night.stones)
    ? Math.min(assigned.length, night.stones.length)
    : assigned.length;
  for (let i = 0; i < total; i += 1) {
    const at = assigned[i];
    if (!Number.isInteger(at) || at < 0 || at >= topics.leaves.length) continue;
    const leaf = topics.leaves[at];
    if (!leaf) continue;
    if (Object.prototype.hasOwnProperty.call(leaves, leaf.id)) leaves[leaf.id] += 1;
    if (Object.prototype.hasOwnProperty.call(parents, leaf.parent)) parents[leaf.parent] += 1;
  }
  return { parents, leaves };
}

/** The most common leaf in one wagon; ties go to the lowest leaf index. */
function mainLeaf(night, indices) {
  const tally = new Map();
  for (const at of indices) {
    const topic = night.topic?.[at];
    if (!Number.isInteger(topic) || topic < 0) continue;
    tally.set(topic, (tally.get(topic) ?? 0) + 1);
  }
  let best = -1;
  let bestCount = 0;
  for (const [topic, count] of tally) {
    if (count > bestCount || (count === bestCount && topic < best)) {
      best = topic;
      bestCount = count;
    }
  }
  return best;
}

/**
 * The wagons whose most common leaf is `leafId`, as `{ index, name, size }`.
 *
 * `index` is the wagon's place in `night.components` — the same index the map
 * and the names array use, so a later stage can point at the same wagon. The
 * name is the LLM's when there is one, else "Wagon 3"; a wagon with no topic
 * at all belongs under no leaf and is left out.
 */
export function wagonsForLeaf(night, topics, leafId) {
  if (!night || !Array.isArray(night.components) || !night.topic) return [];
  const leaves = topics?.leaves ?? [];
  const at = topics?.leafIndex?.get?.(leafId) ?? leaves.findIndex((leaf) => leaf.id === leafId);
  if (!Number.isInteger(at) || at < 0) return [];

  const out = [];
  night.components.forEach((component, index) => {
    const indices = Array.isArray(component?.indices) ? component.indices : [];
    if (!indices.length) return;
    if (mainLeaf(night, indices) !== at) return;
    const named = Array.isArray(night.names) ? night.names[index] : null;
    out.push({
      index,
      name: named || `Wagon ${index + 1}`,
      size: indices.length,
    });
  });
  return out;
}

const PAST_TENSE = Object.freeze({ prefer: 'preferred', avoid: 'avoided', off: 'off', equal: 'equal' });

/**
 * The one line stage 5 folds to: the applied topic choices, then Surprise.
 * "Computing preferred · surprise 50" at the shipped defaults.
 */
export function prefsSummary(topics, prefs) {
  const chips = chipsFromSetting(topics, prefs?.setting ?? settingFor(topics));
  const bits = chips.map((chip) => `${chip.label} ${PAST_TENSE[chip.choice] ?? chip.choice}`);
  if (!bits.length) bits.push('topics equal');
  const surprise = Number.isFinite(prefs?.sliders?.surprise)
    ? prefs.sliders.surprise
    : SLIDERS.surprise.value;
  bits.push(`surprise ${surprise}`);
  return bits.join(' · ');
}

/* ── the stage ──────────────────────────────────────────────────────────── */

/** Load this stage's stylesheet once; the page links none of its own. */
function ensureStyles() {
  const href = new URL('./cave-priorities.css', import.meta.url).href;
  if (!document.head || document.head.querySelector(`link[href="${href}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  document.head.appendChild(link);
}

/** A whole number slider label, e.g. "no preference" or "40 toward theory". */
function experimentText(value) {
  if (value === 0) return 'no preference';
  return Math.abs(value) + ' toward ' + (value < 0 ? 'experiment' : 'theory');
}

const plural = (n) => (n === 1 ? 'paper' : 'papers');

/** Ids out of the prefs store: strings, trimmed, deduplicated, order kept. */
const idListOf = (raw) => (Array.isArray(raw)
  ? [...new Set(raw.map((id) => String(id ?? '').trim()).filter(Boolean))]
  : []);


export function mount(body, ctx) {
  if (!body || !ctx) return;

  ensureStyles();

  /* Without the corpus there is no mean to centre words against; without
     topics there is no tree. One muted line beats eight broken controls. */
  if (!ctx.corpus || !ctx.topics) {
    body.innerHTML = '<p class="cave-priorities-muted">' + escapeHtml(
      !ctx.topics
        ? 'No topics.json on this build, so there is nothing to weigh tonight.'
        : 'No corpus on this build, so your words cannot be placed — priorities wait.',
    ) + '</p>';
    return;
  }

  const topics = ctx.topics;
  const saved = readStore(ctx.storage, STORE_KEY, null);
  const stored = saved && typeof saved === 'object' ? saved : {};
  const restored = parsePrefs(topics, stored.q || (typeof saved === 'string' ? saved : ''));
  const vectors = Array.isArray(stored.touchstones)
    ? stored.touchstones
      .filter((row) => Array.isArray(row) && row.length === ctx.corpus.mean.length)
      .map((row) => Float32Array.from(row))
    : [];

  const shipExp = !!(ctx.axes && ctx.axes.expTheory && ctx.axes.expTheory.ship);
  const shipMl = !!(ctx.axes && ctx.axes.ml4q && ctx.axes.ml4q.ship);

  const state = {
    night: ctx.night || null,
    setting: restored.setting,
    sliders: restored.sliders,
    text: typeof stored.text === 'string' ? stored.text : restored.text,
    touchstones: vectors,
    more: idListOf(stored.more),
    less: idListOf(stored.less),
    ml4q: shipMl ? restored.ml4q : false,
    counts: null,
  };
  state.counts = treeCounts(state.night, topics);

  /* Expanded state is UI only, and survives re-renders the way v3's set did. */
  const expandedParents = new Set();
  const expandedLeaves = new Set();
  let touchKey = vectors.length ? cacheKeyText(state.text) : '';
  let textTimer = 0;
  let textGen = 0;
  let emitTimer = 0;

  const textPlaceholder = 'A phrase, a sentence, or an abstract you liked';
  const parentChoices = (id) => {
    const parent = topics.parents.find((p) => p.id === id);
    return choiceOf(state.setting[id] ?? parent?.default);
  };
  const leafChoices = (leaf) => choiceOf(state.setting.leaves?.[leaf.id] ?? state.setting[leaf.parent]);

  const selectHtml = (scope, id, label, value) =>
    '<select class="cave-tselect" data-' + scope + '="' + escapeHtml(id) + '" aria-label="' +
      escapeHtml(label + ' weight') + '">' +
      CHOICES.map((choice) => '<option value="' + choice + '"' +
        (choice === value ? ' selected' : '') + '>' + CHOICE_LABEL[choice] + '</option>').join('') +
    '</select>';

  const weightBarHtml = (scope, id, choice) => {
    const width = (weightOf(choice) / WEIGHT.prefer) * 100;
    return '<span class="cave-weight-bar" data-weight="' + scope + ':' + escapeHtml(id) +
      '" data-choice="' + choice + '" aria-hidden="true">' +
      '<span class="cave-weight-fill" style="width:' + width + '%"></span></span>';
  };


  const sliderRowHtml = (id, label, min, max, value, ends, extra = '') =>
    '<div class="cave-priorities-ctl"' + extra + '>' +
      '<div class="cave-priorities-ctl-head">' +
        '<label for="cave-priorities-' + id + '">' + escapeHtml(label) + '</label>' +
        '<output class="cave-priorities-val" id="cave-priorities-' + id + '-val" for="cave-priorities-' + id + '">' +
          value + '</output>' +
      '</div>' +
      '<input class="cave-priorities-slider" type="range" id="cave-priorities-' + id + '" min="' + min +
        '" max="' + max + '" step="1" value="' + value + '">' +
      '<div class="cave-priorities-ends" aria-hidden="true"><span>' + escapeHtml(ends[0]) +
        '</span><span>' + escapeHtml(ends[1]) + '</span></div>' +
    '</div>';

  body.innerHTML =
    '<div class="cave-priorities">' +
      '<div class="cave-field">' +
        '<label class="cave-field-label" for="cave-priorities-text">What do you care about?</label>' +
        '<textarea class="cave-priorities-text" id="cave-priorities-text" rows="3" placeholder="' +
          escapeHtml(textPlaceholder) + '"></textarea>' +
        '<p class="cave-priorities-hint">Empty is fine — the topics and the sliders still rank the night.</p>' +
        '<p class="cave-priorities-note" role="status"></p>' +
      '</div>' +
      '<div class="cave-priorities-chips" role="group" aria-label="Applied topic weights and paper nudges"></div>' +
      '<div class="cave-priorities-sliders" role="group" aria-label="Ranking sliders">' +
        sliderRowHtml('match', 'Topic match', SLIDERS.match.min, SLIDERS.match.max,
          state.sliders.match, ['any topic', 'only close matches']) +
        sliderRowHtml('surprise', 'Surprise', SLIDERS.surprise.min, SLIDERS.surprise.max,
          state.sliders.surprise, ['proven', 'surprising']) +
        sliderRowHtml('exptheory', 'Experiment ↔ Theory', SLIDERS.expTheory.min, SLIDERS.expTheory.max,
          experimentText(state.sliders.expTheory), ['Experiment', 'Theory'],
          shipExp ? '' : ' hidden') +
      '</div>' +
      '<div class="cave-priorities-tags">' +
        '<button type="button" class="cave-ml4q" aria-pressed="false"' +
          (shipMl ? '' : ' hidden') + '>ML for quantum</button>' +
      '</div>' +
      '<div class="cave-priorities-tree-wrap">' +
        '<div class="cave-priorities-tree-head">' +
          '<h3 class="cave-priorities-tree-title">Topics tonight</h3>' +
          '<button type="button" class="cave-reset-topics">Reset topics</button>' +
        '</div>' +
        '<p class="cave-priorities-muted cave-tree-empty">Dig first — tonight\'s counts appear here.</p>' +
        '<div class="cave-priorities-tree"></div>' +
      '</div>' +
      '<div class="button-bar">' +
        '<button type="button" class="cave-continue-btn cave-primary">Rank tonight</button>' +
      '</div>' +
    '</div>';

  const textEl = body.querySelector('.cave-priorities-text');
  const noteEl = body.querySelector('.cave-priorities-note');
  const chipsEl = body.querySelector('.cave-priorities-chips');
  const matchEl = body.querySelector('#cave-priorities-match');
  const surpriseEl = body.querySelector('#cave-priorities-surprise');
  const expEl = body.querySelector('#cave-priorities-exptheory');
  const expRowEl = expEl.closest('.cave-priorities-ctl');
  const matchValEl = body.querySelector('#cave-priorities-match-val');
  const surpriseValEl = body.querySelector('#cave-priorities-surprise-val');
  const expValEl = body.querySelector('#cave-priorities-exptheory-val');
  const ml4qEl = body.querySelector('.cave-ml4q');
  const treeEl = body.querySelector('.cave-priorities-tree');
  const emptyEl = body.querySelector('.cave-tree-empty');
  const continueBtn = body.querySelector('.cave-continue-btn');

  textEl.value = state.text;
  emptyEl.hidden = !!state.night;


  /* ── prefs out, storage down ────────────────────────────────────────── */

  function currentPrefs() {
    return {
      setting: state.setting,
      sliders: { ...state.sliders },
      touchstones: state.touchstones,
      text: state.text,
      more: state.more,
      less: state.less,
      ml4q: state.ml4q,
    };
  }

  function persist() {
    if (!ctx.storage) return;
    /* Vectors ride along: a reload then keeps the box's meaning without
       paying for the same sentence again. Text and code always; vectors only
       when there are some. */
    const payload = {
      q: serialisePrefs(topics, currentPrefs()),
      text: state.text,
      more: state.more,
      less: state.less,
    };
    if (state.touchstones.length) {
      payload.touchstones = state.touchstones.map((vec) => Array.from(vec));
    }
    writeStore(ctx.storage, STORE_KEY, payload);
  }

  function emit() {
    ctx.prefs = currentPrefs();
    try {
      ctx.bus.dispatchEvent(new CustomEvent('prefs', { detail: ctx.prefs }));
    } catch (_) { /* no bus, or a bus from a page that is closing */ }
  }

  function publish() {
    clearTimeout(emitTimer);
    emitTimer = 0;
    persist();
    emit();
  }

  /** Sliders are the one control a drag fires in bursts: settle for 150 ms. */
  function publishSoon() {
    clearTimeout(emitTimer);
    emitTimer = setTimeout(publish, 150);
  }

  function note(message, isError = false) {
    noteEl.textContent = message || '';
    noteEl.classList.toggle('is-error', !!isError);
  }

  /* ── the box's words ────────────────────────────────────────────────── */

  /**
   * Embed the box, if the collapsed words changed. `touchKey` is the guard
   * that makes a slider drag, a topic press or a reload free.
   */
  async function embedWords() {
    const words = cacheKeyText(textEl.value);
    if (words === touchKey) return;
    const gen = textGen;

    if (!words) {
      state.touchstones = [];
      touchKey = '';
      note('');
      publish();
      return;
    }
    if (!ctx.config || !ctx.config.embedUrl) {
      note('Embedding is off on this build, so your words are saved but not used.');
      return;
    }

    note('Embedding what you care about…');
    try {
      const [vec] = await embedTexts({
        texts: [words],
        embedUrl: ctx.config.embedUrl,
        onProgress: (done, total) => note(`Embedding what you care about… ${done}/${total}`),
      });
      if (gen !== textGen) return;      // the reader typed again while it was out
      state.touchstones = [centreUnit(vec, ctx.corpus.mean)];
      touchKey = words;
      note('');
      publish();
    } catch (err) {
      if (gen !== textGen) return;
      note('Could not embed your words: ' + ((err && err.message) || err), true);
    }
  }

  /* ── the tree ───────────────────────────────────────────────────────── */

  function wagonsHtml(leafId) {
    if (!state.night) return '<p class="cave-priorities-muted">Dig first — wagons appear here.</p>';
    const wagons = wagonsForLeaf(state.night, topics, leafId);
    if (!wagons.length) return '<p class="cave-priorities-muted">No wagon landed here tonight.</p>';
    return '<ul class="cave-wagon-list">' + wagons.map((wagon) =>
      '<li><span class="cave-wagon-name">' + escapeHtml(wagon.name) + '</span>' +
        '<span class="cave-wagon-size">' + wagon.size + ' ' + plural(wagon.size) + '</span></li>',
    ).join('') + '</ul>';
  }

  const countHtml = (value) => (state.night ? String(value) : '—');


  /** One parent group: its row, then its leaves, then nothing until clicked. */
  function parentHtml(parent) {
    const leaves = topics.leaves.filter((leaf) => leaf.parent === parent.id);
    const open = expandedParents.has(parent.id);
    return '<div class="cave-tgroup" data-group="' + escapeHtml(parent.id) + '">' +
      '<div class="cave-trow cave-trow--parent">' +
        '<button type="button" class="cave-trow-toggle" data-expand="parent:' + escapeHtml(parent.id) +
          '" aria-expanded="' + open + '">' +
          '<span class="cave-twisty" aria-hidden="true">' + (open ? '▾' : '▸') + '</span>' +
          '<span class="cave-trow-label">' + escapeHtml(parent.label) + '</span>' +
          '<span class="cave-trow-count">' + countHtml(state.counts.parents[parent.id] ?? 0) + '</span>' +
        '</button>' +
        selectHtml('parent', parent.id, parent.label, parentChoices(parent.id)) +
        weightBarHtml('parent', parent.id, parentChoices(parent.id)) +
      '</div>' +
      '<div class="cave-kids" data-kids="' + escapeHtml(parent.id) + '"' + (open ? '' : ' hidden') + '>' +
        leaves.map((leaf) => leafHtml(leaf)).join('') +
      '</div>' +
    '</div>';
  }

  function leafHtml(leaf) {
    const open = expandedLeaves.has(leaf.id);
    const choice = leafChoices(leaf);
    return '<div class="cave-trow cave-trow--leaf">' +
        '<button type="button" class="cave-trow-toggle" data-expand="leaf:' + escapeHtml(leaf.id) +
          '" aria-expanded="' + open + '">' +
          '<span class="cave-twisty" aria-hidden="true">' + (open ? '▾' : '▸') + '</span>' +
          '<span class="cave-trow-label">' + escapeHtml(leaf.label) + '</span>' +
          '<span class="cave-trow-count">' + countHtml(state.counts.leaves[leaf.id] ?? 0) + '</span>' +
        '</button>' +
        selectHtml('leaf', leaf.id, leaf.label, choice) +
        weightBarHtml('leaf', leaf.id, choice) +
      '</div>' +
      '<div class="cave-wagons" data-wagons="' + escapeHtml(leaf.id) + '"' + (open ? '' : ' hidden') + '>' +
        (open ? wagonsHtml(leaf.id) : '') +
      '</div>';
  }

  function renderTree() {
    treeEl.innerHTML = topics.parents.map((parent) => parentHtml(parent)).join('');
  }

  /** Selects and bars in step with the setting, without rebuilding the tree. */
  function syncTree() {
    for (const select of treeEl.querySelectorAll('select[data-parent]')) {
      select.value = parentChoices(select.dataset.parent);
    }
    for (const select of treeEl.querySelectorAll('select[data-leaf]')) {
      const leaf = topics.leaves[topics.leafIndex.get(select.dataset.leaf)];
      if (leaf) select.value = leafChoices(leaf);
    }
    for (const bar of treeEl.querySelectorAll('.cave-weight-bar')) {
      const [scope, id] = bar.dataset.weight.split(':');
      const choice = scope === 'parent'
        ? parentChoices(id)
        : leafChoices(topics.leaves[topics.leafIndex.get(id)]);
      bar.dataset.choice = choice;
      const fill = bar.querySelector('.cave-weight-fill');
      if (fill) fill.style.width = ((weightOf(choice) / WEIGHT.prefer) * 100) + '%';
    }
  }

  /** Open/close without a rebuild, so focus stays on the row that was pressed. */
  function syncExpanded() {
    for (const group of treeEl.querySelectorAll('[data-kids]')) {
      group.hidden = !expandedParents.has(group.dataset.kids);
    }
    for (const box of treeEl.querySelectorAll('[data-wagons]')) {
      const open = expandedLeaves.has(box.dataset.wagons);
      if (open && box.dataset.filled !== '1') {
        box.innerHTML = wagonsHtml(box.dataset.wagons);
        box.dataset.filled = '1';
      }
      if (!open) delete box.dataset.filled;   // reopen on a fresh list
      box.hidden = !open;
    }
    for (const button of treeEl.querySelectorAll('[data-expand]')) {
      const [scope, id] = button.dataset.expand.split(':');
      const open = scope === 'parent' ? expandedParents.has(id) : expandedLeaves.has(id);
      button.setAttribute('aria-expanded', String(open));
      const twisty = button.querySelector('.cave-twisty');
      if (twisty) twisty.textContent = open ? '▾' : '▸';
    }
  }


  /* ── the chips ──────────────────────────────────────────────────────── */

  /** The full title behind a nudge id: tonight's stone first, then the ranking. */
  function titleFor(id) {
    const stone = (state.night?.stones ?? []).find((row) => row && String(row.id) === id);
    if (stone && stone.title) return String(stone.title);
    const item = (ctx.ranked ?? []).find((row) => row && String(row.id) === id);
    return item && item.title ? String(item.title) : '';
  }

  function nudgeChipHtml(chip) {
    return '<button type="button" class="cave-tchip cave-tchip--' +
      (chip.sign > 0 ? 'more' : 'less') + '" data-unnudge="' + escapeHtml(chip.id) + '"' +
      ' aria-label="Remove ' + chip.label + ': ' + escapeHtml(chip.title) + '">' +
      (chip.sign > 0 ? '+' : '−') + ' ' + chip.label + ': ' + escapeHtml(chip.title) +
      '<span aria-hidden="true">×</span></button>';
  }

  function renderChips() {
    const chips = chipsFromSetting(topics, state.setting);
    chipsEl.innerHTML = chips.map((chip) =>
      '<button type="button" class="cave-tchip" data-drop="' + chip.scope + ':' + escapeHtml(chip.id) +
        '" aria-label="Remove filter: ' + escapeHtml(chip.label) + ' ' + CHOICE_LABEL[chip.choice] + '">' +
        escapeHtml(chip.label) + ' · ' + CHOICE_LABEL[chip.choice] +
        '<span aria-hidden="true">×</span></button>',
    ).join('') +
      /* The nudge chips sit in the same row, so "more like" is one glance away
         from "Computing · Prefer" — they are all priorities the reader set. */
      nudgeChips(currentPrefs(), titleFor).map(nudgeChipHtml).join('');
  }

  /* ── the sliders ────────────────────────────────────────────────────── */

  function renderSliders() {
    matchEl.value = String(state.sliders.match);
    surpriseEl.value = String(state.sliders.surprise);
    expEl.value = String(state.sliders.expTheory);

    matchEl.setAttribute('aria-valuetext', `Topic match: ${state.sliders.match} of 100`);
    surpriseEl.setAttribute('aria-valuetext', `Surprise: ${state.sliders.surprise} of 100`);
    expEl.setAttribute('aria-valuetext',
      `Experiment to theory: ${experimentText(state.sliders.expTheory)}`);

    matchValEl.textContent = String(state.sliders.match);
    surpriseValEl.textContent = String(state.sliders.surprise);
    expValEl.textContent = experimentText(state.sliders.expTheory);

    /* A control that does nothing is a lie: an axis that did not ship is
       hidden, not disabled (the contract's ship flags, as in v3). */
    expRowEl.hidden = !shipExp;
    ml4qEl.hidden = !shipMl;
    ml4qEl.setAttribute('aria-pressed', String(state.ml4q));
    if (!shipMl) state.ml4q = false;
  }

  /* ── setting changes ────────────────────────────────────────────────── */

  function afterSettingChange() {
    syncTree();
    renderChips();
    publish();
  }

  /* ── the night ──────────────────────────────────────────────────────── */

  function setNight(night) {
    state.night = night || null;
    state.counts = treeCounts(state.night, topics);
    emptyEl.hidden = !!state.night;
    renderTree();      // new counts, and open leaf lists filled with the new wagons
    renderChips();     // the nudge chips may now know titles they did not before
  }

  /* ── the nudges ─────────────────────────────────────────────────────── */

  /**
   * One "more like" (+1), "less like" (-1) or "clear" (0), from a chip's × or
   * from the Act stage over the bus. `applyNudge` owns the one-list rule; this
   * only stores and announces, like every other pref change.
   */
  function setNudge(id, sign) {
    if (!id) return;
    const next = applyNudge(currentPrefs(), { id, sign });
    state.more = next.more;
    state.less = next.less;
    renderChips();
    publish();
  }


  /* ── wiring ─────────────────────────────────────────────────────────── */

  renderTree();
  renderChips();
  renderSliders();

  textEl.addEventListener('input', () => {
    state.text = textEl.value.trim();
    textGen += 1;
    persist();                 // the words survive even if the embed never does
    emit();                    // prefs follow the text; touchstones catch up after the pause
    clearTimeout(textTimer);
    textTimer = setTimeout(embedWords, 600);
  });

  matchEl.addEventListener('input', () => {
    state.sliders.match = number(matchEl.value, SLIDERS.match.value, SLIDERS.match.min, SLIDERS.match.max);
    renderSliders();
    publishSoon();
  });

  surpriseEl.addEventListener('input', () => {
    state.sliders.surprise = number(surpriseEl.value, SLIDERS.surprise.value, SLIDERS.surprise.min, SLIDERS.surprise.max);
    renderSliders();
    publishSoon();
  });

  expEl.addEventListener('input', () => {
    state.sliders.expTheory = number(expEl.value, SLIDERS.expTheory.value, SLIDERS.expTheory.min, SLIDERS.expTheory.max);
    renderSliders();
    publishSoon();
  });

  ml4qEl.addEventListener('click', () => {
    state.ml4q = !state.ml4q;
    ml4qEl.setAttribute('aria-pressed', String(state.ml4q));
    publish();
  });

  treeEl.addEventListener('change', (event) => {
    const el = event.target;
    if (el.matches?.('select[data-parent]')) {
      /* A parent sets its children: their overrides go, or the dropdown would
         claim something its leaves contradict (v3's rule). */
      state.setting[el.dataset.parent] = choiceOf(el.value);
      for (const leaf of topics.leaves) {
        if (leaf.parent === el.dataset.parent) delete state.setting.leaves[leaf.id];
      }
      afterSettingChange();
      return;
    }
    if (el.matches?.('select[data-leaf]')) {
      state.setting.leaves[el.dataset.leaf] = choiceOf(el.value);
      afterSettingChange();
    }
  });

  treeEl.addEventListener('click', (event) => {
    /* The dropdown is part of the row but is not the row. */
    if (event.target.closest('select')) return;

    const toggle = event.target.closest('[data-expand]');
    if (toggle) {
      const [scope, id] = toggle.dataset.expand.split(':');
      const set = scope === 'parent' ? expandedParents : expandedLeaves;
      if (set.has(id)) set.delete(id);
      else set.add(id);
      syncExpanded();
      return;
    }

    /* Anywhere else on a parent row opens it, as the card asks. */
    const row = event.target.closest('.cave-trow--parent');
    if (row) {
      const group = row.closest('.cave-tgroup');
      const id = group && group.dataset.group;
      if (!id) return;
      if (expandedParents.has(id)) expandedParents.delete(id);
      else expandedParents.add(id);
      syncExpanded();
    }
  });

  chipsEl.addEventListener('click', (event) => {
    const nudgeDrop = event.target.closest('[data-unnudge]');
    if (nudgeDrop) {
      setNudge(nudgeDrop.dataset.unnudge, 0);
      return;
    }
    const drop = event.target.closest('[data-drop]');
    if (!drop) return;
    const at = drop.dataset.drop.indexOf(':');
    const chip = { scope: drop.dataset.drop.slice(0, at), id: drop.dataset.drop.slice(at + 1) };
    state.setting = removeChip(topics, state.setting, chip);
    afterSettingChange();
  });

  body.querySelector('.cave-reset-topics').addEventListener('click', () => {
    state.setting = defaultSetting(topics);
    afterSettingChange();
  });

  continueBtn.addEventListener('click', () => {
    if (!ctx.flow || ctx.flow.status('priorities') === 'locked') return;
    ctx.flow.complete('priorities', prefsSummary(topics, currentPrefs()));
  });

  ctx.bus.addEventListener('night', (event) => setNight(event.detail));

  /* The Act stage's "more like / less like" is a priority, so it takes the same
     path as a slider: store it, redraw the chips, announce the new prefs. */
  ctx.bus.addEventListener('nudge', (event) => {
    const detail = event.detail || {};
    setNudge(detail.id, detail.sign);
  });

  /* The ranking usually knows a title before this card does; a re-rank is free
     to read, so relabel the nudge chips when one lands. */
  ctx.bus.addEventListener('ranked', () => renderChips());

  /* A named wagon (or a re-cut) changes what the leaf lists say; rebuild just
     those lists, leaving counts and expanded state where they are. */
  ctx.bus.addEventListener('wagons', () => {
    for (const box of treeEl.querySelectorAll('[data-wagons]')) {
      if (!expandedLeaves.has(box.dataset.wagons)) {
        delete box.dataset.filled;    // closed: refill when it opens
        continue;
      }
      box.innerHTML = wagonsHtml(box.dataset.wagons);
      box.dataset.filled = '1';
    }
  });

  /* Restored or default: the rest of the page gets one prefs event at mount,
     before any control is touched. */
  emit();
}

