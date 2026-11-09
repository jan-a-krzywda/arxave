/**
 * corpus-build — S2: the raw window in, the page's frozen corpus out.
 *
 * WHERE THIS SITS. `corpus-fetch.mjs` (S1) writes `corpus-raw.json` — every
 * window paper with its citation percentile. The Sieve page (S3/S4) needs a
 * small, fixed, *embeddable* corpus: a few thousand vectors it can ship as a
 * static asset with no inference at read time. This is the step between: sample
 * a few thousand papers, embed them, cluster them into topics, and write the two
 * files the page loads.
 *
 * THE FILES ARE A CONTRACT, NOT AN OUTPUT. `corpus.json` and `corpus.vec.bin`
 * are read by `docs/assets/sieve-core.mjs`, whose `loadCorpus` reconstructs the
 * geometry the browser ranks in. Change the format here — the centring, the
 * quantisation, the row order — and the page still loads and still ranks, only
 * wrongly. So the layout is pinned by fixtures in `corpus-build.test.mjs`.
 *
 * THE GEOMETRY. Vectors go into the binary UN-centred and int8-quantised; the
 * mean rides in `corpus.json`. The page centres a candidate and a corpus vector
 * the same way (`v − mean`, renormalise) before any cosine — the convention of
 * `preset-feed.mjs`. Clustering happens in that centred space, and a cluster's
 * centroid is the mean of its members' CENTRED vectors, renormalised: the same
 * number the page compares against, not a centroid of the raw cone.
 *
 * WHY RESUME. A full run embeds ~6000 abstracts with SPECTER2 and takes hours;
 * it will be interrupted. Every vector is appended to `<out>/.vec-cache.jsonl`
 * the moment it comes back, and a run that finds a text already there skips the
 * embed — so a crash costs the batch in flight, not the night.
 *
 * Usage:
 *   node scripts/corpus-build.mjs --raw corpus-raw.json --out ../docs/assets/corpus \
 *     --top 3000 --rand 3000 --k 20 --seed 1 [--embed-local] [--label-llm]
 *
 * Flags:
 *   --raw          corpus-raw.json from S1 (required)
 *   --out          directory to write corpus.json + corpus.vec.bin into (required)
 *   --top / --rand papers by highest pct / uniformly random others (default 3000 each)
 *   --k            clusters (default 20)
 *   --seed         PRNG seed for sampling and k-means (default 1)
 *   --embed-local  embed with SPECTER2 on this machine, not the hosted pick
 *   --label-llm    name clusters through the LLM endpoint (default: the word fallback)
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { chooseEmbedder } from './embed-local.mjs';
import { cosine } from './preset-feed.mjs';
import {
  DEFAULT_EMBED, DIM, MODEL, cacheKeyText, coreEmbedText, embedChunk, resolveEndpoint,
} from './warm-dig.mjs';

/* The quantisation step, so a stored int8 is `v/scale` in [−1, 1] × 127. At
   0.25 a unit vector's components (which are small, SPECTER2 lives in a cone)
   almost never clip — the expected clip count is ≈ 0. */
export const SCALE = 0.25;

/* Texts per embed call, the warmer's own batch (warm-dig.mjs, embed-local.mjs). */
const BATCH = 64;

/* k-means++ pass cap. Well-separated clusters converge in a handful; the cap
   only bounds a pathological run. */
const MAX_ITERS = 50;

/* Checkpoint file name inside --out. Gitignored: it is scratch, not an asset. */
const CHECKPOINT = '.vec-cache.jsonl';

/* How many nearest titles a cluster hands the labeler. */
const LABEL_TITLES = 12;

/**
 * mulberry32 — a small seeded PRNG. Every random choice in this file goes
 * through it, so a run is reproducible from `--seed` alone: the same sample, the
 * same k-means++ init, the same clusters. `Math.random` would make `corpus.json`
 * a different file on every rebuild with no way to tell why.
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The sample: exactly `top` papers by highest `pct`, plus `rand` uniformly
 * random others, disjoint from them, seeded.
 *
 * The two halves are the point of the corpus. The high-pct half is the proven
 * work the ranking should reward; the random half is the background that keeps
 * every cosine honest — a corpus of only winners has no "ordinary" to measure
 * against, and Impact (S3) would have nothing but its own winners to compare a
 * candidate to. `pct` ties break by id ascending so a rebuild is byte-stable.
 *
 * `raw` is the whole `corpus-raw.json` (or a bare papers array).
 */
