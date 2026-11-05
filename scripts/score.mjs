/**
 * score — the arithmetic the ranking pipeline decides on, and nothing else.
 *
 * WHY THIS IS A FILE OF ITS OWN. `preset-feed.mjs` grades a day against a
 * preset and then compares each paper to that day's own median: it answers
 * "what is worth reading today". The pipeline needs the other question — "is
 * this paper relevant at all" — and that needs a bar measured against a fixed
 * background sample instead of against the day. Same estimator, different
 * reference, which is the point: `z_day` and `z_ref` stay on one scale, so a
 * threshold set on the background means the same thing on a quiet day and on a
 * rich one. The estimator is therefore the one the page and the feed already
 * use (see `robustStats`), not a textbook one.
 *
 * NO I/O, NO CLOCK, NO RANDOMNESS. Plain data in, plain data out, so every
 * decision below is pinned by fixtures in `score.test.mjs` and the driver is
 * left with nothing but plumbing.
 */

import { cosine } from './preset-feed.mjs';

/**
 * The row this stone matches most strongly, and which row it was.
 *
 * `grade()` answers "how much does this paper look like the whole axis"; this
 * answers "which single row does it look most like", which is what an item's
 * "closest to …" line needs. A row without a vector is skipped rather than
 * scored zero: a core sample that failed to resolve must not become the argmax
 * by default, and must not cap the maximum at zero either — so the running
 * maximum starts at the first row that did resolve, and may be negative.
 *
 * No row with a vector gives `{ max: 0, row: null }`, the same "nothing scored"
 * zero `grade()` returns. Ties keep the earlier row, so a caller can rely on
 * the row order it passed in.
 */
export function maxSim(stone, rows) {
  let max = 0;
  let row = null;
  for (const r of rows || []) {
    if (!r || !r.vector) continue;
    const c = cosine(stone, r.vector);
    if (!row || c > max) { max = c; row = r; }
  }
  return { max, row };
}

/**
 * Median and raw median absolute deviation — the same estimator, down to the
 * even-count convention, that `selectItems()` in preset-feed.mjs and the
 * browser's gate use: the element at `floor(n/2)`, not the mean of the two
 * middle ones. A z computed here is compared against a z computed there, so
 * disagreeing on even counts would put two scales under one threshold.
 *
 * An empty list has no spread to speak of: `{ median: 0, mad: 0 }`, which
 * `zRef` then turns into a flat 0 rather than a NaN.
 */
export function robustStats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (!n) return { median: 0, mad: 0 };
  const median = sorted[Math.floor(n / 2)];
  const devs = sorted.map((v) => Math.abs(v - median)).sort((a, b) => a - b);
  return { median, mad: devs[Math.floor(n / 2)] };
}

/**
 * How far above the reference a value sits, in MAD units.
 *
 * 1.4826 makes the MAD a consistent estimator of the standard deviation for
 * normal data, which is what makes the number comparable to a z the reader may
 * have seen elsewhere. A degenerate spread (mad 0, or no stats at all) has no
 * scale to divide by: 0, the same "no confidence claimed" answer the feed gives
 * on a no-spread day — never Infinity, which would rank one paper above all
 * others on the strength of an artefact. A value that is not a finite number
 * (an axis a paper was never scored on) is 0 for the same reason.
 */
export function zRef(value, stats = {}) {
  const { median = 0, mad = 0 } = stats || {};
  if (!(mad > 0) || !Number.isFinite(value)) return 0;
  return (value - median) / (1.4826 * mad);
}

/**
 * The lowest bar that keeps the pass rate at or under `rate`.
 *
 * A background sample is the only honest way to say what "1% of papers pass"
 * means, and it has to be said as a threshold: `rate = 0.01` over 100
 * background values puts the bar at the top value, so exactly one of them
 * clears it. The bar is the smallest such value, i.e. the tightest one that
 * still respects the budget, and it is always one of the values rather than a
 * number in between, so the answer is stable across runs.
 *
 * Ties count as passing, so a value repeated at the top drags the bar up with
 * it. When the whole top is tied, no value can hold the rate — the honest bar
 * is "just above the maximum" — and the sentinel for that is Infinity: nothing
 * passes, which is the safe direction, and the shortlist's floor still fills
 * the day. An empty sample is 0 for the same reason `grade()` returns 0.
 */
export function thresholdForPassRate(values, rate) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (!n) return 0;
  for (let i = 0; i < n; i++) {
    /* One candidate per distinct value: at `sorted[i]` every later element and
       every earlier equal one passes, so the count is exactly `n - i`. */
    if (i > 0 && sorted[i] === sorted[i - 1]) continue;
    if ((n - i) / n <= rate) return sorted[i];
  }
  return Infinity;
}

