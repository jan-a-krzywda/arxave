# Cave v3 — one page, merging Dig and Sieve

Status: FINAL SPEC. Implementation happens in a separate chat; see "Handoff" at the end.

## Goal

One page replaces `/filter/` (Dig) and `/sieve/`. A reader opens it, optionally types
what they care about, and gets tonight's arXiv ranked. Defaults are good enough that
touching nothing still works. Everything else is reachable but folded away.

## Controls (top to bottom)

1. **Input box** (kept). Free text: touchstone abstracts, titles, or a few sentences.
   Empty box is valid: ranking then uses topics + surprise only.
2. **Three sliders**, in this order:
   - **Topic match** — how strictly a paper must sit in the chosen topics (and, when the
     box has text, near the touchstones). Replaces "Strictness". Default 50.
   - **Surprise** — weight on novelty / impact relative to the weighted background.
     Default 50.
   - **Experiment ↔ Theory** — two-ended, default centre = no preference. Left favours
     experimental/hardware papers, right favours theory.
3. **Topics**, hierarchical, parent first (see below). Default: every topic enabled; the Computing parent is set to Prefer, all other parents Equal.
4. Results list.
5. Collapsed "Advanced": Refine (LLM), corpus window, export. Nothing else.

## Topic tree

Parents expand to children. Default: all enabled, weight 1, except Computing's children at Prefer (weight 1.5). A parent row has one
dropdown (Equal / Prefer / Avoid / Off) that sets its children together; each child has
the same dropdown to override. No numeric inputs. "Reset topics" restores the default.

| Parent | Children |
|---|---|
| Computing | Optimisation & quantum algorithms · Quantum machine learning · Error-correcting codes · Fault-tolerant computing & roadmaps |
| Measurement | Tomography & metrology · Quantum sensing |
| Matter | Many-body physics · Quantum materials (superconductivity, magnetism, 2D) |
| Light & atoms | Cold atoms & quantum optics · Cavity QED |
| Foundations & gravity | Foundations · Gravity & holography |

Cross-cutting tag **ML for quantum** is a filter chip, not a topic: it marks papers that
use ML on quantum problems (decoders, tomography, control) on top of their primary topic.

Assignment rules for overlapping pairs:
- Error-correcting codes = constructions and decoders; Fault-tolerant & roadmaps =
  hardware demos, resource estimates, advantage claims.
- Quantum sensing = physical devices; Tomography & metrology = estimation theory, state learning.
- Many-body = dynamics and thermalisation theory; Quantum materials = material-specific.
- Cavity QED = light–matter coupling in a cavity; Cold atoms & optics = everything else there.

Each paper gets one primary topic, plus an optional secondary when the runner-up is close.
Primary counts fully for sliders and topic weights, secondary counts at half.

"Foundations & gravity" is in, decided by the maintainer: without it about 13% of the corpus
would have no home. It is Equal by default. Only Computing is preferred by default.

## Data changes

- **Topics**: re-assign corpus papers with hand-labelled seed papers per topic (about 25
  each) and nearest-centroid on the SPECTER2 vectors; ship `topics.json` (tree + centroids)
  and `corpus.json` `topic` / `topic2` arrays. Replaces the 20 k-means clusters.
- **Experiment↔Theory axis**: one direction in the SPECTER2 space, fitted on hand-labelled
  seeds (about 60 each side) with logistic regression; ships as a 768-vector. Score is a
  projection, so tonight's candidates get it in the browser with no extra service. Report
  held-out accuracy in the PR; below 80% the slider is hidden, not shipped.
- **ML-for-quantum tag**: same method, one more direction.

## Look

- Keep the pixel, cave-like art (`cave-wall.svg`, `haul-wall.svg`, `stockpile-wall.svg`
  family) as the page's identity: header band and empty states.
- The interface itself follows modern product-UI patterns found on Mobbin, not pixel
  art: calm neutral surfaces, one accent, real type scale. Pixel art stays decoration.

References gathered (Mobbin):
- Filter panel with collapsible groups, applied-filter chips and "Clear filters":
  Upwork all-filters drawer — https://mobbin.com/screens/e4973c2b-adc2-4bb3-965c-1b0da9dc50a3
- Dropdown with grouped, searchable options: Upwork location picker —
  https://mobbin.com/screens/d817873a-5458-41db-b563-13ca6d3ec51b ; incident.io type filter —
  https://mobbin.com/screens/47217935-caa2-4b2e-89a8-9b2f6556c885
- Compact filter bar of dropdown chips above a list, with Clear Filters: Sprig —
  https://mobbin.com/screens/59544c88-4416-40a7-97c0-787c2149e9dd
- Centered search box with a quiet filter row, text-first feed: Voicenotes —
  https://mobbin.com/screens/337da877-cf5b-4350-a315-750f8df1baaf
- Dense but readable list with grouped sections and row-level status: Plane —
  https://mobbin.com/screens/b274b760-5c97-4900-ae57-115489320c86

Layout: desktop = left column (box, sliders, topic tree), right column results;
phone = box and sliders on top, topics in a bottom sheet behind one "Topics" chip,
applied-topic chips under the box.

## Cards (Cline), each with oracle tests

- C1 topics: seeds, `topics.json`, reassignment script, tests (every paper has a primary,
  tree is consistent, seed recall ≥ 90% leave-one-out).
- C2 axes: Experiment↔Theory and ML-for-quantum directions, held-out accuracy report.
- C3 core: extend `sieve-core.mjs` — topic weights, secondary at half, three-slider score;
  pure functions, tests with hand-built fixtures.
- C4 page: merged page, markup, tree UI, sliders, mobile sheet; replaces filter and sieve
  routes (old URLs redirect).
- C5 art/style: pixel header and empty states, tokens, light/dark.

Claude writes this spec, reviews, integrates and verifies; Cline writes the code.

## Out of scope here

Rolling corpus refresh, upload-your-own background, user accounts.

## Handoff to the implementation chat

- Branch `cave-v3` (from `main`); this spec is the contract. Read `sieve2-spec.md` for the
  existing corpus formats, scoring and refine API that this builds on.
- Run order: C1 and C2 first (data), then C3 (core), then C4 and C5. C1/C2 can run in parallel.
- Rules carried over: Cline provider is always `cline`; Claude never patches Cline's code;
  the maintainer merges PRs; GitHub token has no `workflow` scope; Pages deploys only
  from `main`. Commit trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- The Mobbin MCP (`mcp__mobbin__*`) is configured at user scope in Claude Code. Cline's
  entry is in `~/.cline/data/settings/cline_mcp_settings.json` and still needs its own login.
- Hosted `embed` credit was topped up and a new `HF_TOKEN` set; the live Dig worked after that.
  The Refine button has not been checked end to end yet.
