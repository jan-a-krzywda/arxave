/**
 * cave-promise-ref — where impact and novelty sit for the corpus itself, so
 * the Cave page can read tonight's papers against the background instead of
 * against each other.
 *
 * LEAVE ONE OUT. Every corpus paper is scored the way `rank` scores a
 * candidate — impact over its k nearest, novelty from its nearest proven paper
 * — against the other n-1, never itself (a paper is its own nearest
 * neighbour at cosine 1, which would make every corpus paper look like a
 * clone of something proven). Tonight's papers are not in the corpus either,
 * so this is the distribution they are drawn against.
 *
 * Topic weights are left uniform: `rank` weighs a neighbour by
 * `p[i] + 0.05`, and a constant weight cancels out of the impact mean. A
 * reader's topic choices move impact a little; the reference does not try to
 * follow them.
 *
 * PURE, THEN A CLI, like cave-topics: `promiseRef` takes the `loadCorpus`
 * object, and only `main()` touches the disk — it writes `promise_ref` into
 * corpus.json and prints how well each term predicts a paper's own citation
 * percentile, the numbers `PROMISE_REF`'s note in sieve-core quotes.
 *
 *   node scripts/cave-promise-ref.mjs [--corpus docs/assets/corpus]
 *
 * n x n dot products: about a minute for the 5 000 x 768 corpus.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadCorpus } from '../docs/assets/sieve-core.mjs';

const round4 = (v) => Math.round(v * 1e4) / 1e4;

/** Mean and population sd of an array. */
function stats(values) {
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  return { mean, sd };
}

/** Pearson correlation of two equal-length arrays. */
function correlation(x, y) {
  const sx = stats(x);
  const sy = stats(y);
  let c = 0;
  for (let i = 0; i < x.length; i++) c += (x[i] - sx.mean) * (y[i] - sy.mean);
  return c / x.length / Math.max(sx.sd * sy.sd, 1e-12);
}

/**
 * Leave-one-out impact and novelty for every corpus paper, as two arrays.
 * The same arithmetic as `rank`: impact is the cosine-weighted mean pct of the
 * k nearest (cosines clamped at 0), novelty is 1 - the largest cosine to a
 * paper with pct >= topQ (1 when there is none).
 */
export function looTerms(corpus, { k = 15, topQ = 0.75 } = {}) {
  const { n, dim, vecs, pct } = corpus;
  const impact = new Float64Array(n);
  const novelty = new Float64Array(n);
  const dots = new Float32Array(n);
  for (let a = 0; a < n; a++) {
    const off = a * dim;
    for (let b = 0; b < n; b++) {
      let s = 0;
      const boff = b * dim;
      for (let d = 0; d < dim; d++) s += vecs[off + d] * vecs[boff + d];
      dots[b] = s;
    }
    const top = [];
    let best = -Infinity;
    for (let b = 0; b < n; b++) {
      if (b === a) continue;
      const c = dots[b];
      if (pct[b] >= topQ && c > best) best = c;
      if (top.length < k || c > top[top.length - 1][0]) {
        top.push([c, b]);
        top.sort((x, y) => y[0] - x[0]);
        if (top.length > k) top.pop();
      }
    }
    let num = 0;
    let den = 0;
    for (const [c, b] of top) {
      const w = Math.max(c, 0);
      num += w * pct[b];
      den += w;
    }
    impact[a] = den ? num / den : 0;
    novelty[a] = 1 - (best === -Infinity ? 0 : best);
  }
  return { impact, novelty };
}

/** The `promise_ref` object sieve-core's `promiseScore` reads. */
export function promiseRef(corpus, opts = {}) {
  const { impact, novelty } = looTerms(corpus, opts);
  const si = stats(impact);
  const sn = stats(novelty);
  return {
    impact: { mean: round4(si.mean), sd: round4(si.sd) },
    novelty: { mean: round4(sn.mean), sd: round4(sn.sd) },
    rho: Math.round(correlation(impact, novelty) * 1e3) / 1e3,
    k: opts.k ?? 15,
    topQ: opts.topQ ?? 0.75,
  };
}

function main(argv) {
  const at = argv.indexOf('--corpus');
  const dir = at >= 0 ? argv[at + 1] : 'docs/assets/corpus';
  const json = JSON.parse(readFileSync(join(dir, 'corpus.json'), 'utf8'));
  const bin = readFileSync(join(dir, 'corpus.vec.bin'));
  const corpus = loadCorpus(json, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
  const ref = promiseRef(corpus);
  json.promise_ref = ref;
  writeFileSync(join(dir, 'corpus.json'), JSON.stringify(json));
  console.log(JSON.stringify(ref));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
