/**
 * sieve-core — the arithmetic behind the Sieve page: how well tonight's paper
 * fits the topics someone picked, how much it looks like the papers that
 * mattered, and what is left after the gate. Pure ESM: no DOM, no network, no
 * dependencies, so the same file runs in the browser and under `node --test`.
 *
 * WHY THIS IS A FILE OF ITS OWN. The page moves sliders and re-scores live; the
 * corpus is 6000 x 768 floats. Both of those are reasons to keep the maths out
 * of the page — testable against hand-computed fixtures, and free of any
 * document, fetch or clock. Nothing here reads a global.
 *
 * WHY prepare() AND rank() ARE SEPARATE. Two of the four sliders — Strictness
 * (gate) and Surprise — cannot change the fit statistics, because the fit
 * statistics are measured over the corpus once per (weights, touchstones) pair
 * and touch neither. They are also the expensive half: a weighted median over
 * every corpus paper. So prepare() computes them and hands back a plain object,
 * rank() re-reads that object for whatever gate and surprise are on the
 * sliders, and score() is the two of them in one call for callers that do not
 * care.
 *
 * WHY PERCENTILE RANKS AND NOT THE RAW NUMBERS. Impact is a pct-weighted mean
 * of cosines; novelty is `1 - max cos`. The two live on unrelated scales, and
 * blending them directly would let whichever has the wider spread decide the
 * order. The spec converts each to its percentile rank among the *gated*
 * candidates first, so both halves are in [0,1] and the Surprise slider means
 * what the UI promises it means. One consequence worth knowing: a score
 * depends on the other candidates in the same run (there are `m` of them),
 * which is exactly why `P` is computed after the gate and never in prepare().
 *
 * CENTRING. Everything here — corpus rows, touchstones, candidates — arrives
 * already centred and L2-normalised, so every cosine in this file is a plain
 * dot product. `loadCorpus` and `centreUnit` are the only places that centring
 * happens, and they must be the only places: a raw vector compared against a
 * centred one is a cosine between two spaces that looks like a number.
 */

/* ── vector helpers ─────────────────────────────────────────────────────── */

/**
 * The dot of `dim` elements of `vecs` from `off` against `vec`. The hot loop of
 * the whole file — every candidate against every corpus paper, ~1.2 M calls of
 * 768 multiply-adds for one night — so it takes an offset rather than a row
 * (`vecs.subarray()` would allocate a view per pair) and sums in four
 * independent accumulators.
 *
 * The accumulators are not a stylistic choice. A single `s += a * b` chain is
 * serial: each add waits on the previous one, so over 768 dims the whole loop
 * is latency and not throughput. That version measured 3.9 s wall for the
 * card's 6000 x 768 x 200, against a 1.5 s budget; four chains let the pipeline
 * fill. With the pairing in rank() and the gate in front of it (see there) the
 * same 200 candidates measure under a second on a machine that is busy.
 * Re-measure with the budget test whenever this loop is touched.
 */
function dotAt(vecs, off, vec, dim) {
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  let s3 = 0;
  let k = 0;
  for (; k + 4 <= dim; k += 4) {
    s0 += vecs[off + k] * vec[k];
    s1 += vecs[off + k + 1] * vec[k + 1];
    s2 += vecs[off + k + 2] * vec[k + 2];
    s3 += vecs[off + k + 3] * vec[k + 3];
  }
  for (; k < dim; k++) s0 += vecs[off + k] * vec[k];
  return (s0 + s1) + (s2 + s3);
}

/**
 * Sorted insertion of one cos into a descending top-K buffer of `(cos, index)`
 * pairs; returns the new count. The guard is a strict `>`, so on a tie the
 * earlier corpus index stays in front — the same corpus always reports the same
 * landmarks.
 *
 * A sorted buffer rather than a heap: K is 15, the common case is one
 * comparison, and a heap is more code for a smaller constant.
 */
function insertTop(tcos, tidx, count, K, c, i) {
  if (count === K && !(c > tcos[K - 1])) return count;
  let j = count < K ? count : K - 1;
  while (j > 0 && tcos[j - 1] < c) {
    tcos[j] = tcos[j - 1];
    tidx[j] = tidx[j - 1];
    j--;
  }
  tcos[j] = c;
  tidx[j] = i;
  return count < K ? count + 1 : count;
}

/**
 * Out of SPECTER2's cone and back onto the unit sphere: `vec - mean`, then
 * L2-normalised. The browser's centring convention (see `center()` in
 * filter.js and the `mean` S2 writes into corpus.json).
 *
 * A vector that lands exactly on the mean is left at zero rather than divided
 * into NaN: a zero row scores 0 against everything, which is a wrong answer,
 * while a NaN row poisons every cosine it ever touches, which is a wrong
 * answer that hides. A non-finite norm is left alone for the same reason
 * (`clsPool` in embed-local.mjs makes the same call).
 */
