# Cave v4: interface contract

Binding for cards K5 and later. Read `cave-v4-spec.md` first. ESM, no bundler, no new dependencies, Node test runner.

## Modules from K1–K4 (already on `cave-v4`)

- `cave-train.mjs`: `startHaulTrain(canvas)` → `{ set(done,total), stop() }` | null.
- `cave-wagons.mjs`: `computeWagonMap`, `buildDendrogram`, `cutDendrogram`, `countWagons`, `bestWagonThresh`,
  `clusterOrder`, `WAGON_THRESH`.
- `cave-wagon-graph.mjs`: `mountWagonGraph(canvas, {...})`.
- `cave-wagon-views.mjs`: `wagonTableHtml`, `trainStripHtml`, `wireTrainStrip`, `nameWagons`, `wagonKey`, `wagonLabel`.
- `cave-flow.mjs`: `STAGES`, `createFlow({ storage })`.
- Unchanged from v3: `sieve-core.mjs` (`caveScore`, `assignTopics`, `loadTopics`, `loadAxes`, `topicWeights`,
  `defaultSetting`, `centreUnit`, `loadCorpus`), `sieve-ui.mjs` (`createRelay`, `fetchAnnouncement`, `embedCandidates`,
  `embedTexts`, `loadCorpusFrom`, `escapeHtml`, `paperEmbedText`, `readStore`, `writeStore`, `refineHtml`).

## Page (`docs/cave.md`, permalink `/cave/` until cutover)

Layout `page`, site styles (`/assets/style.css`, `/assets/filter.css` for shared components) plus `/assets/cave.css`.
The two `cave-wall` side divs as in `docs/filter.md`. Assets linked with `relative_url` and `?v={{ site.time | date: '%s' }}`.
No `cave-tokens.css`, no `--cv-` tokens: colours only from `docs/_sass/cave.scss` (`--cave-air --rock-deep --rock
--rock-edge --rock-lit --lamp --text --text-dim --text-faint --gold --gold-dim --ember --moss`, ore/lamp ramps).
New page-local tokens may only be derived from those (e.g. `--fire-glow: color-mix(in srgb, var(--gold) 14%, transparent)`).

Markup, one per stage, in `STAGES` order:

```html
<section class="cave-stage" id="stage-<id>" data-stage="<id>">
  <button type="button" class="cave-stage-head" aria-expanded="…">
    <span class="cave-stage-n">1</span><span class="cave-stage-name">Dig</span>
    <span class="cave-stage-summary"></span>
  </button>
  <div class="cave-stage-body"></div>
</section>
```

Plus `<nav class="cave-rail" id="cave-rail">` (stepper; vertical sticky on ≥ 900 px, top segments below) and
`<div id="cave-app">` wrapping all. Locked stages render dimmed with the body hidden; done stages fold to the summary.

## Wiring (`docs/assets/cave.js`, owned by K5)

`cave.js` creates the flow, loads corpus / topics / axes, builds `ctx`, renders the rail, and calls each stage module's
`mount(bodyEl, ctx)` once. Stage modules, one file each, one owner each:

| stage | module | owner |
|---|---|---|
| dig, train | `cave-stage-dig.mjs` | K5 |
| map | `cave-stage-map.mjs` | K5 |
| fire | `cave-stage-fire.mjs` | K6 |
| priorities | `cave-stage-priorities.mjs` | K7 |
| ranking | `cave-stage-ranking.mjs` | K8 |
| act | `cave-stage-act.mjs` | K13 |
| story | `cave-stage-story.mjs` | K15 |

A missing module (not built yet) is skipped with a placeholder "Coming soon" body; `cave.js` imports them dynamically
(`import()` in try/catch).

```js
ctx = {
  flow,                 // createFlow(...)
  bus,                  // EventTarget; events below, detail in event.detail
  config: { functionsBase, relayUrl, embedUrl, cacheUrl, nameUrl, discussionsRepo, discussionsCategory },
  corpus, topics, axes, // from sieve-core loaders (null if the corpus failed to load; stages must cope)
  night: null,          // set by dig: see below
  prefs: null,          // set by priorities
  ranked: [],           // set by ranking
  picks: new Set(),     // arXiv ids, set by ranking / act
  storage,              // localStorage or null
}
```

`night` = `{ date, categories, stones:[{ id, title, abstract, authors, cat, link }], vecs: Float32Array[] (centred unit),
topic: Int32Array, topic2: Int32Array, components: {indices:number[]}[] (as clusterOrder returns; indices into stones), names: (string|null)[] }`.

Bus events (all `CustomEvent`): `night` (dig finished; detail = night) · `wagons` (map re-cut or named; detail =
{components, names}) · `prefs` (detail = { setting, sliders, touchstones: Float32Array[], text }) · `ranked` (detail =
ranked list) · `picks` (detail = array of ids). A stage calls `ctx.flow.complete(id, summary)` when its step is done;
a new dig calls `ctx.flow.invalidateFrom('train')`.

Every module exports pure helpers (HTML builders, reducers) next to `mount`, and its test covers the helpers.
