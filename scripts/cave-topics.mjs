/**
 * cave-topics — hand-labelled seed papers, nearest-centroid topic assignment,
 * and the two files the Cave page reads (`topics.json` + the `topic`/`topic2`
 * arrays in `corpus.json`).
 *
 * WHY NEAREST CENTROID AND NOT k-MEANS. The 20 k-means clusters v2 ships are
 * unnamed shapes in the vector space; the Cave page needs the leaves the spec
 * names, in a tree the reader can recognise. Twenty-five hand-picked seeds per
 * leaf fix the names and the positions, and every paper — tonight's included —
 * is then one dot product away from a topic. `leaveOneOut` is the honesty
 * check: drop a seed, rebuild its centroid from the other 24, and see whether
 * the space alone puts it back. Below 90% the seeds are describing themselves
 * rather than the topic.
 *
 * PURE, THEN A CLI. `centroidsFromSeeds`, `assign` and `leaveOneOut` take plain
 * data (the `loadCorpus` object and the seeds JSON) and return plain data, so
 * the hand-built fixtures in the test can be three-dimensional. Only `main()`
 * touches the disk.
 *
 * CENTRING. `loadCorpus` (`docs/assets/sieve-core.mjs`) already centres every
 * row and normalises it, which is the same convention the browser uses, so a
 * centroid here is exactly the mean of its seeds re-normalised — no second
 * centring, which would quietly move every centroid off the sphere the page
 * compares against.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadCorpus } from '../docs/assets/sieve-core.mjs';

/* ── the contract's tree (cave-v3-interfaces.md) ────────────────────────── */

export const PARENTS = Object.freeze([
  ['computing', 'Computing', 'prefer'],
  ['measurement', 'Measurement', 'equal'],
  ['matter', 'Matter', 'equal'],
  ['light-atoms', 'Light & atoms', 'equal'],
  ['foundations', 'Foundations & gravity', 'equal'],
].map(([id, label, def]) => Object.freeze({ id, label, default: def })));

export const LEAVES = Object.freeze([
  ['opt-qalgo', 'computing', 'Optimisation & quantum algorithms'],
  ['qml', 'computing', 'Quantum machine learning'],
  ['qec', 'computing', 'Error-correcting codes'],
  ['ft-roadmaps', 'computing', 'Fault-tolerant computing & roadmaps'],
  ['tomo-metro', 'measurement', 'Tomography & metrology'],
  ['sensing', 'measurement', 'Quantum sensing'],
  ['many-body', 'matter', 'Many-body physics'],
  ['materials', 'matter', 'Quantum materials'],
  ['cold-atoms', 'light-atoms', 'Cold atoms & quantum optics'],
  ['cavity-qed', 'light-atoms', 'Cavity QED'],
  ['foundations', 'foundations', 'Foundations'],
  ['gravity', 'foundations', 'Gravity & holography'],
].map(([id, parent, label]) => Object.freeze({ id, parent, label })));

export const TAGS = Object.freeze([Object.freeze({ id: 'ml4q', label: 'ML for quantum' })]);

/** Cosine of two rows that are normally both unit; a zero norm scores 0, not NaN. */
function cosine(a, b, dim) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let k = 0; k < dim; k++) {
    dot += a[k] * b[k];
    na += a[k] * a[k];
    nb += b[k] * b[k];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d > 0 && Number.isFinite(d) ? dot / d : 0;
}

/** `sum` scaled onto the unit sphere, left alone when it has no length. */
function unit(sum, dim) {
  const out = new Float32Array(dim);
  let n = 0;
  for (let k = 0; k < dim; k++) n += sum[k] * sum[k];
  n = Math.sqrt(n);
  if (n > 0 && Number.isFinite(n)) for (let k = 0; k < dim; k++) out[k] = sum[k] / n;
  return out;
}

/**
 * Seeds: `{ leafId: [paperId | {id, why}, ...] }` → mean seed vector per leaf,
 * re-normalised, in the key order of `seeds` (the CLI feeds it contract order,
 * and that order is the `topic` index space).
 *
 * Returns `{ leafIds, dim, centroids }`. A seed id that is not in the corpus,
 * a leaf with no seeds, or a paper sitting in two leaves is a mistake that
 * would otherwise show up as a slightly wrong centroid and a slightly lower
 * leave-one-out number — so each of them throws instead.
 */
