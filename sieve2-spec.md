# Sieve v2 — spec and contracts

Goal: anyone opens one page, moves a few sliders, and gets last night's arXiv ranked by
**fit** (is it my topic?) and **impact** (does it look like papers that mattered?).
No account, no key. An LLM "Refine" button is optional and on demand.

## Parts

| Card | Owns | Needs |
|------|------|-------|
| S1 | `scripts/corpus-fetch.mjs` (+test) | — |
| S2 | `scripts/corpus-build.mjs` (+test) | S1 output format |
| S3 | `docs/assets/sieve-core.mjs` (+test `scripts/sieve-core.test.mjs`) | this file |
| S4 | `docs/sieve.md`, `docs/assets/sieve.js`, `docs/assets/sieve.css` | S3 API, corpus format |
| S5 | `supabase/functions/refine/` (+test) | this file |

## Corpus

A fixed window of arXiv papers (default `2025-09-01 … 2025-12-31`, i.e. 10–14 months old, so
citations have settled), categories `quant-ph`, `cond-mat.mes-hall`.

**S1** fetches *every* paper of the window (arXiv API, sliced per category per week, 3 s between
calls) and looks citations up in OpenAlex by DOI `10.48550/arXiv.<id>` (50 per request,
`filter=doi:a|b|c`, field `cited_by_count`). Output `corpus-raw.json`:

```json
{ "window": {"from":"2025-09-01","to":"2025-12-31"}, "categories": ["quant-ph","cond-mat.mes-hall"],
  "papers": [ {"id":"2509.01234","title":"…","abstract":"…","cat":"quant-ph","cites":7,"pct":0.83} ] }
```

`pct` = citation percentile (0..1, ties get the mean rank) among all window papers of the same
primary category `cat`. Papers OpenAlex does not know get `cites: 0`.

**S2** reads `corpus-raw.json`, samples `--top` (default 3000) papers by highest `pct` plus `--rand`
(default 3000) uniformly random others (seeded, `--seed`), embeds them (`chooseEmbedder`,
`cacheKeyText`, as `background.mjs` does), clusters with k-means (`--k`, default 20, seeded,
k-means++ init, cosine on centred vectors), labels each cluster, and writes into
`docs/assets/corpus/`:

* `corpus.json`
  ```json
  { "built_on":"2026-11-10", "model":"allenai/specter2_base", "dim":768, "n":6000,
    "window":{"from":"…","to":"…"}, "scale":0.25,
    "mean":[768 floats, 5 decimals],
    "ids":[…], "titles":[…], "cites":[…], "pct":[…], "cluster":[0..k-1 ints],
    "clusters":[ {"id":0,"label":"Superconducting qubit readout","size":312,
                  "centroid":[768 floats, 4 decimals]} ] }
  ```
* `corpus.vec.bin` — `n × dim` int8, row-major. Each vector = SPECTER2 CLS, L2-normalised
  (what `embedLocal` returns), then `q = round(clamp(v/scale, -1, 1) * 127)`. Dequantise:
  `v ≈ q * scale / 127`. The builder prints how many components clipped (expected ≈ 0).
  Vectors are stored **uncentred**; `mean` is the mean of the uncentred vectors.
* Cluster `label`: with `--label-llm` ask the grader endpoint (as `scripts/llm.mjs` does) for a
  3–6 word name from the 12 titles nearest the centroid; otherwise (default, and on any LLM
  failure) use `"Topic <id>: <3 most frequent non-stopword title words>"`.
* Centroids are of the centred vectors, re-normalised.

Centring convention: the browser embeds a new abstract (unit vector), subtracts `mean`, and
compares to corpus vectors that were centred the same way — the geometry of `preset-feed.mjs`.
After centring, cosine uses re-normalised vectors.

## Scoring (S3, `docs/assets/sieve-core.mjs`, pure ESM, no DOM, no network)

```js
loadCorpus(json, binArrayBuffer) -> corpus
  // corpus = { n, dim, mean:Float32Array, vecs:Float32Array(n*dim) /* centred, unit */,
  //            titles, ids, pct:Float32Array, cluster:Int32Array, clusters:[{id,label,size,centroid:Float32Array}] }

centreUnit(vec, mean) -> Float32Array     // vec - mean, then L2-normalise (zero stays zero)

score({ corpus, weights, touchstones, candidates, opts }) -> ranked
  // weights:      { [clusterId]: number in [0,1] }   missing id = 0.5
  // touchstones:  Float32Array[]  already centreUnit'ed  (may be empty)
  // candidates:   [{ id, vec:Float32Array /* centreUnit'ed */ , ...passthrough }]
  // opts:         { gate=1.0, surprise=0.4, k=15, topQ=0.75 }
  // ranked:       candidates that pass the gate, sorted by score desc, each with
  //               { ...candidate, fit, fitZ, impact, novelty, score, cluster, landmarks:[{id,title,sim,pct}] }
```

