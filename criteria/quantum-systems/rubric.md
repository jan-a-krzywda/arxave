# Rubric: quantum-systems

Context: a team will operate, benchmark, integrate and offer to users a semiconductor spin-qubit quantum computer
(at least 16 qubits, upgradable) that is co-located with and integrated into an HPC system. Papers are scored for
how much they help that team. Platform-agnostic work counts when it transfers to spin qubits or to the operating,
benchmarking, calibration, software or HPC-integration problems of such a machine.

## relevance (1-5, absolute, not relative to today's other papers)

- 5: changes how the machine is operated, calibrated, benchmarked or integrated, or reports a result directly on the
  headline figures of merit for spin qubits (fidelity, readout, coherence, gate speed, scale).
- 4: strong, directly usable method or measurement for spin qubits, or for calibration, benchmarking, compilation,
  scheduling or HPC integration of a small noisy QPU.
- 3: useful background or adjacent platform result worth skimming; transferable idea with some adaptation.
- 2: same field, little bearing on this machine.
- 1: unrelated, or only shares vocabulary.

## novelty (1-5, against the paper's own statement of the prior best)

- 5: new capability or record number.
- 4: clear step beyond the previous best.
- 3: solid, expected progress.
- 2: incremental, same group and device as before.
- 1: restates known results.

## kind

One of: device, benchmark, algorithm, integration, review.

## Rules

- Judge from the supplied text only; do not credit claims the text does not make.
- `refs` may contain only ids present in the supplied requirements list. Use an empty list when none apply.
- `why` is one sentence naming the concrete reason, not a restatement of the abstract.