export function centroidsFromSeeds(vecs, seeds) {
  const { dim, ids } = vecs ?? {};
  if (!Array.isArray(ids)) throw new Error('cave-topics: centroidsFromSeeds needs a loadCorpus object');
  const row = new Map();
  for (let i = 0; i < ids.length; i++) row.set(ids[i], i);

  const leafIds = Object.keys(seeds ?? {});
  if (!leafIds.length) throw new Error('cave-topics: no leaves in the seeds');

  const seen = new Map();
  const centroids = leafIds.map((leafId) => {
    const list = seeds[leafId];
    if (!Array.isArray(list) || !list.length) throw new Error(`cave-topics: leaf ${leafId} has no seeds`);
    const sum = new Float64Array(dim);
    for (const entry of list) {
      const id = typeof entry === 'string' ? entry : entry?.id;
      const at = row.get(id);
      if (at === undefined) throw new Error(`cave-topics: seed ${id} in ${leafId} is not in the corpus`);
      if (seen.has(id)) throw new Error(`cave-topics: ${id} is a seed in both ${seen.get(id)} and ${leafId}`);
      seen.set(id, leafId);
      const off = at * dim;
      for (let k = 0; k < dim; k++) sum[k] += vecs.vecs[off + k];
    }
    return unit(sum, dim);
  });

  return { leafIds, dim, centroids };
}

/**
 * Nearest centroid: `{ topic, topic2 }`. `topic2` is the runner-up only when
 * its cosine is within 0.03 of the best (the spec's "close runner-up"), else
 * -1. Ties go to the lower index, so the answer never depends on iteration
 * luck.
 */
export function assign(vec, centroids) {
  if (!Array.isArray(centroids) || !centroids.length) throw new Error('cave-topics: assign needs centroids');
  const dim = vec.length;
  if (centroids[0].length !== dim) {
    throw new Error(`cave-topics: assign got ${dim} dims against ${centroids[0].length}-dim centroids`);
  }
  const scores = centroids.map((c) => cosine(vec, c, dim));
  let topic = 0;
  for (let k = 1; k < scores.length; k++) if (scores[k] > scores[topic]) topic = k;

  let second = -1;
  let secondAt = -1;
  for (let k = 0; k < scores.length; k++) {
    if (k === topic) continue;
    if (scores[k] > second) {
      second = scores[k];
      secondAt = k;
    }
  }
  const topic2 = secondAt >= 0 && scores[topic] - second <= 0.03 ? secondAt : -1;
  return { topic, topic2 };
}

/**
 * Leave-one-out recall over the seeds, in [0,1]: for each seed, rebuild its
 * leaf's centroid without it, assign the seed, and count a hit when it lands
 * back in its own leaf (primary only — a `topic2` would be a half hit).
 *
 * A leaf with a single seed has nothing to leave out and cannot be scored, so
 * it throws rather than reporting a flattering number.
 */
export function leaveOneOut(vecs, seeds) {
  const { dim, leafIds } = centroidsFromSeeds(vecs, seeds);
  const row = new Map();
  for (let i = 0; i < vecs.ids.length; i++) row.set(vecs.ids[i], i);
  const index = (entry) => row.get(typeof entry === 'string' ? entry : entry?.id);

  // One raw (un-normalised) sum per leaf, so a held-out seed is a subtraction
  // rather than a second pass over the list.
  const sums = leafIds.map((leafId) => {
    const sum = new Float64Array(dim);
    for (const entry of seeds[leafId]) {
      const off = index(entry) * dim;
      for (let k = 0; k < dim; k++) sum[k] += vecs.vecs[off + k];
    }
    return sum;
  });

  const base = sums.map((s) => unit(s, dim));
  let hits = 0;
  let total = 0;
  for (let leaf = 0; leaf < leafIds.length; leaf++) {
    const list = seeds[leafIds[leaf]];
    if (list.length < 2) throw new Error(`cave-topics: leaf ${leafIds[leaf]} needs two seeds to leave one out`);
    for (const entry of list) {
      const off = index(entry) * dim;
      const rest = new Float64Array(dim);
      for (let k = 0; k < dim; k++) rest[k] = sums[leaf][k] - vecs.vecs[off + k];
      const held = base.slice();
      held[leaf] = unit(rest, dim);
      if (assign(vecs.vecs.subarray(off, off + dim), held).topic === leaf) hits++;
      total++;
    }
  }
  return total ? hits / total : 0;
}

/* ── CLI: seeds + corpus in, topics.json + topic arrays out ─────────────── */

