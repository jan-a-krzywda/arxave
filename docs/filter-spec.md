---
layout: page
title: Filter — Specification
permalink: /filter-spec/
---

# arXave — Filter Stage Specification

> **Scope.** This document specifies the **filter** stage only — the first
> user-facing step. Filter runs entirely in the browser, on the user's own API
> key, and returns a **ranked** list of the day's papers. Summarize, brief, and
> the citation-graph backfill are out of scope here and referenced only where
> they hand data to or from filter.
>
> *Status: draft v0.1. Target: a static Jekyll page on GitHub Pages, no server.*

---

## 1. What "filter" is

Filter is the stage that turns the day's raw arXiv firehose (~120 papers) into a
short **ranked** list scored against *this user's* interests. It is deliberately
**cheap and instant**: it does most of its work with embeddings and arithmetic,
and calls a large LLM only as an optional refinement over the survivors.

Three principles, settled in design:

1. **Rank before you spend.** Ranking uses cheap signals (embedding cosine,
   scite counts, citation overlap) — no per-paper generative LLM call. The
   expensive LLM only ever sees the top of an already-ranked list.
2. **Relevance is per-user.** There is no shared "relevant" set. The morning
   batch cannot pre-filter because it does not know whose topics. So filter is a
   **browser-side, per-user** stage keyed on the user's own topics and corpus.
3. **The abstract is the shared summary.** arXiv ships an abstract with every
   paper for free. Filter reads abstracts, not LLM summaries — so no morning LLM
   cost is required to make filter work.

**Input:** the day's arXiv metadata (id, title, abstract, authors, category,
date) + the user's config (topics, optional `.bib` corpus, four weights).
**Output:** the same papers, each carrying an `importance` score and its signal
breakdown, sorted descending, top-N surfaced.

---

## 2. The score

Every candidate paper gets a blended `importance` in `[0, 1]`:

```
importance = ( w1·topic_cos + w2·corpus_cos + w3·citation_overlap + w4·scite )
             ───────────────────────────────────────────────────────────────
                        sum of the weights whose signal is present
```

Four signals, four user-tunable weights (`w1..w4`), each exposed as a **slider**
(§5). The denominator is **renormalized over the signals actually present** for
that paper — a missing signal is dropped from both numerator and denominator,
never scored as 0. This is the same rule the Python `rank.blend()` already uses
([src/arxave/rank.py](../src/arxave/rank.py)); the browser filter must reproduce
it exactly so local and hosted ranking agree.

### 2.1 The four signals

| # | Signal | Weight | Range | Source | Cost | Availability |
|---|--------|--------|-------|--------|------|--------------|
| 1 | `topic_cos` | **w1** | 0..1 | embedding cosine, abstract vs each topic | 1 embed call, batched | **live in browser** |
| 2 | `corpus_cos` | **w2** | 0..1 | embedding cosine, abstract vs user's `.bib` corpus | reuses same embed batch | live **iff** `.bib` uploaded |
| 3 | `citation_overlap` | **w3** | 0..1 | shared references between paper and corpus | `.bbl` parse + set overlap | **deferred** → `null` until backend enrichment |
| 4 | `scite` | **w4** | 0..1 | Scirate scite count, saturating | 1 HTTP GET/paper | **best-effort** → `null` on failure |

**Why these four, and why the split.** `topic_cos` catches semantic relevance
(`"spin qubit"` ≈ `"electron spin in quantum dots"` with no shared words).
`corpus_cos` catches "close to what *you* already read" (personal, needs the
user's corpus). `citation_overlap` catches structural connection to the library
(the moat). `scite` catches crowd attention (global). Two are personal (1, 2),
two are global (3, 4) — a good triangulation, and no single one is trusted.

### 2.2 Signal definitions

- **`topic_cos`** — encode each topic string to a vector `Tⱼ`; encode the
  abstract to `A`. `topic_cos = maxⱼ cos(A, Tⱼ)`. Max, not mean: a paper that
  nails one topic should not be diluted by the user's other topics.
- **`corpus_cos`** — encode each `.bib` entry (title, or title+abstract if
  available offline) to `Cₖ`. `corpus_cos = maxₖ cos(A, Cₖ)`. `null` if no
  `.bib` uploaded. v1 may embed **titles only** so it stays fully offline (no
  per-entry fetch); this is a documented approximation, refined later.
- **`citation_overlap`** — `|refs(paper) ∩ corpus| / |refs(paper)|`, where
  `refs(paper)` comes from the paper's arXiv e-print `.bbl` (fresh preprints are
  reference-less in OpenAlex, so `.bbl` is the source — see
  [openalex-preprints-lack-references] / [bib-from-arxiv-source] in project
  memory). **Deferred** in the browser: downloading and parsing each candidate's
  source tarball client-side is too heavy for day one. Until a backend supplies
  it, this signal is `null` and its weight renormalizes out. The slider still
  exists so the contract is stable when the signal turns on.
