/**
 * `cd scripts && node --test cave-wagons.test.mjs`.
 *
 * `docs/assets/cave-wagons.mjs` is a copy of Dig's clustering maths, so the
 * test does not describe what the maths should do — it takes the reference
 * functions out of `docs/assets/filter.js` as TEXT, evaluates them in one
 * `node:vm` context, and asserts the copy returns the same numbers. A drift on
 * either side fails here instead of quietly redrawing the same night as two
 * different nights.
 *
 * Three checks:
 *   1. ORACLE — coupling map, dendrogram, cut at three thresholds, wagon
 *      counts, best threshold and cluster order on three seeded fixtures.
 *   2. ORACLE, primitives — dot / cosine / center, which also pins the corpus
 *      centroid the copy had to carry along.
 *   3. HAND FIXTURE — two tight groups of three, far apart: two wagons of
 *      three at WAGON_THRESH. The one expectation a human can check by eye.
 *
 * Shape of the fixtures: 40 vectors of dim 16, eight seeded directions with
 * five noisy copies each. Uniform noise on a 16-sphere scores near zero
 * everywhere, and then every threshold returns lone stones — the sweep and the
 * cut would agree on nothing interesting.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import {
  WAGON_MIN_SIZE, WAGON_THRESH, bestWagonThresh, buildDendrogram, center, clusterOrder,
  computeWagonMap, cosine, countWagons, cutDendrogram, dot,
} from '../docs/assets/cave-wagons.mjs';

const SRC = readFileSync(fileURLToPath(new URL('../docs/assets/filter.js', import.meta.url)), 'utf8');

/* ── pulling the reference out of filter.js ─────────────────────────────
 *
 * TEXT, NOT AN IMPORT: filter.js is an IIFE with no exports, and the point is
 * to compare against the file as it is rather than against a copy of it. The
 * functions are cut out by BRACE COUNTING — a regex would stop at the first
 * `}` inside a block or a comment — and evaluated together in one context so
 * they can see each other and the constants they close over.
 *
 * The scanner skips '…', "…", `…`, // and block comments. A template literal is
 * skipped whole, `${}` included, without interpreting it.
 * ponytail: a template containing a backtick inside `${}` would end the scan
 * early; the reference has none, and a repair here fails loudly rather than
 * silently, because the cut text would not parse.
 */

const QUOTED = new Set(["'", '"', '`']);

/** Index just past the quoted run starting at `i`. */
function skipString(src, i) {
  const quote = src[i];
  for (i += 1; i < src.length; i += 1) {
    if (src[i] === '\\') { i += 1; continue; }
    if (src[i] === quote) return i + 1;
  }
  return i;
}

/** Index of the `}` closing the `{` at `open`. */
function matchBrace(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      i = src.indexOf('\n', i);
      if (i < 0) break;
    } else if (c === '/' && src[i + 1] === '*') {
      i = src.indexOf('*/', i + 2) + 1;
      if (i <= 0) break;
    } else if (QUOTED.has(c)) {
      i = skipString(src, i) - 1;
    } else if (c === '{') {
      depth += 1;
    } else if (c === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error('unbalanced braces in the reference');
}

/** Index of the `;` ending the statement that starts at `from`. */
function matchSemicolon(src, from) {
  let depth = 0;
  for (let i = from; i < src.length; i += 1) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      i = src.indexOf('\n', i);
      if (i < 0) break;
    } else if (c === '/' && src[i + 1] === '*') {
      i = src.indexOf('*/', i + 2) + 1;
      if (i <= 0) break;
    } else if (QUOTED.has(c)) {
      i = skipString(src, i) - 1;
    } else if ('([{'.includes(c)) {
      depth += 1;
    } else if (')]}'.includes(c)) {
      depth -= 1;
    } else if (c === ';' && depth === 0) {
      return i;
    }
  }
  throw new Error('unterminated declaration in the reference');
}


/** Source of `function <name>(…) { … }`, whole. */
function fnSource(name) {
  const at = SRC.indexOf(`\n  function ${name}(`);
  assert.notEqual(at, -1, `filter.js no longer defines function ${name}`);
  const brace = SRC.indexOf('{', at);
  return SRC.slice(at, matchBrace(SRC, brace) + 1);
}