export function sample(raw, { top = 3000, rand = 3000, seed = 1 } = {}) {
  const papers = Array.isArray(raw) ? raw : (raw?.papers ?? []);

  const ranked = [...papers].sort(
    (a, b) => (b.pct - a.pct) || String(a.id).localeCompare(String(b.id)),
  );
  const topN = Math.max(0, Math.min(top, ranked.length));
  const chosen = ranked.slice(0, topN);

  const rest = ranked.slice(topN);
  const rnd = mulberry32(seed);
  /* Partial Fisher–Yates: only the first `rand` positions need fixing. */
  const randN = Math.max(0, Math.min(rand, rest.length));
  for (let i = 0; i < randN; i++) {
    const j = i + Math.floor(rnd() * (rest.length - i));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }

  return [...chosen, ...rest.slice(0, randN)];
}

/**
 * One vector → int8, `q = round(clamp(v/scale, −1, 1) × 127)`.
 *
 * `clipped` counts the components the clamp moved — the ones that cannot be
 * recovered by `q × scale / 127`. The builder prints it; a non-trivial count
 * means `scale` is too small for this model's spread and the corpus geometry
 * has been quietly flattened.
 *
 * ±127, not −128: the range stays symmetric so renormalising after dequantise
 * cannot bias a vector toward one sign.
 */
export function quantise(vec, scale = SCALE) {
  const q = new Int8Array(vec.length);
  let clipped = 0;
  for (let i = 0; i < vec.length; i++) {
    const x = vec[i] / scale;
    if (x > 1) { q[i] = 127; clipped += 1; }
    else if (x < -1) { q[i] = -127; clipped += 1; }
    else q[i] = Math.round(x * 127);
  }
  return { q, clipped };
}

/**
 * k-means over unit vectors, cosine as the metric, seeded and k-means++.
 *
 * The inputs are assumed unit (the caller centres and renormalises first), so
 * `cosine` is the dot product and `1 − cosine` is the distance. Centroids are
 * the mean of their members, renormalised, so they stay unit and remain the
 * thing the page compares a candidate against. An empty cluster is not left
 * empty: it is reseeded to the point currently farthest from its centroid, which
 * keeps `k` clusters alive without a second pass.
 */
export function kmeans(vecs, k, { seed = 1, maxIters = MAX_ITERS } = {}) {
  const n = vecs.length;
  if (n === 0) return { labels: new Int32Array(0), centroids: [] };
  const dim = vecs[0].length;
  const kk = Math.max(1, Math.min(k, n));
  const rnd = mulberry32(seed);

  /* k-means++: first centre uniform, each next proportional to D(x)², the
     squared distance to the nearest centre already chosen. */
  const centroids = [Float32Array.from(vecs[Math.floor(rnd() * n)])];
  const nearest = vecs.map((v) => 1 - cosine(v, centroids[0]));
  while (centroids.length < kk) {
    let total = 0;
    for (const d of nearest) total += d * d;
    let pick = Math.floor(rnd() * n);
    if (total > 0) {
      const target = rnd() * total;
      let acc = 0;
      for (let i = 0; i < n; i++) {
        acc += nearest[i] * nearest[i];
        if (acc >= target) { pick = i; break; }
      }
    }
    centroids.push(Float32Array.from(vecs[pick]));
    for (let i = 0; i < n; i++) {
      const d = 1 - cosine(vecs[i], centroids[centroids.length - 1]);
      if (d < nearest[i]) nearest[i] = d;
    }
  }

  const labels = new Int32Array(n);
  const sums = Array.from({ length: centroids.length }, () => new Float64Array(dim));
  const counts = new Int32Array(centroids.length);

  for (let iter = 0; iter < maxIters; iter++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestSim = -Infinity;
      for (let c = 0; c < centroids.length; c++) {
        const s = cosine(vecs[i], centroids[c]);
        if (s > bestSim) { bestSim = s; best = c; }
      }
      if (labels[i] !== best) { labels[i] = best; changed = true; }
    }

    for (const s of sums) s.fill(0);
    counts.fill(0);
    for (let i = 0; i < n; i++) {
      const c = labels[i];
      counts[c] += 1;
      const v = vecs[i];
      const s = sums[c];
      for (let d = 0; d < dim; d++) s[d] += v[d];
    }

    for (let c = 0; c < centroids.length; c++) {
      if (counts[c] === 0) {
        /* Reseed to the farthest point, and pull that point into this cluster
           so the next assignment pass has something to work with. */
        let worst = 0;
        let worstSim = Infinity;
        for (let i = 0; i < n; i++) {
          const s = cosine(vecs[i], centroids[labels[i]]);
          if (s < worstSim) { worstSim = s; worst = i; }
        }
        centroids[c] = Float32Array.from(vecs[worst]);
        labels[worst] = c;
        changed = true;
      } else {
        const s = sums[c];
        let norm = 0;
        for (let d = 0; d < dim; d++) { s[d] /= counts[c]; norm += s[d] * s[d]; }
        norm = Math.sqrt(norm);
        const out = new Float32Array(dim);
        if (norm > 0 && Number.isFinite(norm)) for (let d = 0; d < dim; d++) out[d] = s[d] / norm;
        centroids[c] = out;
      }
    }

    if (!changed) break;
  }

  return { labels, centroids };
}

