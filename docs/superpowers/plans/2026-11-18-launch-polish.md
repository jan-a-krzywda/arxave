# Launch Polish: Hero Line, Feeds Room, Lift Ride, Lone Cart

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** (1) a punchy one-line hero; (2) a Feeds room in the nav listing every launch link; (3) while a launch loads, the lift rides smoothly down to Ranking with a large "on our way" box on the right, replacing the cart strip; (4) when nothing matches, a lone cart in the wind says so loudly above the closest papers.

**Architecture:** Feeds is a static Jekyll page whose list is rendered from `LAUNCHES` by a pure `feedsHtml`. The ride reuses the rail's existing lift (`--lift-floor`) with a slower transition while riding, plus a fixed overlay built by a pure `rideHtml`. The cart drawing moves from the strip (deleted) into the no-match panel.

**Tech Stack:** Static Jekyll on GitHub Pages, ES modules in `docs/assets/`, `node --test`.

**Spec:** the user's request of 2026-11-18 after #155 merged (four points: no-match visibility with a lone cart and wind; a "Feeds" menu entry reusing the haul icon; lift ride plus "on our way" box instead of the moving cart; hero text "arXiv drops hundreds of papers a night. Let's dig together.").

## Global Constraints

- Hero copy, exactly: `arXiv drops hundreds of papers a night. Let's dig together.` The "Six stages…" sub line goes.
- Overlay copy: heading `On our way…`, line `Your ranking should be here in a few seconds.`, plus the launch label.
- No-match panel copy: heading `No match today`, line `Nothing on tonight's arXiv is close to your words, so here are the closest ones.`, then the closeness in small text.
- Nav order: Dig, Feeds, Stockpile, Details. Feeds uses the `haul` icon and gloss `topics`. `haul.md` stays as a page but leaves `header_pages`.
- "launch", never "preset" in code (RSS feeds own "preset"); the reader-facing word is "Feeds".
- `cave-launch.mjs` stays free of imports (a test enforces it).
- Theme tokens only for colour; `prefers-reduced-motion`: no ride animation (the lift jumps), no wind, overlay and text still shown.
- Tests: `node --test tests/js/launch.test.mjs tests/js/match.test.mjs tests/js/feeds.test.mjs`. Older `claims`, `gate`, `lazy-pick` fail without our changes; ignore.

## Review Focus

- A reload or a click on the rail during the ride must not leave the lift stuck at Ranking after the run ends; the ride override clears on `ranked` and on failure paths.
- A launch on a phone (no lift below 900 px): the overlay alone, not covering the cards' controls permanently.
- Weak verdict keeps the small one-line banner; only `none` gets the big panel.
- The Feeds page must work with JS off: a `<noscript>` line pointing to the Cave, not an empty page.

---

### Task 1: Hero line

**Files:** Modify `docs/cave.md` (the `.cave-lede` and `.cave-sub` paragraphs); `docs/assets/cave.css` only if `.cave-sub` rules become dead (remove them). Test: `tests/js/launch.test.mjs`.

- [ ] **Step 1: Failing test:** `docs/cave.md` contains the exact hero copy and does not contain `cave-sub` or `Six stages`.
- [ ] **Step 2: Run, FAIL. Step 3: Edit. Step 4: Run, PASS. Commit** `feat(cave): one-line hero`.

### Task 2: Feeds room

**Files:** Create `docs/feeds.md` (front matter: `layout: page`, `title: Feeds`, `permalink: /feeds/`, `gloss: topics`, `nav_icon: haul`), `docs/assets/feeds-page.mjs`, `docs/assets/feeds.css`; Modify `docs/_config.yml` (`header_pages`); Test: `tests/js/feeds.test.mjs`.

**Interfaces:**
- Consumes: `LAUNCHES` from `cave-launch.mjs`, `escapeHtml` from `sieve-ui.mjs`.
- Produces: `feedsHtml(launches): string`: one section per field in the order fields first appear (Quantum, AI headings from `cave-fields.mjs` `fieldById(id).label`), each launch a card `<a class="feeds-card" href="/<field>/<slug>">` with the label, the categories, and the phrase in a smaller line.

