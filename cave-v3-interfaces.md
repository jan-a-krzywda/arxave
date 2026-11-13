# Cave v3 — interface contract

Binding for cards C1–C5. Read `cave-v3-spec.md` (the goal) and `sieve2-spec.md` (existing corpus format and scoring) first.
ESM `.mjs`, Node test runner (`node --test`), no new dependencies. Pure functions; network/filesystem behind injectable params.
Existing code to reuse, not reimplement: `docs/assets/sieve-core.mjs` (`loadCorpus`, `centreUnit`, `prepare`, `rank`, `score`,
`weightedMedian`, `percentRank`), `docs/assets/sieve-ui.mjs`, `scripts/corpus-build.mjs` (`quantise`, `mulberry32`).
Do not edit `docs/assets/filter.js`.

## Data files (all under `docs/assets/corpus/`)

`corpus.json` keeps every v2 field. C1 adds (the old `cluster` / `clusters` stay for now, so v2 keeps working):

```json
{ "topic":  [int × n],   // index into topics.json "leaves" (primary, always present)
  "topic2": [int × n] }  // secondary leaf index or -1
```

`topics.json` (C1):

```json
{ "version": 1, "dim": 768,
  "parents": [ {"id":"computing","label":"Computing","default":"prefer"|"equal"} ],
  "leaves":  [ {"id":"opt-qalgo","parent":"computing","label":"Optimisation & quantum algorithms",
                "centroid":[768 floats, 4 decimals]  /* centred, unit */ } ],
  "tags":    [ {"id":"ml4q","label":"ML for quantum"} ] }
```

Leaf ids (fixed, 12): `opt-qalgo qml qec ft-roadmaps` (computing) · `tomo-metro sensing` (measurement) ·
`many-body materials` (matter) · `cold-atoms cavity-qed` (light-atoms) · `foundations gravity` (foundations).
Parent ids: `computing measurement matter light-atoms foundations`. Only `computing` has `default:"prefer"`.

`axes.json` (C2):

```json
{ "version": 1, "dim": 768,
  "exp_theory": { "w":[768 floats], "b":0.0, "heldout_acc":0.0, "n_train":0, "n_test":0, "ship":true },
  "ml4q":       { "w":[768 floats], "b":0.0, "heldout_acc":0.0, "n_train":0, "n_test":0, "ship":true } }
```

`w` applies to a **centred unit** vector: `z = dot(w, x) + b`; `p = 1/(1+exp(-z))`. For `exp_theory`, high p = theory.
If `heldout_acc < 0.80` then `ship:false` and the UI hides the slider. Seeds go in `scripts/cave-seeds/*.json`
(arrays of arXiv ids from the corpus, with a `why` string each), reviewable by the maintainer.

## sieve-core additions (C3) — new exports in `docs/assets/sieve-core.mjs`

```js
loadTopics(topicsJson) -> { parents, leaves, leafIndex:Map<id,int>, parentOf:Int32Array }
loadAxes(axesJson) -> { expTheory: {w:Float32Array,b,ship}, ml4q: {w,b,ship} }
topicWeights(topics, setting)
  // setting: { [parentId]: 'equal'|'prefer'|'avoid'|'off', leaves?: { [leafId]: same } }  — leaf entry overrides parent
  // -> Float32Array(leafCount); equal=1, prefer=1.5, avoid=0.5, off=0
defaultSetting(topics) -> setting      // computing prefer, others equal, no leaf overrides
paperTopicWeight(corpusOrCand, i, tw)  // primary*1 + secondary*0.5 counted as: w = tw[topic] + 0.5*tw[topic2] (if topic2>=0) over (1 + 0.5 if topic2>=0)
caveScore({ corpus, topics, axes, setting, sliders, touchstones, candidates })
  // sliders: { match:0..100 (default 50), surprise:0..100 (50), expTheory:-100..100 (0) }
  // candidates: [{ id, vec(centred unit), topic, topic2, ...passthrough }]
  // -> ranked: [{ ...cand, fit, impact, novelty, theory:0..1, ml4q:0..1, score, landmarks }] sorted desc
```

Mapping: `gate = 3 * match/100`; `surprise = surprise/100` (these feed the existing `prepare`/`rank`; weights per paper come from
`paperTopicWeight`, replacing the cluster weights). `off` topics are excluded outright. Experiment↔Theory: if `ship` and
`expTheory != 0`, final score gets `+ (|s|/100) * (±(theory - 0.5)*2) * 0.25`, sign + for the theory side. Pure, deterministic,
no DOM. A candidate with no `topic` is assigned nearest-leaf-centroid in `caveScore` (tonight's papers have no stored topic):
export `assignTopics(vec, topics) -> {topic, topic2}` with secondary = runner-up if its cosine is within 0.03 of the best, else -1.

## Page (C4) — files owned: `docs/cave.md`, `docs/assets/cave.js`, `docs/assets/cave.css`

Permalink `/cave/`. `docs/sieve.md` becomes a redirect stub (as in `docs/filter-moved.md`) pointing to `/cave/`.
The site root `/` (`docs/filter.md`) is NOT touched; the maintainer decides later. Imports only `sieve-core.mjs` and
`sieve-ui.mjs` (read-only). DOM hooks: `#cv-app`, `#cv-text`, `#cv-match`, `#cv-surprise`, `#cv-exptheory`, `#cv-tree`,
`#cv-chips`, `#cv-results`, `#cv-advanced`, `#cv-topics-btn`, `#cv-sheet`. Settings persist in localStorage (try/catch).

## Look (C5) — files owned: `docs/assets/cave-tokens.css`, `docs/assets/cave-art/*.svg`, small `cave-art.mjs` helper

Pixel art = decoration only: header band (cave mouth + campfire), empty states (idle fire, "no papers yet", "digging").
Interface = modern product UI (Mobbin refs: Canny/Substack filter sidebar on near-black, Whoop/Alta grouped checkbox sheets,
Revolut "Apply filters" bottom sheet, Sprig chip bar). Look: **cave dark, firelight warm**.

Tokens (CSS custom properties on `:root`, prefix `--cv-`):
```
--cv-bg:#14100d  --cv-surface:#1c1713  --cv-surface-2:#251e18  --cv-line:#3a2f26
--cv-text:#efe4d4  --cv-muted:#a8987f
--cv-fire:#ff9a3c (the single accent)  --cv-ember:#e2571e  --cv-glow:rgba(255,154,60,.18)
```
Light theme (`@media (prefers-color-scheme: light)` and `[data-theme=light]`): `--cv-bg:#f5ecdf --cv-surface:#fffaf1
--cv-text:#2a2018 --cv-fire:#c2570a`. Type: system UI stack, scale 12/14/16/20/28, line-height 1.5. Radius 12px, hairline
borders, soft fire glow on focus and on the primary button. Pixel art SVGs use `shape-rendering="crispEdges"`, a 4-colour
ember palette taken from the tokens, and one CSS keyframe flicker (`steps(4)`, 0.9 s) on the flame, disabled under
`prefers-reduced-motion`. Must be legible at 360 px.