- **`scite`** — `min(count / SATURATION, 1.0)`, `SATURATION = 20` (matches
  `rank.SCITE_SATURATION`). `null` when the count can't be fetched.

### 2.3 Cosine, precisely

```
cos(A, B) = (A · B) / (|A| · |B|)          # in [-1, 1]; negatives clamp to 0
```

Vectorized over the whole day in one shot:

```js
// A: [N × d] abstract vectors, T: [d] one topic vector (both L2-usable)
scores = (A @ T) / (norm(A, axis=1) * norm(T))
```

Normalize once, reuse. All cosines for the day are a couple of matrix products —
this is why ranking is effectively free.

---

## 3. Pipeline (all client-side)

```
config (topics, .bib, w1..w4, top-N, keys, proxy)
        │
        ▼
┌────────────┐  arXiv API (Atom)         reuse scout query shape from src/arxave/scout.py
│ 1. scout   │◄──────────────────────    cat:<categories>, sortBy=submittedDate
└─────┬──────┘   → [{arxiv_id,title,abstract,authors,category,date}]
      ▼
┌────────────┐  embeddings API (user key, OpenAI-compatible /v1/embeddings)
│ 2. embed   │◄──────────────────────    ONE batched call: [abstracts…, topics…, corpus titles…]
└─────┬──────┘   → vectors
      ▼
┌────────────┐  pure arithmetic
│ 3. cosine  │   topic_cos = max_j cos(A, T_j);  corpus_cos = max_k cos(A, C_k)
└─────┬──────┘
      ▼
┌────────────┐  Scirate (best-effort, via proxy)     citation_overlap = null (deferred)
│ 4. signals │◄──────────────────────    scite = min(count/20, 1) or null
└─────┬──────┘
      ▼
┌────────────┐  blend() with renormalization over present signals
│ 5. rank    │   importance = Σ w·signal / Σ w(present)
└─────┬──────┘   sort desc → top-N
      ▼
┌────────────┐  render ranked table + per-signal breakdown  (this is the deliverable UI)
│ 6. present │
└─────┬──────┘
      ▼ (optional)
┌────────────┐  large LLM (user key), ONE batched call over top-N abstracts
│ 7. refine  │   {relevant, score, reason} per paper → re-sort / gate
└────────────┘   NOT run by default; user clicks "Refine top-N"
```

Stages 1–6 are the filter proper and run with **no generative LLM**. Stage 7 is
the optional handoff toward the brief: it is the *only* place a large model is
spent, and only over the top-N the cheap rank already chose.

---

## 4. Everything in the browser — and the honest edges

The page is static (GitHub Pages). No arXave server, no secrets leave the
machine. Same guarantee the existing config page already makes: keys stay in the
form, nothing is posted anywhere the user didn't type.

Three external fetches are needed, and two have real CORS constraints. The spec
handles each explicitly rather than pretending they're free:

| Fetch | Endpoint | CORS reality | Strategy |
|-------|----------|--------------|----------|
| Embeddings | user's provider `/v1/embeddings` | OpenAI + local (LM Studio/Ollama on localhost) allow browser CORS | direct |
| arXiv scout | `export.arxiv.org/api/query` | not guaranteed to send `Access-Control-Allow-Origin` | **optional CORS-proxy field**, direct first, proxy fallback |
| Scirate scite | `scirate.com/arxiv/<id>` | HTML page, no API, cross-origin blocked | via same proxy; **best-effort**, `null` on any failure |

**Design rules that follow:**

