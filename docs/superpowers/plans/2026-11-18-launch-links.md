# Launch Links + Embed Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Typing in the Priorities box stops lagging (embed only on a button press), and `arxave.com/<field>/<slug>` opens the Cave, digs the last day, embeds a preset phrase and lands on the ranking, with a train-themed progress strip.

**Architecture:** A pure module `cave-launch.mjs` holds the launch table and URL parsing. A static `docs/404.html` turns `/quantum/spin-qubits` into `/?launch=quantum/spin-qubits` (GitHub Pages cannot serve the path natively) and `cave.js` restores the clean address with `history.replaceState`. `cave.js` seeds Dig/field/prefs storage and sets a one-shot autorun flag, the same way `switchField` already seeds `AUTODIG_KEY`; Dig, Priorities and the flow then run themselves.

**Tech Stack:** Static Jekyll on GitHub Pages, ES modules in `docs/assets/`, tests under `tests/js/` run with `node --test`.

**Spec:** The agreed design is the chat playback of 2026-11-18 (embed button, launch links, train strip). Preset slugs and phrases come from the Opus proposal saved at `docs/superpowers/plans/2026-11-18-launch-presets-proposal.md`.

## Global Constraints

- Name is "launch", never "preset": `tests/js/presets.test.js` and `filter.js` already own "preset" for RSS feeds.
- Lookback is 1 day. Sliders are the defaults from `defaultPrefs(topics)`. Quantum categories lead with `quant-ph, cond-mat.mes-hall`; AI with `cs.AI, cs.LG` (the field's own list, `cave-fields.mjs` `FIELDS`).
- Valid URL forms: `/<field>/<slug>`, optional trailing slash, slug `[a-z0-9-]+`, field one of `FIELDS[].id`. Anything else is a normal 404.
- No new dependencies. No network call except the existing `/embed`.
- Match file style: JSDoc block comments explaining why, 2-space indent, single quotes, `.mjs` for modules.
- Tests: `node --test tests/js/launch.test.mjs`; older tests stay `node tests/js/<name>.test.js`.

## Review Focus

- Unknown slug or field (`/quantum/nope`, `/ai/`, `/foo/bar`): show the 404 page, never a half-started Cave.
- Reload on the clean URL after `replaceState`: must still launch (404.html serves again) and must not re-dig a night already finished this load.
- Launch whose categories include an uncached code (`cs.CL`, `cs.CV`, `physics.atom-ph`): the strip must say the first load is slower, and the run must still finish.
- Embed service down or slow during a launch: the Cave must still reach Ranking with the old order and an error line, not hang on the strip.
- Reader opens a launch link while Dig's saved categories are the other field: the launch wins and Dig's saved categories are realigned.
- Typing then pressing Rank tonight without Embed: ranking uses the old vectors and the note says the words were not embedded.

---

### Task 1: Launch table and URL parsing

**Files:**
- Create: `docs/assets/cave-launch.mjs`
- Test: `tests/js/launch.test.mjs`

**Interfaces:**
- Produces:
  - `LAUNCHES: readonly Launch[]` where `Launch = { id: 'quantum/spin-qubits', field: 'quantum'|'ai', slug: string, label: string, categories: string[], phrase: string, nudge: string | null }` (`nudge` is a topic leaf id set to `prefer`, or null)
  - `launchById(id: string): Launch | null`
  - `launchFromPath(pathname: string): Launch | null` (accepts `/quantum/spin-qubits`, `/quantum/spin-qubits/`)
  - `launchFromSearch(search: string): Launch | null` (reads `?launch=quantum/spin-qubits`)
  - `LAUNCH_KEY = 'arxave-cave-launch'` (localStorage key for the one-shot autorun record `{ id, at }`)
  - `LAUNCH_FRESH_MS = 120000`

- [ ] **Step 1: Write failing tests** in `launch.test.mjs`: `launchFromPath('/quantum/spin-qubits')` and `'/quantum/spin-qubits/'` return the same launch with `field === 'quantum'`; `'/quantum/nope'`, `'/ai/'`, `'/foo/spin-qubits'`, `'/quantum/spin-qubits/extra'` return `null`; `launchFromSearch('?launch=ai/llms')` returns the llms launch; every launch has `id === field + '/' + slug`, a slug matching `/^[a-z0-9-]+$/`, a `field` found by `fieldById`, its first category is in `fieldById(field).categories` (`cave-fields.mjs`), and a phrase of 6 to 40 words; ids are unique; `launchById('ai/reinforcement-learning')` exists.
- [ ] **Step 2: Run** `node --test tests/js/launch.test.mjs`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** `cave-launch.mjs` with the signatures above. Rows: take the first 12 rows (categories, phrase, nudge) from the Opus proposal file, in its order; the three required ones are `quantum/spin-qubits`, `ai/llms`, `ai/reinforcement-learning`. Freeze rows like `FIELDS` does.
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(cave): launch table and URL parsing`.

### Task 2: 404 redirect and clean address

**Files:**
- Create: `docs/404.html` (front matter `layout: page`, `permalink: /404.html`, `nav_icon` omitted; body keeps a readable "Not found" message plus the redirect script)
- Modify: `docs/assets/cave.js` (top of `startPage`, before `chooseField`)
- Test: `tests/js/launch.test.mjs`

**Interfaces:**
- Consumes: `launchFromPath`, `launchFromSearch` (Task 1).
- Produces: `resolveLaunch(loc: { pathname, search }): Launch | null` exported from `cave-launch.mjs`: search form wins, path form second.

- [ ] **Step 1: Failing test** `resolveLaunch({pathname:'/', search:'?launch=ai/llms'})` returns llms; `{pathname:'/ai/llms', search:''}` returns llms; `{pathname:'/', search:''}` returns `null`.
- [ ] **Step 2: Run, expect FAIL. Step 3: implement `resolveLaunch`.**
- [ ] **Step 4: 404.html script:** if `location.pathname` matches `/^\/(quantum|ai)\/[a-z0-9-]+\/?$/`, `location.replace('/?launch=' + path-without-leading-and-trailing-slash)`; otherwise do nothing so the 404 text shows. Add a wiring test that reads `docs/404.html` and asserts it contains `/?launch=` and that the regex alternation equals `FIELDS` ids joined with `|`.
- [ ] **Step 5: In `cave.js`:** call `resolveLaunch(window.location)`; when it returns a launch, `history.replaceState(null, '', '/' + launch.id)` after reading it. Seeding happens in Task 4.
- [ ] **Step 6: Run tests, commit** `feat(cave): 404 redirect for launch links`.

### Task 3: Embed button replaces live embedding

**Files:**
- Modify: `docs/assets/cave-stage-priorities.mjs` (the box markup near line 496, `embedWords` near 592, input handler near 855)
- Modify: `docs/assets/cave-priorities.css`
- Test: `tests/js/launch.test.mjs` (wiring guard)

**Interfaces:**
- Produces: the stage's `mount(body, ctx)` result gains `embedNow(): Promise<boolean>` (true when touchstones were updated or the box is empty, false on error); it embeds `cacheKeyText(textEl.value)`, publishes, and is also what the new `.cave-embed-btn` ("Embed & rank") calls. Task 4 calls it.

- [ ] **Step 1: Failing wiring test:** the file source contains `cave-embed-btn`, and does not contain `setTimeout(embedWords`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Input handler:** only sets `state.text` and `textGen += 1`, then schedules `persist()` once after 400 ms (writing vectors to localStorage per keystroke is the likely lag); no `emit()`, no embed timer. Show note "Words changed. Press Embed & rank to use them." when `cacheKeyText(textEl.value) !== touchKey`.
- [ ] **Step 4: Button:** add `.cave-embed-btn` under the box. Pressing it disables itself, runs `embedNow`, then re-enables. `embedNow` keeps the existing `embedWords` logic, shows "Embedding…" progress in `.cave-priorities-note`, and on failure keeps the old `state.touchstones` and shows the error with `is-error`. On success the note reads "Ranked by your words." and `publish()` re-ranks.
- [ ] **Step 5: Rank tonight with unembedded words:** if the box text differs from `touchKey`, the continue button still works but sets the note to "Your words were not embedded, so the ranking ignores them."
- [ ] **Step 6: Style the button** with the existing `.cave-primary` look; run tests; manual check by serving `docs/` (`bundle exec jekyll serve` in `docs/`) and typing 200 characters with no embed request in the network tab.
- [ ] **Step 7: Commit** `feat(cave): embed on button press, not on typing`.

### Task 4: Launch autorun

**Files:**
- Modify: `docs/assets/cave.js` (seed storage after `resolveLaunch`, before `chooseField`)
- Modify: `docs/assets/cave-stage-dig.mjs` (autodig block at line 625)
- Modify: `docs/assets/cave-stage-priorities.mjs` (end of `mount`)
- Modify: `docs/assets/cave-stage-ranking.mjs` only if the Priorities continue button is not enough to open Ranking
- Test: `tests/js/launch.test.mjs`

**Interfaces:**
- Consumes: `resolveLaunch`, `LAUNCH_KEY`, `LAUNCH_FRESH_MS`, `embedNow` (Task 3), `FIELD_KEY`, `DIG_KEY`/`FORM_KEY`, `AUTODIG_KEY`, `alignCategories`.
- Produces: `seedLaunch({ storage, launch, now }): void` exported from `cave-launch.mjs`: writes `FIELD_KEY`, `FORM_KEY` with `categories` joined and `lookback: 1`, `AUTODIG_KEY = now`, `LAUNCH_KEY = { id, at: now }`, and removes the stored Priorities prefs so sliders are defaults, then writes `launch.nudge` (when not null) as `prefer` for that leaf into the Priorities prefs.

- [ ] **Step 1: Failing tests** for `seedLaunch` using a fake storage object (`getItem`/`setItem`/`removeItem`): after seeding `ai/llms` over a stored quantum Dig form, `readStore` of the Dig key has categories starting `cs.AI`, lookback 1, `LAUNCH_KEY.id === 'ai/llms'`.
- [ ] **Step 2: Implement `seedLaunch`**; storage key names are imported, not retyped. `cave.js` calls it once when a launch resolves, and skips it when `LAUNCH_KEY` already holds the same id younger than `LAUNCH_FRESH_MS` (reload guard).
- [ ] **Step 3: Priorities mount end:** if `LAUNCH_KEY` is fresh, set the box to `launch.phrase`, wait for the `night` bus event, call `await embedNow()`, then press the continue button whether it returned true or false (embed failure must not stop the run); clear `LAUNCH_KEY`.
- [ ] **Step 4: Ranking opens through the existing flow** after Priorities completes; verify by manual run of `/?launch=quantum/spin-qubits`.
- [ ] **Step 5: Commit** `feat(cave): launch links dig, embed and rank on their own`.

### Task 5: Train progress strip

**Files:**
- Create: `docs/assets/cave-launch-strip.mjs`
- Modify: `docs/assets/cave.js` (mount the strip above `#cave-rail` while a launch runs), `docs/assets/cave.css`
- Test: `tests/js/launch.test.mjs`

**Interfaces:**
- Produces: `stripHtml(step: 'dig'|'embed'|'rank'|'done'|'error', label: string): string` returns the markup: three wagon chips (Dig, Embed, Rank), the current one marked `aria-current="step"`, finished ones `is-done`, a locomotive element that CSS slides to the active wagon; `prefers-reduced-motion` stops the slide.

- [ ] **Step 1: Failing tests:** `stripHtml('embed', 'spin qubits')` has `aria-current="step"` on exactly the Embed wagon, `is-done` on Dig only, and contains the escaped label; `stripHtml('error', 'x')` carries `is-error`.
- [ ] **Step 2: Implement; step 3: wire** transitions from the `night` event (dig to embed), the `embedNow` start and end (embed to rank), and the ranking `ranked` bus event (done, then the strip fades).
- [ ] **Step 4: Run tests; manual run in light and dark theme; commit** `feat(cave): train strip for launch links`.

### Task 6: Docs and full run

**Files:**
- Modify: `docs/details.md` (one short section: launch links, the Embed button)
- Modify: `README.md` only if it lists URLs

- [ ] **Step 1:** Document the supported launch URLs from `LAUNCHES`.
- [ ] **Step 2:** Run `for f in tests/js/*.test.js; do node $f; done` and `node --test tests/js/launch.test.mjs`; all green.
- [ ] **Step 3: Commit** `docs(cave): launch links and embed button`.
