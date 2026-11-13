/**
 * cave-axes — C2: the two directions the Cave page's sliders project onto.
 *
 * WHAT THIS PRODUCES. `axes.json` (contract: `cave-v3-interfaces.md`) holds two
 * logistic-regression directions fitted on the corpus' own SPECTER2 vectors:
 *
 *   exp_theory  high p = theory, low p = experiment/hardware  (the slider's ends)
 *   ml4q        high p = "ML for quantum" (a chip, not a topic)
 *
 * Each direction ships as 768 floats that apply to a **centred unit** vector —
 * exactly what `loadCorpus` hands back — so the browser gets the score of a
 * candidate with one dot product and no extra service:
 *
 *     z = dot(w, x) + b        p = 1 / (1 + exp(-z))
 *
 * A direction that does not generalise is not shipped: `ship` is `heldout_acc
 * >= 0.80`, and the page hides the control when it is false. The number is
 * reported, not assumed — a direction fitted on 120 seeds that happens to
 * memorise them is worthless on tonight's papers, and that is the failure this
 * gate exists for.
 *
 * WHERE THE LABELS COME FROM. Hand labelling 240 papers is not the job; the
 * contract asks for ~60 seeds a side picked by title keyword rules, reviewable
 * by the maintainer. `pickSeeds` does that: an ordered table of title patterns
 * per class, each a well-known cue ("demonstrat", "theorem", "neural"), with a
 * weight so a title that carries several strong cues outranks one that carries
 * a single weak cue. A paper whose title matches both sides is dropped rather
 * than guessed — ambiguity in the seeds is error in the direction. The seeds
 * land in `scripts/cave-seeds/*.json`, one `{id, label, why}` each, so the
 * maintainer can read the list and argue with it.
 *
 * The files are the source of truth once written: the CLI reads them, and only
 * writes them when they are missing (or `--write-seeds` says so). Editing a
 * seed by hand must not be silently reverted by the next rebuild.
 *
 * THE FIT. L2-regularised logistic regression, plain full-batch gradient
 * descent on the mean log-loss, step `1 / L` with `L` the loss' Lipschitz
 * constant estimated by power iteration on `XᵀX/n`. No dependencies, no
 * `Math.random`, no warm start: same corpus and same seeds give byte-identical
 * floats, which is what makes `axes.json` a diffable data file rather than a
 * lottery ticket. The data is separable at this dimension (train hits 100%),
 * so `l2` is what keeps `w` finite and the run deterministic.
 *
 * PROBE/DELIBERATE COPY: `mulberry32` is reproduced from `corpus-build.mjs`
 * instead of imported. Importing that file drags `fast-xml-parser` and the
 * transformers optional dep into this module's graph, and this file must run
 * (`node --test`) in a checkout with no `node_modules`. The generator is
 * identical, so the same `--seed` picks the same shuffle here as there.
 *
 * Usage (from scripts/):
 *   node cave-axes.mjs [--corpus ../docs/assets/corpus] [--seeds ./cave-seeds]
 *                      [--out ../docs/assets/corpus/axes.json]
 *                      [--seed 1] [--l2 0.001] [--iters 4000] [--write-seeds]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadCorpus } from '../docs/assets/sieve-core.mjs';

/* Centred unit vectors, as `loadCorpus` builds them. */
export const DIM = 768;

/* Below this held-out accuracy the control is not shipped (contract). */
export const SHIP_ACC = 0.8;

/* Held-out fraction, and the seeded shuffle's default. `axes.json` carries no
   seed of its own (the contract fixes its shape), so cave-axes.test.mjs
   recomputes the split with these same defaults. */
export const TEST_FRAC = 0.2;
export const SPLIT_SEED = 1;

/* How many seeds a side takes: ~60/60 for the slider, ~40 vs ~80 for the chip. */
const EXP_TAKE = 60;
const THEO_TAKE = 60;
const ML4Q_TAKE = 40;
const ML4Q_NEG_TAKE = 80;

/* ── the seeded PRNG (see PROBE note above) ─────────────────────────────── */

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ── the title rules ────────────────────────────────────────────────────── */