- A single **"CORS proxy" config field** (blank = direct). External GETs route
  through it when set. Documented, opt-in, user-controlled — no hidden relay.
- **Graceful degradation is mandatory.** arXiv unreachable → the run errors
  visibly (no papers = nothing to rank). Scirate unreachable → every `scite` is
  `null`, `w4` renormalizes out, ranking proceeds on the other signals. An
  unavailable scite is `null`, **never 0** — 0 would rank a paper as "nobody
  cared" when the truth is "we couldn't check" (contract from
  [src/arxave/scirate.py](../src/arxave/scirate.py)).
- Users who don't want a proxy can run the local `arxave serve` backend, which
  does the same fetches server-side without CORS. The browser page is the
  zero-install path; the local server is the no-proxy path. Same UI either way.

---

## 5. Interface

A single page under the site nav (proposed `/filter/`), sharing the existing
Jekyll `minima` theme, `safety-banner`, and `role-grid` styling so it reads as
one product with the current config page.

### 5.1 Controls

- **Topics** — textarea, one topic per line (reuse the existing widget +
  `.bib`-keyword chip suggester from `assets/main.js`).
- **Corpus** — optional `.bib` upload; enables `corpus_cos`. Show a chip/count
  confirming N entries loaded.
- **Scout** — arXiv categories, lookback days, max results (reuse existing
  scout fieldset).
- **Embedding provider** — provider + model + key + env name (reuse the
  provider-preset machinery in `main.js`; embeddings only — the heavy LLM box is
  needed just for the optional refine step).
- **CORS proxy** — single optional text field (see §4).
- **Weight sliders** — the headline control, next section.

### 5.2 The weight sliders (w1–w4)

Four `range` sliders, `min=0 max=1 step=0.05`, each with a **live numeric
readout** and a plain-language label:

| Slider | Binds | Label | Default |
|--------|-------|-------|---------|
| w1 | `topic_cos` | **Topic match** — semantic fit to your topics | 0.50 |
| w2 | `corpus_cos` | **Corpus fit** — closeness to your library | 0.25 |
| w3 | `citation_overlap` | **Citation overlap** — shared references *(deferred)* | 0.15 |
| w4 | `scite` | **Crowd attention** — Scirate scites | 0.10 |

- Weights need **not** sum to 1 — the blend renormalizes (§2). Optionally show a
  normalized "% influence" readout so users see relative pull without being
  forced to balance to 1.0.
- A slider whose signal is currently unavailable (w3 deferred; w4 if scirate
  failed; w2 with no `.bib`) renders **disabled with a "signal unavailable"
  note**, so the UI never implies an input that does nothing.
- **Re-ranking is instant and local.** Moving a slider re-blends and re-sorts
  the already-fetched vectors — **no re-fetch, no new API call**. This is the
  payoff of ranking being pure arithmetic: the user dials weights and watches
  the order rearrange live.

### 5.3 Results

A ranked table, best first:

| Col | Content |
|-----|---------|
| # | rank |
| Title | linked to arXiv abstract + PDF |
| Score | `importance`, with a small stacked bar showing each signal's weighted contribution |
| Signals | badges: `topic .82 · corpus .61 · scite 7 · cit —` (— = null/deferred) |
| Meta | primary category, date |

Top-N (the `top-N` control) visually separated from the "also-ran" tail so the
selection is obvious. A **"Refine top-N with LLM"** button (§3 stage 7) sits
above the table, off by default, and annotates each refined row with the LLM's
`relevant` verdict + one-line reason.

---

## 6. Data contracts

### 6.1 Candidate (after scout)

```json
{
  "arxiv_id": "2507.12345",
  "title": "…",
  "abstract": "…",
  "authors": ["…"],
  "primary_category": "cond-mat.mes-hall",
  "published": "2026-07-28",
  "abs_url": "https://arxiv.org/abs/2507.12345",
  "pdf_url": "https://arxiv.org/pdf/2507.12345"
}
```

### 6.2 Ranked paper (filter output)

```json
{
  "arxiv_id": "2507.12345",
  "signals": { "topic_cos": 0.82, "corpus_cos": 0.61, "citation_overlap": null, "scite": 0.35 },
  "scite_count": 7,
  "importance": 0.71,
  "matched_topic": "silicon spin qubits and exchange gates",
  "llm": null
}
```

