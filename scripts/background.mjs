/**
 * background — the fixed yardstick every axis is measured against.
 *
 * WHY A BACKGROUND AT ALL. `preset-feed.mjs` scores a day against that day's
 * own median: it answers "what is worth reading today", which is a different
 * question from "is this paper relevant at all". A quiet day still produces a
 * z of 2, and a preset that matches its whole category pushes its own good
 * papers down. So the pipeline needs a bar that does not move with the day, and
 * the only honest way to set it is to measure it: score a large, fixed sample of
 * ordinary papers against each axis and read the distribution off.
 *
 * WHAT IS MEASURED, PER AXIS. For every paper in the sample, its blended grade
 * (`grade`, the page's own formula) and its single closest row (`maxSim`). The
 * `mean_sim` distribution sets `tau_ref` — a z that means the same thing on
 * every axis — and the `max_sim` distribution sets `tau_seed`, because a single
 * very close seed is exactly the signal there and a z would flatten it.
 *
 * THE SAMPLE IS THE LOOKBACK WINDOW, ~60 weekdays of the configured categories,
 * fetched through the same `fetchEarlier` the warmer uses, embedded with the
 * cache key text and centred exactly as the pipeline centres a day's stones.
 * Same texts, same transform, same geometry — or the thresholds would describe
 * a space the ranking never visits.
 *
 * A SEED THAT WILL NOT RESOLVE IS SKIPPED, NEVER ZERO. A row that failed to
 * fetch has no vector; scoring it as 0 would drag the axis' mean toward zero and
 * invent a distribution nobody would get at ranking time. `grade` and `maxSim`
 * both drop a row with no vector, so the axis is measured on the rows that did
 * resolve and nothing else.
 *
 * NO I/O IN THE FUNCTION. Fetching, embedding and seed resolution are all
 * injected (`fetchEarlier`, `embed`, `coreFetch`), so the arithmetic is pinned
 * by fixtures in `background.test.mjs` without a socket.
 *
 * CLI:
 *   node background.mjs --pack ../criteria/quantum-systems \
 *     --config ../config/quantum-systems.yml \
 *     --out ../criteria/quantum-systems/background.json [--embed-local]
 *
 * Flags:
 *   --pack         the criterion pack directory, criteria/<name> (required)
 *   --config       the pipeline config (default: config/<pack name>.yml)
 *   --out          where the background JSON goes (required)
 *   --embed-local  embed with SPECTER2 on this machine, not the hosted pick
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadConfig, loadPack, presetsFromPack } from './pack.mjs';
import { center, grade } from './preset-feed.mjs';
import { maxSim, robustStats } from './score.mjs';
import { chooseEmbedder } from './embed-local.mjs';
import {
  DEFAULT_EMBED, cacheKeyText, coreRefs, embedChunk, fetchCore, fetchCoreArxiv,
  fetchEarlier, resolveEndpoint,
} from './warm-dig.mjs';

/* Texts per embed request, the warmer's own batch (warm-dig.mjs). The hosted
   pick bills compute, not calls, and a smaller chunk means one failure costs
   less re-work. */
const BATCH = 64;

/* Per weekday, the per-category window the warmer uses (warm-dig.mjs: 400). The
   background is a distribution, not a day, so the window only has to reach the
   cutoff — under-fetching shrinks the sample silently. ponytail: one window per
   category, so on a very busy archive arXiv may cap it before the 60th weekday;
   the sample is then smaller but still valid. Upgrade path: paginate `start`. */
const RESULTS_PER_WEEKDAY = 400;
/* arXiv's API answers HTTP 500 above ~10000 results in one slice (measured:
   8000 ok, 12000 fails), so the window is capped below that. */
const MAX_WINDOW = 8000;

/* The same dispatcher `loadPresets` uses internally: a DOI resolves through
   OpenAlex, an arXiv-only seed through the search API. Local because that
   helper is not exported, and injected so a test never resolves a real seed. */
const coreFetchDefault = (ref, slug) => (ref.kind === 'doi'
  ? fetchCore(ref.id, slug)
  : fetchCoreArxiv(ref.id, slug));

/** One vector per text, in order, in the warmer's chunks. */
async function embedAll(texts, embed) {
  const out = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    out.push(...await embed(texts.slice(i, i + BATCH)));
  }
  return out;
}

/** The estimator plus the sample it was taken from, sorted ascending. */
function statsOf(values) {
  return { ...robustStats(values), values: [...values].sort((a, b) => a - b) };
}

/**
 * The background object `score.mjs` reads: `{ built_on, n, axes }`, each axis
 * carrying the `mean_sim` and `max_sim` distributions over the sample.
 */
