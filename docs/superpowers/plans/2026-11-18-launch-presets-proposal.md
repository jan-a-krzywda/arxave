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

- llms: "Large language models: pretraining, instruction tuning and evaluation of transformer language models on benchmarks of knowledge and generation"
- spin-qubits: "Electron and hole spin qubits in silicon and germanium quantum dots: gate fidelity, exchange coupling and charge noise in semiconductor devices"
- reinforcement-learning: "Reinforcement learning for sequential decision making: policy optimization, value estimation and exploration in Markov decision processes"
- quantum-error-correction: "Quantum error correction with surface codes and qLDPC codes: decoders, logical error rates and fault-tolerance thresholds"
- llm-agents: "Autonomous language model agents that plan, call tools and act in software or web environments over long-horizon tasks"
- superconducting-qubits: "Superconducting transmon and fluxonium qubits in circuit QED: coherence, two-qubit gate fidelity and readout of multi-qubit processors"
- diffusion-models: "Diffusion and flow-matching generative models: score-based training, fast sampling and image or video synthesis"
- neutral-atoms: "Neutral-atom quantum processors in optical tweezer arrays: Rydberg blockade gates, atom rearrangement and analog quantum simulation"
- interpretability: "Mechanistic interpretability of neural networks: sparse autoencoders, circuits and features inside transformer language models"
- quantum-algorithms: "Quantum algorithms for Hamiltonian simulation and optimization: query complexity, variational circuits and provable speedups"
- ai-safety: "Alignment and safety of large language models: reward hacking, jailbreaks, red-teaming and scalable oversight of model behaviour"
- quantum-sensing: "Quantum sensing with NV centres and atomic magnetometers: sensitivity beyond the standard quantum limit using entangled probes"

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