- [ ] **Step 1: Failing tests:** `feedsHtml(LAUNCHES)` contains 12 `feeds-card` links, each `href` equal to `'/' + launch.id`; two section headings `Quantum` and `AI`; labels are escaped (feed a fake launch with `<b>`); `_config.yml` `header_pages` lists `cave.md, feeds.md, stockpile.md, details.md` in that order; `feeds.md` front matter has `nav_icon: haul` and contains a `<noscript>`.
- [ ] **Step 2: Run, FAIL. Step 3: Implement** the module and the page (a container element plus `<script type="module">` that imports the module and fills it; one short intro line: "Pick a topic. Each one digs tonight's arXiv and ranks it for you."). Cards in a responsive grid (one column at phone width).
- [ ] **Step 4: Run, PASS. Commit** `feat(site): Feeds room lists every launch link`.

### Task 3: Lone cart for "no match"

**Files:** Modify `docs/assets/cave-match.mjs` (`matchBannerHtml` for state `none`), `docs/assets/cave-ranking.css`; Test: `tests/js/match.test.mjs`.

**Interfaces:**
- Produces: `CART_SVG` exported from `cave-match.mjs` (the cart drawing, copied from `cave-launch-strip.mjs`'s `CART`, wheels static). `matchBannerHtml({state:'none', top3})` returns `<div class="cave-match-panel is-none" role="status">` holding: a scene (`.cave-match-scene` with the cart and three `.cave-match-wind` streak spans), `<p class="cave-match-head">No match today</p>`, the copy line, and `<p class="cave-match-close">closeness 0.66</p>`. Other states unchanged.

- [ ] **Step 1: Failing tests:** for `none`: contains `cave-match-panel`, `No match today`, the copy line (apostrophe escaped as the module escapes it), three `cave-match-wind`, `cave-match-close` with the two-decimal number; `weak` still returns the one-line `cave-match-banner is-weak`; CSS has a keyframe animation on `.cave-match-wind` and a reduced-motion rule that hides or stops it.
- [ ] **Step 2: Run, FAIL. Step 3: Implement**; the panel is large (centred, generous padding) so it reads before the list; wind streaks are thin lines drifting left to right past the cart, slow (3 to 5 s), staggered.
- [ ] **Step 4: Run, PASS. Commit** `feat(cave): lone cart says when nothing matches`.

### Task 4: Lift ride and "on our way" box (replaces the strip)

**Files:** Delete `docs/assets/cave-launch-strip.mjs` and its CSS block in `docs/assets/cave.css`; Create `docs/assets/cave-launch-ride.mjs`; Modify `docs/assets/cave.js` (strip mount and `paintStrip` go; `paintRail`/`moveLift` honour a ride floor), `docs/assets/cave.css`; Test: `tests/js/launch.test.mjs` (strip tests replaced).

**Interfaces:**
- Produces: `rideHtml(label: string): string` → `<aside class="cave-ride" role="status">` with `On our way…`, the line, and the escaped label; `RIDE_MS = 6000` (the slow lift transition while riding).
- `cave.js`: `let rideFloor = null`; `moveLift(rideFloor ?? visitFloor ?? floor)` in `paintRail`; while a launch runs, add class `is-riding` to `#cave-app` (CSS sets the cage transition to `transform var(--ride-ms) ease-in-out`), set `rideFloor = STAGES.indexOf('ranking')`, mount the overlay into `document.body`. On the `ranked` bus event: clear `rideFloor`, remove `is-riding`, fade the overlay out and remove it, and smooth-scroll `#stage-ranking` into view.

- [ ] **Step 1: Failing tests:** `rideHtml('Spin qubits')` contains the heading, line and label, with `role="status"`; a `<b>` label is escaped; `cave-launch-strip.mjs` no longer exists; `cave.js` does not import it, imports `rideHtml`, contains `rideFloor ??`; `cave.css` has a `.cave-ride` rule (fixed, right side at ≥900 px, bottom sheet below) and a reduced-motion rule that removes the slow transition.
- [ ] **Step 2: Run, FAIL. Step 3: Implement**; the overlay is large (about 22rem wide on desktop, big type), above the content (`z-index`), and does not block clicks on the cards outside it.
- [ ] **Step 4: Remove the old strip tests** and keep every other launch test green. **Step 5: Commit** `feat(cave): ride the lift down while a launch loads`.

### Task 5: Docs

**Files:** Modify `docs/details.md` (the launch paragraphs mention the cart strip; describe the ride and the overlay, the lone-cart panel, the Feeds room; keep the numbers).

- [ ] Run all tests above. Commit `docs: ride, lone cart, Feeds room`.
