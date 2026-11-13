# Cave v4: one staged page from dig to story

Status: APPROVED 2026-11-13 (shared LLM cap, maintainer deploys functions, threads on GitHub Discussions, old Dig to
`/legacy/dig/`). Replaces the single-screen Cave v3 at `/cave/`, and at cutover takes over
`/` (Dig) and `/sieve/`.

## Why v3 missed

- **Wrong look.** v3 added its own brown `--cv-` palette and system fonts, so it looks like a different site. v4 uses the
  site palette in `docs/_sass/cave.scss` (rock blue-grey, lamp blue, gold ore, ember red), Dig's `fieldset` stage cards from
  `style.css` / `filter.css`, and the `cave-wall*.svg` side walls. `cave-tokens.css` is deleted.
- **Lost Dig's best parts.** The haul train, wagon clustering (table / graph / strip), and wagon naming were dropped. v4
  carries all of them.
- **Flat topics.** The topic tree had no counts and no weights you could see. In v4 each parent and leaf shows how many
  papers it has tonight and its weight, and a click opens the detail below it.

## The journey (one page, seven stages, top to bottom)

Each stage is a card. It unlocks when the stage before it is done, and when done it folds to a one-line summary
("312 papers · 14 wagons") that reopens on click. Progress shows as a sticky rail: a vertical stepper on desktop (Stripe
setup and Snowflake run patterns) and thin segments across the top on a phone (Fresha). State persists in localStorage,
so a reload resumes at the same stage.

| # | Stage | What the reader does / sees | Reuses |
|---|---|---|---|
| 1 | **Dig** | Categories (chips), lookback, max. One button: *Dig*. | `sieve-ui.mjs` relay + RSS/Atom parse; Dig's category picker |
| 2 | **Train** | The pixel mine train fills while abstracts embed. Same animation as today. | `startHaulTrain` from `filter.js` (copied unchanged) |
| 3 | **Map** | Tonight's papers as wagons: train strip, **Table / Graph** switch, threshold slider, *Name the wagons* (LLM). New: a bar of tonight's papers across the 12 topics, each wagon tagged with its main topic, so it reads even unnamed. | `filter.js` dendrogram, graph, strip, `wagon-name` function; `assignTopics` |
| 4 | **Priorities** | Box (what you care about), three sliders (Topic match, Surprise, Experiment↔Theory), **topic tree with weights**: parent rows show count tonight + Equal/Prefer/Avoid/Off; a click opens leaves with their own counts and dropdowns; a leaf click shows its wagons. ML-for-quantum chip. Presets and core samples from Dig sit under *More*. Opens on the lit campfire, and the page carries its gold glow from here down. | `caveScore`, `topicWeights`, `topics.json`, `axes.json` (v3, kept) |
| 5 | **Ranking** | List ranked live. Each row: title, authors, wagon / topic chip, **two meters: Fit and Promise** (Promise = impact↔novelty, blended by Surprise), "looks like" landmarks. Click opens the abstract in place. Checkbox to pick. | `caveScore` output; Dig's list row |
| 6 | **Act** | Per paper, and in bulk from a floating bar ("3 picked · Zotero · Diamonds · Thread", the incident.io / Plane pattern): see actions below. | new |
| 7 | **Story** | With papers picked: *Tell me tonight's story*. The LLM writes a short narrative of the night around your picks (what moved, how they connect, what to read first). Read-aloud button, copy as Markdown, download. | new `story` function |

### Stage 7 actions

Ship first:
- **To Zotero**: download `.ris` (Zotero imports it in one click) and `.bib`; copy BibTeX. No account needed.
- **Extract the diamond** (LLM, per paper): 2-sentence summary, 3 take-home messages, 3 open questions, "read this if…".
  Shown in a side panel (Searchable / Plane AI-summary patterns). Cached per arXiv id in the browser.
- **Open a thread**: on GitHub Discussions in a repo the maintainer hosts (`discussions_repo` in `docs/_config.yml`,
  category `discussions_category`). No backend: the page first links to a search for the arXiv id
  (`/discussions?discussions_q=<id>`), so an existing thread is joined rather than duplicated, and otherwise opens
  `/discussions/new?category=…&title=[<id>] <title>&body=<link, abstract, diamond if extracted>` prefilled. The
  maintainer enables Discussions on that repo.