/** Source of a `var`/`const` declaration, whole (multi-line strings and all). */
function declSource(name) {
  const at = SRC.search(new RegExp(`^\\s+(?:var|const) ${name}\\b`, 'm'));
  assert.notEqual(at, -1, `filter.js no longer defines ${name}`);
  return SRC.slice(at, matchSemicolon(SRC, at) + 1);
}

const REF_FNS = [
  'normalize', 'dot', 'center', 'cosine', 'computeWagonMap', 'buildDendrogram',
  'cutDendrogram', 'countWagons', 'bestWagonThresh', 'clusterOrder',
];
const REF_CONSTS = [
  'CORPUS_CENTROID_B64', 'CORPUS_CENTROID',
  'WAGON_THRESH', 'WAGON_MIN_SIZE', 'WAGON_MAX_SHARE', 'WAGON_MAX_SHARE_FLOOR',
];

/** The filter.js originals, live in their own realm. */
function loadReference() {
  const body = [...REF_CONSTS.map(declSource), ...REF_FNS.map(fnSource)].join('\n');
  /* `atob` is the one non-intrinsic global the centroid decoder needs; the
     context's Math, typed arrays and Set are its own. */
  const context = vm.createContext({
    atob: (b64) => Buffer.from(b64, 'base64').toString('latin1'),
  });
  const names = [...REF_FNS, ...REF_CONSTS.slice(2)].join(', ');
  return vm.runInContext(`${body}\n({ ${names} })`, context);
}

/* Cross-realm comparison: the reference's arrays, typed arrays and plain
   objects come from another context, so a prototype-sensitive deepEqual would
   fail on identity rather than on value. Copy into this realm, values only. */
function plain(v) {
  if (Array.isArray(v) || ArrayBuffer.isView(v)) return Array.from(v, plain);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = plain(v[k]);
    return out;
  }
  return v;
}

/* ── fixtures ─────────────────────────────────────────────────────────── */

const DIM = 16;
const GROUPS = 8;
const PER_GROUP = 5;
const N = GROUPS * PER_GROUP;   // 40

/** Seeded PRNG: 32-bit state, no dependencies, same stream every run. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 40 vectors of dim 16: eight seeded directions, five noisy copies each. */
function fixture(seed) {
  const rnd = mulberry32(seed);
  const direction = () => Array.from({ length: DIM }, () => rnd() * 2 - 1);
  const A = [];
  for (let g = 0; g < GROUPS; g += 1) {
    const base = direction();
    for (let k = 0; k < PER_GROUP; k += 1) {
      A.push(base.map((x) => x + 0.4 * (rnd() * 2 - 1)));
    }
  }
  return A;
}

/* Only `title` is read by clusterOrder (source of `centralTitle`). */
const stones = Array.from({ length: N }, (_, i) => ({ title: `stone ${i}` }));


/* ── 1. the oracle ────────────────────────────────────────────────────── */

