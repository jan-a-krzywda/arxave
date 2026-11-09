/**
 * rank — the day's ranking pipeline: fetch, embed, centre, score, shortlist,
 * read, grade, enrich, ship.
 *
 * WHY THIS IS A SEPARATE DRIVER. `preset-feed.mjs` answers "what is worth
 * reading today, for this one preset" and its z is measured against the day's
 * own spread, so a quiet day still produces z ≈ 2. This answers the other
 * question — "is this paper relevant at all" — against a fixed background
 * (`background.json`, built by `background.mjs`) and then has a model grade the
 * survivors against the criterion pack. The two share every helper that matters
 * (`grade`, `center`, `maxSim`, `robustStats`, `shortlist`, `renderFeed`,
 * `archiveEntry`, `mergeMonth`), so the arithmetic here is the arithmetic the
 * page and the feed already run, not a third copy of it.
 *
 * EVERYTHING WITH A CLOCK OR A SOCKET IS A PARAMETER. `runRank(deps)` takes the
 * fetched stones, the embedder, the full-text reader, the grader, the enricher
 * and the filesystem, so `rank.test.mjs` runs the whole pipeline — fetch to
 * written XML — on four hand-computed papers with a stub embedder, a stub
 * grader and an in-memory fs. The pure functions below take plain data and
 * return plain data and are pinned on their own.
 *
 * TWO DEGRADATIONS, BOTH LOUD.
 *   - No `background.json`: there is no fixed reference, so `z_ref` collapses
 *     onto the day's own `z_day` and the shortlist is the day's own spread. The
 *     run warns; it does not stop, because a missing background is a warm that
 *     has not run yet, not a broken day.
 *   - No grader key: nothing can be scored for relevance, so the shortlist
 *     ships as-is with `relevance: null` and every band is a long shot. An
 *     ungraded feed is honest; an empty one is not.
 *
 * Usage:
 *   node rank.mjs --config ../config/quantum-systems.yml --out ../docs/feeds
 *
 * Flags:
 *   --config       the pipeline config (required)
 *   --out          where the feeds and the stockpile go (default: ../docs/feeds)
 *   --presets      directory of axis preset claims (default: ../docs/presets)
 *   --pack         the criterion pack directory (default: ../criteria/<criterion>)
 *   --background   the background stats file (default: <pack>/background.json)
 *   --endpoint     dig-cache URL (default: the project's deployed function)
 *   --embed        embed URL (default: the project's deployed function)
 *   --embed-local  embed with SPECTER2 on this machine, not the hosted pick
 *   --dry-run      run the pipeline, write nothing
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  DEFAULT_EMBED, embedChunk, fetchAbstracts, fetchEarlier, loadPresets, resolveEndpoint,
} from './warm-dig.mjs';
import { chooseEmbedder } from './embed-local.mjs';
import {
  archiveEntry, center, cosine, grade, mergeMonth, renderFeed, rowLabel, tallyOf,
} from './preset-feed.mjs';
import { maxSim, resolveTaus, robustStats, shortlist, zRef } from './score.mjs';
import { gradePaper } from './llm.mjs';
import { fetchFullText } from './fulltext.mjs';
import { enrichItems } from './enrich.mjs';
import { applyOverrides, loadConfig, loadPack } from './pack.mjs';

/* The canonical domain, the same default preset-feed uses: every link in a
   feed is absolute and outlives the file it came in. */
const DEFAULT_SITE = 'https://arxave.com/';

/* Per category, and a window that has to reach a date rather than fill a
   screen — the warmer's number, for the same reason it is not the page's 200. */
const LOOKBACK_MAX = 400;

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
/* A missing number sorts below every real one, and `-Infinity - -Infinity` is
   NaN — which `||` treats as "tie, try the next key", exactly what is wanted. */
const num = (v) => (Number.isFinite(v) ? v : -Infinity);