/* Words that carry no topic: the function words a title is made of, plus the
   filler a physics title repeats. Deliberately short — a long list starts
   eating the words that name the topic. */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'via', 'using', 'used', 'use',
  'based', 'through', 'between', 'under', 'over', 'toward', 'towards', 'onto',
  'its', 'their', 'our', 'this', 'that', 'these', 'those', 'are', 'was', 'were',
  'not', 'new', 'novel', 'high', 'low', 'study', 'analysis', 'effect', 'effects',
  'role', 'case', 'can', 'more', 'most', 'two', 'one', 'all', 'any', 'how',
  'what', 'when', 'where', 'which', 'who', 'why', 'near', 'far', 'very',
]);

/**
 * The fallback cluster name: `"Topic <id>: <3 most frequent non-stopword title
 * words>"`. Used by default and on any LLM failure — a cluster with no name is
 * a slider labelled nothing, so there is always a name.
 *
 * Words are lowercased and split on non-alphanumerics; ties break alphabetically
 * so a rebuild names a cluster the same way twice.
 */
export function fallbackLabel(id, titles = []) {
  const counts = new Map();
  for (const title of titles) {
    for (const word of String(title).toLowerCase().split(/[^a-z0-9]+/)) {
      if (word.length < 3 || STOPWORDS.has(word)) continue;
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  const top = [...counts]
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([word]) => word);
  return `Topic ${id}: ${top.join(' ')}`.trim();
}

/**
 * A corpus vector out of the raw cone: `v − mean`, then L2-normalise. Zero
 * stays zero — an all-zero vector must score 0 everywhere, not NaN. The page
 * runs the identical function (`centreUnit` in sieve-core.mjs) on the vectors it
 * reads back, which is why this is defined here rather than reached for from
 * `preset-feed.mjs`: that `center` subtracts the ONE global SPECTER2 centroid,
 * while this corpus carries its own `mean`. Same idea, different constant.
 */
function centreUnit(vec, mean) {
  const out = new Float32Array(vec.length);
  let sum = 0;
  for (let i = 0; i < vec.length; i++) {
    const x = vec[i] - mean[i];
    out[i] = x;
    sum += x * x;
  }
  const norm = Math.sqrt(sum);
  if (norm > 0 && Number.isFinite(norm)) for (let i = 0; i < vec.length; i++) out[i] /= norm;
  return out;
}

/**
 * The checkpoint: one JSON object per line, `{"t": <cache key text>, "v": [...]}`.
 * Keyed on the exact embedded text, not the arXiv id, so a resume recognises the
 * same string the embedder saw. A missing file is an empty checkpoint; a torn
 * last line (a crash mid-append) is skipped rather than failing the whole run.
 */
async function readCheckpoint(cachePath, readFile) {
  const map = new Map();
  if (!cachePath) return map;
  let raw;
  try {
    raw = await readFile(cachePath);
  } catch (err) {
    if (err?.code === 'ENOENT') return map;
    throw err;
  }
  for (const line of String(raw).split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;   // a partial line from an interrupted write
    }
    if (obj && typeof obj.t === 'string' && Array.isArray(obj.v)) map.set(obj.t, obj.v);
  }
  return map;
}

