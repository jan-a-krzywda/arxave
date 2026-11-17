/**
 * cave-topic-seeds — a field's topic seeds from title rules, for cave-topics.
 *
 * WHY A SCRIPT, NOT A HAND LIST. The quantum seeds were picked once by hand
 * from keyword matches; a second field (AI) needs the same thing for a corpus
 * nobody has read. The rules live in `cave-seeds/<field>/tree.json`, beside
 * the tree they fill, so the maintainer argues with a regex rather than with
 * three hundred ids — and rerunning after an edit gives the same seeds.
 *
 * THE PICK. A title that matches exactly one leaf's rules joins that leaf's
 * pool; a title that matches two is dropped, because ambiguity in a seed is
 * error in a centroid. The pool's mean is the leaf's rough position, and the
 * `--per` pool members closest to it are the seeds: one coherent area, not a
 * keyword bag. The quantum seeds note describes the same procedure.
 *
 * PURE, THEN A CLI, like cave-topics: `pickTopicSeeds` takes the `loadCorpus`
 * object and the tree, and only `main()` touches the disk.
 *
 *   node scripts/cave-topic-seeds.mjs --corpus docs/assets/corpus/ai \
 *     --tree scripts/cave-seeds/ai/tree.json --out scripts/cave-seeds/ai/topics.json [--per 25]
 *
 * Then: node scripts/cave-topics.mjs --corpus docs/assets/corpus/ai --seeds scripts/cave-seeds/ai/topics.json
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadCorpus } from '../docs/assets/sieve-core.mjs';

/** The first rule of `leaf` the title matches, or null. */
function ruleFor(leaf, title) {
  return leaf.compiled.find((rule) => rule.re.test(title)) ?? null;
}

/**
 * `{ leafId: [{ id, why }] }` in tree order, plus each leaf's pool size so the
 * CLI can say which leaf is thin. `corpus` needs `ids`, `titles`, `dim` and the
 * centred unit `vecs` that `loadCorpus` builds.
 */
export function pickTopicSeeds(corpus, tree, { per = 25 } = {}) {
  const leaves = (tree?.leaves ?? []).map((leaf) => ({
    ...leaf,
    compiled: (leaf.rules ?? []).map((r) => ({ re: new RegExp(r.re, 'i'), why: r.why })),
  }));
  if (!leaves.length) throw new Error('cave-topic-seeds: tree has no leaves');
  const titles = corpus.titles ?? [];
  const { dim, vecs } = corpus;

  const pools = leaves.map(() => []);
  for (let i = 0; i < corpus.ids.length; i++) {
    const title = String(titles[i] ?? '');
    let at = -1;
    let rule = null;
    let hits = 0;
    leaves.forEach((leaf, k) => {
      const r = ruleFor(leaf, title);
      if (!r) return;
      hits++;
      at = k;
      rule = r;
    });
    if (hits === 1) pools[at].push({ row: i, why: rule.why });
  }

  const seeds = {};
  const poolSizes = {};
  leaves.forEach((leaf, k) => {
    const pool = pools[k];
    poolSizes[leaf.id] = pool.length;
    const mean = new Float64Array(dim);
    for (const { row } of pool) for (let d = 0; d < dim; d++) mean[d] += vecs[row * dim + d];
    const score = (row) => {
      let dot = 0;
      for (let d = 0; d < dim; d++) dot += mean[d] * vecs[row * dim + d];
      return dot;
    };
    seeds[leaf.id] = pool
      .map((entry) => ({ ...entry, s: score(entry.row) }))
      .sort((a, b) => (b.s - a.s) || (a.row - b.row))
      .slice(0, per)
      .map(({ row, why }) => ({ id: corpus.ids[row], why }));
  });
  return { seeds, poolSizes };
}

function arg(argv, name, fallback = null) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

function main(argv) {
  const corpusDir = arg(argv, 'corpus');
  const treePath = arg(argv, 'tree');
  const out = arg(argv, 'out');
  if (!corpusDir || !treePath || !out) {
    throw new Error('usage: --corpus <dir> --tree <tree.json> --out <seeds.json> [--per 25]');
  }
  const per = Number(arg(argv, 'per', 25));
  const json = JSON.parse(readFileSync(join(corpusDir, 'corpus.json'), 'utf8'));
  const corpus = loadCorpus(json, readFileSync(join(corpusDir, 'corpus.vec.bin')));
  corpus.titles = json.titles;
  const tree = JSON.parse(readFileSync(treePath, 'utf8'));

  const { seeds, poolSizes } = pickTopicSeeds(corpus, tree, { per });
  const file = {
    version: 1,
    note: `Seeds picked by cave-topic-seeds.mjs from the rules in ${treePath.split('/').slice(-2).join('/')}: `
      + `titles matching exactly one leaf, the ${per} closest to that leaf's pool mean.`,
    tree: {
      parents: tree.parents,
      leaves: tree.leaves.map(({ id, parent, label }) => ({ id, parent, label })),
      tags: tree.tags ?? [],
    },
    leaves: seeds,
  };
  writeFileSync(out, JSON.stringify(file, null, 1) + '\n');
  for (const leaf of tree.leaves) {
    const thin = seeds[leaf.id].length < per ? '  (thin)' : '';
    console.log(`${leaf.id}: pool ${poolSizes[leaf.id]}, seeds ${seeds[leaf.id].length}${thin}`);
  }
  console.log(`cave-topic-seeds: written to ${out}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error('cave-topic-seeds: ' + (err?.message ?? err));
    process.exit(1);
  }
}
