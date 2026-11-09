/**
 * `node --test scripts/corpus-build.test.mjs`.
 *
 * The pure half pins the three things a rebuild must reproduce — the sample, the
 * k-means clustering, and the int8 quantisation — against hand-computed
 * fixtures. The `build()` half runs the whole pipeline with a fake embed and a
 * temp checkpoint, so the corpus.json/corpus.vec.bin layout the page reads is
 * checked without a model, a socket, or a minute of SPECTER2.
 *
 * No network: `embed` is always the deterministic `fakeVec` below.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  build, fallbackLabel, kmeans, quantise, sample, SCALE,
} from './corpus-build.mjs';
import { cacheKeyText, coreEmbedText, MODEL } from './warm-dig.mjs';

/** L2-normalise a plain array into a Float32Array. */
const unit = (v) => {
  const n = Math.hypot(...v) || 1;
  return Float32Array.from(v, (x) => x / n);
};

/**
 * A deterministic unit vector from the text alone — the stand-in for SPECTER2.
 * Unit, because the real embedder returns unit vectors and `build` clusters them
 * after centring.
 */
function fakeVec(text, dim = 8) {
  const v = new Float32Array(dim);
  let h = 2166136261;
  for (let i = 0; i < dim; i++) {
    for (const ch of `${text}:${i}`) {
      h ^= ch.charCodeAt(0);
      h = Math.imul(h, 16777619);
    }
    v[i] = ((h >>> 0) / 4294967296) * 2 - 1;
  }
  return unit(v);
}

/** The vector `build` will see for one paper — the same text convention it uses. */
const vecOf = (paper, dim = 8) => fakeVec(cacheKeyText(coreEmbedText(paper.title, paper.abstract)), dim);

/** `n` papers with distinct pct so the top-by-pct half is unambiguous. */
function makePapers(n = 12) {
  return Array.from({ length: n }, (_, i) => ({
    id: `25${String(10 + i).padStart(2, '0')}.0000${i}`,
    title: `Paper ${i} on manifold ${i % 3}`,
    abstract: `Abstract number ${i} about a condensed matter system`,
    cat: i % 2 ? 'cond-mat.mes-hall' : 'quant-ph',
    cites: i * 3,
    pct: i / (n - 1),
  }));
}

const WINDOW = { from: '2025-09-01', to: '2025-12-31' };
const PAPERS = makePapers(12);
const RAW = { window: WINDOW, categories: ['quant-ph', 'cond-mat.mes-hall'], papers: PAPERS };

/* ── sample ─────────────────────────────────────────────────────────────── */

test('sample takes exactly the top by pct plus seeded random others, disjoint', () => {
  const picks = sample({ papers: PAPERS }, { top: 4, rand: 3, seed: 1 });
  assert.equal(picks.length, 7);

  const ids = picks.map((p) => p.id);
  assert.equal(new Set(ids).size, 7, 'the two halves are disjoint');

  const topIds = [...PAPERS].sort((a, b) => b.pct - a.pct).slice(0, 4).map((p) => p.id);
  for (const id of topIds) assert.ok(ids.includes(id), `top paper ${id} is sampled`);

  const rest = new Set(PAPERS.filter((p) => !topIds.includes(p.id)).map((p) => p.id));
  for (const id of ids.filter((id) => !topIds.includes(id))) assert.ok(rest.has(id), `${id} is a random other`);

  assert.deepEqual(
    sample({ papers: PAPERS }, { top: 4, rand: 3, seed: 1 }).map((p) => p.id), ids,
    'the same seed gives the same sample');
});

test('sample caps at the pool when asked for more papers than exist', () => {
  const small = makePapers(4);
  assert.equal(sample({ papers: small }, { top: 10, rand: 10, seed: 1 }).length, 4);
});

/* ── quantise ───────────────────────────────────────────────────────────── */

test('quantise round-trips within scale/127 when nothing clips', () => {
  const within = [0.2, -0.1, 0.05, -0.25, 0.0, 0.18];
  const { q, clipped } = quantise(within, SCALE);
  assert.equal(clipped, 0);
  assert.ok(q instanceof Int8Array);

  for (let i = 0; i < within.length; i++) {
    const back = (q[i] * SCALE) / 127;
    assert.ok(Math.abs(back - within[i]) <= SCALE / 127,
      `component ${i}: ${back} vs ${within[i]}`);
  }
});