/**
 * `raw` → `{ json, bin, clipped }`.
 *
 * Everything with a knob is a parameter, so a test pins the whole pipeline with
 * a fake embed and a temp checkpoint, and the CLI supplies the real ones.
 * `embed` answers `(texts) => Float32Array[]` — `chooseEmbedder`'s shape — and
 * is the only network in the run. `labeler`, if given, is
 * `({ id, titles }) => string|null`; a falsy or thrown answer falls back to
 * `fallbackLabel`.
 */
export async function build({
  raw, embed, top = 3000, rand = 3000, k = 20, seed = 1, labeler = null,
  dim = DIM, model = MODEL, scale = SCALE, cachePath = null, now = new Date(),
  readFile = (p) => fs.readFile(p, 'utf8'),
  appendFile = (p, data) => fs.appendFile(p, data),
  mkdir = (p, o) => fs.mkdir(p, o),
} = {}) {
  if (typeof embed !== 'function') throw new Error('build: an `embed` function is required');

  const picked = sample(raw, { top, rand, seed });
  const n = picked.length;
  const texts = picked.map((p) => cacheKeyText(coreEmbedText(p.title, p.abstract)));

  if (cachePath) await mkdir(path.dirname(cachePath), { recursive: true });
  const done = await readCheckpoint(cachePath, readFile);

  const vecs = new Array(n);
  const todo = [];
  for (let i = 0; i < n; i++) {
    const hit = done.get(texts[i]);
    if (hit && hit.length === dim) vecs[i] = Float32Array.from(hit);
    else todo.push(i);
  }

  for (let i = 0; i < todo.length; i += BATCH) {
    const at = todo.slice(i, i + BATCH);
    const out = await embed(at.map((j) => texts[j]));
    if (!out || out.length !== at.length) {
      throw new Error(`embed returned ${out?.length} vectors for ${at.length} texts`);
    }
    for (let b = 0; b < at.length; b++) {
      const v = Float32Array.from(out[b]);
      if (v.length !== dim) throw new Error(`embed returned ${v.length} dims, expected ${dim}`);
      vecs[at[b]] = v;
      if (cachePath) await appendFile(cachePath, JSON.stringify({ t: texts[at[b]], v: [...v] }) + '\n');
    }
  }

  /* Mean of the UN-centred vectors — the page subtracts exactly this back out. */
  const mean = new Float64Array(dim);
  for (const v of vecs) for (let d = 0; d < dim; d++) mean[d] += v[d];
  for (let d = 0; d < dim; d++) mean[d] /= n || 1;

  const centred = vecs.map((v) => centreUnit(v, mean));
  const { labels, centroids } = kmeans(centred, k, { seed });

  const titles = picked.map((p) => p.title);
  const groups = centroids.map((centroid, id) => {
    const members = [];
    for (let i = 0; i < n; i++) if (labels[i] === id) members.push(i);
    const nearest = [...members]
      .sort((a, b) => cosine(centred[b], centroid) - cosine(centred[a], centroid))
      .slice(0, LABEL_TITLES)
      .map((i) => titles[i]);
    return { id, members, nearest, centroid };
  });

  const clusters = [];
  for (const c of groups) {
    let label = null;
    if (labeler) {
      try {
        label = await labeler({ id: c.id, titles: c.nearest, centroid: c.centroid });
      } catch {
        label = null;   // any LLM failure is the fallback's job, never a crash
      }
    }
    if (typeof label !== 'string' || !label.trim()) {
      label = fallbackLabel(c.id, c.members.map((i) => titles[i]));
    }
    clusters.push({
      id: c.id,
      label: label.trim(),
      size: c.members.length,
      centroid: [...c.centroid].map((x) => Number(x.toFixed(4))),
    });
  }

  /* The binary: un-centred, row-major, quantised. `mean` above is the constant
     the page pairs with it. */
  const q = new Int8Array(n * dim);
  let clipped = 0;
  for (let i = 0; i < n; i++) {
    const { q: row, clipped: c } = quantise(vecs[i], scale);
    q.set(row, i * dim);
    clipped += c;
  }

  const json = {
    built_on: now.toISOString().slice(0, 10),
    model,
    dim,
    n,
    window: raw?.window ?? null,
    scale,
    mean: [...mean].map((x) => Number(x.toFixed(5))),
    ids: picked.map((p) => p.id),
    titles,
    cites: picked.map((p) => p.cites ?? 0),
    pct: picked.map((p) => p.pct),
    cluster: Array.from(labels),
    clusters,
  };

  return { json, bin: Buffer.from(q.buffer, q.byteOffset, q.byteLength), clipped };
}

