/**
 * `node --test scripts/background.test.mjs`.
 *
 * Every expectation below is hand-computed from INTERFACES.md and the formula
 * the page and the feed already use, never from this file's own output. Nothing
 * touches the network: `fetchEarlier`, `embed` and `coreFetch` are all stubbed.
 *
 * THE TRICK THAT MAKES THE ARITHMETIC CHECKABLE BY EYE. `buildBackground`
 * centres every vector, and the centroid is a 768-float constant, so a 3-dim
 * fixture would normally be mangled into unreadable numbers. `raw()` inverts
 * `center` for 3-vectors: `center(raw(a)) === a`, so a fixture can state its
 * *centred* geometry directly — e1, −e1, e2 — and every cosine below is exactly
 * 1, 0 or −1. `raw` is derived from the centroid, not from `center`'s output,
 * so the expected numbers stay independent of the code under test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildBackground } from './background.mjs';
import { resolveTaus } from './score.mjs';
import { CORPUS_CENTROID, center } from './preset-feed.mjs';

/* The 3-vector slice of the centroid that `center` subtracts from a 3-vector. */
const C = CORPUS_CENTROID.slice(0, 3);
const CC = C[0] * C[0] + C[1] * C[1] + C[2] * C[2];

/** The unit 3-vector whose image under `center` is `a` (see the header). */
function raw(a) {
  const ca = a[0] * C[0] + a[1] * C[1] + a[2] * C[2];
  const t = -ca + Math.sqrt(ca * ca + 1 - CC);
  return [C[0] + t * a[0], C[1] + t * a[1], C[2] + t * a[2]];
}

const E1 = raw([1, 0, 0]);
const NE1 = raw([-1, 0, 0]);
const E2 = raw([0, 1, 0]);
const E3 = raw([0, 0, 1]);

const NOW = new Date('2026-11-05T00:00:00Z');

/* Four background papers, centring to e1, −e1, e2, e3. */
const STONES = [
  { arxivId: 'p1', abstract: 'a1' },
  { arxivId: 'p2', abstract: 'a2' },
  { arxivId: 'p3', abstract: 'a3' },
  { arxivId: 'p4', abstract: 'a4' },
];

const VECTORS = {
  a1: E1, a2: NE1, a3: E2, a4: E3,
  'A touchstone': E1, 'A seed': E2, 'B touchstone': E1,
};

/* Axis A has two rows (e1 and e2), axis B one (e1). Both are the pack's own
   rows: a touchstone, then a seed the injected coreFetch resolves. */
const PACK = {
  criterion: { axes: ['A', 'B'], description: 'demo pack' },
  axes: {
    A: {
      name: 'A',
      touchstones: [{ text: 'A touchstone', weight: 1 }],
      seeds: [{ doi: '10.1/x', weight: 1 }],
    },
    B: {
      name: 'B',
      touchstones: [{ text: 'B touchstone', weight: 1 }],
      seeds: [],
    },
  },
};

const CONFIG = { feed: { categories: ['quant-ph', 'cond-mat.mes-hall'] } };

/**
 * A run with every seam stubbed. `seen` is every text the embedder was handed,
 * `calls` every fetchEarlier invocation — so a test can assert on the wiring
 * without a socket.
 */
function run({
  pack = PACK, config = CONFIG, stones = STONES, coreFetch, maxResults, now = NOW, weekdays,
} = {}) {
  const seen = [];
  const calls = [];
  const fetchEarlier = async (categories, lookback, window, at) => {
    calls.push({ categories, lookback, window, at });
    return stones;
  };
  const embed = async (texts) => {
    seen.push(...texts);
    return texts.map((t) => VECTORS[t]);
  };
  const core = coreFetch || (async (ref) => ({ text: ref.id === '10.1/x' ? 'A seed' : ref.id }));
  const promise = buildBackground({
    pack, config, fetchEarlier, embed, coreFetch: core, maxResults, now,
    ...(weekdays === undefined ? {} : { weekdays }),
  });
  return { promise, seen, calls };
}

const close = (got, want, msg) =>
  assert.ok(Math.abs(got - want) < 1e-6, `${msg}: ${got} != ${want}`);
const closeArr = (got, want, msg) => {
  assert.equal(got.length, want.length, `${msg} length`);
  got.forEach((v, i) => close(v, want[i], `${msg}[${i}]`));
};

/* Hand-computed. Axis A's rows are e1 and e2, so mean_sim is the mean of the two
   cosines and max_sim is the larger of them; axis B has only e1, so its mean and
   max are the same cosine. */
const A_MEAN = { median: 0.5, mad: 0.5, values: [-0.5, 0, 0.5, 0.5] };
const A_MAX = { median: 1, mad: 1, values: [0, 0, 1, 1] };
const B_STATS = { median: 0, mad: 1, values: [-1, 0, 0, 1] };

const checkStats = (got, want, msg) => {
  close(got.median, want.median, `${msg} median`);
  close(got.mad, want.mad, `${msg} mad`);
  closeArr(got.values, want.values, `${msg} values`);
};

test('raw() is the inverse of center() on a 3-vector, which is why the fixtures read cleanly', () => {
  for (const a of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, 1]]) {
    closeArr(center(raw(a)), a, `center(raw(${a}))`);
  }
});