/**
 * One stone against every axis: the blend, the closest seed, and which seed.
 *
 * `mean_sim` is `grade()` over the axis' whole row set — touchstones and cores
 * together — because that is the blend the page computes. `max_sim` and
 * `nearest` look only at the seeds: a single very close seed is the signal the
 * mean dilutes away, and a touchstone is a phrase, not a paper to name.
 *
 * Rows are seeds unless they are marked `kind: 'touchstone'` (the `kind` the
 * warmer writes); a row with no kind at all is treated as a seed, so a caller
 * that passes bare rows still gets a nearest seed.
 */
export function scoreAxes(stone, axisRows) {
  const out = {};
  for (const [axis, rows] of Object.entries(axisRows || {})) {
    const list = rows || [];
    const seeds = list.filter((r) => r && r.kind !== 'touchstone');
    const { max, row } = maxSim(stone, seeds);
    out[axis] = {
      mean_sim: grade(stone, list),
      max_sim: max,
      nearest: row ? (row.label || '') : null,
    };
  }
  return out;
}

/**
 * The day's own z, per axis, appended to every paper.
 *
 * Same estimator as everywhere else (`robustStats`, the `floor(n/2)` median and
 * the raw MAD), so `z_day` here means what `z` means in a preset feed. A paper
 * missing an axis simply has no `z_day` on it.
 */
export function addDayZ(papers) {
  const axes = new Set();
  for (const p of papers) for (const axis of Object.keys(p.axes || {})) axes.add(axis);
  const stats = {};
  for (const axis of axes) {
    stats[axis] = robustStats(papers.map((p) => p.axes?.[axis]?.mean_sim).filter(Number.isFinite));
  }
  return papers.map((p) => ({
    ...p,
    axes: Object.fromEntries(Object.entries(p.axes || {}).map(([axis, e]) => [
      axis, { ...e, z_day: zRef(e.mean_sim, stats[axis]) },
    ])),
  }));
}

/**
 * How much of this paper has been seen before: the largest cosine to anything
 * shipped recently, or 0 when there is nothing to compare against.
 *
 * A high value is the "we have read this already" flag (a revision, a follow-up,
 * a parallel group). The raw maximum is returned rather than a clamped one — a
 * negative cosine is informative, and 0 already means "nothing to compare".
 */
export function redundancy(stone, recentStones) {
  const stones = (recentStones || []).filter(Boolean);
  if (!stones.length) return 0;
  let max = -Infinity;
  for (const v of stones) {
    const c = cosine(stone, v);
    if (c > max) max = c;
  }
  return max;
}

/**
 * What a relevance score is called on a card.
 *
 * The bands are the reading decision, not the assay's confidence: 5 changes how
 * the machine is run, 4 is directly usable, 3 is worth a skim. Anything below —
 * including `null`, a paper the grader never saw — is a long shot, which is the
 * one band that admits "we do not know".
 */
export function bandOfRelevance(r) {
  if (r >= 5) return 'Must read';
  if (r >= 4) return 'Read';
  if (r >= 3) return 'Skim';
  return 'Long shot';
}

/** Relevance first, then novelty, then the background z, then id. */
export function orderShipped(items) {
  return [...items].sort((a, b) =>
    (num(b.relevance) - num(a.relevance)) ||
    (num(b.novelty) - num(a.novelty)) ||
    (num(b.z_ref) - num(a.z_ref)) ||
    byId(a, b));
}

/**
 * What goes in the feed today.
 *
 * `ship.max` is a ceiling on a rich day, never a target, so the qualified
 * papers are ordered first and then cut. A day where nothing reaches
 * `ship.relevance` still says something: the top `longshots_on_empty` by the
 * day's own z, labelled so a reader can see they are admitted, not recommended.
 */
export function pickShip(graded, config) {
  const ship = config?.ship || {};
  const bar = Number.isFinite(ship.relevance) ? ship.relevance : 3;
  const cap = Number.isFinite(ship.max) ? ship.max : 8;
  const longshots = Number.isFinite(ship.longshots_on_empty) ? ship.longshots_on_empty : 0;

  const qualified = graded.filter((it) => Number.isFinite(it.relevance) && it.relevance >= bar);
  if (qualified.length) {
    return orderShipped(qualified).slice(0, cap)
      .map((it) => ({ ...it, band: bandOfRelevance(it.relevance) }));
  }
  return [...graded]
    .sort((a, b) => (num(b.z_day) - num(a.z_day)) || byId(a, b))
    .slice(0, longshots)
    .map((it) => ({ ...it, band: 'Long shot' }));
}

