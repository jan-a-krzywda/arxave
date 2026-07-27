# Arxave — Specification

> A daily arXiv scout for the SpinLib corpus. Each morning it reads the
> overnight firehose, selects the few papers that matter, and **briefs you** —
> arguing why each one is worth your attention and how it connects to what you
> already know. Everything it evaluates is remembered in the citation graph, so
> nothing is lost even when it doesn't make the brief.

*Status: draft v0.2. Target environment: local dev in VS Code, Python 3.11+.*

---

## 1. Mental model

**The scout is a research analyst who reads the overnight arXiv firehose and
comes back to brief you — with a point of view.** Not a feed, not an archive,
not a list. A briefing that selects the few papers that matter, argues why, and
tells you what to do about them. Most of the value is in what it leaves out.

Three properties make it a *brief*, not a *digest*:

1. **It selects and ranks.** Most papers don't make the cut. The ranking engine
   triangulates three signals (§4) rather than trusting any one.
2. **It contextualizes against your library.** The pitch gets specific because
   it's grounded in SpinLib's graph: *"cites six papers in your library and
   contradicts the decoherence bound in Petta2005."* No generic tool can say
   this — it's the moat.
3. **It argues — leads with stakes, not the abstract.** Each paper is presented
   as claim → why it matters → how it connects → verdict, so you can act
   without opening a PDF.

**Two outputs, one pipeline.** The **brief** is the human-facing *view* — daily,
presentation-like, disposable. The **graph + `papers.db`** is the *memory* —
everything the scout evaluates lands there, even what the brief omits. The brief
is what you read; the accumulation is what you keep. This is the answer to
"we're losing knowledge every day": nothing evaluated is ever lost.

---

## 2. Goal

SpinLib is a curated corpus (`library.bib`, ~1650 spin-qubit papers) plus a
pipeline that resolves each entry to OpenAlex and renders a clustered citation
graph. Today it's static — the corpus only grows when a human adds a `.bib`
entry.

**Arxave** is the daily scout that makes it grow itself and reports back. Each run:

1. **Scout** — pull recent arXiv papers for the user's topics.
2. **Summarize** — LLM writes a structured 1-paragraph summary (topic, research
   question, main contribution).
3. **Filter** — LLM relevance-gates each paper against the topics.
4. **Rank** — score survivors by triangulating Scirate scites, in-corpus
   citation centrality, and LLM judgment (§4).
5. **Link** — resolve to OpenAlex and append to the corpus, so the graph builder
   auto-connects new papers to older ones via shared references.
6. **Brief** — generate the daily briefing that pitches the top papers (§5).

Design principle: **reuse SpinLib's structural machinery; add only the scouting,
LLM, ranking, and briefing layers.**

---

## 3. Why this fits SpinLib cleanly

`build_graph.py::build_digraph()` induces an edge `A -> B` whenever `A`'s
`referenced_works` (OpenAlex IDs) contains a `B` already in the corpus:

```python
id_to_key = {rec['openalex_id']: key for key, rec in works.items()}
for key, rec in works.items():
    for ref in rec.get('referenced_works', []):
        tgt = id_to_key.get(ref)
        if tgt is not None and tgt != key:
            g.add_edge(key, tgt)   # key cites tgt
```

**Consequence:** a new arXiv paper that cites existing SpinLib papers wires
itself into the graph the moment its OpenAlex record is appended. Arxave never
builds edges by hand — it only adds nodes with correct `referenced_works`. The
connections fall out. This same reference overlap is also what powers the
"how it connects" line in the brief and the citation-centrality ranking signal.

arXiv papers now receive a DataCite DOI of the form `10.48550/arXiv.<id>`, which
OpenAlex indexes, so `oa_fetch.py::resolve_by_doi()` resolves preprints with no
change — Arxave just feeds it the arXiv DOIs.

---

## 4. The ranking engine (the editor)

No single relevance signal is trustworthy; the editorial value comes from
triangulating three:

| Signal | Source | What it captures | Access |
|---|---|---|---|
| **Scites** | Scirate | Crowd attention, quant-ph-specific | unofficial — scrape via `vprusso/scirate` wrapper or Scirate's daily quant-ph page; treat as best-effort, degrade gracefully if unavailable |
| **Citation centrality** | SpinLib graph | Does it land in a dense part of *your* library? (shared references with, and citations into, the corpus) | computed locally from `works.json` |
| **LLM judgment** | `filter.py` | Novelty + relevance to the user's topics | already produced in stage 3 |

The final `importance` score is a weighted blend (weights configurable, tuned by
hand at first). Scites and centrality are both cheap and objective; the LLM
score is the tie-breaker and the source of the "why it matters" argument.

A later section of the brief — *"sciting but unseen"* — can surface papers the
community is sciting heavily that your topic filters missed, as a discovery
safety net.