/** Four decimals, as the contract asks, and no `-0` in the output. */
function round4(x) {
  const r = Math.round(x * 1e4) / 1e4;
  return r === 0 ? 0 : r;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--corpus' || argv[i] === '--seeds') out[argv[i].slice(2)] = argv[++i];
    else throw new Error(`cave-topics: unknown argument ${argv[i]}`);
  }
  if (!out.corpus || !out.seeds) throw new Error('cave-topics: usage: --corpus <dir> --seeds <file>');
  return out;
}

/**
 * The seeds file restricted to the contract's leaves, in contract order (that
 * order is the `topic` index space) and with every id checked against the
 * corpus, so a mistyped arXiv id is an error here rather than a silently
 * missing seed later.
 */
function orderedSeeds(file, corpusIds) {
  const byLeaf = file.leaves ?? file;
  const wanted = LEAVES.map((l) => l.id);
  const missing = wanted.filter((id) => !byLeaf[id]);
  const extra = Object.keys(byLeaf).filter((id) => !wanted.includes(id));
  if (missing.length) throw new Error(`cave-topics: seeds have no leaf ${missing.join(', ')}`);
  if (extra.length) throw new Error(`cave-topics: seeds name unknown leaf ${extra.join(', ')}`);

  const have = new Set(corpusIds);
  const ordered = {};
  for (const leaf of LEAVES) {
    ordered[leaf.id] = byLeaf[leaf.id].map((entry) => {
      const id = typeof entry === 'string' ? entry : entry?.id;
      if (!have.has(id)) throw new Error(`cave-topics: seed ${id} in ${leaf.id} is not in the corpus`);
      return entry;
    });
  }
  return ordered;
}

/** topics.json: the tree the contract fixes, plus this run's centroids. */
function topicsFromCentroids(dim, centroids) {
  return {
    version: 1,
    dim,
    parents: PARENTS.map((p) => ({ ...p })),
    leaves: LEAVES.map((leaf, i) => ({
      id: leaf.id,
      parent: leaf.parent,
      label: leaf.label,
      centroid: Array.from(centroids[i], round4),
    })),
    tags: TAGS.map((t) => ({ ...t })),
  };
}

function main(argv) {
  const args = parseArgs(argv);
  const corpusJson = JSON.parse(readFileSync(join(args.corpus, 'corpus.json'), 'utf8'));
  const corpus = loadCorpus(corpusJson, readFileSync(join(args.corpus, 'corpus.vec.bin')));
  const seeds = orderedSeeds(JSON.parse(readFileSync(args.seeds, 'utf8')), corpus.ids);

  const { leafIds, dim, centroids } = centroidsFromSeeds(corpus, seeds);
  // topics.json's centroids are the rounded ones (4 decimals, as the contract
  // asks) and the assignment uses exactly those: the page compares tonight's
  // papers against the rounded file, so a paper on a knife edge must not flip
  // between what ships and what the arrays say.
  const published = centroids.map((c) => Array.from(c, round4));
  // topic/topic2 are appended after every existing key; the rest of the object
  // is written back exactly as parsed (the file is compact JSON, so the diff is
  // the same line with two arrays added and no other value touched).
  corpusJson.topic = new Array(corpus.n);
  corpusJson.topic2 = new Array(corpus.n);
  const counts = new Array(leafIds.length).fill(0);
  for (let i = 0; i < corpus.n; i++) {
    const { topic, topic2 } = assign(corpus.vecs.subarray(i * dim, (i + 1) * dim), published);
    corpusJson.topic[i] = topic;
    corpusJson.topic2[i] = topic2;
    counts[topic]++;
  }

  writeFileSync(join(args.corpus, 'topics.json'), JSON.stringify(topicsFromCentroids(dim, published)));
  writeFileSync(join(args.corpus, 'corpus.json'), JSON.stringify(corpusJson));

  const extra = corpusJson.topic2.reduce((n, t) => n + (t >= 0 ? 1 : 0), 0);
  const recall = leaveOneOut(corpus, seeds);
  console.log(`leave-one-out seed recall: ${recall.toFixed(3)} `
    + `(${leafIds.length} leaves, ${LEAVES.reduce((n, l) => n + seeds[l.id].length, 0)} seeds)`);
  console.log(`papers with a close secondary: ${extra}/${corpus.n}`);
  console.log(leafIds.map((id, i) => `${id}: ${counts[i]}`).join('\n'));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