- **More like this / Less like this**: adds the paper as a positive or negative touchstone and re-ranks. Free and instant.

Later candidates (your call):
- Ask the paper (chat over its abstract, then full text via `scripts/fulltext.mjs`).
- Direct save to Zotero via the Zotero web API (user pastes their API key once).
- Reading queue that carries picks across nights, plus "still unread" in tomorrow's story.
- Follow an author or a wagon, so the next dig flags it.
- Compare two picked papers side by side (diamond vs diamond).
- Obsidian / Notion Markdown export with the diamond inside.
- Story as audio (browser speech now, nicer TTS later) for the commute.

## Look, in one line

Cave dark is the site's rock palette. Warmth is the gold `--gold` / `--ember` light: it is absent in stages 1–3 (the dig
is lit by the blue lamp), the campfire lights at stage 4, and stages 5–8 sit in its glow (a low-alpha radial gradient from
the fire plus gold focus rings). Pixel art stays decoration: the side walls, the train, the campfire, empty states.
Interface is Dig's own components, tightened with Mobbin patterns (stepper, floating bulk bar, AI summary panel).

## Data and backend

- Corpus, `topics.json`, `axes.json`, and `sieve-core.mjs` from v3 stay as they are.
- New Supabase functions `diamond` and `story`, built on `refine`'s provider code and its Postgres daily budget
  (`refine_usage_spend`): one shared per-IP and global daily cap across refine, diamond and story (decided). BYO key
  header honoured as in `refine`. The maintainer deploys the functions (`supabase functions deploy diamond story`).
- No workflow-file changes (token has no `workflow` scope).

## Cards (Cline, `cline -P cline-pass`), each small with oracle tests

PR 1, parity (stages 1–6):
- **K1 train module**: copy `startHaulTrain`, `TRAIN`, `trainStoneGold` into `docs/assets/cave-train.mjs` (ESM, no
  changes to drawing). Test: mounts on a fake canvas, `set(done,total)` relays, null without canvas.
- **K2 wagons module**: copy `computeWagonMap`, `buildDendrogram`, `cutDendrogram`, `countWagons`, `bestWagonThresh`,
  `clusterOrder` into `docs/assets/cave-wagons.mjs`. Tests: hand-built similarity fixtures, same output as `filter.js`.
- **K3a wagon graph** (`docs/assets/cave-wagon-graph.mjs`) and **K3b table + strip + naming client**
  (`docs/assets/cave-wagon-views.mjs`), plus the
  `wagon-name` client. Test: table and strip HTML from fixtures; graph mounts on a fake canvas.
- **K4 flow module**: `docs/assets/cave-flow.mjs`, pure stage machine (unlock, fold, summary line, persist / restore).
- **K5 page shell + stages 1–3**: rewrite `docs/cave.md`, `cave.js`, `cave.css` on site tokens; stepper; dig → train →
  map wired to K1–K4; topic bar.
- **K6 fire**: campfire art in site palette, stage-4 card, glow layer, reduced motion.
- **K7 priorities**: tree with tonight's counts, weights, leaf → wagons, sliders, box; reuse v3 logic.
- **K8 ranking**: rows with two meters, landmarks, abstract expand, pick checkbox.

PR 2, act: **K9** export (`.ris` / `.bib` / Markdown, pure, tested) · **K10** `diamond` function + tests · **K11**
diamond panel UI · **K12** GitHub Discussions thread links (pure URL builder, tested) · **K13** bulk bar + more/less like this.

PR 3, story: **K14** `story` function + tests · **K15** story reader (read aloud, copy, download).

PR 4, cutover (Claude, small): `/` serves the Cave; old Dig moves to `/legacy/dig/`; `/cave/`, `/sieve/`, `/filter/`
redirect to `/`; nav updated.

Run order: K1–K4 in parallel, then K5, then K6–K8 in parallel. Claude reviews, renders each stage in a browser at 360 px
and desktop, and integrates; Claude does not patch Cline's code.