/* Experimental / hardware. Weighted by how little else a title with this word
   can be: "we demonstrate" or "quantum processor" is hardware, "fidelity" is
   usually a gate benchmark but can be a bound on one, so it counts less. */
const EXP_RULES = [
  { id: 'demonstration', weight: 3, re: /\b(?:experimental\s+)?demonstrat\w*/i, gloss: 'the title announces a demonstration' },
  { id: 'processor', weight: 3, re: /\b(?:quantum (?:processor|computer|chip|simulator|hardware)|trapped-ion (?:quantum computer|processor)|superconducting (?:qubit|processor|circuit)s?)\b/i, gloss: 'a device is named' },
  { id: 'experiment', weight: 2.5, re: /\bexperiment(?:al|ally)?\b/i, gloss: 'the title says experiment' },
  { id: 'observation', weight: 2.5, re: /\b(?:observation|observed|observe)\b/i, gloss: 'something was observed' },
  { id: 'imaging', weight: 2.5, re: /\b(?:spectroscopy|microscopy|imaging|magnetometry|sensing|ellipsometry|neutron scattering)\b/i, gloss: 'a measurement technique is named' },
  { id: 'measurement', weight: 2, re: /\bwe measur\w*|\bmeasur(?:ed|ement of|ements of)\b/i, gloss: 'the title reports a measurement' },
  { id: 'device', weight: 2, re: /\b(?:device|devices|fabricat\w*|nanowire|heterostructure|thin[- ]films?|waveguide|on[- ]chip|dilution refrigerator|cryogenic|circuit QED|optical cavity|microcavity|FPGA)\b/i, gloss: 'hardware or a fabrication step is named' },
  { id: 'interferometry', weight: 2, re: /\b(?:optical|atom|matter[- ]wave|neutron|electron) interferomet\w*/i, gloss: 'a physical interferometer is named' },
  { id: 'metrology', weight: 2, re: /\b(?:metrolog\w*|atomic clocks?|optical clocks?|lattice clocks?)\b/i, gloss: 'metrology or a clock is named' },
  { id: 'fidelity', weight: 1.5, re: /\bfidelity\b/i, gloss: 'a gate/readout fidelity is reported' },
];

/* Theory. The same idea from the other side: a theorem, a bound, an analytic
   model, a scaling law. */
const THEORY_RULES = [
  { id: 'theorem', weight: 3, re: /\b(?:theorem|lemma|proof|prove[sd]?)\b/i, gloss: 'a theorem or proof is announced' },
  { id: 'bounds', weight: 3, re: /\b(?:lower bounds?|upper bounds?|bounds? on|no-go|impossibility)\b/i, gloss: 'a bound or a no-go statement is announced' },
  { id: 'holography', weight: 3, re: /\b(?:holograph\w*|\bAdS\b|\bCFT\b|conformal field theor\w*|black holes?|gravity|wormholes?|SYK)\b/i, gloss: 'gravity / holography vocabulary' },
  { id: 'renormalisation', weight: 2.5, re: /\b(?:effective field theor\w*|renormalis\w*|renormaliz\w*|mean[- ]field|exactly solvable|integrable|perturbative|asymptotic|thermodynamic limit|large-[Nn])\b/i, gloss: 'an analytic model is named' },
  { id: 'thermalisation', weight: 2.5, re: /\b(?:thermalis\w*|thermaliz\w*|equilibration|ergodicit\w*|many[- ]body localis\w*|quench\w*)\b/i, gloss: 'dynamics/thermalisation theory' },
  { id: 'information', weight: 2, re: /\b(?:entanglement entropy|entanglement spectrum|mutual information|correlation functions?|von Neumann entropy)\b/i, gloss: 'an information-theoretic quantity is computed' },
  { id: 'complexity', weight: 2, re: /\bcomplexity\b/i, gloss: 'complexity is the subject' },
  { id: 'algorithm', weight: 1.5, re: /\balgorithms?\b/i, gloss: 'an algorithm is the subject' },
  { id: 'scaling', weight: 1.5, re: /\b(?:universality|scaling (?:laws?|behaviour|behavior)|phase diagram|critical exponents?)\b/i, gloss: 'a scaling law or phase diagram is derived' },
  { id: 'formalism', weight: 1, re: /\b(?:formalism|framework|prescription|correspondence|conjecture)\b/i, gloss: 'a formalism or framework is proposed' },
];

