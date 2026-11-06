# Ranking pipeline: interface contract

Binding for all cards. ESM (`.mjs`), Node test runner (`node --test`), no new dependencies (`yaml` is already in
`scripts/package.json`). Pure functions take plain data and return plain data; network and filesystem access sit
behind injectable parameters (`fetchImpl`, `readFile`) so tests never touch the network.

Existing helpers to reuse, do not reimplement: `cosine`, `center`, `grade`, `bestRow`, `bandOf`, `selectItems`
(`preset-feed.mjs`); `loadPresets`, `embedChunk`, `cacheKeyText`, `MODEL`, `DIM` (`warm-dig.mjs`); `enrichItems`
(`enrich.mjs`); `fulltext.mjs`.

Vocabulary: a **stone** is a paper vector (centred SPECTER2, 768 floats). A **row** is `{vector, weight, label}`
(touchstone or seed). An **axis** is one of A-I; each axis is one preset made of its touchstones and seed papers.

## Files

| File | Owner card | Purpose |
|---|---|---|
| `scripts/pack.mjs` + `pack.test.mjs` | Q1 | load config + criterion pack, generate axis presets |
| `scripts/score.mjs` + `score.test.mjs` | Q2 | pure scoring: max_sim, z_ref, thresholds, shortlist |
| `scripts/llm.mjs` + `llm.test.mjs` | Q3 | OpenAI-compatible client, grading prompt, JSON validation |
| `scripts/embed-local.mjs` + `embed-local.test.mjs` | Q4 | runner-side SPECTER2 embedding |
| `scripts/background.mjs` + `background.test.mjs` | Q5 | build per-axis background stats |
| `scripts/rank.mjs` + `rank.test.mjs` | Q6 | pipeline driver, ship, new item fields |
| `.github/workflows/warm-dig.yml` | Q7 | wire the pipeline in, narrow default categories |

## pack.mjs (Q1)

```js
export async function loadConfig(path)            // -> config object (config/quantum-systems.yml shape), validated
export async function loadPack(dir)               // dir = criteria/<name>
  // -> { criterion, rubric, requirements: Map<id,text>, axes: { A: {name, touchstones:[{text,weight}], seeds:[{doi?,arxiv?,title,first_author,year,weight,anchor?}] }, ... } }
export function applyOverrides(config, pack)      // pack.criterion.overrides deep-merged over config; returns new object
export function presetsFromPack(pack, { saved })  // -> [{slug, claim}] one per axis in criterion.axes
export async function writePresets(pack, outDir, { saved, readFile, writeFile })
```

- Validation errors throw `Error` with a message naming the file and key.
- `presetsFromPack` slug: `qs-<axis lowercase>`, for example `qs-a`. The claim follows `docs/presets/*.json`
  exactly (`arxave_claim: 1`, `preset`, `name`, `blurb`, `saved`, `scout`, `touchstones`, `cores`, `blend`), plus
  `"unlisted": true` and `"axis": "A"`. A seed with `doi` becomes `{doi, weight}`; a seed with only `arxiv`
  becomes `{arxiv, weight}` (check `loadPresets`/`fetchCore` in `warm-dig.mjs`; if arXiv ids are not supported
  there, extend that code minimally, with a test).
- Unlisted presets are written to `docs/presets/` but NEVER added to `docs/presets/index.json`, and the site
  catalogue (reads index.json) must not show them. `loadPresets` must still load them.
- The criterion pack never contains organisation or project names; do not add any.

## score.mjs (Q2)

```js
export function maxSim(stone, rows)               // -> { max, row }  largest cosine over rows with a vector, row = argmax row (or null)
export function robustStats(values)               // -> { median, mad }   mad = raw median absolute deviation
export function zRef(value, { median, mad })      // -> (value - median) / (1.4826 * mad); mad 0 -> 0
export function thresholdForPassRate(values, rate)// -> smallest t such that fraction(values >= t) <= rate; values sorted internally
export function resolveTaus(config, background)   // -> { tau_ref, tau_seed }
export function shortlist(papers, opts)           // see below
```

- `background` shape (written by Q5): `{ built_on, n, axes: { A: { mean: {median, mad, values:[...]}, max: {median, mad, values:[...]} }, ... } }`
  where `values` are the sorted per-paper `mean_sim` and `max_sim` over the background sample.
- `resolveTaus`: explicit `shortlist.tau_ref` / `tau_seed` win. Otherwise pool the background across axes:
  `tau_ref` = `thresholdForPassRate` of all axis z_ref values at `sensitivity_presets[sensitivity].background_pass`;
  `tau_seed` = same on pooled `max_sim` values.
- `shortlist(papers, {tauRef, tauSeed, max, min, axisWeights})`: each paper is
  `{id, axes: { A: {mean_sim, max_sim, nearest, z_ref, z_day}, ... }}`. A paper passes if on any axis with
  weight > 0 `z_ref >= tauRef` or `max_sim >= tauSeed`. Return `{ papers: [{id, passed_by: 'z_ref'|'max_sim'|'z_day', best_axis}], filled: n }`
  sorted by best axis z_ref descending, capped at `max`. If fewer than `min` pass, fill from the top `z_day`
  (best axis) with `passed_by: 'z_day'`. Deterministic tie-break: id ascending.

