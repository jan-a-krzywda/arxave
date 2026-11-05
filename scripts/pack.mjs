/**
 * pack — a criterion pack → the axis presets the pipeline ranks against.
 *
 * A criterion pack (criteria/<name>/) is data: a rubric for the grader, the
 * citable requirements, and — in seeds.yml — the reading axes, each carrying
 * its touchstone phrases and its seed papers. This is the only place that turns
 * that data into the preset files the rest of the pipeline reads, so the seed
 * list stays the single source of truth for what each axis is.
 *
 * The presets it writes are UNLISTED. They land in docs/presets/ so
 * `loadPresets` warms their touchstones and cores, but they are never added to
 * docs/presets/index.json — and the site catalogue, which reads that manifest,
 * therefore never offers them as buttons.
 *
 * Usage:
 *   node pack.mjs --pack ../criteria/quantum-systems --out ../docs/presets
 *
 * Flags:
 *   --pack    the criterion pack directory, criteria/<name> (required)
 *   --out     where the preset files go (default: ../docs/presets)
 *   --config  the pipeline config, for the presets' scout block
 *             (default: config/<criterion name>.yml beside the pack)
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';

/* Reused rather than re-spelled: the version suffix and the `arXiv:` prefix
   must come off the same way here as in the warmer that later resolves them. */
import { bareArxivId } from './warm-dig.mjs';

/* The three words shortlist.sensitivity may take; each must name a preset in
   sensitivity_presets. Mirrors the spec's strict | normal | broad. */
const SENSITIVITIES = ['strict', 'normal', 'broad'];

/* The page's own default scouting cap (docs/assets/filter.js), and what every
   shipped preset carries. Nothing in the config overrides it, so it is a
   constant here rather than a missing knob. */
const SCOUT_MAX_RESULTS = 200;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A dotted path off `obj`, or an Error naming the file and the key. */
function get(file, obj, key) {
  const value = key.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
  if (value === undefined || value === null || value === '') {
    throw new Error(`${file}: ${key} is missing`);
  }
  return value;
}

function requireNumber(file, obj, key) {
  const value = Number(get(file, obj, key));
  if (!Number.isFinite(value)) throw new Error(`${file}: ${key} must be a number`);
  return value;
}

async function readText(file, readFile) {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    const wrapped = new Error(`${file}: ${err.message}`);
    wrapped.code = err.code;   // callers may still tell "absent" from "broken"
    throw wrapped;
  }
}

async function readYaml(file, readFile) {
  const raw = await readText(file, readFile);
  try {
    return parseYaml(raw);
  } catch (err) {
    throw new Error(`${file}: ${err.message}`);
  }
}

/**
 * The pipeline config, validated.
 *
 * Every failure names the file and the key that caused it: a config loader that
 * fails with "cannot read property of undefined" twenty seconds into a nightly
 * run costs a morning, and one that says which key is wrong costs a minute.
 */
export async function loadConfig(file, { readFile = fs.readFile } = {}) {
  const config = await readYaml(file, readFile);
  if (!isObject(config)) throw new Error(`${file}: not a mapping`);

  get(file, config, 'criterion');

  const categories = get(file, config, 'feed.categories');
  if (!Array.isArray(categories) || !categories.every((c) => typeof c === 'string' && c.trim())) {
    throw new Error(`${file}: feed.categories must be a non-empty list of arXiv categories`);
  }
  requireNumber(file, config, 'feed.lookback_weekdays');

  requireNumber(file, config, 'shortlist.max');
  requireNumber(file, config, 'shortlist.min');
  const sensitivity = get(file, config, 'shortlist.sensitivity');
  if (!SENSITIVITIES.includes(sensitivity)) {
    throw new Error(
      `${file}: shortlist.sensitivity "${sensitivity}" is not one of ${SENSITIVITIES.join('|')}`);
  }
  for (const name of SENSITIVITIES) {
    const rate = requireNumber(file, config, `sensitivity_presets.${name}.background_pass`);
    if (!(rate > 0 && rate <= 1)) {
      throw new Error(`${file}: sensitivity_presets.${name}.background_pass must be in (0, 1]`);
    }
  }

  for (const key of ['llm.base_url', 'llm.model', 'llm.api_key_env']) get(file, config, key);
  for (const key of ['store.relevance', 'store.novelty', 'store.novelty_min_relevance']) {
    requireNumber(file, config, key);
  }
  for (const key of ['ship.relevance', 'ship.max', 'ship.longshots_on_empty']) {
    requireNumber(file, config, key);
  }
  const axes = get(file, config, 'axes');
  if (!isObject(axes)) throw new Error(`${file}: axes is missing`);
  for (const id of Object.keys(axes)) requireNumber(file, config, `axes.${id}`);

  return config;
}