/* ML for quantum: the vocabulary of a learned model. The quantum-problem gate
   below is separate, so "LLM agents for protein design" stays out. */
const ML_RULES = [
  { id: 'neural', weight: 3, re: /\bneural\b/i, gloss: 'a neural model is used' },
  { id: 'machine-learning', weight: 3, re: /\bmachine learning\b/i, gloss: 'the title says machine learning' },
  { id: 'reinforcement-learning', weight: 3, re: /\breinforcement learning\b/i, gloss: 'a learned controller' },
  { id: 'transformer', weight: 3, re: /\btransformers?\b|attention[- ]based/i, gloss: 'a transformer/attention model' },
  { id: 'llm', weight: 3, re: /\blarge language models?\b|\bLLMs?\b|LLM[- ]/i, gloss: 'a language model is used' },
  { id: 'graph-neural', weight: 3, re: /\bgraph neural\b/i, gloss: 'a graph neural network' },
  { id: 'diffusion-model', weight: 3, re: /\bdiffusion model\b/i, gloss: 'a diffusion model' },
  { id: 'generative', weight: 2.5, re: /\bgenerative (?:model\w*|network\w*|adversarial)\b/i, gloss: 'a generative model' },
  { id: 'deep-learning', weight: 2.5, re: /\bdeep learning\b/i, gloss: 'deep learning' },
  { id: 'classical-ml', weight: 2, re: /\b(?:support vector|random forest|gradient boosting|autoencoder|self-supervised|variational autoencoder|GAN)\b/i, gloss: 'a classical ML method' },
  { id: 'ai', weight: 1.5, re: /\bAI\b|\bA\.I\./i, gloss: 'AI is named' },
  { id: 'learning', weight: 1, re: /\blearning\b/i, gloss: 'something is learned' },
];

/* The ml4q gate: a quantum problem, not just any problem. */
const QUANTUM = /quantum|qubit|entangl|hamiltonian|many[- ]body|superconduct|spin[- ]?\w*|photon|variational|circuit|\bcode\b|tomograph|decoheren|anneal|\bgate\b/i;

/* ── the axes ───────────────────────────────────────────────────────────── */

/* Which label is the 1. High p = theory for the slider (contract); high p =
   tagged for the chip. `file` is the seed file under scripts/cave-seeds. */
export const SEED_AXES = {
  exp_theory: {
    file: 'exp-theory.json',
    positive: 'theory',
    negative: 'experiment',
  },
  ml4q: {
    file: 'ml4q.json',
    positive: 'ml4q',
    negative: 'other',
  },
};

/** The highest-weighted rule a title matches, or null. */
function bestRule(rules, title) {
  let best = null;
  for (const rule of rules) {
    if (!rule.re.test(title)) continue;
    if (!best || rule.weight > best.weight) best = rule;
  }
  return best;
}

function total(rules, title) {
  let sum = 0;
  for (const rule of rules) if (rule.re.test(title)) sum += rule.weight;
  return sum;
}

/** Candidates for one class: own rules matched, the other side's not, best first. */
function rank(rows, rules, against) {
  const out = [];
  rows.forEach((row, i) => {
    const mine = bestRule(rules, row.title);
    if (!mine) return;
    if (against && bestRule(against, row.title)) return; // ambiguous: drop, do not guess
    out.push({ ...row, score: total(rules, row.title), rule: mine, order: i });
  });
  return out.sort((a, b) => (b.score - a.score) || (a.order - b.order));
}

const seedOf = (label) => (row) => ({
  id: row.id,
  label,
  why: `${row.rule.gloss} (title matches /${row.rule.re.source}/i)`,
});

/**
 * The seed list for one axis, from the corpus' titles.
 *
 * `corpus` only needs `ids` and `titles`, so a bare corpus.json object works as
 * well as a loaded corpus. Every returned id is a corpus id by construction.
 * The list is class by class, best rule score first, so a reviewer reads the
 * cleanest examples at the top of each block.
 */
