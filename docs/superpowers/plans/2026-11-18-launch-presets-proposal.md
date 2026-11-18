# Launch presets: proposal (Opus research, 2026-11-18)

Source: read-only Opus pass over `cave-fields.mjs`, both `topics.json` files, `cave-stage-dig.mjs` and the 5,000-paper corpora. Volumes are title-keyword counts from the Sept–Dec 2025 corpora, a sample, not live listings. Treat the phrases as drafts: check each phrase's top ten on a recent night before shipping.

## Rules the code imposes

- A field is chosen by the first category a field claims: quantum = `cond-mat.mes-hall`, `quant-ph`; ai = `cs.AI`, `cs.LG`. Every launch must start with one of its field's two codes.
- Cached, fast categories: `quant-ph`, `cs.AI`, `cs.LG`, `cond-mat.mes-hall`, `cond-mat.str-el`. Any other code costs about a minute of local embedding on first load (marked ⚠).
- The phrase box is one vector, clipped and centred on the field's corpus mean (`corpusSpace`). A topic nudge is written `topics=<id>:prefer`.

## Ranked launches

| # | slug | field | categories | nudge (leaf) | why |
|---|---|---|---|---|---|
| 1 | `llms` | ai | `cs.AI, cs.CL` ⚠ | none (parent `language` optional) | 22% of AI titles mention LLMs |
| 2 | `spin-qubits` | quantum | `cond-mat.mes-hall, quant-ph` | none (no hardware leaf) | requested |
| 3 | `reinforcement-learning` | ai | `cs.LG, cs.AI` | `rl` | requested; clean leaf |
| 4 | `quantum-error-correction` | quantum | `quant-ph` | `qec` | clean leaf fit |
| 5 | `llm-agents` | ai | `cs.AI, cs.LG` | `agents` | 596 titles |
| 6 | `superconducting-qubits` | quantum | `quant-ph, cond-mat.mes-hall` | `ft-roadmaps` (weak fit) | leading platform |
| 7 | `diffusion-models` | ai | `cs.LG, cs.CV` ⚠ | `generative` | 227 titles |
| 8 | `neutral-atoms` | quantum | `quant-ph, physics.atom-ph` ⚠ | `cold-atoms` | fast-growing |
| 9 | `interpretability` | ai | `cs.LG, cs.AI` | `interp` | strong pull, low volume |
| 10 | `quantum-algorithms` | quantum | `quant-ph` | `opt-qalgo` | theory audience |
| 11 | `ai-safety` | ai | `cs.AI, cs.LG` | `safety` | distinct demand |
| 12 | `quantum-sensing` | quantum | `quant-ph, cond-mat.mes-hall` | `sensing` | NV-centre papers in mes-hall |

Next in line: `moire-materials` (`cond-mat.mes-hall, cond-mat.str-el`, `materials`), `reasoning-llms`, `quantum-networks`, `topological-qubits`.

## Embed phrases

- llms: "Large language models: pretraining, instruction tuning, in-context learning, reasoning and efficient inference of transformer language models, evaluated on knowledge, coding and multilingual benchmarks"
- spin-qubits: "Spin qubits in semiconductors and defects: electron and hole spins in silicon and germanium quantum dots, donor spins, and nitrogen-vacancy and other colour-centre spins, with coherent control, readout and coupling"
- reinforcement-learning: "Reinforcement learning for sequential decision making: online and offline policy optimization, value-based and model-based methods, exploration and multi-agent learning in control, robotics and games"
- quantum-error-correction: "Quantum error correction and fault tolerance: surface, colour, bosonic and low-density parity-check codes, decoding, magic state distillation, logical qubit experiments and error thresholds"
- llm-agents: "Language model agents: planning, tool use, memory and multi-agent collaboration of autonomous agents acting in software, web, embodied and scientific environments, measured on agent benchmarks"
- superconducting-qubits: "Superconducting qubits and circuit quantum electrodynamics: transmon, fluxonium and bosonic cavity qubits, Josephson junction devices, coherence and materials losses, gates, readout and scaling of multi-qubit processors"
- diffusion-models: "Diffusion and flow-based generative models: score matching, flow matching and consistency training, fast sampling, guidance and conditional generation of images, video, audio and molecules"
- neutral-atoms: "Neutral-atom quantum platforms: optical tweezer and lattice arrays of atoms, Rydberg interactions and entangling gates, atom loading and rearrangement, mid-circuit readout and analog quantum simulation"
- interpretability: "Interpretability of neural networks: mechanistic circuits, sparse autoencoder features, probing of internal representations, and attribution and explanation methods for language and vision models"
- quantum-algorithms: "Quantum algorithms and complexity: Hamiltonian simulation, quantum linear algebra and search, variational and optimization algorithms, resource estimation and provable quantum speedups over classical computation"
- ai-safety: "AI safety and alignment: reward hacking, deceptive and misaligned behaviour, jailbreaks and adversarial robustness, red-teaming, scalable oversight and dangerous capability evaluations of frontier models"
- quantum-sensing: "Quantum sensing and metrology: nitrogen-vacancy and other defect spins, atomic magnetometers and clocks, interferometric and optomechanical sensors, using entanglement and squeezing beyond the standard quantum limit"

Breadth check (verify against real top tens):
- Too broad: `llms` still spans most of cs.AI/cs.CL and will pull agents, safety and reasoning papers; `quantum-algorithms` covers most quant-ph theory and may admit generic quantum information papers; `interpretability` now includes attribution/explanation methods, which can drag in general explainable-AI and vision work.
- Overlap: `spin-qubits` and `quantum-sensing` both name nitrogen-vacancy and defect spins, so NV papers may top both; `reinforcement-learning` may surface RL fine-tuning of language models that also belong to `llms`.
- Too narrow: `neutral-atoms` stays tweezer/Rydberg-centred and may under-rank optical-lattice many-body physics; `superconducting-qubits` may miss pure materials or microwave-engineering papers that never say "qubit".

## Writing phrases for SPECTER2

- Write like a title plus abstract clause; use subfield vocabulary (methods, materials, measured quantities).
- Centring removes what the whole field shares: generic words add little, distinctive nouns carry the signal.
- One phrase, one subject. A list of sub-topics lands between them.
- No acronym lists ("RL, PPO, DQN"), no negation ("not X" embeds near X). Exclude through the tree (`avoid`/`off`) or "less like this".
- Main risk: `llms` is generic and spread over `safety`, `agents`, `reasoning`; expect a broad ranking.

## Open points

- `cs.CL` / `cs.CV` first load costs about a minute. Either add them to the warm run or fall back to `cs.AI, cs.LG`.
- Combined `cs.AI` + `cs.CL` could approach the 1,000-abstract cap on a busy weekday (unchecked).
- Phrase vectors are fixed per launch and could ship precomputed, skipping an embed call per visit. Not in this plan.
- Quantum tree has no hardware leaf, so `spin-qubits` has no nudge.
