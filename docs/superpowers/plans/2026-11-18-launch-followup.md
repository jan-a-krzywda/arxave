# Launch Follow-up: No-Match Banner, Mine Cart, Stored Phrase Vectors

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** (1) say plainly when tonight has nothing close to the reader's words, (2) replace the sliding-engine strip with a mine cart that stands still while the rails move, (3) stop embedding a launch's fixed phrase on every visit by shipping its vector.

**Architecture:** A pure module `cave-match.mjs` turns a ranked night into a verdict and banner markup; the ranking stage shows it. The strip keeps its API (`stripHtml`, `stripState`) and changes only markup and CSS. Phrase vectors live in one static JSON built by a script that calls the deployed `/embed`, and the Priorities autorun uses them instead of calling `/embed`.

**Tech Stack:** Static Jekyll on GitHub Pages, ES modules in `docs/assets/`, `node --test`.

**Spec:** the chat of 2026-11-18 after #154 merged (three ideas, no-match / mine cart / caching), and `docs/superpowers/plans/2026-11-18-launch-links.md` for the code this builds on.

## Global Constraints

- "launch", never "preset" (`filter.js` owns "preset" for RSS feeds).
- `cave-launch.mjs` stays free of imports (the 404 page loads it alone); a test already enforces that.
- No new dependencies. No network call from the page except the existing `/embed`, `/relay`, `/dig-cache`.
- Match style: JSDoc blocks that say why, 2-space indent, single quotes, `.mjs`.
- Colours only from theme tokens in `cave.css` (dark mode must work); `prefers-reduced-motion` stops motion but keeps the information.
- Tests: `node --test tests/js/launch.test.mjs tests/js/match.test.mjs`. Three older files (`claims`, `gate`, `lazy-pick`) fail without these changes too; ignore them.

## Review Focus

- A percentile saturates (some paper is always above the 99th percentile of the field), and so does a count above a z cut (real matches sit at z 0.7 to 2.8, noise reaches z 1.5 on every night). "No match" is judged on the absolute closeness of the night's top-3 papers to the touchstones (Task 5 has the evidence; Task 1 was rebuilt on it as F5).
- Reader typed no words (no touchstones): no banner at all, never "nothing close".
- Zero papers tonight (weekend, holiday): its own message, not "nothing close".
- A launch phrase vector from an older embedding model: it must be ignored, not used, and the run must fall back to `/embed`.
- Embed service down on a launch with a stored vector: the run now works with no network call to `/embed` at all.

---

### Task 1: Match verdict (pure)

**Files:**
- Create: `docs/assets/cave-match.mjs`
- Test: `tests/js/match.test.mjs`