export function pickSeeds(axis, corpus) {
  const rows = corpus.ids.map((id, i) => ({ id, title: corpus.titles?.[i] ?? '' }));
  const { negative, positive } = SEED_AXES[axis] ?? {};
  if (!negative) throw new Error(`cave-axes: no seed rules for axis "${axis}"`);

  if (axis === 'exp_theory') {
    const experiment = rank(rows, EXP_RULES, THEORY_RULES).slice(0, EXP_TAKE).map(seedOf(negative));
    const theory = rank(rows, THEORY_RULES, EXP_RULES).slice(0, THEO_TAKE).map(seedOf(positive));
    return [...experiment, ...theory];
  }

  const quantum = rows.filter((r) => QUANTUM.test(r.title));
  const ml = rank(quantum, ML_RULES, null).slice(0, ML4Q_TAKE).map(seedOf(positive));

  /* The not-ML side is spread over the whole corpus rather than the first 80
     quantum titles: corpus order starts with the citation-heavy top sample,
     and a contiguous slice would teach "proven work" as "not ML". */
  const pool = quantum.filter((r) => !bestRule(ML_RULES, r.title));
  const stride = Math.max(1, Math.floor(pool.length / ML4Q_NEG_TAKE));
  const other = pool.filter((_, k) => k % stride === 0).slice(0, ML4Q_NEG_TAKE)
    .map((row) => ({
      id: row.id,
      label: negative,
      why: 'no ML keyword in the title — a quantum paper without machine learning',
    }));

  return [...ml, ...other];
}

/* ── the numbers ────────────────────────────────────────────────────────── */

/** Five decimals, the shipped precision of `w` and `b`. */
export function round5(v) {
  return Math.round(v * 1e5) / 1e5;
}

/**
 * L2-regularised logistic regression by full-batch gradient descent.
 *
 *   loss(w, b) = (1/n) Σ log(1 + exp(−y_i (w·x_i + b))) + (l2/2)‖w‖²
 *
 * with `y ∈ {0,1}` — `1` is the class the axis calls positive. `X` is any
 * array-like of equal-length rows (a Float32Array row straight out of the
 * corpus is fine); `w` comes back as Float64Array.
 *
 * The step is `1/L`, `L = 0.25·λmax(XᵀX/n) + l2`, with `λmax` estimated by
 * power iteration: 0.25 is the largest curvature of the logistic loss, so `1/L`
 * cannot overshoot and no line search is needed. With `l2 = 0` (only reachable
 * through the options) separable data would let `w` diverge, which is why every
 * shipped axis passes a positive one.
 *
 * `iters` is a cap, not a promise: the loop stops early when the gradient is
 * numerically zero, so an easy fixture costs a few dozen steps.
 */
export function fitLogistic(X, y, { l2 = 1e-3, iters = 4000 } = {}) {
  const n = X?.length ?? 0;
  if (!n) throw new Error('cave-axes: fitLogistic got no rows');
  if (!y || y.length !== n) throw new Error(`cave-axes: fitLogistic got ${n} rows and ${y?.length} labels`);
  const d = X[0].length;
  if (!(d > 0)) throw new Error('cave-axes: fitLogistic got an empty row');
  for (let i = 0; i < n; i++) {
    if (X[i].length !== d) throw new Error(`cave-axes: fitLogistic row ${i} has ${X[i].length} dims, expected ${d}`);
    if (y[i] !== 0 && y[i] !== 1) throw new Error(`cave-axes: fitLogistic label ${i} is ${y[i]}, expected 0 or 1`);
  }
  if (!(l2 >= 0)) throw new Error(`cave-axes: fitLogistic l2 is ${l2}`);

  /* λmax(XᵀX/n) by power iteration. The vector is the whole state, so 30
     passes converge for any spectrum with a clear top eigenvalue; the estimate
     only sets the step. */
  const v = new Float64Array(d).fill(1 / Math.sqrt(d));
  const u = new Float64Array(d);
  for (let k = 0; k < 30; k++) {
    u.fill(0);
    for (let i = 0; i < n; i++) {
      const x = X[i];
      let s = 0;
      for (let j = 0; j < d; j++) s += x[j] * v[j];
      s /= n;
      for (let j = 0; j < d; j++) u[j] += x[j] * s;
    }
    let norm = 0;
    for (let j = 0; j < d; j++) norm += u[j] * u[j];
    norm = Math.sqrt(norm);
    if (!(norm > 0)) break;
    for (let j = 0; j < d; j++) v[j] = u[j] / norm;
  }
  let lmax = 0;
  for (let i = 0; i < n; i++) {
    const x = X[i];
    let s = 0;
    for (let j = 0; j < d; j++) s += x[j] * v[j];
    lmax += (s * s) / n;
  }
  const step = 1 / (0.25 * lmax + l2);

  const w = new Float64Array(d);
  let b = 0;
  const gw = new Float64Array(d);
  for (let it = 0; it < iters; it++) {
    gw.fill(0);
    let gb = 0;
    for (let i = 0; i < n; i++) {
      const x = X[i];
      let z = b;
      for (let j = 0; j < d; j++) z += w[j] * x[j];
      const e = 1 / (1 + Math.exp(-z)) - y[i]; // d loss / d z, before the 1/n
      for (let j = 0; j < d; j++) gw[j] += (e * x[j]) / n;
      gb += e / n;
    }
    let sq = gb * gb;
    for (let j = 0; j < d; j++) {
      const g = gw[j] + l2 * w[j];
      sq += g * g;
      w[j] -= step * g;
    }
    b -= step * gb;
    if (sq < 1e-24) break;
  }
  return { w, b };
}