/**
 * What is worth keeping: clearly relevant, or surprising.
 *
 * Two routes on purpose. The first is the paper the team should act on; the
 * second is the paper nobody asked for that moves the state of the art — the
 * "most surprising" path, which is why it still demands a floor of relevance so
 * a novel paper about something else cannot slip in on novelty alone.
 */
export function storeCandidates(graded, config) {
  const store = config?.store || {};
  const rel = Number.isFinite(store.relevance) ? store.relevance : 4;
  const nov = Number.isFinite(store.novelty) ? store.novelty : 4;
  const minRel = Number.isFinite(store.novelty_min_relevance) ? store.novelty_min_relevance : 3;
  return graded.filter((it) =>
    (Number.isFinite(it.relevance) && it.relevance >= rel) ||
    (Number.isFinite(it.novelty) && it.novelty >= nov &&
     Number.isFinite(it.relevance) && it.relevance >= minRel));
}

/**
 * The daily summary: one short paragraph over what shipped, or ''.
 *
 * Best-effort by design. The summary is an embellishment on a feed whose
 * ranking is already done, so a refused call, a timeout or a missing key yields
 * an empty string rather than a morning with no feed. Injectable so the test
 * never makes the call.
 */
export async function summarizeDay({ llm, items, fetchImpl = fetch, env = process.env } = {}) {
  const key = env?.[llm?.api_key_env];
  if (!key || !items?.length) return '';
  const url = `${String(llm.base_url).replace(/\/+$/, '')}/chat/completions`;
  const listing = items
    .map((it) => `${it.id} (${it.band}, relevance ${it.relevance ?? '?'}): ${it.title}` +
      (it.why ? ` — ${it.why}` : ''))
    .join('\n');
  try {
    const resp = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: llm.model,
        temperature: 0,
        messages: [
          {
            role: 'system',
            content: "You write one short paragraph introducing today's ranked reading list. " +
              'Plain text, no markdown, no preamble. Refer to papers by their arXiv id.',
          },
          { role: 'user', content: listing.slice(0, 12_000) },
        ],
      }),
    });
    if (!resp.ok) return '';
    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content;
    return typeof content === 'string' ? content.trim() : '';
  } catch {
    return '';
  }
}


/**
 * The whole pipeline, on data the caller supplies.
 *
 * Returns a plain summary object as well as writing the files, so a test can
 * assert on the decision without parsing XML and a dry run can still report
 * what it would have written.
 */