/**
 * The two shortlist thresholds: from the config's sensitivity word, or pinned
 * by hand.
 *
 * `tau_ref` is a z over the background's own per-axis `mean_sim`, so it means
 * the same thing on every axis whatever that axis' scale; `tau_seed` is a raw
 * `max_sim`, because a single very close seed is exactly the signal there and a
 * z would flatten it. The axes are pooled deliberately: one bar per day is what
 * the shortlist wants, and a bar per axis would make the pass rate depend on
 * how many axes the background happens to cover.
 *
 * An explicit `shortlist.tau_ref` / `tau_seed` wins per key — the escape hatch
 * for pinning one value while the background is still being measured.
 */
export function resolveTaus(config, background) {
  const shortlist = config?.shortlist || {};
  const pass = config?.sensitivity_presets?.[shortlist.sensitivity]?.background_pass;
  const axes = background?.axes || {};
  const zs = [];
  const maxes = [];
  for (const id of Object.keys(axes)) {
    const axis = axes[id] || {};
    for (const v of axis.mean?.values || []) zs.push(zRef(v, axis.mean));
    for (const v of axis.max?.values || []) maxes.push(v);
  }
  return {
    tau_ref: Number.isFinite(shortlist.tau_ref) ? shortlist.tau_ref : thresholdForPassRate(zs, pass),
    tau_seed: Number.isFinite(shortlist.tau_seed) ? shortlist.tau_seed : thresholdForPassRate(maxes, pass),
  };
}

/** id ascending — the one tie-break the whole pipeline agrees on. */
function byId(a, b) {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Which papers are worth an LLM read today.
 *
 * A paper passes if, on any axis that is switched on, it is either far above
 * that axis' background (`z_ref`) or very close to one single seed
 * (`max_sim`). Two routes because they fail in different directions: the mean
 * over an axis dilutes a paper that matches one seed exactly, and a seed match
 * says nothing about a paper that is broadly, moderately relevant. `z_ref` is
 * reported as the stronger claim when both hold.
 *
 * An axis absent from `axisWeights` counts as weight 1: the config lists every
 * axis, and only an explicit 0 switches one off, which is how an axis is
 * retired without deleting it.
 *
 * A quiet day still has to say something, so a list shorter than `min` is
 * filled from the best `z_day` and every fill is labelled `'z_day'` — the
 * reader can see the difference between "above the background" and "the best of
 * a quiet day". `max` is a ceiling on the LLM bill, never a target, so the
 * order is by the best axis' `z_ref` descending with id ascending as the
 * tie-break, and the fills land under the papers that earned their place.
 *
 * `best_axis` is the axis with the highest `z_ref` among the axes that are
 * switched on, and that is also the axis whose `z_day` decides the fill order.
 * `filled` is how many of the returned papers arrived through the floor.
 */
export function shortlist(papers, opts = {}) {
  const weights = opts.axisWeights || {};
  const max = Number.isFinite(opts.max) ? opts.max : papers.length;
  const min = Number.isFinite(opts.min) ? opts.min : 0;

  const scored = papers.map((paper) => {
    const entries = paper.axes || {};
    let best = null;
    let passed = null;
    for (const axis of Object.keys(entries).sort()) {
      const weight = Number.isFinite(weights[axis]) ? weights[axis] : 1;
      if (!(weight > 0)) continue;
      const e = entries[axis] || {};
      const z = Number.isFinite(e.z_ref) ? e.z_ref : -Infinity;
      const m = Number.isFinite(e.max_sim) ? e.max_sim : -Infinity;
      if (!best || z > best.z) {
        best = { axis, z, day: Number.isFinite(e.z_day) ? e.z_day : -Infinity };
      }
      if (passed !== 'z_ref' && z >= opts.tauRef) passed = 'z_ref';
      else if (!passed && m >= opts.tauSeed) passed = 'max_sim';
    }
    return {
      id: paper.id,
      passed_by: passed,
      best_axis: best ? best.axis : null,
      z: best ? best.z : -Infinity,
      day: best ? best.day : -Infinity,
    };
  });

  const byZRef = (a, b) => (a.z === b.z ? byId(a, b) : a.z > b.z ? -1 : 1);
  const chosen = scored.filter((p) => p.passed_by).sort(byZRef);
  let filled = 0;
  if (chosen.length < min) {
    const rest = scored.filter((p) => !p.passed_by)
      .sort((a, b) => (a.day === b.day ? byId(a, b) : a.day > b.day ? -1 : 1));
    for (const p of rest) {
      if (chosen.length >= min) break;
      chosen.push({ ...p, passed_by: 'z_day' });
      filled++;
    }
  }

  return {
    papers: chosen.sort(byZRef).slice(0, max)
      .map(({ id, passed_by, best_axis }) => ({ id, passed_by, best_axis })),
    filled,
  };
}