---

## 5. The daily brief (primary surface)

The brief is the product. Format: a **daily standup from your scout** — a page
(Markdown for M-early; a live artifact that refreshes each morning later). Per
paper, a "slide":

- **Claim** — the finding as a headline, not the title.
- **Stakes** — why it matters, one line, leading (this is the "sell").
- **Connection** — the graph line: what in your library it cites, extends, or
  contradicts.
- **Verdict** — read / skim / skip, plus the arXiv + PDF links.

Structure of the page: top N ranked papers as slides, then a compact
"also-ran" list (evaluated, remembered, not pitched), then "sciting but unseen."
The brief is generated *from* the stores, so it's reproducible and never the
source of truth.

This maps onto the existing "morning brief" surface in the environment; a
scheduled daily run can render it automatically (deferred — see §10).

---

## 6. Knowledge representation (three layers)

Accumulation is layered, reusing SpinLib conventions where possible.

| Layer | Store | Holds | Owner |
|---|---|---|---|
| **Corpus** | `library.bib` | Canonical BibTeX entries | existing (append) |
| **Structure** | `.local/graph/works.json` | OpenAlex id, DOI, title, year, `referenced_works` (citation edges) | existing (append) |
| **Enrichment** | `.local/arxave/papers.db` (SQLite) | LLM summary, research question, contribution, topics, relevance, scites, importance, embedding, brief history | **new** |

- **The graph is the accumulating structure** — don't invent a parallel one.
- **Accumulation is idempotent** — everything keyed by `cite_key`; re-running
  enriches existing rows instead of duplicating.