export async function runRank({
  config,
  pack = {},
  presets = {},
  stones,
  fetchStones,
  embed,
  center: centerFn = center,
  background,
  backgroundPath,
  readPaper,
  grade: gradeFn = gradePaper,
  summarize = summarizeDay,
  enrich = enrichItems,
  recentStones = [],
  fs: disk = fs,
  env = process.env,
  log = console,
  site = DEFAULT_SITE,
  outDir = '.',
  now = new Date(),
  dryRun = false,
} = {}) {
  const builtOn = (now instanceof Date ? now : new Date(now)).toISOString().slice(0, 10);
  const llm = config?.llm || {};
  const grading = Boolean(env?.[llm.api_key_env]);

  /* ── 1. The day ─────────────────────────────────────────────────────── */
  const fetched = stones ?? await fetchStones();
  const seen = new Set();
  const day = [];
  for (const s of fetched || []) {
    const id = s.arxivId || s.id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    day.push({ ...s, arxivId: id });
  }

  /* ── 2. The axes: one preset per axis, its rows labelled ─────────────── */
  const axisRows = {};
  const slugOf = {};
  const presetOf = {};
  /* `loadPresets` hands back a Map; the tests hand a plain object. Object.entries
     of a Map is [], which left the run with no axes, wrote nothing, and still
     exited 0 — green in CI with no ranked feed. Take either. */
  const presetEntries = presets instanceof Map ? [...presets] : Object.entries(presets || {});
  for (const [slug, entry] of presetEntries) {
    const preset = entry.preset || entry;
    const axis = preset.axis || /^qs-([a-i])$/.exec(slug)?.[1]?.toUpperCase();
    if (!axis) continue;
    slugOf[axis] = slug;
    presetOf[slug] = preset;
    axisRows[axis] = (entry.rows || []).map((r) => ({
      weight: r.weight, kind: r.kind, text: r.text, title: r.title,
      label: rowLabel(r), vector: null,
    }));
  }
  const axisIds = Object.keys(axisRows).sort();
  /* No axes means no preset was recognised: nothing can be scored, no feed is
     written, and the run used to end with a clean exit and a green CI step. A
     run that cannot rank says so. */
  if (!axisIds.length) {
    throw new Error('no axis presets loaded (expected qs-a … qs-i, or presets with an `axis`)');
  }

  /* ── 3. Embed once, centre once, then hand the rows their vectors ────── */
  const rowQueue = [];
  const texts = day.map((s) => s.abstract);
  for (const axis of axisIds) {
    for (const r of axisRows[axis]) { rowQueue.push(r); texts.push(r.text); }
  }
  const vectors = texts.length ? await embed(texts) : [];
  const stoneVecs = vectors.slice(0, day.length).map(centerFn);
  rowQueue.forEach((r, i) => { r.vector = centerFn(vectors[day.length + i]); });

  /* ── 4. Score every stone on every axis ─────────────────────────────── */
  const scored = day.map((s, i) => ({
    id: s.arxivId, stone: s, vector: stoneVecs[i],
    axes: scoreAxes(stoneVecs[i], axisRows),
  }));

  /* ── 5. Calibrate: the day's z, then the background's ───────────────── */
  let papers = addDayZ(scored);
  let bg = background;
  if (bg === undefined && backgroundPath) {
    try {
      bg = JSON.parse(await disk.readFile(backgroundPath, 'utf8'));
    } catch (err) {
      bg = null;
      log.warn(`rank: no background at ${backgroundPath} (${err.message}) — ` +
        'shortlisting on z_day alone');
    }
  }
  const hasBackground = Boolean(bg?.axes && Object.keys(bg.axes).length);
  if (!hasBackground) {
    log.warn('rank: no background stats — shortlisting on z_day alone');
  }
  papers = papers.map((p) => ({
    ...p,
    axes: Object.fromEntries(Object.entries(p.axes).map(([axis, e]) => [
      axis,
      hasBackground
        ? { ...e, z_ref: zRef(e.mean_sim, bg.axes[axis]?.mean) }
        : { ...e, z_ref: e.z_day },   // the day is its own reference
    ])),
  }));

  /* ── 6. Shortlist ───────────────────────────────────────────────────── */
  const taus = hasBackground
    ? resolveTaus(config, bg)
    : { tau_ref: 0, tau_seed: Infinity };   // z_day >= 0, and no seed route
  const listed = shortlist(papers, {
    tauRef: taus.tau_ref,
    tauSeed: taus.tau_seed,
    max: config?.shortlist?.max,
    min: config?.shortlist?.min,
    axisWeights: config?.axes,
  });
  const byPaper = new Map(papers.map((p) => [p.id, p]));

  /* ── 7. Read, then grade, each shortlisted paper ────────────────────── */
  const graded = [];
  for (const s of listed.papers) {
    const p = byPaper.get(s.id);
    const axis = s.best_axis;
    const e = p.axes[axis] || {};
    const paper = {
      id: p.id, title: p.stone.title, authors: p.stone.authors, abstract: p.stone.abstract,
    };
    if (readPaper) {
      try {
        const full = await readPaper(p.id);
        if (full?.text) paper.intro = full.text;
      } catch (err) {
        /* One degradation step, never two: a paper whose HTML failed to read is
           graded from its abstract, not dropped. */
        log.warn(`rank: ${p.id} full text — ${err.message}`);
      }
    }
    let g = null;
    if (grading) {
      const res = await gradeFn(
        { rubric: pack.rubric, requirements: pack.requirements, axes: pack.axes, paper },
        { llm, env },
      );
      if (res && !res.error) g = res;
      else if (res?.error) log.warn(`rank: ${p.id} — ${res.error}`);
    }
    graded.push({
      ...p.stone,
      id: p.id,
      stone: p.stone,
      vector: p.vector,
      best_axis: axis,
      passed_by: s.passed_by,
      /* The card's own fields, taken from the best axis so the existing feed
         body and archive render without a special case. */
      grade: e.mean_sim ?? 0,
      z: Number.isFinite(e.z_day) ? e.z_day : null,
      matched: e.nearest ? { label: e.nearest, cosine: e.max_sim } : null,
      /* And the pipeline's own fields. */
      z_ref: Number.isFinite(e.z_ref) ? e.z_ref : null,
      z_day: Number.isFinite(e.z_day) ? e.z_day : -Infinity,
      nearest_seed: e.nearest ?? null,
      relevance: g ? g.relevance : null,
      novelty: g ? g.novelty : null,
      axis: g ? g.axis : axis,
      refs: g ? g.refs : [],
      why: g ? g.why : '',
      actions: g ? g.actions : [],
      redundancy: 0,
    });
  }

  /* ── 8. Ship ────────────────────────────────────────────────────────── */
  /* With a grader the relevance gate decides; without one there is nothing to
     gate on, so the shortlist ships in the order it was ranked. */
  const shipped = (grading
    ? pickShip(graded, config)
    : graded.map((it) => ({ ...it, band: bandOfRelevance(it.relevance) }))
  ).map((it) => ({ ...it, redundancy: redundancy(it.vector, recentStones) }));

  const stored = storeCandidates(graded, config);

  /* ── 9. Enrich only what clears the ship bar ────────────────────────── */
  const shipBar = Number.isFinite(config?.ship?.relevance) ? config.ship.relevance : 3;
  const toEnrich = shipped.filter((it) => Number.isFinite(it.relevance) && it.relevance >= shipBar);
  let enriched = shipped;
  if (toEnrich.length) {
    const done = await enrich(toEnrich, {
      cachePath: path.join(outDir, 'enrichment.json'),
    });
    const doneById = new Map((done || []).map((it) => [it.arxivId || it.id, it]));
    enriched = shipped.map((it) => doneById.get(it.id) || it);
  }

  /* ── 10. The summary, only when there is a grader to write it ───────── */
  const summary = grading ? await summarize({ llm, items: enriched, env }) : '';

  /* ── 11. Write: one feed per axis preset, plus the stockpile ────────── */
  const feeds = {};
  const written = [];
  for (const axis of axisIds) {
    const slug = slugOf[axis];
    const items = enriched.filter((it) => it.best_axis === axis);
    feeds[slug] = {
      name: presetOf[slug]?.name || slug, tally: tallyOf(items), items: archiveEntry(items),
    };
    if (dryRun) continue;
    await disk.writeFile(path.join(outDir, `${slug}.xml`),
      renderFeed({ preset: presetOf[slug], slug, items, site, builtOn, summary }));
    written.push(path.join(outDir, `${slug}.xml`));
  }

  if (!dryRun && Object.keys(feeds).length) {
    const archiveDir = path.join(outDir, 'archive');
    await disk.mkdir(archiveDir, { recursive: true });
    const monthPath = path.join(archiveDir, `${builtOn.slice(0, 7)}.json`);
    let priorMonth = null;
    try { priorMonth = JSON.parse(await disk.readFile(monthPath, 'utf8')); } catch (_) { /* new month */ }
    await disk.writeFile(monthPath,
      JSON.stringify(mergeMonth(priorMonth, builtOn, feeds, summary)) + '\n');
    written.push(monthPath);
  }

  log.log(`rank: ${day.length} stones, ${listed.papers.length} shortlisted, ` +
    `${shipped.length} shipped, ${stored.length} to store` +
    `${grading ? '' : ' (no grader key)'}`);

  return {
    builtOn,
    summary,
    stones: day.length,
    shortlisted: listed.papers.map((p) => p.id),
    shipped: shipped.map((it) => ({
      id: it.id, band: it.band, best_axis: it.best_axis, relevance: it.relevance,
      novelty: it.novelty, redundancy: it.redundancy,
    })),
    stored: stored.map((it) => it.id),
    feeds: Object.fromEntries(Object.entries(feeds).map(([slug, f]) => [slug, f.items.map((i) => i.id)])),
    written,
  };
}