test('the background carries built_on, n and one mean/max entry per axis', async () => {
  const bg = await run().promise;
  assert.equal(bg.built_on, '2026-11-05');
  assert.equal(bg.n, 4);
  assert.deepEqual(Object.keys(bg.axes), ['A', 'B']);
  assert.deepEqual(Object.keys(bg.axes.A), ['mean', 'max']);
  assert.deepEqual(Object.keys(bg.axes.A.mean), ['median', 'mad', 'values']);
  assert.deepEqual(Object.keys(bg.axes.A.max), ['median', 'mad', 'values']);
});

test('mean_sim is the blended grade and max_sim the closest row, hand-computed', async () => {
  const bg = await run().promise;
  checkStats(bg.axes.A.mean, A_MEAN, 'A.mean');
  checkStats(bg.axes.A.max, A_MAX, 'A.max');
  // One row: the blend and the closest row are the same cosine, so mean === max.
  checkStats(bg.axes.B.mean, B_STATS, 'B.mean');
  checkStats(bg.axes.B.max, B_STATS, 'B.max');
});

test('values are one per background paper and sorted ascending', async () => {
  const bg = await run().promise;
  for (const id of ['A', 'B']) {
    for (const kind of ['mean', 'max']) {
      const values = bg.axes[id][kind].values;
      assert.equal(values.length, STONES.length, `${id}.${kind} length`);
      assert.deepEqual(values, [...values].sort((a, b) => a - b), `${id}.${kind} not sorted`);
    }
  }
});

test('a seed that will not resolve is skipped, never scored zero', async () => {
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  let bg;
  try {
    const packGone = {
      criterion: { axes: ['A'], description: 'demo' },
      axes: {
        A: {
          name: 'A',
          touchstones: [{ text: 'A touchstone', weight: 1 }],
          seeds: [{ doi: '10.1/x', weight: 1 }, { doi: '10.1/gone', weight: 1 }],
        },
      },
    };
    bg = await run({
      pack: packGone,
      coreFetch: async (ref) => {
        if (ref.id === '10.1/gone') throw new Error('OpenAlex HTTP 404');
        return { text: 'A seed' };
      },
    }).promise;
  } finally {
    console.warn = realWarn;
  }
  // The surviving rows are identical to the single-seed run: the missing seed
  // contributed no vector, rather than a zero that would pull the mean down.
  checkStats(bg.axes.A.mean, A_MEAN, 'A.mean');
  checkStats(bg.axes.A.max, A_MAX, 'A.max');
  assert.equal(bg.n, 4);
  assert.match(warnings.join('\n'), /qs-a core 10\.1\/gone unresolved/);
});

test('the embedder is handed the cache-key text, not the raw string', async () => {
  const packSpaced = {
    criterion: { axes: ['A'], description: 'demo' },
    axes: {
      A: {
        name: 'A',
        touchstones: [{ text: 'A   touchstone', weight: 1 }],
        seeds: [{ doi: '10.1/x', weight: 1 }],
      },
    },
  };
  const { promise, seen } = run({ pack: packSpaced });
  await promise;
  assert.ok(seen.includes('A touchstone'), 'collapsed text was not embedded');
  assert.ok(!seen.includes('A   touchstone'), 'raw text reached the embedder');
});

test('the sample is the configured categories over `weekdays` weekdays', async () => {
  const first = run();
  await first.promise;
  assert.deepEqual(first.calls[0].categories, ['quant-ph', 'cond-mat.mes-hall']);
  assert.equal(first.calls[0].lookback, 60);
  // 60 x 400 = 24000 would be refused by arXiv (HTTP 500 above ~10000), so the
  // window is capped at 8000.
  assert.equal(first.calls[0].window, 8000);
  assert.equal(first.calls[0].at, NOW);

  const short = run({ weekdays: 3 });
  await short.promise;
  assert.equal(short.calls[0].lookback, 3);
  assert.equal(short.calls[0].window, 3 * 400);

  const capped = run({ maxResults: 7 });
  await capped.promise;
  assert.equal(capped.calls[0].window, 7);
});

test('an empty window is an error, not an empty background', async () => {
  await assert.rejects(run({ stones: [] }).promise, /returned no papers/);
});

test('a short embed is refused rather than silently misaligned', async () => {
  await assert.rejects(
    buildBackground({
      pack: PACK, config: CONFIG, now: NOW,
      fetchEarlier: async () => STONES,
      embed: async (texts) => texts.slice(0, texts.length - 1).map((t) => VECTORS[t]),
      coreFetch: async (ref) => ({ text: ref.id === '10.1/x' ? 'A seed' : ref.id }),
    }),
    /embed returned 6 vectors for 7 texts/,
  );
});

test('the object is exactly the shape score.mjs consumes: a threshold comes off it', async () => {
  const bg = await run().promise;
  const config = {
    shortlist: { sensitivity: 'normal' },
    sensitivity_presets: { normal: { background_pass: 1 } },
  };
  const { tau_ref, tau_seed } = resolveTaus(config, bg);
  // At a 100% pass budget the bar is the smallest pooled value, which is one of
  // the sample's own numbers — proof the medians/MADs and values line up. The
  // smallest max_sim is -1: axis B's single row against the anti-aligned stone.
  assert.equal(tau_seed, -1);
  assert.equal(tau_ref, Math.min(...[
    ...bg.axes.A.mean.values.map((v) => (v - bg.axes.A.mean.median) / (1.4826 * bg.axes.A.mean.mad)),
    ...bg.axes.B.mean.values.map((v) => (v - bg.axes.B.mean.median) / (1.4826 * bg.axes.B.mean.mad)),
  ]));
});