Definitions (all cosines are dot products of unit vectors):

1. **Paper weight** `p_i = weights[cluster_i] ?? 0.5`. If every `p_i` is 0, use 1 for all.
2. **Fit raw** `r(x)`:
   * touchstones present: `max_t cos(x, t)`.
   * none: topic affinity `Σ_k w_k cos(x, centroid_k) / Σ_k w_k` with `w_k = weights[k] ?? 0.5`
     (0 if the sum is 0).
3. **Fit z** `fitZ(x) = (r(x) − m) / max(s, 1e-6)` where `m` is the *weighted median* of `r(·)`
   over all corpus papers with weights `p_i`, `s = 1.4826 × weighted median of |r − m|`.
   Weighted median: sort ascending; the first value whose cumulative weight ≥ half the total.
   `fit` = `fitZ`.
4. **Impact** `impact(x)`: take the `k` corpus papers with largest cos to `x`; `a_j = max(cos_j,0) × (p_j + 0.05)`;
   `impact = Σ a_j pct_j / Σ a_j` (0 if `Σ a_j = 0`).
5. **Novelty** `novelty(x) = 1 − max cos(x, j)` over corpus papers with `pct_j ≥ topQ`.
6. **Gate**: keep candidates with `fitZ ≥ opts.gate`.
7. **Score**: among the *gated* candidates, `P(v)` = percentile rank in `[0,1]`
   (`(count of values < v + 0.5 × count of ties) / m`). `score = (1 − surprise) × P(impact) + surprise × P(novelty)`.
   With one gated candidate `P = 0.5`.
8. **landmarks**: the 3 nearest corpus papers by cosine (id, title, sim, pct) — the "looks like" evidence.

Slider meaning for the UI: topic sliders = `weights`; **Strictness** = `gate` (0 … 3, default 1);
**Surprise** = `surprise` (0 … 1, default 0.4; 0 = "papers like the proven ones", 1 = "papers like nothing before").

## Refine (S5, on demand)

`POST /functions/v1/refine` body
`{ "paper": {"title","abstract"}, "neighbours": [ {"title","pct"} ×≤5 ], "touchstones": ["…"×≤6] }`
→ `{ "relevance":1..5, "novelty":1..5, "why":"≤240 chars", "adds":"what it adds vs the neighbours, ≤240 chars" }`.

* Maintainer's key from env `LLM_API_KEY` (same provider shape as `scripts/llm.mjs`), model env `REFINE_MODEL`.
* Budget: per-IP 30 calls/day and global `REFINE_DAILY_CAP` (default 500) per UTC day, counted in a
  Supabase table `refine_usage` (`supabase/refine-usage.sql`). Over budget → HTTP 429 `{"error":"budget"}`.
* Optional BYO: if the request has header `x-llm-key`, call the provider with that key, skip the budget,
  and never log or store the key. (Browser sends it only when the user typed one.)
* Input is validated and clipped (title 300, abstract 3000 chars). Output is validated like `llm.mjs`
  (`GradeError` analogue) before returning.
* Prompt: the paper, its nearest proven papers, the user's touchstones; ask for JSON only.

## Page (S4)

One route `/sieve/` (`docs/sieve.md`, nav entry kept additive; old Dig page untouched).

Above the fold, nothing else:
1. One sentence + **one text box**: "What do you care about?" (free text or paste an abstract; becomes
   one touchstone; empty is fine).
2. **Topic sliders**: the 6 biggest corpus clusters, label + slider. "Show all N topics" expands the rest.
3. **Strictness** and **Surprise** sliders with plain-language end labels.
4. One big **Dig** button.

Collapsed `<details>` by default: *More touchstones*, *Categories and date*, *How this works*.
Results: a list of compact cards (title, one line "why", fit/impact chips, "looks like: …"). Each card
has **Refine with AI** (calls `refine`; shows relevance/novelty/why inline). Moving a slider re-ranks
live without refetching. Touchstone text is embedded via the hosted `embed` function and never
enters the shared cache. Candidates: tonight's arXiv via the existing `relay` + `embed` code path
patterns in `docs/assets/filter.js` (read it; do not edit it). Must work at 360 px width, light and dark.