/**
 * A criterion pack, read and normalised.
 *
 * `requirements` becomes a Map because the grader's job is "is this id
 * citable?" — a set lookup, not a scan — and because the contract says so.
 */
export async function loadPack(dir, { readFile = fs.readFile } = {}) {
  const criterionFile = path.join(dir, 'criterion.yml');
  const criterion = await readYaml(criterionFile, readFile);
  if (!isObject(criterion)) throw new Error(`${criterionFile}: not a mapping`);
  const axisIds = get(criterionFile, criterion, 'axes');
  if (!Array.isArray(axisIds) || !axisIds.length) {
    throw new Error(`${criterionFile}: axes must be a non-empty list of axis ids`);
  }

  const rubric = await readText(path.join(dir, 'rubric.md'), readFile);

  const requirements = new Map();
  const requirementsFile = path.join(dir, 'requirements.yml');
  try {
    const doc = await readYaml(requirementsFile, readFile);
    for (const req of doc?.requirements ?? []) {
      if (!req?.id || typeof req.text !== 'string') {
        throw new Error(`${requirementsFile}: every requirement needs an id and a text`);
      }
      requirements.set(req.id, req.text);
    }
  } catch (err) {
    /* A pack with no requirements.yml still works: the grader then has no
       anchors to cite, which is a valid way to score a rubric-only pack. */
    if (err.code !== 'ENOENT') throw err;
  }

  const seedsFile = path.join(dir, 'seeds.yml');
  const seeds = await readYaml(seedsFile, readFile);
  if (!isObject(seeds?.axes)) throw new Error(`${seedsFile}: axes is missing`);

  const axes = {};
  for (const id of axisIds) {
    const axis = seeds.axes[id];
    if (!isObject(axis)) throw new Error(`${seedsFile}: axes.${id} is missing`);
    if (typeof axis.name !== 'string' || !axis.name.trim()) {
      throw new Error(`${seedsFile}: axes.${id}.name is missing`);
    }
    axes[id] = {
      name: axis.name,
      touchstones: (axis.touchstones ?? []).map((t) => ({
        text: String(t?.text ?? '').trim(),
        weight: Number.isFinite(parseFloat(t?.weight)) ? parseFloat(t.weight) : 1.0,
      })),
      seeds: (axis.seeds ?? []).map((seed) => {
        if (!seed?.doi && !seed?.arxiv) {
          throw new Error(`${seedsFile}: axes.${id} has a seed with neither a doi nor an arxiv id`);
        }
        return {
          ...seed,
          weight: Number.isFinite(parseFloat(seed.weight)) ? parseFloat(seed.weight) : 1.0,
        };
      }),
    };
  }

  return { criterion, rubric, requirements, axes };
}

function deepMerge(base, over) {
  for (const [key, value] of Object.entries(over ?? {})) {
    base[key] = isObject(value) && isObject(base[key])
      ? deepMerge(base[key], value) : structuredClone(value);
  }
  return base;
}

/**
 * The pack's own overrides, deep-merged over the config.
 *
 * Returns a fresh object: the caller keeps the un-overridden config for the
 * parts of the pipeline the pack has no business changing, and the pack never
 * has to be trusted not to have mutated it.
 */
export function applyOverrides(config, pack) {
  return deepMerge(structuredClone(config), pack?.criterion?.overrides ?? {});
}

/** The one-line description a preset carries; the pack's own words, collapsed. */
function blurbOf(criterion) {
  const text = criterion.description || criterion.title || criterion.name || '';
  return String(text).replace(/\s+/g, ' ').trim();
}