test('quantise counts exactly the components past ±scale', () => {
  // 0.25 is exactly +scale (kept), −0.25 exactly −scale (kept); 0.5 and −0.9 clamp.
  const over = [0.5, -0.9, 0.25, -0.25, 0.1];
  const { q, clipped } = quantise(over, SCALE);
  assert.equal(clipped, 2);
  assert.equal(q[0], 127);
  assert.equal(q[1], -127);
  assert.equal(q[2], 127);
  assert.equal(q[3], -127);
  assert.equal(q[4], Math.round(0.4 * 127));
});

/* ── kmeans ─────────────────────────────────────────────────────────────── */

test('kmeans recovers well-separated unit blobs, deterministically for a seed', () => {
  const blobs = [
    [[1, 0.05, 0, 0], [1, -0.05, 0, 0.05], [1, 0, 0.05, 0]],
    [[0, 1, 0.05, 0], [0.05, 1, 0, 0], [0, 1, -0.05, 0]],
    [[0, 0, 1, 0.05], [0, 0, 1, -0.05], [0.05, 0, 1, 0]],
  ];
  const vecs = blobs.flat().map(unit);

  for (const seed of [1, 7, 42]) {
    const { labels, centroids } = kmeans(vecs, 3, { seed });
    const L = Array.from(labels);
    assert.ok(L[0] === L[1] && L[1] === L[2], `blob 0 split (seed ${seed})`);
    assert.ok(L[3] === L[4] && L[4] === L[5], `blob 1 split (seed ${seed})`);
    assert.ok(L[6] === L[7] && L[7] === L[8], `blob 2 split (seed ${seed})`);
    assert.equal(new Set(L).size, 3, `three groups (seed ${seed})`);
    for (const c of centroids) assert.ok(Math.abs(Math.hypot(...c) - 1) < 1e-3, 'centroid is unit');
  }

  const a = kmeans(vecs, 3, { seed: 7 });
  const b = kmeans(vecs, 3, { seed: 7 });
  assert.deepEqual(Array.from(a.labels), Array.from(b.labels));
  assert.deepEqual(a.centroids.map((c) => Array.from(c)), b.centroids.map((c) => Array.from(c)));
});

/* ── fallbackLabel ──────────────────────────────────────────────────────── */

test('fallbackLabel is the three most frequent non-stopword title words', () => {
  // "superconducting" and "qubit" tie at 3, so the alphabetical tie-break puts
  // "qubit" first; then the four singletons resolve to "coherence".
  const titles = [
    'Superconducting qubit readout',
    'Superconducting qubit coherence times',
    'Superconducting qubit gates',
  ];
  assert.equal(fallbackLabel(7, titles), 'Topic 7: qubit superconducting coherence');
});

test('fallbackLabel still names a cluster whose titles carry no topic word', () => {
  assert.equal(fallbackLabel(2, ['The and of a']), 'Topic 2:');
});

/* ── build ──────────────────────────────────────────────────────────────── */

const fakeEmbed = () => (texts) => texts.map((t) => fakeVec(t, 8));

