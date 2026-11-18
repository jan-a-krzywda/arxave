/**
 * cave-launch — the shared entry points: arxave.com/<field>/<slug>.
 *
 * A launch is a dig for one night, ranked by one written phrase, aimed at a
 * reader who was sent a link rather than one who came to browse. Everything it
 * needs is here as data, so the page stays pure: which pack, which categories,
 * the phrase, and (where the tree has the leaf) the topic to prefer. The 404
 * page and `cave.js` only turn a URL into one of these rows.
 *
 * ROWS ARE COPIED FROM THE PROPOSAL, NOT INVENTED. Phrases are written for
 * SPECTER2 (a title plus an abstract clause), so they are copied verbatim from
 * `docs/superpowers/plans/2026-11-18-launch-presets-proposal.md`; the test
 * reads that file and fails on a drift. The first category is load-bearing:
 * `cave-fields.mjs` picks tonight's pack from the first code a field claims.
 *
 * "Launch", never "preset": `filter.js` already owns "preset" for RSS feeds.
 */

/**
 * Where the one-shot autorun record `{ id, at }` lives. It is written before
 * the reload-safe run starts and cleared after the embed, so a reload on the
 * clean URL does not dig a second night.
 */
export const LAUNCH_KEY = 'arxave-cave-launch';

/**
 * How long that record counts as this visit. Two minutes is longer than a
 * dig-plus-embed and shorter than a reader wandering off and coming back; a
 * stale record must not swallow a deliberate reload an hour later.
 */
export const LAUNCH_FRESH_MS = 120000;

