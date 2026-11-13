/**
 * cave-wagons — the wagon maths: cosine similarity, the average-linkage
 * dendrogram, the cut, and the order the train draws in.
 *
 * COPIED FROM `docs/assets/filter.js`, MATHS UNCHANGED. That is the whole
 * contract: tonight's Map stage must group stones exactly the way Dig did, or
 * the same haul reads as two different hauls. The originals stay the
 * reference, and `scripts/cave-wagons.test.mjs` proves the copy — it lifts each
 * function out of filter.js as text, runs them in a `node:vm`, and compares on
 * seeded fixtures. Edit one side only and that test fails.
 *
 * What changed in the move, and nothing else:
 *   * `state.stones` is now the `stones` argument of `clusterOrder()`;
 *     `state.wagonNames` is not read here at all — naming stays with the caller.
 *   * ESM exports instead of an IIFE: no `state`, no DOM, no globals.
 *
 * Pure functions over plain arrays. Nothing here touches the page.
 */

/* ── The corpus centroid ──────────────────────────────────────────────
 *
 * MOVE THIS WITH `CORPUS_CENTROID` IN filter.js OR THE WAGONS WILL NOT MATCH.
 * Base64 float32, little-endian, measured once for `allenai/specter2_base` and
 * shipped as a literal so a stone's coordinates stay a property of the stone
 * rather than of tonight's haul. Re-measure with
 * `node scripts/measure-centroid.mjs` if the pick ever changes — a different
 * model's cone points somewhere else, and this would subtract a direction that
 * means nothing, silently.
 */
const CORPUS_CENTROID_B64 =
  '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';

/** Decoded once at load: base64 float32 → a plain Array of DIM numbers. */
const CORPUS_CENTROID = (function () {
  var bin = atob(CORPUS_CENTROID_B64);
  var bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return Array.prototype.slice.call(new Float32Array(bytes.buffer));
})();

/** Unit-normalise in place. Zero length is returned untouched. */
export function normalize(v) {
  var sq = 0;
  for (var i = 0; i < v.length; i++) sq += v[i] * v[i];
  var len = Math.sqrt(sq);
  if (len === 0) return v;
  for (var j = 0; j < v.length; j++) v[j] /= len;
  return v;
}