test('build lays out corpus.json and the binary the page reads', async () => {
  const { json, bin, clipped } = await build({
    raw: RAW, embed: fakeEmbed(), top: 6, rand: 4, k: 3, seed: 1, dim: 8,
    now: new Date('2026-11-10T00:00:00Z'),
  });

  assert.equal(json.n, 10);
  assert.equal(json.dim, 8);
  assert.equal(json.model, MODEL);
  assert.equal(json.built_on, '2026-11-10');
  assert.deepEqual(json.window, WINDOW);
  assert.equal(json.scale, SCALE);
  assert.equal(bin.length, 10 * 8, 'n × dim int8, row-major');
  assert.equal(json.mean.length, 8);
  assert.ok(Number.isInteger(clipped) && clipped >= 0, 'clipped is a component count');

  for (const key of ['ids', 'titles', 'cites', 'pct', 'cluster']) {
    assert.equal(json[key].length, 10, `${key} has one entry per paper`);
  }
  assert.ok(json.cluster.every((c) => Number.isInteger(c) && c >= 0 && c < 3));

  // The sample's order is preserved, so each title belongs to its id.
  const byId = new Map(PAPERS.map((p) => [p.id, p]));
  for (let i = 0; i < 10; i++) assert.equal(json.titles[i], byId.get(json.ids[i]).title);

  // mean is the mean of the un-centred vectors of exactly those papers.
  const expected = new Float64Array(8);
  for (const id of json.ids) {
    const v = vecOf(byId.get(id), 8);
    for (let d = 0; d < 8; d++) expected[d] += v[d] / 10;
  }
  for (let d = 0; d < 8; d++) {
    assert.ok(Math.abs(json.mean[d] - expected[d]) < 1e-4, `mean[${d}]: ${json.mean[d]} vs ${expected[d]}`);
  }

  // Every paper is in exactly one cluster, and the centroids are unit.
  assert.equal(json.clusters.length, 3);
  assert.equal(json.clusters.reduce((s, c) => s + c.size, 0), 10);
  for (const c of json.clusters) {
    assert.ok(Math.abs(Math.hypot(...c.centroid) - 1) < 2e-3, `centroid ${c.id} is unit`);
    assert.match(c.label, /^Topic \d+:/, 'the default label is the word fallback');
  }
});

test('build labels clusters with the labeler and falls back on failure', async () => {
  const seen = [];
  const named = await build({
    raw: RAW, embed: fakeEmbed(), top: 6, rand: 4, k: 3, seed: 1, dim: 8,
    labeler: async ({ id, titles }) => { seen.push(titles.length); return `Cluster ${id} name`; },
  });
  assert.deepEqual(named.json.clusters.map((c) => c.label),
    ['Cluster 0 name', 'Cluster 1 name', 'Cluster 2 name']);
  for (const len of seen) assert.ok(len <= 12, 'the labeler sees at most 12 titles');

  const fell = await build({
    raw: RAW, embed: fakeEmbed(), top: 6, rand: 4, k: 3, seed: 1, dim: 8,
    labeler: () => { throw new Error('the model is down'); },
  });
  for (const c of fell.json.clusters) assert.match(c.label, /^Topic \d+:/);
});

test('a resume reads the checkpoint and embeds nothing', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'arxave-corpus-'));
  const cachePath = path.join(dir, '.vec-cache.jsonl');

  let calls = 0;
  const embed = async (texts) => { calls += texts.length; return texts.map((t) => fakeVec(t, 8)); };

  const first = await build({ raw: RAW, embed, top: 6, rand: 4, k: 3, seed: 1, dim: 8, cachePath });
  assert.equal(calls, 10, 'the first run embeds every paper');
  assert.ok(fs.existsSync(cachePath));

  calls = 0;
  const second = await build({ raw: RAW, embed, top: 6, rand: 4, k: 3, seed: 1, dim: 8, cachePath });
  assert.equal(calls, 0, 'the resume embeds nothing');
  assert.deepEqual(second.json.ids, first.json.ids);
  assert.deepEqual(second.json.mean, first.json.mean);
  assert.equal(second.bin.length, first.bin.length);

  await fsp.rm(dir, { recursive: true, force: true });
});

test('a torn checkpoint line is skipped, not fatal', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'arxave-corpus-'));
  const cachePath = path.join(dir, '.vec-cache.jsonl');
  const { json } = await build({ raw: RAW, embed: fakeEmbed(), top: 6, rand: 4, k: 3, seed: 1, dim: 8 });
  const good = JSON.stringify({ t: 'kept', v: Array.from(fakeVec('kept', 8)) });
  await fsp.writeFile(cachePath, `${good}\n{"t":"torn","v":[0.1,0.2`);

  // The truncated last line is ignored; the run still completes.
  const again = await build({ raw: RAW, embed: fakeEmbed(), top: 6, rand: 4, k: 3, seed: 1, dim: 8, cachePath });
  assert.equal(again.json.n, json.n);

  await fsp.rm(dir, { recursive: true, force: true });
});