/* ── The CLI ────────────────────────────────────────────────────────────── */

function arg(name, fallback = null) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/** Tonight's announcement plus the lookback window, deduped by arXiv id. */
async function fetchDay(config) {
  const categories = config.feed.categories;
  const seen = new Set();
  const stones = [];
  for (const cat of categories) {
    try {
      for (const s of (await fetchAbstracts(cat)).stones) {
        if (seen.has(s.arxivId)) continue;
        seen.add(s.arxivId);
        stones.push(s);
      }
    } catch (err) {
      console.warn(`rank: ${cat} — ${err.message}`);
    }
  }
  const lookback = config.feed.lookback_weekdays;
  if (lookback > 1) {
    try {
      for (const s of await fetchEarlier(categories, lookback, LOOKBACK_MAX)) {
        if (seen.has(s.arxivId)) continue;
        seen.add(s.arxivId);
        stones.push(s);
      }
    } catch (err) {
      console.warn(`rank: lookback — ${err.message}`);
    }
  }
  return stones;
}

async function main() {
  const configFile = arg('config');
  if (!configFile) {
    console.error('rank: --config <config/name.yml> is required');
    process.exit(2);
  }
  const outDir = arg('out', '../docs/feeds');
  const site = arg('site') || process.env.ARXAVE_SITE || DEFAULT_SITE;
  const raw = await loadConfig(configFile);
  const packDir = arg('pack') ?? path.join(path.dirname(configFile), '..', 'criteria', raw.criterion);
  /* The criterion pack and the config are two different things that both have
     an `axes`: the pack's are the presets' rows, the config's are the shortlist
     weights. Only the latter is a config knob, so the overrides are merged into
     the config and the pack's own fields are passed through untouched. */
  const pack = await loadPack(packDir);
  const config = applyOverrides(raw, pack);
  const presetDir = arg('presets', '../docs/presets');
  const { bySlug, failures } = await loadPresets(presetDir);
  if (failures.length) console.warn('rank: ' + failures.join(' | '));

  let embedUrl;
  try {
    embedUrl = resolveEndpoint(arg('embed'), process.env.EMBED_URL, DEFAULT_EMBED);
  } catch (err) {
    console.error('rank: ' + err.message);
    process.exit(2);
  }
  const embed = chooseEmbedder(
    { embedLocal: process.argv.includes('--embed-local') }, { embedChunk, embedUrl });
  const gradeChars = Number.isFinite(config.llm?.grade_chars) ? config.llm.grade_chars : 8_000;

  await runRank({
    config,
    pack,
    presets: bySlug,
    fetchStones: () => fetchDay(config),
    embed,
    backgroundPath: arg('background', path.join(packDir, 'background.json')),
    /* The head of arXiv's own HTML, or the abstract when there is none —
       `grade_read: abstract` turns the fetch off entirely. */
    readPaper: config.llm?.grade_read === 'abstract'
      ? undefined
      : (id) => fetchFullText(id, { budget: gradeChars }),
    outDir,
    site,
    dryRun: process.argv.includes('--dry-run'),
  });
}

// Importable for tests; only the CLI invocation runs the pipeline.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('rank: ' + (err?.stack ?? err));
    process.exit(1);
  });
}