/** `p = 1/(1+exp(−z))`, `z = w·x + b` — the contract's scoring of a centred unit vector. */
export function predict(w, b, x) {
  let z = b;
  for (let j = 0; j < w.length; j++) z += w[j] * x[j];
  return 1 / (1 + Math.exp(-z));
}

/**
 * Fraction of `X` classified correctly. A score of exactly 0.5 counts as
 * positive: the boundary has to fall somewhere, and the sign of `z` deciding it
 * is the arithmetic the page does too.
 */
export function accuracy(w, b, X, y) {
  if (!X.length) throw new Error('cave-axes: accuracy got no rows');
  if (y.length !== X.length) throw new Error(`cave-axes: accuracy got ${X.length} rows and ${y.length} labels`);
  let hit = 0;
  for (let i = 0; i < X.length; i++) if ((predict(w, b, X[i]) >= 0.5) === (y[i] === 1)) hit += 1;
  return hit / X.length;
}

/**
 * Stratified 80/20 split with a seeded shuffle: each class gives
 * `round(classSize × testFrac)` of its members to the test half, so a 60/60
 * seed list never produces a one-class test set.
 *
 * Fisher–Yates with `mulberry32`, over indices built in ascending order and
 * shuffled in place — the whole point is that the same `y` and `seed` give the
 * same two lists on every machine, which is what lets the test recompute
 * `heldout_acc` from the shipped `w`, `b` alone.
 */
export function stratifiedSplit(y, { seed = SPLIT_SEED, testFrac = TEST_FRAC } = {}) {
  if (!(testFrac > 0 && testFrac < 1)) throw new Error(`cave-axes: testFrac is ${testFrac}`);
  const byClass = [[], []];
  y.forEach((v, i) => {
    if (v !== 0 && v !== 1) throw new Error(`cave-axes: split label ${i} is ${v}, expected 0 or 1`);
    byClass[v].push(i);
  });
  const next = mulberry32(seed);
  const train = [];
  const test = [];
  for (const cls of byClass) {
    for (let i = cls.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      [cls[i], cls[j]] = [cls[j], cls[i]];
    }
    const k = Math.round(cls.length * testFrac);
    test.push(...cls.slice(0, k));
    train.push(...cls.slice(k));
  }
  return { train, test };
}

/**
 * One axis, end to end: seeds → split → fit → the contract's object.
 *
 * `heldout_acc` is measured with the ROUNDED `w` and `b` that ship, not with
 * the full-precision ones nobody downstream can see. That is what makes the
 * reported number reproducible from `axes.json` and `corpus.json` alone.
 */