export function dot(a, b) {
  if (a.length !== b.length) throw new Error('Dimension mismatch: ' + a.length + ' vs ' + b.length);
  var s = 0;
  for (var i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/**
 * Move a vector out of SPECTER2's cone: subtract the corpus centroid, then
 * renormalize so the result is a unit vector again and `cosine` still means
 * cosine. See CORPUS_CENTROID.
 *
 * APPLIED ONCE, WHERE THE WORKING ARRAYS ARE BUILT, and nowhere else — not
 * inside `cosine`, which the coupling map calls O(N²) times and which would
 * then re-centre the same vector nine hundred times a row.
 */
export function center(v) {
  if (!v) return v;
  var u = normalize(v.slice());
  for (var i = 0; i < u.length; i++) u[i] -= CORPUS_CENTROID[i];
  return normalize(u);
}

export function cosine(a, b) {
  var d = dot(a, b);
  // Defensive: re-normalize in case of drift
  var na = 0, nb = 0;
  for (var i = 0; i < a.length; i++) { na += a[i] * a[i]; nb += b[i] * b[i]; }
  na = Math.sqrt(na); nb = Math.sqrt(nb);
  if (na === 0 || nb === 0) return 0;
  /* NO FLOOR AT ZERO. Centred, the median pair scores about -0.03 and a p5 pair
     scores -0.30: roughly half of every coupling map is negative, and clamping
     would flatten "unrelated" and "opposite" into one value. */
  return d / (na * nb);
}

/** N×N cosine coupling map, symmetric, unit diagonal, Float32 rows. */
export function computeWagonMap(A) {
  var N = A.length;
  var S = new Array(N);
  for (var i = 0; i < N; i++) {
    S[i] = new Float32Array(N);
    S[i][i] = 1.0;
  }
  // Upper triangle only (i < j)
  for (var i = 0; i < N; i++) {
    for (var j = i + 1; j < N; j++) {
      var c = cosine(A[i], A[j]);
      S[i][j] = c;
      S[j][i] = c;
    }
  }
  return S;
}

/* Merge threshold and minimum wagon size — shared by the matrix ordering and
   the graph view so both draw the same grouping.

   MEASURED THREE TIMES NOW, and the number moved each time for a different
   reason: 0.75 came from `bge-small-en-v1.5`, #75 re-measured 0.93 for raw
   SPECTER2, #77 centred that space and it became 0.63, and wagons are
   average-linkage groups now rather than connected components — a mean
   similarity between groups is a different quantity from an edge weight.
   Measured 2026-08-20 across three hauls: 0.46 is where the sweep lands on all
   three (89, 336 and 631 stones). The readable band is about 0.35-0.55; below
   0.25 the groups swallow each other, above 0.60 they crumble.

   None of these numbers transfer if the pick, the centroid or the linkage
   changes. Re-measure. */
export var WAGON_THRESH = 0.46;
export var WAGON_MIN_SIZE = 3;

/* ── Average linkage, and why the wagons stopped being one wagon ──────
 *
 * Wagons used to be connected components at a threshold, which is single
 * linkage, and single linkage chains: one stone sitting between two topics
 * joins them. Average linkage merges on the *mean* similarity between two
 * groups, so a bridging paper is outvoted by every pair that is not adjacent
 * to it. Measured 2026-08-20, 89 stones: single linkage gave 1 wagon holding
 * all 89 at 58 of the slider's 101 positions; average gave 11 wagons holding
 * 63. More wagons AND more of the night placed.
 *
 * THE DENDROGRAM IS BUILT ONCE PER HAUL. Agglomerating is O(N^2) with a
 * per-row best cache; cutting it at a threshold is O(N). Rebuilding per
 * threshold would make the slider a fresh agglomeration on every nudge.
 */
export function buildDendrogram(S, N) {
  /* Working copy: Lance-Williams updates the merged row in place, and the
     coupling map is the page's own and must survive this. */
  var D = new Array(N);
  for (var i = 0; i < N; i++) D[i] = Float64Array.from(S[i]);

  var size = new Int32Array(N);
  var alive = new Uint8Array(N);
  for (var a = 0; a < N; a++) { size[a] = 1; alive[a] = 1; }
  /* bestJ/bestV make the global argmax O(K) instead of O(K^2). Without it
     this is O(N^3) and a 900-stone night stops being interactive. */
  var bestJ = new Int32Array(N), bestV = new Float64Array(N);

  function rescan(i) {
    var bv = -Infinity, bj = -1;
    for (var j = 0; j < N; j++) {
      if (!alive[j] || j === i) continue;
      if (D[i][j] > bv) { bv = D[i][j]; bj = j; }
    }
    bestJ[i] = bj; bestV[i] = bv;
  }
  for (var r = 0; r < N; r++) rescan(r);

  /* Each entry is one merge: the two live representatives joined, and the
     mean similarity they were joined at. Similarity falls as merging goes
     on, so a cut at t is "replay every merge whose similarity >= t". */
  var merges = [];
  for (;;) {
    var gv = -Infinity, gi = -1;
    for (var k = 0; k < N; k++) {
      if (alive[k] && bestV[k] > gv) { gv = bestV[k]; gi = k; }
    }
    if (gi < 0) break;
    var b = bestJ[gi];
    if (b < 0) break;
    merges.push({ a: gi, b: b, sim: gv });

    var na = size[gi], nb = size[b];
    for (var m = 0; m < N; m++) {
      if (!alive[m] || m === gi || m === b) continue;
      var v = (na * D[gi][m] + nb * D[b][m]) / (na + nb);
      D[gi][m] = v; D[m][gi] = v;
    }
    alive[b] = 0;
    size[gi] = na + nb;
    rescan(gi);
    /* Only rows whose favourite just died or just changed need rescanning. */
    for (var q = 0; q < N; q++) {
      if (alive[q] && q !== gi && (bestJ[q] === b || bestJ[q] === gi)) rescan(q);
    }
  }
  return merges;
}

/** Cut a dendrogram at `thresh`: union-find over the merges at or above it.
 *  Returns an array of member-index arrays, largest first. */
export function cutDendrogram(merges, N, thresh) {
  var parent = new Int32Array(N);
  for (var i = 0; i < N; i++) parent[i] = i;
  function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
  for (var m = 0; m < merges.length; m++) {
    if (merges[m].sim < thresh) continue;
    var ra = find(merges[m].a), rb = find(merges[m].b);
    if (ra !== rb) parent[rb] = ra;
  }
  var byRoot = {};
  for (var n = 0; n < N; n++) {
    var root = find(n);
    (byRoot[root] || (byRoot[root] = [])).push(n);
  }
  var out = [];
  for (var key in byRoot) if (byRoot.hasOwnProperty(key)) out.push(byRoot[key]);
  out.sort(function (x, y) { return y.length - x.length; });
  return out;
}

/** Wagons ≥ WAGON_MIN_SIZE at one threshold, how many stones they hold, and
 *  the largest component. A cut of the prebuilt dendrogram — no graph walk,
 *  because the sweep runs this a hundred times and the merge order is
 *  already known. */
export function countWagons(merges, N, thresh) {
  var groups = cutDendrogram(merges, N, thresh);
  var wagons = 0, clustered = 0, largest = 0;
  for (var g = 0; g < groups.length; g++) {
    var size = groups[g].length;
    if (size >= WAGON_MIN_SIZE) { wagons++; clustered += size; }
    /* The biggest component, counted whether or not it is a wagon, because
       the thing this guards against is one component swallowing the night —
       and at a low threshold that component is the only one there is. */
    if (size > largest) largest = size;
  }
  return { wagons: wagons, clustered: clustered, largest: largest };
}

/* No wagon may hold more than this share of the night, and the reason is a
   property of the clustering rather than of the data.

   WAGON COUNT ALONE IS THE WRONG OBJECTIVE. A swollen component does not
   reduce the wagon *count* — it appears alongside all the genuine small ones —
   so a sweep that maximises the count actively prefers the threshold just
   before the blob breaks up.

   Measured 2026-08-20 over one announcement day, 336 stones: max wagons gave
   13 wagons / 176 clustered with a largest of 104 (31% of the night); max
   wagons under a 20% cap gave the same 13 wagons, 88 clustered, largest 17.
   It costs coverage, which is the honest trade: the 88 extra were chained in,
   never really in that wagon.

   20% BECAUSE IT IS A NO-OP WHEN NOTHING IS WRONG. A haul whose largest wagon
   is 6% of the night picks exactly the threshold it picked before. The floor
   of 12 keeps it quiet on small hauls, where 20% is a handful of stones and
   every threshold would fail it. If nothing clears the cap the sweep falls
   back to the uncapped answer — a blob is a bad train, but no train is worse. */
export var WAGON_MAX_SHARE = 0.20;
export var WAGON_MAX_SHARE_FLOOR = 12;

/** Pick the threshold that splits the haul into the most distinct wagons.
 *  Too low and everything fuses into one blob; too high and every stone is
 *  lone — the count peaks in between. Ties go to the threshold that leaves
 *  more stones inside a wagon. */
export function bestWagonThresh(merges, N) {
  /* 0.40 to 0.75 in 0.005 steps — the centred band. A sweep of 0.80-0.99 would
     sit entirely past the point where the last wagon has shattered and return
     its own floor on every haul, silently. */
  var cap = Math.max(WAGON_MAX_SHARE_FLOOR, Math.round(WAGON_MAX_SHARE * N));
  var best = -1, bestWagons = -1, bestClustered = -1;
  var loose = WAGON_THRESH, looseWagons = -1, looseClustered = -1;

  for (var k = 40; k <= 140; k++) {
    var t = k / 200;
    var r = countWagons(merges, N, t);
    /* Tracked in parallel rather than in a second sweep: countWagons is the
       expensive part and this way it runs once per threshold, not twice. */
    if (r.wagons > looseWagons ||
        (r.wagons === looseWagons && r.clustered > looseClustered)) {
      loose = t; looseWagons = r.wagons; looseClustered = r.clustered;
    }
    if (r.largest > cap) continue;
    if (r.wagons > bestWagons ||
        (r.wagons === bestWagons && r.clustered > bestClustered)) {
      best = t; bestWagons = r.wagons; bestClustered = r.clustered;
    }
  }
  return best >= 0 ? best : loose;
}

/**
 * Cluster order: cut the dendrogram at `thresh` (default WAGON_THRESH),
 * keeping groups ≥ WAGON_MIN_SIZE.
 * Returns { order: [indices], components: [{indices:[], centralTitle:string}] }
 *
 * @param {Array<{title: string}>} stones  the reference's `state.stones`
 */
export function clusterOrder(stones, S, merges, thresh) {
  var N = stones.length;
  var THRESH = thresh === undefined ? WAGON_THRESH : thresh;

  /* Average-linkage groups, largest first — see buildDendrogram. The coupling
     map `S` is still needed below to pick each wagon's central stone, which is
     a question about the stones themselves and not about how they were
     grouped. */
  var groups = cutDendrogram(merges, N, THRESH);
  var components = [];
  for (var g = 0; g < groups.length; g++) {
    if (groups[g].length >= WAGON_MIN_SIZE) components.push(groups[g]);
  }

  // Find central member by max sum of within-component similarities
  var compInfo = [];
  for (var c = 0; c < components.length; c++) {
    var members = components[c];
    var bestIdx = members[0];
    var bestSum = -Infinity;
    for (var mi = 0; mi < members.length; mi++) {
      var sum = 0;
      for (var mj = 0; mj < members.length; mj++) {
        if (mi !== mj) sum += S[members[mi]][members[mj]];
      }
      if (sum > bestSum) { bestSum = sum; bestIdx = members[mi]; }
    }
    compInfo.push({ indices: members, centralTitle: stones[bestIdx].title });
  }

  // Build order: clustered stones first, then remainder
  var clustered = [];
  var seen = new Set();
  for (var c2 = 0; c2 < components.length; c2++) {
    for (var m2 = 0; m2 < components[c2].length; m2++) {
      var idx = components[c2][m2];
      if (!seen.has(idx)) { seen.add(idx); clustered.push(idx); }
    }
  }
  var remainder = [];
  for (var r = 0; r < N; r++) {
    if (!seen.has(r)) remainder.push(r);
  }
  return { order: clustered.concat(remainder), components: compInfo };
}