`signals` mirrors the `papers` columns (`relevance_score`, `centrality`,
`scites`, `importance`) in the schema at
[arxave-spec.md §6.1](../arxave-spec.md) so the browser output can be persisted
by the hosted backend without a translation layer. `citation_overlap` maps to
`centrality`; `topic_cos`/`corpus_cos` are the semantic signals the schema
should gain.

### 6.3 Config additions

Extend the generated `arxave.yaml` `ranking.weights` from the current
`{llm, centrality, scites}` to the four-signal set:

```yaml
ranking:
  weights:
    topic:     0.50   # w1 — embedding cosine vs topics
    corpus:    0.25   # w2 — embedding cosine vs .bib corpus
    citation:  0.15   # w3 — shared-reference overlap (deferred)
    scite:     0.10   # w4 — Scirate scites
  top_n: 5
embedding:
  provider: openai
  model: text-embedding-3-small
  api_key_env: OPENAI_API_KEY
  base_url: null
proxy: ""            # optional CORS proxy for arXiv/Scirate GETs
```

This is additive; the existing `llm.light`/`llm.heavy` blocks stay for the
summarize/refine/brief stages.

---

## 7. Scirate connection (detail)

No official API. Best-effort by nature; the interface is fixed so the
implementation can be swapped without touching ranking.

- **Endpoint:** `GET https://scirate.com/arxiv/<arxiv_id>` (HTML), routed
  through the CORS proxy if set.
- **Extract:** parse the scite count from the page (the "Scited by N" / scited
  count element). Regex a leading integer near the scite marker; if the markup
  shifts, treat as failure, not zero.
- **Batching / rate:** sequential or small-concurrency GETs with a modest cap
  (e.g. 5 in flight) and a per-run ceiling; skip the rest gracefully if the cap
  is hit. Scirate is a courtesy source, not a dependency.
- **Contract:** `scites_for(ids) -> { id: int | null }`, identical to
  [src/arxave/scirate.py](../src/arxave/scirate.py). `null` on any error,
  timeout, missing page, or parse miss. Ranking renormalizes `w4` out for that
  paper.
- **Fallback:** if scirate is wholly unreachable, the whole signal is `null`
  across the run and the UI marks the w4 slider "unavailable". Ranking is
  unaffected beyond losing one signal.

---

## 8. What this stage does *not* do

- **No summarize.** Abstracts are the filter input; LLM summaries are a separate
  (and, per the design discussion, possibly unnecessary) stage.
- **No brief.** The optional stage-7 LLM refine produces a `relevant`/`reason`
  gate over top-N — it does **not** write claim/stakes/connection/verdict. That
  is the brief stage, on the heavy model, re-reading PDFs.
- **No graph write.** Filter reads corpus signals; appending new papers to
  `library.bib` / `works.json` is the link stage.
- **No morning cron.** Filter is on-demand, per-user, in the browser. A "morning
  brief" is a *cache* of already-filtered popular topics, not a scheduled LLM
  run — out of scope here.

---

## 9. Open questions

- **Embedding model** — hosted (`text-embedding-3-small`, cheap, needs key +
  CORS) vs. in-browser (`transformers.js`, zero key, larger download). Affects
  the "everything in the browser with no proxy" promise. v1: hosted; note
  `transformers.js` as the fully-offline future path.
- **arXiv CORS** — confirm whether `export.arxiv.org` sends permissive CORS
  headers today; if yes, the proxy field is optional-in-practice; if no, decide
  the default proxy story.
- **corpus_cos fidelity** — titles-only (offline) vs. title+abstract (needs a
  fetch per `.bib` entry). Start titles-only; measure the precision gap.
- **citation_overlap in-browser** — is a WASM/`.bbl` parse ever worth doing
  client-side, or does this signal stay a backend-only enrichment that the page
  reads back? Keep the slider stable either way.
- **Weight persistence** — remember slider positions in `localStorage` and/or
  export into `arxave.yaml` so the browser and the CLI rank identically.

---

*Related: [arxave-spec.md](../arxave-spec.md) (full pipeline), stages
`scout` / `scirate` / `rank` in [src/arxave/](../src/arxave/).*