/** The 12 launches, in the proposal's ranked order. Frozen like `FIELDS`. */
export const LAUNCHES = Object.freeze([
  Object.freeze({
    id: 'ai/llms',
    field: 'ai',
    slug: 'llms',
    label: 'LLMs',
    categories: Object.freeze(['cs.AI', 'cs.CL']),
    phrase: 'Large language models: pretraining, instruction tuning, in-context learning, reasoning and efficient inference of transformer language models, evaluated on knowledge, coding and multilingual benchmarks',
    nudge: null,
  }),
  Object.freeze({
    id: 'quantum/spin-qubits',
    field: 'quantum',
    slug: 'spin-qubits',
    label: 'Spin qubits',
    categories: Object.freeze(['cond-mat.mes-hall', 'quant-ph']),
    phrase: 'Semiconductor spin qubits: electron and hole spins in silicon and germanium quantum dots and donor spins, with coherent control, exchange coupling, readout, spin-orbit effects and scaling of spin qubit arrays',
    nudge: null,
  }),
  Object.freeze({
    id: 'ai/reinforcement-learning',
    field: 'ai',
    slug: 'reinforcement-learning',
    label: 'Reinforcement learning',
    categories: Object.freeze(['cs.LG', 'cs.AI']),
    phrase: 'Reinforcement learning for sequential decision making: online and offline policy optimization, value-based and model-based methods, exploration and multi-agent learning in control, robotics and games',
    nudge: 'rl',
  }),
  Object.freeze({
    id: 'quantum/quantum-error-correction',
    field: 'quantum',
    slug: 'quantum-error-correction',
    label: 'Quantum error correction',
    categories: Object.freeze(['quant-ph']),
    phrase: 'Quantum error correction and fault tolerance: surface, colour, bosonic and low-density parity-check codes, decoding, magic state distillation, logical qubit experiments and error thresholds',
    nudge: 'qec',
  }),
  Object.freeze({
    id: 'ai/llm-agents',
    field: 'ai',
    slug: 'llm-agents',
    label: 'LLM agents',
    categories: Object.freeze(['cs.AI', 'cs.LG']),
    phrase: 'Language model agents: planning, tool use, memory and multi-agent collaboration of autonomous agents acting in software, web, embodied and scientific environments, measured on agent benchmarks',
    nudge: 'agents',
  }),
  Object.freeze({
    id: 'quantum/superconducting-qubits',
    field: 'quantum',
    slug: 'superconducting-qubits',
    label: 'Superconducting qubits',
    categories: Object.freeze(['quant-ph', 'cond-mat.mes-hall']),
    phrase: 'Superconducting qubits and circuit quantum electrodynamics: transmon, fluxonium and bosonic cavity qubits, Josephson junctions, materials and surface losses, superconducting resonators, microwave control and cryogenic packaging, gates, readout and scaling of multi-qubit processors',
    nudge: 'ft-roadmaps',
  }),
  Object.freeze({
    id: 'ai/diffusion-models',
    field: 'ai',
    slug: 'diffusion-models',
    label: 'Diffusion models',
    categories: Object.freeze(['cs.LG', 'cs.CV']),
    phrase: 'Diffusion and flow-based generative models: score matching, flow matching and consistency training, fast sampling, guidance and conditional generation of images, video, audio and molecules',
    nudge: 'generative',
  }),
  Object.freeze({
    id: 'quantum/neutral-atoms',
    field: 'quantum',
    slug: 'neutral-atoms',
    label: 'Neutral atoms',
    categories: Object.freeze(['quant-ph', 'physics.atom-ph']),
    phrase: 'Neutral-atom quantum platforms: optical tweezer and lattice arrays of atoms, Rydberg interactions and entangling gates, atom loading and rearrangement, mid-circuit readout and analog quantum simulation',
    nudge: 'cold-atoms',
  }),
  Object.freeze({
    id: 'ai/interpretability',
    field: 'ai',
    slug: 'interpretability',
    label: 'Interpretability',
    categories: Object.freeze(['cs.LG', 'cs.AI']),
    phrase: 'Interpretability of neural networks: mechanistic circuits, sparse autoencoder features, probing of internal representations, and attribution and explanation methods for language and vision models',
    nudge: 'interp',
  }),
  Object.freeze({
    id: 'quantum/quantum-algorithms',
    field: 'quantum',
    slug: 'quantum-algorithms',
    label: 'Quantum algorithms',
    categories: Object.freeze(['quant-ph']),
    phrase: 'Quantum algorithms and complexity: Hamiltonian simulation, quantum linear algebra and search, variational and optimization algorithms, quantum machine learning, resource estimation and provable quantum speedups over classical computation',
    nudge: 'opt-qalgo',
  }),
  Object.freeze({
    id: 'ai/ai-safety',
    field: 'ai',
    slug: 'ai-safety',
    label: 'AI safety',
    categories: Object.freeze(['cs.AI', 'cs.LG']),
    phrase: 'AI safety and alignment: reward hacking, deceptive and misaligned behaviour, jailbreaks and adversarial robustness, red-teaming, scalable oversight and dangerous capability evaluations of frontier models',
    nudge: 'safety',
  }),
  Object.freeze({
    id: 'quantum/quantum-sensing',
    field: 'quantum',
    slug: 'quantum-sensing',
    label: 'Quantum sensing',
    categories: Object.freeze(['quant-ph', 'cond-mat.mes-hall']),
    phrase: 'Quantum sensing and metrology: nitrogen-vacancy and other defect spins, atomic magnetometers and clocks, interferometric and optomechanical sensors, using entanglement and squeezing beyond the standard quantum limit',
    nudge: 'sensing',
  }),
]);

const BY_ID = new Map(LAUNCHES.map((launch) => [launch.id, launch]));

/** A launch by `<field>/<slug>`, or null. */
export function launchById(id) {
  return BY_ID.get(id) ?? null;
}

/** `/<field>/<slug>` with an optional trailing slash, and nothing else. */
export function launchFromPath(pathname) {
  const found = /^\/([a-z]+)\/([a-z0-9-]+)\/?$/.exec(String(pathname || ''));
  return found ? launchById(found[1] + '/' + found[2]) : null;
}

/** `?launch=<field>/<slug>`, the form `404.html` redirects to, or null. */
export function launchFromSearch(search) {
  try {
    return launchById(new URLSearchParams(search).get('launch'));
  } catch (_) {
    return null; /* a search string URLSearchParams will not read is no launch */
  }
}