## llm.mjs (Q3)

```js
export function buildGradePrompt({ rubric, requirements, axes, paper })  // -> messages [{role,content}]
  // paper = { id, title, authors, abstract, intro? }; rubric inserted VERBATIM; requirements = Map id->text
export function parseGrade(text, { requirements, axisIds }) // -> validated grade or throws GradeError
export async function gradePaper(args, { llm, fetchImpl = fetch, env = process.env })
  // llm = config.llm; POST {base_url}/chat/completions, Authorization Bearer env[llm.api_key_env];
  // retries 2x on 429/5xx with backoff (injectable sleep); returns grade or {error}
export class GradeError extends Error {}
```

Grade JSON (the model must return only this object; tolerate a ```json fence):
`{ relevance:1-5 int, novelty:1-5 int, axis:'A'..'I', refs:[ids], why:string, kind:'device'|'benchmark'|'algorithm'|'integration'|'review', actions:[{type,title,body}] }`

- `refs` entries not present in `requirements` are dropped (never throw for that); out-of-range numbers, unknown
  `axis`, unknown `kind`, empty `why` throw `GradeError`.
- `actions[].type` in `code|follow-up|mail|question|problem`; unknown types are dropped.
- With an empty requirements map, `refs` is forced to `[]`.
- No API key in env: `gradePaper` returns `{ error: 'no-key' }`, never throws, never calls the network.

## embed-local.mjs (Q4)

```js
export async function embedLocal(texts, { pipelineFactory })  // -> Float32Array[] each length DIM (768)
```

Drop-in for `embedChunk(texts, embedUrl)` from `warm-dig.mjs`: same text in, same vector out, so the cache key
(`cacheKeyText`, `MODEL`) stays valid. Loads `allenai/specter2_base` with `@huggingface/transformers` (the
pre-PR #68 history of `warm-dig.mjs` shows how it used to be done: `git log -S transformers`). CLS pooling
(token 0 of the token grid, the row `toVectors` takes) and L2 normalisation must match what the hosted
`embed` function returns. Add a `--embed-local` flag to
`warm-dig.mjs` and `preset-feed.mjs` and `rank.mjs` entry points that switches `embedChunk` to `embedLocal`.
The dependency `@huggingface/transformers` is the ONE allowed new dependency, added to `scripts/package.json`
`optionalDependencies` so the test suite runs without it (tests inject `pipelineFactory`).

## background.mjs (Q5)

```js
export async function buildBackground({ pack, config, fetchEarlier, embed, weekdays = 60 }) // -> background object (score.mjs shape)
```

CLI: `node background.mjs --pack ../criteria/quantum-systems --config ../config/quantum-systems.yml --out ../criteria/quantum-systems/background.json [--embed-local]`.
Fetches ~60 weekdays of both categories (reuse `fetchEarlier`), embeds with the cache key text, centres, computes
`mean_sim` (via `grade`) and `max_sim` (via `maxSim`) per axis per paper, stores sorted values and `{median, mad}`.

## rank.mjs (Q6)

CLI: `node rank.mjs --config ../config/quantum-systems.yml --out ../docs/feeds [--embed-local] [--dry-run]`.
Steps (fetch, embed, centre, score per axis, z_day, z_ref from `background.json`, shortlist, read, grade, enrich
those with `relevance >= ship.relevance`, ship) are exported as separate functions so each is testable:

```js
export function scoreAxes(stone, axisRows)                       // -> { A: {mean_sim, max_sim, nearest}, ... }
export function addDayZ(papers)                                   // adds z_day per axis (median/MAD over that day)
export function redundancy(stone, recentStones)                   // -> max cosine to recent shipped vectors, 0 if none
export function orderShipped(items)                               // relevance desc, then novelty desc, then z_ref desc, then id
export function bandOfRelevance(r)                                // 5 'Must read', 4 'Read', 3 'Skim'
export function pickShip(graded, config)                          // relevance >= ship.relevance, cap ship.max;
                                                                  // none qualify -> top `longshots_on_empty` by z_day, band 'Long shot'
export function storeCandidates(graded, config)                   // relevance >= store.relevance OR (novelty >= store.novelty AND relevance >= store.novelty_min_relevance)
```

New item fields written into feeds and `docs/feeds/archive/YYYY-MM.json`: `relevance`, `novelty`, `redundancy`,
`z_ref`, `nearest_seed`, `refs`, `axis`, `actions`; each archive day gains `summary` (string, LLM daily summary,
may be empty). Existing fields and existing presets' behaviour stay unchanged; the existing tests must keep passing.

## Conventions

- Every card ships tests for its own file(s) plus keeps `node --test *.test.mjs` green.
- Fixtures are hand-computed and written into the test file (small 3-4 dimensional vectors where possible).
- No file in this repo may contain the names of the people, organisations, sites or procurement this pack was
  informed by. Use "the pack" / "the criterion".
