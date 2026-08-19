/**
 * measure-centroid — the constant that makes SPECTER2's cosines mean something.
 *
 * WHY THIS SCRIPT EXISTS. SPECTER2's vectors are not spread over the sphere;
 * they sit in a narrow cone. Measured over the deployed pick, the mean of a
 * day's stone vectors has norm ~0.93, which is to say roughly nine tenths of
 * every vector is the same direction as every other vector, carrying no
 * information about the paper. Cosine reads that shared direction along with
 * the signal, so every pair of arXiv abstracts scores 0.82-0.92 and the
 * ordering inside that band is the whole of what the model actually said.
 *
 * The consequence is not subtle. It is why the train showed one wagon holding
 * everything at every threshold, why grades came back inside a 0.07 window, and
 * why a ship gate cutting on z over that window was cutting on noise. #73
 * measured a threshold table inside the compressed band and picked the least
 * bad point in a range that had no good one.
 *
 * Subtracting a fixed centroid and renormalizing removes the shared direction
 * and leaves the residual — which is where the model kept the paper. Measured
 * over one day's 90 stones:
 *
 *     pairwise cosine     p5      p50     p95    spread
 *     raw                0.818   0.875   0.921   0.103
 *     centered          -0.245  -0.026   0.283   0.526
 *
 * THE CENTROID MUST BE A CONSTANT, NOT THIS HAUL'S MEAN. Centering on the
 * night's own stones would make a paper's grade depend on what else was
 * announced that night, and two hauls of the same paper would disagree. Worse,
 * the cached vector is keyed by text alone, so a haul-local transform would put
 * two different geometries behind one cache key. A fixed vector, measured once
 * over a broad corpus and shipped as a literal, keeps a stone's coordinates a
 * property of the stone.
 *
 * Usage:
 *
 *     node scripts/measure-centroid.mjs \
 *       --categories "quant-ph, cond-mat.mes-hall, cs.AI, cs.LG" \
 *       --lookback 5
 *
 * It reads vectors from the shared cache only — it never embeds — so it costs
 * nothing and reports honestly how much of the corpus it actually saw. Run it
 * after a warm, when the day is in the cache.
 *
 * The output is a base64 float32 literal for `CORPUS_CENTROID`, which lives in
 * `docs/assets/filter.js` and `scripts/preset-feed.mjs`. Both must carry the
 * same bytes, and the parity test pins them together.
 *
 * RE-MEASURE WHEN THE PICK CHANGES. This vector is a property of
 * `allenai/specter2_base` and nothing else. A different model has a different
 * cone pointing somewhere else, and this constant would then be subtracting a
 * direction that means nothing — quietly, with no error, exactly the failure
 * the threshold constants had.
 */

import { writeFileSync } from 'node:fs';
import {
  DEFAULT_EMBED,
  fetchAbstracts,
  fetchEarlier,
  sha256Hex,
} from './warm-dig.mjs';

const CACHE = 'https://ugxxakguqgpxpdfhgtsb.supabase.co/functions/v1/dig-cache';
const MODEL = 'allenai/specter2_base';
const DIM = 768;
const READ_CHUNK = 500;

function arg(name, fallback = null) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function normalize(v) {
  let sum = 0;
  for (const x of v) sum += x * x;
  const n = Math.sqrt(sum);
  if (!n || !isFinite(n)) return v.slice();
  return v.map((x) => x / n);
}

function decode(b64) {
  const buf = Buffer.from(b64, 'base64');
  return Array.from(new Float32Array(buf.buffer, buf.byteOffset, DIM));
}

/** Every abstract the warmer would have covered: tonight plus the lookback. */
async function corpusTexts(categories, lookback) {
  const texts = [];
  const seen = new Set();
  for (const cat of categories) {
    try {
      const { stones } = await fetchAbstracts(cat);
      for (const s of stones) {
        if (seen.has(s.arxivId)) continue;
        seen.add(s.arxivId);
        texts.push(s.abstract);
      }
    } catch (err) {
      console.warn(`centroid: ${cat} feed — ${err.message}`);
    }
  }
  if (lookback > 1) {
    try {
      for (const s of await fetchEarlier(categories, lookback, 400)) {
        if (seen.has(s.arxivId)) continue;
        seen.add(s.arxivId);
        texts.push(s.abstract);
      }
    } catch (err) {
      console.warn(`centroid: lookback — ${err.message}`);
    }
  }
  return texts;
}