export function centreUnit(vec, mean) {
  const dim = mean.length;
  if (!vec || vec.length !== dim) {
    throw new Error(`sieve-core: centreUnit got ${vec ? vec.length : 'no'} dims against a mean of ${dim}`);
  }
  const out = new Float32Array(dim);
  let sum = 0;
  for (let k = 0; k < dim; k++) {
    const v = vec[k] - mean[k];
    out[k] = v;
    sum += v * v;
  }
  const norm = Math.sqrt(sum);
  if (norm > 0 && Number.isFinite(norm)) for (let k = 0; k < dim; k++) out[k] /= norm;
  return out;
}

/* ── the corpus ─────────────────────────────────────────────────────────── */

/**
 * corpus.json + corpus.vec.bin → the working corpus.
 *
 * The file is int8 and uncentred; a row is `v = q * scale / 127` (S2's
 * quantisation, verbatim) and is centred and normalised here, once, instead of
 * on every cosine. `titles` and `ids` are carried along because the landmarks
 * and the result cards need them, and `pct` because it is what makes impact a
 * citation-weighted number rather than a bag of neighbours.
 *
 * SIZES ARE CHECKED, NOT ASSUMED. A bin one row short of the json, or a pct
 * array that has drifted out of step with the ids, throws nowhere downstream —
 * it silently ranks the wrong paper or reads past the end of the buffer. This
 * is the one place where the file meets the code, so it is the one place that
 * can say what is wrong.
 *
 * `binArrayBuffer` is an ArrayBuffer, as the browser hands it over; a Node
 * Buffer (what `fs.readFile` returns) or any other typed-array view works too,
 * because the same bytes arrive both ways.
 */
export function loadCorpus(json, binArrayBuffer) {
  const { n, dim, scale } = json ?? {};
  if (!Number.isInteger(n) || n <= 0) throw new Error(`sieve-core: corpus n is ${n}`);
  if (!Number.isInteger(dim) || dim <= 0) throw new Error(`sieve-core: corpus dim is ${dim}`);
  if (!(scale > 0)) throw new Error(`sieve-core: corpus scale is ${scale}`);
  for (const key of ['ids', 'titles', 'pct', 'cluster']) {
    if (!Array.isArray(json[key]) || json[key].length !== n) {
      throw new Error(`sieve-core: corpus ${key} does not hold ${n} entries`);
    }
  }
  const mean = Float32Array.from(json.mean ?? []);
  if (mean.length !== dim) throw new Error(`sieve-core: mean has ${mean.length} dims, expected ${dim}`);
  if (!Array.isArray(json.clusters)) throw new Error('sieve-core: corpus has no clusters');

  const bytes = binArrayBuffer instanceof Uint8Array
    ? new Int8Array(binArrayBuffer.buffer, binArrayBuffer.byteOffset, binArrayBuffer.byteLength)
    : new Int8Array(binArrayBuffer);
  if (bytes.length !== n * dim) {
    throw new Error(`sieve-core: corpus.vec.bin holds ${bytes.length} bytes, expected ${n * dim}`);
  }

  const vecs = new Float32Array(n * dim);
  const row = new Float32Array(dim);
  for (let i = 0, off = 0; i < n; i++, off += dim) {
    for (let k = 0; k < dim; k++) row[k] = bytes[off + k] * scale / 127;
    vecs.set(centreUnit(row, mean), off);
  }

  return {
    n, dim, mean, vecs,
    ids: json.ids,
    titles: json.titles,
    pct: Float32Array.from(json.pct),
    cluster: Int32Array.from(json.cluster),
    clusters: json.clusters.map((c) => ({
      id: c.id, label: c.label, size: c.size, centroid: Float32Array.from(c.centroid),
    })),
  };
}

/* ── the two estimators the fit statistics are built from ───────────────── */

/**
 * The weighted median: sort ascending, walk the weights, and take the first
 * value whose cumulative weight reaches half the total.
 *
 * `>=` on the boundary, not `>`: with two values of equal weight the lower one
 * wins, so a corpus of halves has a median of the lower half rather than of the
 * upper one. Weights may be zero; all-zero weights return the smallest value
 * (nothing has reached half of nothing, and the walk stops at the first value),
 * which the caller avoids by falling back to unit weights — see prepare(). An
 * empty input is 0, the same "nothing scored" zero `robustStats` in score.mjs
 * returns.
 *
 * The input is neither sorted in place nor otherwise mutated.
 */