export function fitAxis(axis, seeds, corpus, { seed = SPLIT_SEED, l2 = 1e-3, iters = 4000 } = {}) {
  const { positive, negative } = SEED_AXES[axis] ?? {};
  if (!positive) throw new Error(`cave-axes: no such axis "${axis}"`);

  const index = new Map();
  corpus.ids.forEach((id, i) => index.set(id, i));
  const rows = seeds.map((s) => {
    const i = index.get(s.id);
    if (i === undefined) throw new Error(`cave-axes: seed ${s.id} is not in the corpus`);
    if (s.label !== positive && s.label !== negative) {
      throw new Error(`cave-axes: seed ${s.id} has label "${s.label}", expected "${positive}" or "${negative}"`);
    }
    return i;
  });
  const y = seeds.map((s) => (s.label === positive ? 1 : 0));
  if (!y.includes(0) || !y.includes(1)) throw new Error(`cave-axes: axis "${axis}" seeds hold one class only`);

  const vec = (k) => corpus.vecs.subarray(rows[k] * corpus.dim, (rows[k] + 1) * corpus.dim);
  const { train, test } = stratifiedSplit(y, { seed, testFrac: TEST_FRAC });
  const { w, b } = fitLogistic(train.map(vec), train.map((k) => y[k]), { l2, iters });

  const wr = Array.from(w, round5);
  const br = round5(b);
  const heldout = accuracy(wr, br, test.map(vec), test.map((k) => y[k]));
  return {
    w: wr,
    b: br,
    heldout_acc: heldout,
    n_train: train.length,
    n_test: test.length,
    ship: heldout >= SHIP_ACC,
  };
}

/* ── the files ──────────────────────────────────────────────────────────── */

/**
 * The seed file for one axis: read it if it is there (the maintainer's edits
 * are authoritative), write the rules' version if it is not, or when
 * `rewrite` is set. `dir` is `scripts/cave-seeds`.
 */
export function loadSeeds(dir, axis, corpus, { rewrite = false } = {}) {
  const file = path.join(dir, SEED_AXES[axis].file);
  if (!rewrite && existsSync(file)) {
    const seeds = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(seeds)) throw new Error(`cave-axes: ${file} is not an array of seeds`);
    return seeds;
  }
  const seeds = pickSeeds(axis, corpus);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(seeds, null, 1) + '\n');
  return seeds;
}

/** Both axes → the object the contract describes. */
export function buildAxes({ corpus, seedDir, seed = SPLIT_SEED, l2 = 1e-3, iters = 4000, rewriteSeeds = false }) {
  const axes = {};
  for (const axis of Object.keys(SEED_AXES)) {
    const seeds = loadSeeds(seedDir, axis, corpus, { rewrite: rewriteSeeds });
    axes[axis] = fitAxis(axis, seeds, corpus, { seed, l2, iters });
  }
  return { version: 1, dim: corpus.dim, ...axes };
}

function arg(name, fallback = null) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function main() {
  const corpusDir = arg('corpus', '../docs/assets/corpus');
  const seedDir = arg('seeds', './cave-seeds');
  const out = arg('out', path.join(corpusDir, 'axes.json'));
  const corpus = loadCorpus(
    JSON.parse(readFileSync(path.join(corpusDir, 'corpus.json'), 'utf8')),
    readFileSync(path.join(corpusDir, 'corpus.vec.bin')),
  );

  const json = buildAxes({
    corpus,
    seedDir,
    seed: Number(arg('seed', SPLIT_SEED)),
    l2: Number(arg('l2', 1e-3)),
    iters: Number(arg('iters', 4000)),
    rewriteSeeds: process.argv.includes('--write-seeds'),
  });

  for (const axis of Object.keys(SEED_AXES)) {
    const a = json[axis];
    console.log(
      `cave-axes: ${axis} — ${a.n_train + a.n_test} seeds (${a.n_train} train / ${a.n_test} test), ` +
      `held-out ${(a.heldout_acc * 100).toFixed(1)}%, ship=${a.ship}`,
    );
  }
  writeFileSync(out, JSON.stringify(json) + '\n');
  console.log(`cave-axes: written to ${out}`);
}

// Importable for tests; only the CLI invocation writes the files.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (err) {
    console.error('cave-axes: ' + (err?.stack ?? err));
    process.exit(1);
  }
}

