# Arxave

A daily arXiv scout. Each morning it reads the overnight firehose, selects the
few papers that matter, and briefs you — arguing why each one is worth your
attention. Everything it evaluates is remembered in `papers.db`, so nothing is
lost even when it doesn't make the brief.

Status: **M1**. See `arxave-spec.md` for the full design and the M2–M4 roadmap.

## Setup

```bash
uv venv --python 3.11
uv pip install -e ".[dev]"

cp .env.example .env          # then add your ANTHROPIC_API_KEY
$EDITOR config/arxave.yaml     # then replace the example topics — see below
```

Two things must be done before the first useful run:

1. **Set your topics.** `config/arxave.yaml` ships with placeholder examples.
   The filter stage gates every paper against this list, so it is the single
   biggest lever on what the brief pitches. Be specific — "quantum computing"
   lets everything through.
2. **Snapshot the corpus** (optional, enables connection lines):
   ```bash
   arxave sync-corpus
   ```

## Use

```bash
arxave run                        # full pipeline -> briefs/<today>.md
arxave run --stage scout --dry-run # see what would be fetched, write nothing
arxave run --stage summarize      # run one stage while iterating on prompts
arxave render                     # re-render today's brief, no LLM calls
```

Every stage is idempotent and resumable via the `status` column, so an
interrupted run resumes cleanly and re-running a stage enriches rows rather
than duplicating them.

## Design notes

**Relationship to the paper library.** Arxave has no runtime dependency on the
spin-qubit library repo. The OpenAlex client is arxave's own code
(`openalex.py`), and the corpus is a **snapshot** copied in by `sync-corpus`
and read from `.local/corpus/`. The library stays a library. The cost is
drift: `.local/corpus/meta.json` records the source and sync time, and runs
warn once the snapshot passes `corpus.stale_after_days`.

**Two LLM roles.** `light` does per-paper work (summarize, filter) and runs
once per scouted paper, so it dominates cost. `heavy` writes the brief and
runs only for the top N. Each is configured independently — provider, model,
base URL, key env var — so they can point at different providers.

**The scout window counts publishing days, not calendar days.** arXiv does not
announce on weekends, so a calendar-day lookback returns nothing every Monday.

## Known limitation: connection lines are usually empty

The `connect` stage resolves each paper's arXiv DOI through OpenAlex and
intersects its references with the corpus. That is what makes the brief's
"Connection" line specific rather than generic.

**On the daily firehose it almost never fires**, for two reasons — the second
measured against the live API on 2026-07-20 and worse than the spec assumed:

1. **Indexing lag.** Of 61 papers scouted that morning, a sample of 12
   resolved in OpenAlex **0 times**. Same-day preprints simply aren't there.
2. **Preprint records carry no reference list.** Even when the arXiv DOI
   resolves, the record is usually a stub — the references live on the
   separate record for the *published* version, under a different DOI.
   Measured: arXiv:2112.08863 ("Semiconductor Spin Qubits") resolves to
   `W4320341678` with **0** references, while the Rev. Mod. Phys. record for
   the same paper, `W4380590907`, has **664**.

So the citation route works for older papers and for re-runs after a preprint
is published, not for today's papers. Getting real day-one connections needs a
**semantic** route — embeddings over abstracts against the corpus — which is
the spec's M3 work. This stage is the evidence for why that matters.

The brief is written to read correctly when no connection is available: it
asks the model to say which of your topics the paper bears on instead, and
explicitly forbids claiming the paper is disconnected from your library
(absence of a reference list is an artifact of the index, not a fact about
the paper).

## Not yet built

`scirate.py` is a stub returning `None` — ranking renormalizes over the
signals actually present, so a missing scite count redistributes weight rather
than scoring the paper as "nobody cared". Real scites, embeddings, corpus
ingest, and scheduled runs are M2–M4.

## Tests

```bash
uv run pytest
```

No network, no API keys, no fixtures outside `tmp_path`.