export function weightedMedian(values, weights) {
  const n = values.length;
  if (!n) return 0;
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => values[a] - values[b]);
  let total = 0;
  for (let i = 0; i < n; i++) total += weights[i];
  const half = total / 2;
  let acc = 0;
  for (const i of order) {
    acc += weights[i];
    if (acc >= half) return values[i];
  }
  return values[order[n - 1]];
}

/**
 * Where `v` falls among `values`, as a percentile rank in [0,1]:
 * `(count of values < v + 0.5 x count of ties) / m`.
 *
 * Ties are split rather than ordered by position, so two candidates with the
 * same impact get the same P and the result does not depend on the order the
 * candidates arrived in. One value gives 0.5 — the spec's "with one gated
 * candidate P = 0.5", which is not a special case here, it is the formula.
 *
 * Equality is exact: the values being ranked are the ones this run just
 * computed from the same arithmetic, so there is nothing to be fuzzy about.
 * Empty values give 0, there being no distribution to be a rank in.
 */
export function percentRank(values, v) {
  const m = values.length;
  if (!m) return 0;
  let less = 0;
  let ties = 0;
  for (let i = 0; i < m; i++) {
    if (values[i] < v) less++;
    else if (values[i] === v) ties++;
  }
  return (less + 0.5 * ties) / m;
}

/* ── fit ────────────────────────────────────────────────────────────────── */

/**
 * What `r(x)` is measured against, resolved once: the touchstones if there are
 * any, otherwise the topic centrings and their weights.
 *
 * The weighted mean over centroids is the answer to "which of my topics does
 * this look like", and it is why the corpus clusters exist at all: a person
 * cannot write a touchstone for every corner of a field, but they can drag a
 * slider for it. A cluster with no slider is 0.5, the same "no opinion" the
 * paper weights use.
 */
function fitContext(weights, touchstones, clusters) {
  const clusterWeights = clusters.map((c) => weights[c.id] ?? 0.5);
  let weightSum = 0;
  for (const w of clusterWeights) weightSum += w;
  return { touchstones, clusters, clusterWeights, weightSum };
}

/**
 * Fit raw, verbatim from the spec: `max_t cos(x, t)` over the touchstones when
 * there are any, otherwise `Σ_k w_k cos(x, centroid_k) / Σ_k w_k`, and 0 when
 * that sum is 0 (every slider at zero, which is a fair reading of "I have said
 * nothing about what I want" — every paper fits equally badly).
 *
 * The same function measures the corpus rows and the candidates, which is what
 * makes `fitZ` a z against the corpus it is ranking into: `vecs` is the flat
 * corpus (or, for a candidate, that one vector) and `off` says where the row
 * starts, so a candidate is simply a one-row corpus at offset 0.
 */
function fitRaw(vecs, off, ctx) {
  if (ctx.touchstones.length) {
    let best = -Infinity;
    for (const t of ctx.touchstones) {
      const c = dotAt(vecs, off, t, t.length);
      if (c > best) best = c;
    }
    return best;
  }
  let s = 0;
  for (let k = 0; k < ctx.clusters.length; k++) {
    const w = ctx.clusterWeights[k];
    const centroid = ctx.clusters[k].centroid;
    if (w) s += w * dotAt(vecs, off, centroid, centroid.length);
  }
  return ctx.weightSum ? s / ctx.weightSum : 0;
}

/**
 * Everything the corpus-side fit statistics need, computed once per
 * (weights, touchstones) pair: the paper weights, the weighted median of `r`
 * over the corpus (`m`), and 1.4826 x the weighted median absolute deviation
 * (`s`, the robust sigma).
 *
 * That `m` is a *weighted* median is the point of the topic sliders: a corpus
 * that is mostly papers someone does not care about does not drag their
 * reference down, because those papers are barely in the sample.
 *
 * 1.4826 is the constant that makes a MAD the sigma of a normal distribution;
 * the same one `robustStats` and the page's gate use, so a `fitZ` here means
 * what a z means everywhere else in the repo.
 */