async function cachedVectors(texts) {
  const shas = await Promise.all(texts.map(sha256Hex));
  const unique = [...new Set(shas)];
  const hits = {};
  for (let i = 0; i < unique.length; i += READ_CHUNK) {
    const resp = await fetch(CACHE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, dim: DIM, sha: unique.slice(i, i + READ_CHUNK) }),
    });
    if (!resp.ok) throw new Error(`dig-cache HTTP ${resp.status}`);
    const data = await resp.json();
    for (const [sha, b64] of Object.entries(data.hits || {})) hits[sha] = decode(b64);
  }
  return { vectors: unique.map((s) => hits[s]).filter(Boolean), asked: unique.length };
}

function quantile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

/** What the centering actually bought, on the corpus it was measured over. */
function report(vectors, centroid) {
  const unit = vectors.map(normalize);
  const cen = unit.map((v) => normalize(v.map((x, i) => x - centroid[i])));
  const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

  // A sample of pairs — the full triangle is quadratic and this is a summary.
  const pick = () => Math.floor(Math.random() * unit.length);
  const raw = [], ctr = [];
  for (let k = 0; k < 60_000; k++) {
    const i = pick(), j = pick();
    if (i === j) continue;
    raw.push(dot(unit[i], unit[j]));
    ctr.push(dot(cen[i], cen[j]));
  }
  raw.sort((a, b) => a - b); ctr.sort((a, b) => a - b);
  const line = (l, s) => console.log(
    '  ' + l.padEnd(10) +
    ['p5', 'p50', 'p95'].map((n, i) => n + ' ' + quantile(s, [0.05, 0.5, 0.95][i]).toFixed(3)).join('  ') +
    '   spread ' + (quantile(s, 0.95) - quantile(s, 0.05)).toFixed(3));
  console.log('\npairwise cosine over the measured corpus:');
  line('raw', raw);
  line('centered', ctr);
}

const categories = (arg('categories') || 'quant-ph, cond-mat.mes-hall, cs.AI, cs.LG')
  .split(',').map((c) => c.trim()).filter(Boolean);
const lookback = Number(arg('lookback', '5'));

const texts = await corpusTexts(categories, lookback);
console.log(`centroid: ${texts.length} abstracts across ${categories.join(', ')}`);

const { vectors, asked } = await cachedVectors(texts);
console.log(`centroid: ${vectors.length} of ${asked} already cut (the rest are not warmed)`);
if (vectors.length < 200) {
  console.error(
    'centroid: too few vectors to measure a corpus direction. Run a warm first, ' +
    'or widen --categories / --lookback.',
  );
  process.exit(1);
}

/* The mean of the *unit* vectors, not of the raw ones: cosine only ever sees
   directions, so the direction to remove is the mean direction. Weighting by
   length would let a long vector speak twice. */
const unit = vectors.map(normalize);
const centroid = new Array(DIM).fill(0);
for (const v of unit) for (let i = 0; i < DIM; i++) centroid[i] += v[i] / unit.length;

let norm = 0;
for (const x of centroid) norm += x * x;
norm = Math.sqrt(norm);
console.log(`centroid: ||mu|| = ${norm.toFixed(4)}  (1.0 would mean every vector points the same way)`);

report(vectors, centroid);

/* Shipped as base64 float32 rather than 768 decimal literals: it is the same
   encoding the cache already uses for a vector, it survives a diff without
   wrapping across 40 lines, and it cannot pick up a rounding difference
   between the two files that must carry it. */
const buf = Buffer.alloc(DIM * 4);
for (let i = 0; i < DIM; i++) buf.writeFloatLE(centroid[i], i * 4);
const b64 = buf.toString('base64');

const out = arg('out');
if (out) {
  writeFileSync(out, b64);
  console.log(`\ncentroid: written to ${out}`);
}
console.log(`\nCORPUS_CENTROID (${unit.length} vectors, ${new Date().toISOString().slice(0, 10)}):\n`);
console.log(b64);