test('oracle: same results as filter.js on three seeded fixtures', () => {
  const REF = loadReference();

  for (const seed of [1, 2, 3]) {
    const A = fixture(seed);
    const S = computeWagonMap(A);
    const merges = buildDendrogram(S, N);

    const refS = REF.computeWagonMap(A);
    const refMerges = REF.buildDendrogram(refS, N);

    assert.deepEqual(plain(S), plain(refS), `seed ${seed}: coupling map`);

    /* A dendrogram that is empty, or one giant merge, compares equal and
       proves nothing — so the fixture has to have wagons in it. */
    const at = countWagons(merges, N, WAGON_THRESH);
    assert.ok(
      at.wagons >= 2 && at.clustered >= 2 * WAGON_MIN_SIZE,
      `seed ${seed}: fixture has no wagons to compare (${JSON.stringify(at)})`,
    );

    assert.deepEqual(plain(merges), plain(refMerges), `seed ${seed}: dendrogram`);

    for (const t of [0.30, WAGON_THRESH, 0.60]) {
      assert.deepEqual(
        plain(cutDendrogram(merges, N, t)),
        plain(REF.cutDendrogram(refMerges, N, t)),
        `seed ${seed}: cut at ${t}`,
      );
      assert.deepEqual(
        plain(countWagons(merges, N, t)),
        plain(REF.countWagons(refMerges, N, t)),
        `seed ${seed}: countWagons at ${t}`,
      );
    }

    assert.equal(
      bestWagonThresh(merges, N),
      REF.bestWagonThresh(refMerges, N),
      `seed ${seed}: bestWagonThresh`,
    );

    const mine = clusterOrder(stones, S, merges);
    assert.deepEqual(
      plain(mine),
      plain(REF.clusterOrder(stones, refS, refMerges)),
      `seed ${seed}: clusterOrder`,
    );

    /* The order is a permutation of the night with the wagons first — true of
       the copy and of the reference alike. */
    assert.equal(mine.order.length, N);
    assert.deepEqual(mine.order.slice().sort((x, y) => x - y), [...Array(N).keys()]);
    assert.ok(mine.components.length >= 2, `seed ${seed}: fixture clustered`);
    for (const c of mine.components) assert.ok(c.indices.length >= WAGON_MIN_SIZE);
  }
});

/* ── 2. the primitives the module had to carry ────────────────────────── */

test('oracle: dot, cosine and center match, corpus centroid included', () => {
  const REF = loadReference();
  const A = fixture(7);

  assert.equal(WAGON_THRESH, REF.WAGON_THRESH);

  /* center() subtracts the 768-dim corpus centroid, so a mis-copied base64
     blob is caught here and nowhere else. */
  for (let i = 0; i + 1 < A.length; i += 9) {
    assert.equal(dot(A[i], A[i + 1]), REF.dot(A[i], A[i + 1]), `dot ${i}`);
    assert.equal(cosine(A[i], A[i + 1]), REF.cosine(A[i], A[i + 1]), `cosine ${i}`);
    assert.deepEqual(plain(center(A[i])), plain(REF.center(A[i])), `center ${i}`);
  }

  /* Behaviour kept on purpose: a width mismatch is loud, a zero vector is 0. */
  assert.throws(() => dot([1, 2], [1]), /Dimension mismatch/);
  assert.equal(cosine([0, 0], [1, 1]), 0);
});

/* ── 3. by eye ────────────────────────────────────────────────────────── */

test('hand fixture: two tight groups of three cut into two wagons of three', () => {
  /* Two orthogonal directions, three near-copies of each: within-group cosine
     is ~0.9999, between-group ~0.02, and nothing lives in between — so the
     threshold's answer is readable without running anything. */
  const A = [
    [1, 0.02, 0, 0], [1, -0.02, 0.01, 0], [0.99, 0, 0.02, 0],
    [0.01, 1, 0, 0], [0, 1, -0.01, 0], [0, 0.99, 0, 0.02],
  ];
  const n = A.length;
  const S = computeWagonMap(A);
  const merges = buildDendrogram(S, n);

  const groups = cutDendrogram(merges, n, WAGON_THRESH);
  assert.deepEqual(groups.map((g) => g.length), [3, 3]);
  assert.deepEqual(
    groups.map((g) => g.slice().sort((x, y) => x - y)),
    [[0, 1, 2], [3, 4, 5]],
    'the cut does not mix the two groups',
  );

  assert.deepEqual(countWagons(merges, n, WAGON_THRESH), { wagons: 2, clustered: 6, largest: 3 });

  const six = A.map((_, i) => ({ title: `title ${i}` }));
  const explicit = clusterOrder(six, S, merges, WAGON_THRESH);
  assert.deepEqual(clusterOrder(six, S, merges), explicit, 'WAGON_THRESH is the default cut');
  assert.equal(explicit.order.length, 6);
  assert.deepEqual(explicit.components.map((c) => c.indices.length), [3, 3]);
  assert.deepEqual(
    explicit.components.map((c) => c.indices.slice().sort((x, y) => x - y)),
    [[0, 1, 2], [3, 4, 5]],
  );
  /* Every wagon names itself by its most central stone's title. */
  for (const c of explicit.components) assert.match(c.centralTitle, /^title \d$/);
});