/** A seed paper as the preset stores it: a DOI, or an arXiv id when it has none. */
function coreOf(seed) {
  const weight = Number.isFinite(parseFloat(seed.weight)) ? parseFloat(seed.weight) : 1.0;
  if (seed.doi) return { doi: String(seed.doi).trim(), weight };
  return { arxiv: bareArxivId(seed.arxiv), weight };
}

/**
 * One preset claim per axis, in criterion.axes order.
 *
 * The claim's keys and their order are the shipped presets' (`arxave_claim`,
 * `preset`, `name`, `blurb`, `saved`, `scout`, `touchstones`, `cores`, `blend`)
 * with `unlisted` and `axis` appended, so a generated file is the same kind of
 * thing the page already loads — just one the catalogue does not offer.
 *
 * `feed` is the pipeline's feed block (config.feed, after overrides): the
 * preset's scout window has to be the window the pipeline actually scouts, or
 * its feed would be built from a different set of papers than the page ranks.
 */
export function presetsFromPack(pack, { saved, feed } = {}) {
  const scout = {
    categories: (feed?.categories ?? []).join(', '),
    lookback_days: Number.isFinite(parseFloat(feed?.lookback_weekdays))
      ? parseFloat(feed.lookback_weekdays) : 1,
    max_results: SCOUT_MAX_RESULTS,
  };
  return pack.criterion.axes.map((id) => {
    const axis = pack.axes[id];
    const claim = {
      arxave_claim: 1,
      preset: `qs-${id.toLowerCase()}`,
      name: axis.name,
      blurb: blurbOf(pack.criterion),
      saved: saved ?? new Date().toISOString().slice(0, 10),
      scout: { ...scout },
      touchstones: axis.touchstones.map((t) => ({ text: t.text, weight: t.weight })),
      cores: axis.seeds.map(coreOf),
      blend: { paydirt_n: 10 },
      unlisted: true,
      axis: id,
    };
    return { slug: claim.preset, claim };
  });
}


/** Slugs docs/presets/index.json already offers, or an empty set without one. */
async function listedSlugs(outDir, readFile) {
  try {
    const manifest = JSON.parse(await readFile(path.join(outDir, 'index.json'), 'utf8'));
    return new Set((manifest.presets ?? []).map((p) => p.slug));
  } catch (_) {
    return new Set();   // no readable manifest yet
  }
}

/**
 * Write every axis preset under outDir. Never touches index.json.
 *
 * A generated slug the catalogue already lists is skipped rather than
 * overwritten: writing an `unlisted` file under a listed slug would put the
 * file and the manifest in disagreement about the same preset, and index.json
 * is the page's, not ours.
 */
export async function writePresets(pack, outDir, {
  saved, feed, readFile = fs.readFile, writeFile = fs.writeFile,
} = {}) {
  const listed = await listedSlugs(outDir, readFile);
  const written = [];
  for (const { slug, claim } of presetsFromPack(pack, { saved, feed })) {
    if (listed.has(slug)) {
      console.warn(`pack: ${slug} is already in index.json — leaving it to the catalogue`);
      continue;
    }
    const file = path.join(outDir, slug + '.json');
    await writeFile(file, JSON.stringify(claim, null, 2) + '\n');
    written.push(file);
  }
  return written;
}

function arg(name, fallback = null) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const packDir = arg('pack');
  if (!packDir) {
    console.error('pack: --pack <criteria/name> is required');
    process.exit(2);
  }
  const outDir = arg('out', '../docs/presets');

  const pack = await loadPack(packDir);
  /* The pack sits at criteria/<name>, so its config is two levels up in
     config/<name>.yml — the same file rank.mjs reads, resolved from the pack
     rather than from wherever the shell happens to be standing. */
  const configFile = arg('config') ?? path.join(packDir, '..', '..', 'config', pack.criterion.name + '.yml');
  const config = await loadConfig(configFile);

  await fs.mkdir(outDir, { recursive: true });
  const written = await writePresets(pack, outDir, {
    saved: new Date().toISOString().slice(0, 10),
    feed: applyOverrides(config, pack).feed,
  });
  console.log(`pack: wrote ${written.length} unlisted preset(s) to ${outDir}`);
  console.log('pack: docs/presets/index.json untouched');
}

// Importable for tests; only the CLI invocation writes files.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('pack: ' + (err?.stack ?? err));
    process.exit(1);
  });
}