export function prepare({ corpus, weights = {}, touchstones = [] }) {
  const { n, dim, vecs, cluster, clusters } = corpus;
  for (const t of touchstones) {
    if (!t || t.length !== dim) {
      throw new Error(`sieve-core: touchstone has ${t ? t.length : 'no'} dims, expected ${dim}`);
    }
  }

  /* p_i = weights[cluster_i] ?? 0.5, and 1 for every paper if that leaves
     nothing weighted at all — an all-zero corpus would otherwise have a median
     of "the smallest value", which is not a median. */
  const p = new Float32Array(n);
  let weighted = false;
  for (let i = 0; i < n; i++) {
    p[i] = weights[cluster[i]] ?? 0.5;
    if (p[i] !== 0) weighted = true;
  }
  if (!weighted) p.fill(1);

  const ctx = fitContext(weights, touchstones, clusters);
  const r = new Float32Array(n);
  for (let i = 0, off = 0; i < n; i++, off += dim) {
    r[i] = fitRaw(vecs, off, ctx);
  }

  const m = weightedMedian(r, p);
  const dev = new Float32Array(n);
  for (let i = 0; i < n; i++) dev[i] = Math.abs(r[i] - m);
  const s = 1.4826 * weightedMedian(dev, p);

  return { corpus, weights, touchstones, p, m, s };
}

/* ── ranking ────────────────────────────────────────────────────────────── */

/**
 * A `prepare()`ed corpus + tonight's candidates + the gate/surprise sliders →
 * the ranked list the page renders.
 *
 * ONE SET OF DOTS PER CANDIDATE, SHARED BY EVERYTHING THAT NEEDS THEM. The cos
 * of a candidate against a corpus paper answers three questions at once — the k
 * nearest (impact), the nearest proven paper (novelty), the three nearest
 * overall (landmarks) — so the corpus is walked once, over its flat Float32Array
 * with no views, and those three are read back off the numbers. The order is
 * the spec's, and it is also the fast order: fit and the gate first (they need
 * only the touchstones or the centroids), then the one expensive pass, and only
 * for the candidates that survived.
 *
 * The kNN is a sorted insertion into a K-long buffer rather than a heap: K is
 * 15, the common case is one comparison, and a heap is more code for a smaller
 * constant. Ties keep the earlier corpus paper (the guard is a strict `>`), so
 * the same corpus always produces the same landmarks.
 *
 * `cluster` on a result is the nearest cluster centroid. Candidates come from
 * tonight's arXiv and carry no cluster of their own, and the label of the topic
 * a paper landed in is the piece of the corpus the result cards want to show.
 */