export async function buildBackground({
  pack, config, fetchEarlier: fetch, embed, weekdays = 60,
  coreFetch = coreFetchDefault, maxResults, now = new Date(),
} = {}) {
  const categories = config?.feed?.categories ?? [];
  if (!categories.length) throw new Error('background: config.feed.categories is empty');
  const window = Number.isFinite(maxResults) ? maxResults : Math.min(MAX_WINDOW, weekdays * RESULTS_PER_WEEKDAY);

  const stones = await fetch(categories, weekdays, window, now);
  if (!stones.length) throw new Error('background: the lookback window returned no papers');

  /* Axis rows are the pack's own preset rows — its touchstones, then its
     resolved seed papers — so the background is measured against exactly the
     rows the ranking will use. `presetsFromPack` gives the touchstones and the
     seed refs; `coreRefs` + `coreFetch` turn a ref into the text to embed. */
  const rowsByAxis = {};
  const rowTexts = [];
  for (const { slug, claim } of presetsFromPack(pack, { feed: config?.feed })) {
    const rows = [];
    for (const t of claim.touchstones) rows.push({ text: t.text, weight: t.weight });
    for (const ref of coreRefs(claim)) {
      try {
        const unit = await coreFetch(ref, slug);
        rows.push({ text: unit.text, weight: ref.weight });
      } catch (err) {
        console.warn(`background: ${slug} core ${ref.id} unresolved — ${err.message}`);
      }
    }
    rowsByAxis[claim.axis] = rows;
    for (const r of rows) rowTexts.push(cacheKeyText(r.text));
  }

  const stoneTexts = stones.map((s) => cacheKeyText(s.abstract));
  const vectors = await embedAll([...stoneTexts, ...rowTexts], embed);
  if (vectors.length !== stones.length + rowTexts.length) {
    throw new Error(`background: embed returned ${vectors.length} vectors for ` +
      `${stones.length + rowTexts.length} texts`);
  }

  /* Centred once, here, exactly as a day's stones are — `center` on both sides
     of the cosine, so every number below lives in the space the ranking uses. */
  const stoneVecs = vectors.slice(0, stones.length).map(center);
  let at = stones.length;
  const rowVecs = {};
  for (const id of Object.keys(rowsByAxis)) {
    rowVecs[id] = rowsByAxis[id].map((r) => ({ weight: r.weight, vector: center(vectors[at++]) }));
  }

  const axes = {};
  for (const id of Object.keys(rowsByAxis)) {
    const mean = [];
    const max = [];
    for (const stone of stoneVecs) {
      mean.push(grade(stone, rowVecs[id]));
      max.push(maxSim(stone, rowVecs[id]).max);
    }
    axes[id] = { mean: statsOf(mean), max: statsOf(max) };
  }

  return { built_on: now.toISOString().slice(0, 10), n: stones.length, axes };
}

function arg(name, fallback = null) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const EMBED_LOCAL = process.argv.includes('--embed-local');

async function main() {
  const packDir = arg('pack');
  const outFile = arg('out');
  if (!packDir || !outFile) {
    console.error('background: --pack <criteria/name> and --out <file> are required');
    process.exit(2);
  }
  const pack = await loadPack(packDir);
  /* The pack sits at criteria/<name>, so its config is config/<name>.yml — the
     same file rank.mjs reads, resolved from the pack rather than the shell. */
  const configFile = arg('config')
    ?? path.join(packDir, '..', '..', 'config', pack.criterion.name + '.yml');
  const config = await loadConfig(configFile);

  let embedUrl;
  try {
    embedUrl = resolveEndpoint(arg('embed'), process.env.EMBED_URL, DEFAULT_EMBED);
  } catch (err) {
    console.error('background: ' + err.message);
    process.exit(2);
  }
  /* `--embed-local` swaps the hosted pick for SPECTER2 on this runner; both
     answer `(texts) => Float32Array[]`, so `buildBackground` does not care. */
  const embed = chooseEmbedder({ embedLocal: EMBED_LOCAL }, { embedChunk, embedUrl });
  console.log(`background: embedding with ${EMBED_LOCAL ? 'SPECTER2 on this runner' : 'the hosted pick'}`);

  console.log(`background: fetching 60 weekdays of ${config.feed.categories.join(', ')}`);
  const background = await buildBackground({ pack, config, fetchEarlier, embed });

  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await fs.writeFile(outFile, JSON.stringify(background, null, 2) + '\n');
  console.log(
    `background: ${background.n} papers × ${Object.keys(background.axes).length} axes → ${outFile}`);
}

// Importable for tests; only the CLI invocation writes the file.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('background: ' + (err?.stack ?? err));
    process.exit(1);
  });
}