**Interfaces:**
- Produces (as rebuilt by F5 after Task 5's calibration; the first version counted z-scores and was replaced):
  - `NONE_COS = 0.7`, `WEAK_COS = 0.73`, `MIN_NIGHT = 30`
  - `matchVerdict(ranked: {vec}[], { touchstones }): { state: 'off'|'empty'|'none'|'weak'|'ok', top3: number | null, count: number }`
  - `matchBannerHtml(verdict): string` (empty string for `off` and `ok`)

- [ ] **Step 1: Failing tests** in `match.test.mjs`: no words gives `state 'off'` and banner `''`, even for an empty list; words and `[]` gives `'empty'` with a banner containing "announced nothing"; all `fit` below `CLOSE_Z` gives `'none'`, banner contains "Nothing close tonight" and the best z formatted to one decimal; two papers at or above `CLOSE_Z` gives `'few'`, banner contains "Only 2"; three or more gives `'ok'` and `''`; `best` is the maximum `fit`; non-finite `fit` values are ignored, not counted close.
- [ ] **Step 2: Run** `node --test tests/js/match.test.mjs`, expect FAIL (module missing).
- [ ] **Step 3: Implement** both functions. Banner is a `<p class="cave-match-banner is-none|is-few|is-empty" role="status">` with escaped text; copy: none "Nothing close tonight. Your closest paper is only a weak match (z 1.4). The list below is the nearest, not a match."; few "Only N papers tonight are close to your words."; empty "arXiv announced nothing for this day. Pick another day in Dig."
- [ ] **Step 4: Run tests, expect PASS. Step 5: Commit** `feat(cave): match verdict and banner markup`.

### Task 2: Ranking stage shows the banner

**Files:**
- Modify: `docs/assets/cave-stage-ranking.mjs` (`paintList`, near line 680)
- Modify: `docs/assets/cave-ranking.css`
- Test: `tests/js/match.test.mjs`

**Interfaces:**
- Consumes: `matchVerdict`, `matchBannerHtml` (Task 1).

- [ ] **Step 1: Failing wiring tests:** the ranking stage source imports `matchVerdict` and passes `hasWords` from `ctx.prefs.touchstones.length > 0`; a `.cave-match-banner` rule exists in `cave-ranking.css`; its colours use `var(--` tokens only (no hex).
- [ ] **Step 2: Run, expect FAIL. Step 3: In `paintList`** compute the verdict from `state.ranked` and put the banner in a container above the list (one new element created at mount); when the state is `none`, add `is-weak` to the list so rows render dimmed. Re-computed on every paint, so a slider drag or a new embed updates it.
- [ ] **Step 4: CSS** for the banner and `.is-weak` (opacity only, no layout shift). **Step 5: Run tests; commit** `feat(cave): say when nothing matches`.

### Task 3: Mine cart strip

**Files:**
- Modify: `docs/assets/cave-launch-strip.mjs`, `docs/assets/cave.css`, `docs/assets/cave.js` (`paintStrip`)
- Test: `tests/js/launch.test.mjs`

**Interfaces:**
- Keeps: `STRIP_STEPS`, `stripState(step)`, `stripHtml(step, label)`.
- Changes: markup. The track now holds `.cave-launch-cart` (fixed in the middle), `.cave-launch-rails` (scrolls), `.cave-launch-lamp` (flicker), and one `.cave-launch-say` line with the step's words ("Digging tonight's papers…", "Embedding your words…", "Ranking…", "Done."). The three wagon labels stay as step markers above.

- [ ] **Step 1: Update and add failing tests:** `stripHtml('embed', 'x')` contains `cave-launch-cart`, `cave-launch-rails`, no `cave-launch-loco`, and the say line for Embed; `stripHtml('error', 'x')` has class `is-error` and a say line mentioning the old order; the CSS has `animation` on `.cave-launch-rails` and a reduced-motion rule that sets `animation: none` for rails and lamp, and none for the cart; `.is-error` stops the rails (`animation-play-state: paused`).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement markup** in `stripHtml` (pure string), and the CSS: the cart is an inline SVG or CSS shape using theme tokens; rails are a repeating-linear-gradient background whose `background-position` animates (a looping keyframe, translateX of one tile), wheels turn with a rotate keyframe, the lamp flickers with an opacity keyframe, a slow dust layer is optional.
- [ ] **Step 4: `paintStrip`** toggles the new classes and updates the say line text from `stripState`; it must not recreate the cart (no jump). Remove `--launch-step` use.
- [ ] **Step 5: Run tests; manual look at 1100 px and 500 px, light and dark. Commit** `feat(cave): mine cart on moving rails`.

### Task 4: Stored phrase vectors

**Files:**
- Create: `scripts/launch-vectors.mjs` (builds the file), `docs/assets/cave-launch-vectors.mjs` (runtime loader)
- Modify: `docs/assets/cave-stage-priorities.mjs` (`runLaunch`, line ~1029)
- Test: `tests/js/launch.test.mjs`

**Interfaces:**
- Produces:
  - `buildVectorsFile(launches, embed): Promise<{ model: string, dim: number, built: string, vectors: Record<string, number[]> }>` in the script (exported, `embed(texts) -> number[][]` injected so tests need no network).
  - `loadLaunchVector(id, { url, model, dim, fetchImpl }): Promise<Float32Array | null>` in the loader: `null` on a missing file, a missing id, a wrong `dim`, or a different `model`.
  - File `docs/assets/corpus/launch-vectors.json`, vectors as the page's `embedTexts` returns them (normalised, not corpus-centred; the page centres them per field with `corpusSpace`).

- [ ] **Step 1: Failing tests:** `buildVectorsFile` with a fake embedder returns a vector per launch id with `dim` equal to the fake's length and the real `MODEL`; `loadLaunchVector` returns `null` for a model mismatch, a dim mismatch and an unknown id, and a `Float32Array` of the right length otherwise; a wiring test that `runLaunch` calls `loadLaunchVector` and only falls back to `embedNow()` when it returned `null`.
- [ ] **Step 2: Run, expect FAIL. Step 3: Implement** the script (the CLI part calls the deployed `/embed` once with the 12 phrases and writes the JSON with 5-decimal numbers) and the loader.
- [ ] **Step 4: `runLaunch`:** when the loader returns a vector, set `state.touchstones = [corpusSpace(vec, ctx.corpus)]`, set `touchKey` to the collapsed phrase, `publish()`, and skip `embedNow()`; otherwise unchanged.
- [ ] **Step 5: Run tests; commit** `feat(cave): launch phrases ship their vectors`. (The JSON itself is built and committed by the orchestrator, because it needs the live service.)

### Task 5: Calibrate the thresholds (orchestrator, not Cline) — DONE

Built `launch-vectors.json` from the live `/embed` (12 × 768, `allenai/specter2_base`). Findings that replaced Task 1's rule:

- **z-count fails.** Title-matched papers have a median fit z of 0.7 to 2.8 (none of 1176 `llms` titles reach z 3); non-matching papers reach z 1.5 in 2 to 8% of cases. A count above a z cut cannot tell "no match" from "a few matches".
- **Absolute closeness works.** `cos(paper)` = largest dot of the paper's corpus-space vector with a touchstone; `top3` = mean of a night's three largest. Simulated 200-paper nights: launch phrases 5th percentile 0.719 (spin-qubits) to 0.832; 6 off-topic phrases 95th percentile 0.623 to 0.758 (all but the adjacent "quantum dots for solar cells" below 0.73).
- **Rule (F5):** `NONE_COS = 0.70`, `WEAK_COS = 0.73`, `MIN_NIGHT = 30` (smaller nights get no verdict). States: off / empty / none / weak / ok.
- **End to end with the real `caveScore`**, 40 random nights each: quantum-sensing 40 ok; spin-qubits 35 ok, 5 weak (12%, the narrowest phrase); sourdough 40 none. About 100 papers survive the topic gate on a 200-paper night.
- Known cost: a narrow launch like spin-qubits will say "only weak matches" on roughly one normal night in eight. Lowering `WEAK_COS` to about 0.715 would halve that.

### Task 6: Docs

**Files:**
- Modify: `docs/details.md`

- [ ] Add: what the banner says and when, what the cart shows, and that launch phrases ship precomputed vectors. Run all tests above. Commit `docs(cave): no-match banner, mine cart, stored vectors`.

## Not in this plan

Precomputing each launch's ranking nightly in the warm job (instant launch pages) needs the cave scoring code to run in Node on the warm job's vectors and a place to publish the JSON. That is a design question; it follows once Task 5 shows how stable the thresholds are.