/**
 * A cluster labeler backed by the grader endpoint, shaped exactly like the call
 * `llm.mjs` makes (`{base_url}/chat/completions`, bearer key, JSON reply).
 *
 * `llm.mjs` has no generic "ask the model for a string" helper — `gradePaper`
 * grades one paper against a rubric and returns a fixed shape — so this is the
 * smallest call that fits the flag, mirroring that file's request. It returns
 * `null` with no key, and every failure falls back to `fallbackLabel`.
 */
function llmLabeler({ env = process.env, fetchImpl = fetch } = {}) {
  const key = env.LLM_API_KEY;
  if (!key) return null;
  const base = String(env.LLM_BASE_URL || 'https://api.sailresearch.com/v1').replace(/\/+$/, '');
  const model = env.LLM_MODEL || 'deepseek-ai/DeepSeek-V4.1-Flash-1017';
  return async ({ titles }) => {
    const resp = await fetchImpl(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'Name the topic of a cluster of papers in 3 to 6 words. ' +
            'Return ONLY JSON: {"label":"..."}.' },
          { role: 'user', content: titles.join('\n') },
        ],
      }),
    });
    if (!resp.ok) return null;
    const data = await resp.json().catch(() => null);
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') return null;
    const body = content.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? content;
    const parsed = JSON.parse(body.trim());
    return typeof parsed?.label === 'string' ? parsed.label : null;
  };
}

function arg(name, fallback = null) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const EMBED_LOCAL = process.argv.includes('--embed-local');
const LABEL_LLM = process.argv.includes('--label-llm');

async function main() {
  const rawPath = arg('raw');
  const outDir = arg('out');
  if (!rawPath || !outDir) {
    console.error('corpus-build: --raw <corpus-raw.json> and --out <docs/assets/corpus> are required');
    process.exit(2);
  }

  let embedUrl;
  try {
    embedUrl = resolveEndpoint(arg('embed'), process.env.EMBED_URL, DEFAULT_EMBED);
  } catch (err) {
    console.error('corpus-build: ' + err.message);
    process.exit(2);
  }
  const embed = chooseEmbedder({ embedLocal: EMBED_LOCAL }, { embedChunk, embedUrl });
  const labeler = LABEL_LLM ? llmLabeler() : null;
  if (LABEL_LLM && !labeler) {
    console.warn('corpus-build: --label-llm but $LLM_API_KEY is unset — using the word fallback');
  }

  const raw = JSON.parse(await fs.readFile(rawPath, 'utf8'));
  const cachePath = path.join(outDir, CHECKPOINT);

  console.log(`corpus-build: embedding with ${EMBED_LOCAL ? 'SPECTER2 on this runner' : 'the hosted pick'}`);
  const { json, bin, clipped } = await build({
    raw,
    embed,
    top: Number(arg('top', '3000')),
    rand: Number(arg('rand', '3000')),
    k: Number(arg('k', '20')),
    seed: Number(arg('seed', '1')),
    labeler,
    cachePath,
  });

  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'corpus.json'), JSON.stringify(json) + '\n');
  await fs.writeFile(path.join(outDir, 'corpus.vec.bin'), bin);
  console.log(
    `corpus-build: ${json.n} papers × ${json.dim} → ${outDir} ` +
    `(${clipped} components clipped, ${json.clusters.length} clusters)`);
}

// Importable for tests; only the CLI invocation writes the files.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('corpus-build: ' + (err?.stack ?? err));
    process.exit(1);
  });
}