export function rank(prep, candidates, opts = {}) {
  const { gate = 1.0, surprise = 0.4, k = 15, topQ = 0.75 } = opts;
  const { corpus, p, m, s } = prep;
  const { n, dim, vecs, pct, clusters, ids, titles } = corpus;
  const sigma = Math.max(s, 1e-6);
  const ctx = fitContext(prep.weights, prep.touchstones, clusters);

  /* THE GATE FIRST, BEFORE A DIME IS SPENT ON THE CORPUS. `fitZ` is measured
     against the touchstones or the cluster centroids — at most twenty vectors —
     so it costs a few thousand multiply-adds and never needs the candidate
     against the corpus. A candidate the gate is going to drop anyway therefore
     costs nothing at all, which on a real night (Strictness 1.0) is most of
     them. The order is the spec's too: fit, gate, then impact and novelty. */
  const kept = [];
  for (const candidate of candidates || []) {
    const vec = candidate.vec;
    if (!vec || vec.length !== dim) {
      throw new Error(`sieve-core: candidate ${candidate.id} has ${vec ? vec.length : 'no'} dims, expected ${dim}`);
    }
    const fit = (fitRaw(vec, 0, ctx) - m) / sigma;
    if (fit >= gate) kept.push({ candidate, fit });   // a NaN fit fails this, as it should
  }

  /* The kNN and the 3 landmarks read one list; k can be smaller than 3. */
  const K = Math.max(3, k);
  const tcos = new Float32Array(K);
  const tidx = new Int32Array(K);
  /* Two candidates' cosines against the whole corpus, reused between pairs. */
  const dotsU = new Float32Array(n);
  const dotsV = new Float32Array(n);
  const gated = [];

  /* Everything a candidate needs from one row of cosines: its k nearest (for
     impact), the nearest proven one (novelty), the gate, and the three nearest
     overall (landmarks). Separated from the dot loop so that loop is arithmetic
     and nothing else. */
  const finish = (entry, dots) => {
    const vec = entry.candidate.vec;
    let count = 0;
    let novelMax = 0;
    let novelSeen = false;
    for (let i = 0; i < n; i++) {
      const c = dots[i];
      /* Novelty is "how far from anything proven", so only papers with a pct
         at or above topQ are evidence. A corpus with none of them leaves
         novelSeen false and novelty 1 — nothing proven looks like this. */
      if (pct[i] >= topQ && (!novelSeen || c > novelMax)) {
        novelMax = c;
        novelSeen = true;
      }
      count = insertTop(tcos, tidx, count, K, c, i);
    }

    const fit = entry.fit;                 // measured before the gate dropped the rest

    /* Impact: the k nearest corpus papers, the ones that mattered weighing most,
       clamped at 0 so a paper pointing away cannot vote. `den` is 0 only when
       every neighbour sits at cos <= 0, the same "nothing scored" zero the page
       returns elsewhere. */
    const nTop = Math.min(k, count);
    let num = 0;
    let den = 0;
    for (let j = 0; j < nTop; j++) {
      const i = tidx[j];
      const a = Math.max(tcos[j], 0) * (p[i] + 0.05);
      num += a * pct[i];
      den += a;
    }
    const impact = den ? num / den : 0;
    const novelty = 1 - (novelSeen ? novelMax : 0);

    /* Which topic the paper landed in: the nearest corpus centroid. */
    let cluster = -1;
    let best = -Infinity;
    for (const cl of clusters) {
      const c = dotAt(vec, 0, cl.centroid, cl.centroid.length);
      if (c > best) {
        best = c;
        cluster = cl.id;
      }
    }

    const landmarks = [];
    for (let j = 0; j < Math.min(3, count); j++) {
      const i = tidx[j];
      landmarks.push({ id: ids[i], title: titles[i], sim: tcos[j], pct: pct[i] });
    }

    gated.push({ candidate: entry.candidate, fit, fitZ: fit, impact, novelty, cluster, landmarks });
  };

  /* TWO CANDIDATES PER PASS OVER THE CORPUS, and one load of a corpus element
     for both of them. The corpus is 18 MB, so a candidate costs a full stream
     of it no matter what; doing two at once is the difference between 1.5 s and
     0.9 s for the card's 6000 x 768 x 200, measured under load. An odd count
     pairs the last candidate with itself — one discarded row of dots, half a
     percent of the work, in exchange for one hot loop instead of two. */
  for (let ci = 0; ci < kept.length; ci += 2) {
    const first = kept[ci];
    const last = ci + 1 >= kept.length;
    const second = last ? first : kept[ci + 1];
    const u = first.candidate.vec;
    const v = second.candidate.vec;
    for (let i = 0, off = 0; i < n; i++, off += dim) {
      let u0 = 0; let u1 = 0; let u2 = 0; let u3 = 0;
      let v0 = 0; let v1 = 0; let v2 = 0; let v3 = 0;
      let kk = 0;
      for (; kk + 4 <= dim; kk += 4) {
        const x0 = vecs[off + kk];
        const x1 = vecs[off + kk + 1];
        const x2 = vecs[off + kk + 2];
        const x3 = vecs[off + kk + 3];
        u0 += x0 * u[kk]; u1 += x1 * u[kk + 1]; u2 += x2 * u[kk + 2]; u3 += x3 * u[kk + 3];
        v0 += x0 * v[kk]; v1 += x1 * v[kk + 1]; v2 += x2 * v[kk + 2]; v3 += x3 * v[kk + 3];
      }
      for (; kk < dim; kk++) {
        const x = vecs[off + kk];
        u0 += x * u[kk];
        v0 += x * v[kk];
      }
      dotsU[i] = (u0 + u1) + (u2 + u3);
      dotsV[i] = (v0 + v1) + (v2 + v3);
    }

    finish(first, dotsU);
    if (!last) finish(second, dotsV);
  }

  /* Percentile ranks are taken over the gated set only, as the spec says: the
     scale a candidate is scored on is the scale of what survived. */
  const impacts = new Float32Array(gated.length);
  const novelties = new Float32Array(gated.length);
  for (let i = 0; i < gated.length; i++) {
    impacts[i] = gated[i].impact;
    novelties[i] = gated[i].novelty;
  }

  const ranked = gated.map((g) => ({
    ...g.candidate,
    fit: g.fit,
    fitZ: g.fitZ,
    impact: g.impact,
    novelty: g.novelty,
    score: (1 - surprise) * percentRank(impacts, g.impact) + surprise * percentRank(novelties, g.novelty),
    cluster: g.cluster,
    landmarks: g.landmarks,
  }));

  /* Score descending, id ascending — the deterministic tie-break the ranking
     pipeline uses, so two runs over one night cannot disagree. */
  ranked.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return ranked;
}

/**
 * The whole thing in one call, for callers that score once and never move a
 * slider again: `rank(prepare(...), ...)`. The page uses the two halves
 * separately, so a Strictness or Surprise drag re-ranks without re-measuring
 * the corpus.
 */
export function score({ corpus, weights, touchstones, candidates, opts }) {
  return rank(prepare({ corpus, weights, touchstones }), candidates, opts);
}