- **Citations connect papers structurally; embeddings connect them
  semantically** (papers about the same thing that don't cite each other).

### 6.1 `papers.db` schema (SQLite)

```sql
CREATE TABLE papers (
    cite_key        TEXT PRIMARY KEY,   -- shared key across all three layers
    arxiv_id        TEXT UNIQUE,
    doi             TEXT,               -- 10.48550/arXiv.<id> for preprints
    openalex_id     TEXT,
    title           TEXT,
    authors         TEXT,               -- JSON array
    published       TEXT,               -- ISO date
    primary_category TEXT,
    abstract        TEXT,
    -- LLM enrichment --
    summary         TEXT,               -- the 1-paragraph structured summary
    research_question TEXT,
    contribution    TEXT,
    topics          TEXT,               -- JSON array of matched user topics
    relevance_score REAL,               -- 0..1, LLM
    relevant        INTEGER,            -- 0/1 gate result
    -- ranking --
    scites          INTEGER,            -- Scirate count (nullable)
    centrality      REAL,               -- in-corpus citation centrality
    importance      REAL,               -- blended final score
    -- briefing --
    claim           TEXT,               -- headline finding
    stakes          TEXT,               -- why it matters
    connection      TEXT,               -- graph context line
    verdict         TEXT,               -- read | skim | skip
    briefed_on      TEXT,               -- ISO date it appeared in a brief (nullable)
    -- bookkeeping --
    first_seen      TEXT,
    llm_model       TEXT,
    status          TEXT                -- new|summarized|filtered|ranked|ingested|briefed
);

CREATE TABLE embeddings (
    cite_key TEXT PRIMARY KEY REFERENCES papers(cite_key),
    dim      INTEGER,
    vector   BLOB                       -- or sqlite-vec virtual table
);

CREATE TABLE runs (
    run_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    started    TEXT,
    topics     TEXT,
    n_scraped  INTEGER,
    n_relevant INTEGER,
    n_briefed  INTEGER
);
```

Use `sqlite-vec` if you want ANN search inside SQLite; otherwise raw `BLOB` +
NumPy cosine is fine to tens of thousands of rows.

---

## 7. Pipeline

```
config/arxave.yaml (topics, filters, weights)
        │
        ▼
┌──────────────┐  arxiv API
│ 1. scout     │◄─────────  reuse arxiv.Client from daily_arxiv.py
└──────┬───────┘             (drop paperswithcode/markdown parts)
       ▼ papers.db (status='new')
┌──────────────┐  LLM
│ 2. summarize │◄─────────  -> summary / research_question / contribution
└──────┬───────┘
       ▼ status='summarized'
┌──────────────┐  LLM
│ 3. filter    │◄─────────  relevance gate vs. topics
└──────┬───────┘
       ▼ keep relevant, status='filtered'
┌──────────────┐  Scirate + graph + LLM
│ 4. rank      │◄─────────  scites + centrality + judgment -> importance
└──────┬───────┘
       ▼ status='ranked'
┌──────────────┐  OpenAlex
│ 5. link      │◄─────────  reuse oa_fetch.resolve_by_doi();
└──────┬───────┘             append to library.bib + works.json
       ▼ status='ingested'
┌──────────────┐  LLM
│ 6. brief     │◄─────────  pitch top-N: claim/stakes/connection/verdict
└──────────────┘             render Markdown/HTML from the stores
```

Each stage is idempotent and resumable via the `status` column (same philosophy
as `oa_fetch.py`'s resume-from-cache), so a crashed run resumes cleanly.

---

## 8. Module layout

New code under `scripts/arxave/`; existing scripts imported, not modified (except
the small additive refactor in §9).

```
scripts/
  arxave/
    __init__.py
    config.py       # topics, filters, ranking weights, model, paths
    scout.py        # stage 1: arxiv fetch (adapts daily_arxiv.get_daily_papers)
    llm.py          # provider-agnostic LLM + embedding interface (§below)
    summarize.py    # stage 2
    filter.py       # stage 3
    scirate.py      # scite fetch (wrapper or page scrape; best-effort)
    rank.py         # stage 4: blend scites + centrality + LLM -> importance
    link.py         # stage 5: OpenAlex resolve + append to bib/works.json
    brief.py        # stage 6: pitch top-N, render the daily brief
    store.py        # papers.db access (upserts, status transitions)
    run.py          # CLI: orchestrates 1->6; --stage to run one; --date
  oa_fetch.py       # EXISTING — reused by link.py
  build_graph.py    # EXISTING — reused for graph rebuild
  bibmeta.py        # EXISTING — reused for bib parsing
config/
  arxave.yaml
docs/
  arxave-spec.md     # this file
```

### Provider-agnostic LLM interface

```python
# scripts/arxave/llm.py
from typing import Protocol

class LLM(Protocol):
    def complete(self, system: str, user: str, *, json_schema: dict | None = None) -> str: ...
    def embed(self, texts: list[str]) -> list[list[float]]: ...

def get_llm(cfg) -> LLM:
    match cfg.provider:
        case "anthropic": return AnthropicLLM(cfg)
        case "openai":    return OpenAILLM(cfg)
        case "ollama":    return OllamaLLM(cfg)
    raise ValueError(cfg.provider)
```

Default: Anthropic for `complete`, a config-selectable embedding model for
`embed`. Both LLM stages request **schema-constrained JSON** so parsing is
deterministic. Summarize returns `{summary, research_question, contribution}`;
filter returns `{relevant, relevance_score, matched_topics, reason}`; brief
returns `{claim, stakes, connection, verdict}` per paper. Keys in a gitignored
`.env`, never in `config/arxave.yaml`.

---

## 9. Touch points in existing code

Additive only:

1. **`oa_fetch.py`** — factor the DOI-batch resolve into a callable
   `resolve_records(meta) -> dict` that `link.py` can call for a handful of new
   papers (today `main()` does a full-corpus pass; the per-batch logic already
   exists, just expose it).
2. **`link.py`** — append new entries to `library.bib` (respect the README's
   "don't normalize wholesale / check near-duplicate keys" rule) and merge new
   records into `works.json`.
3. **`build_graph.py`** — unchanged; re-run after ingestion, new nodes appear
   and auto-cluster. Centrality for ranking (§4) reads the same `works.json`.

Cite-key generation must match SpinLib conventions and avoid collisions (keys
vary: `Author2012` vs `author_slug_2012`). Proposed: `firstauthorlastname +
year + arxiv-shortid`.

---

## 10. Phasing

- **M1 — Scout + brief (thin slice):** scout → summarize → filter → rank
  (LLM-only, Scirate stubbed) → **Markdown brief**. Ships the product feel end
  to end fast; proves the pitch format is useful.
- **M2 — Graph merge:** `link.py` + `oa_fetch` refactor; new papers enter the
  rebuilt graph, and the "connection" line + centrality signal go live. Payoff
  milestone — the moat turns on.
- **M3 — Scirate + semantic layer:** real scites in ranking; embeddings for
  "related but uncited" and "sciting but unseen."
- **M4 — Live + scheduled:** brief as a refreshing artifact; optional daily
  scheduled run.

---

## 11. Open questions

- **Cite-key scheme** — finalize the collision-proof convention (§9) before
  first ingest; keys are the join across all three layers.
- **De-duplication** — a preprint later published gets a new DOI; merge rule so
  arXiv v1 and the journal version don't become two nodes.
- **Ranking weights** — hand-tuned at first; worth logging click/read feedback
  later to learn them.
- **Scirate reliability** — no official API; decide the fallback when scraping
  breaks (degrade to centrality + LLM only).
- **Community layer (v2)** — comments/annotation on the brief is a real
  direction but deliberately deferred so it doesn't dilute the daily core; the
  shareable brief is the seed for it.
- **Embedding model** — local vs hosted; affects `llm.py` default and privacy.
