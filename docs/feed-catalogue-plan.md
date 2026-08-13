# The feed catalogue — what breaks first, and how community feeds get in

> **Scope.** Everything needed to go from four hand-written presets to a
> catalogue strangers can add to. Written to be picked up cold: the three
> defects below are prerequisites for opening submissions at all, and the
> community plan after them assumes they are fixed.
>
> **Status 2026-08-13.** Four presets live: `spin-qubits`, `error-correction`,
> `superconducting-qubits`, `quantum-machine-learning`. Nothing in this document
> is built yet.

---

## Part 1 — What breaks before the money does

The economics are not the constraint and it is worth stating why up front, so
nobody builds a billing story that isn't needed.

**Cost scales with distinct papers surfaced per day, not with number of feeds.**
The enrichment cache in [`scripts/enrich.mjs`](../scripts/enrich.mjs) is keyed by
`arxivId` alone and written to one shared `docs/feeds/enrichment.json`, so a
paper landing in five feeds costs one Gemini call. Ten quant-ph presets over the
same ~250-paper announcement surface maybe 30–40 distinct papers a day, not 10×
anything. At roughly 1.5k input + 250 output tokens per paper on
gemini-2.5-flash that is **on the order of $1–2/month** (re-check current
pricing before quoting this anywhere). Embedding is local on the runner, Actions
is free on a public repo, and the dig-cache sits inside Supabase's free tier with
the retention job already in place.

So the owner paying for it is not a meaningful commitment, and the page should
say so rather than implying a funding model that doesn't exist. What actually
runs out is arXiv's patience, Gemini's rate limit, and git.

### 1.1 arXiv fetch fan-out — blocks opening submissions

[`scripts/preset-feed.mjs`](../scripts/preset-feed.mjs), in `main()`, loops
presets and inside each one loops that preset's categories calling
`fetchAbstracts`. Four presets on quant-ph today means four identical GETs of
`rss.arxiv.org/rss/quant-ph` in one job. Thirty community presets means thirty.

`warm-dig.mjs` already fetches each category once; the feed builder does not
share that work or its own.

**Fix.** Hoist the fetch into a per-category memo built once before the preset
loop, keyed by category string. Small and self-contained — the loop already
dedupes by `arxivId` into `seen`, so only the fetch itself moves.

This is the one that gets the project noticed by arXiv, and it must land before
anyone outside the repo can add a preset.

### 1.2 Enrichment has no rate limit and no budget — blocks opening submissions

`enrichItems` in [`scripts/enrich.mjs`](../scripts/enrich.mjs) loops items
sequentially with no spacing and no ceiling. Gemini's free tier is roughly
10 requests/minute and 250/day. Forty cold papers in a burst will take 429s.

The dangerous part is the interaction with the module's own design principle:
**failure is soft on purpose**, so a rate-limited morning produces feeds that are
silently unenriched — grades and abstracts, no verdict line — and nothing in the
job reports a problem. The counters already exist (`hits`, `called`, `failed`)
and are only `console.log`'d.

**Fix, three parts:**
- Space the calls (a few hundred ms between them is enough for 10 RPM).
- A per-run ceiling on `called`, so one pathological morning cannot burn the
  daily quota; items past the ceiling ship unenriched, which is the existing
  soft-failure path.
- Make a high `failed` count visible — a workflow warning annotation, or a
  non-zero exit once the feeds are already written. Silence is the bug here,
  not the failure.

### 1.3 Git churn — decide before there are thirty feeds

Every feed is a committed XML file, plus `enrichment.json` growing daily. Four
feeds is nothing; thirty feeds committed every weekday is repo size and a commit
log that is almost entirely bot.

The alternative is building feeds inside the Pages job and publishing them as
build output rather than committing them. That loses the "feed history is in git"
property, which may or may not be wanted — it is currently the only record of
what was recommended on a given day.

**This is the one decision that is expensive to reverse later**, so make it while
the catalogue is still small. Not urgent for four feeds; urgent before twenty.

---

## Part 2 — Measurements from the first quant-ph day

Recorded because the next person will otherwise re-derive them. All from
2026-08-13, 66 papers in the quant-ph announcement.

| preset | n | median | MAD | z≥2.0 | top paper |
|---|---|---|---|---|---|
| error-correction | 66 | 0.618 | 0.027 | **2** | Trapping Sets of Detector Error Models (z=3.04) |
| quantum-machine-learning | 66 | 0.649 | 0.034 | 0 | Hamilton-Zero: neural tensor-network foundation model (z=1.89) |
| superconducting-qubits | 66 | 0.616 | 0.023 | 0 | A 12-CNOT Double Qubit Excitation Gate (z=1.98) |
| spin-qubits | 87 | 0.605 | 0.023 | 0 | A 12-CNOT Double Qubit Excitation Gate (z=1.89) |

**Three of four feeds were empty, and that is the gate working, not failing.**
`error-correction` found two genuinely on-topic papers and shipped exactly those
two. The other three had nothing on-topic in the day's announcement.

**The failure mode to watch:** when a preset has no on-topic paper, what floats to
the top is generic quantum-computing abstracts — the same "12-CNOT Double Qubit
Excitation Gate" leads both `superconducting-qubits` and `spin-qubits` at
z≈1.9. These sit just under the z=2.0 cut. This is a pre-existing property of the
scoring, not something the new presets introduced, and the gate is what stops
them shipping. **Do not lower `min_z` below 2.0 to make quiet feeds less empty** —
that is precisely the change that would fill every feed with the same generic
paper and teach people to stop opening them.

**Open question — categories.** All four presets currently scout `quant-ph` only
(spin-qubits also takes `cond-mat.mes-hall`). Superconducting-qubit *device*
papers largely announce in `cond-mat.supr-con`. Tested on 2026-08-13: adding
`cond-mat.supr-con` + `cond-mat.mes-hall` took the pool from 66 to 91 papers and
changed nothing at the top — but that day had no superconducting-qubit hardware
paper in any category, so the test is uninformative rather than negative. **Run
the quant-ph-only configuration for a week and count on-topic misses before
deciding.** Note that `ARXAVE_WARM_CATEGORIES` (a repo variable, currently
`quant-ph, cond-mat.mes-hall, cs.AI, cs.LG`) would need `cond-mat.supr-con` added
too, or those abstracts get embedded locally on every run instead of hitting the
warm cache.

**Rejected: adding `cs.LG` to `quantum-machine-learning`.** It would pull ~400
classical-ML abstracts into the pool, which become the median and MAD. The
day's baseline would then be computed over mostly-classical papers, making every
quant-ph QML paper a large outlier and flooding the feed. The z-gate only works
when the pool is a population the preset is a genuine minority within.

---

## Part 3 — Community feeds

The contribution unit is already right: a preset is one JSON file in
`docs/presets/`. What's missing is everything around it.

### 3.1 Review by output, not by diff

**The single highest-value piece.** A PR adding `docs/presets/<slug>.json`
triggers a job that builds that feed against today's announcement and posts the
rendered items as a PR comment.

Nobody can review a list of touchstone strings and eight DOIs. Everybody can
review *"these are the five papers it would have sent you this morning."*
Without this, preset review is unfalsifiable taste, and the catalogue's quality
depends entirely on the maintainer's patience.

The machinery already exists — `preset-feed.mjs --presets <dir> --out <dir>`
against a directory containing just the one new preset. Note that an empty
result is a *legitimate* outcome (see Part 2), so the comment must distinguish
"nothing cleared the bar today" from "this preset is broken", ideally by also
printing the top 5 by raw grade with their z-scores.

### 3.2 Schema and CI validation

There is no schema today; `loadPresets` trusts the file. Validate on PR:

- `slug` matches filename, is unique, and is `[a-z0-9-]+`
- `scout.categories` are real arXiv categories (fetch and check for HTTP 200)
- `touchstones[].weight` and `cores[].weight` in (0, 1]
- every `cores[].doi` resolves through OpenAlex — and **warn when it resolves
  without an abstract**, since `fetchCore` then falls back to embedding the title
  twice (see `coreEmbedText`), which is a materially weaker row. Two of the
  `quantum-machine-learning` cores are already in this state.
- `select.max_items` capped (15 is the current default and a reasonable ceiling)
- at least ~4 touchstones; cores optional

**Cores must stay optional.** They are the expensive human part — the eight
canonical DOIs that make a blend discriminate need someone who knows the seam. A
touchstones-only preset is worse but not broken, and requiring cores is what
would keep every field outside the maintainer's own out of the catalogue.

### 3.3 The catalogue itself

`docs/presets/index.json` is the catalogue and currently carries three fields
per entry (`slug`, `name`, `blurb`), consumed by
[`docs/assets/filter.js`](assets/filter.js) around line 3771 to render the preset
buttons. Extra fields are ignored harmlessly, so it can grow:

- `categories` — so the catalogue page can show what each feed watches
- `maintainer` — GitHub handle; this is also the auth model, see below
- `added` — ISO date
- `status` — `core` | `community` | `dormant`

Then generate a browsable `/feeds/` page from `index.json` so the catalogue and
the directory cannot drift. `loadPresets` already *warns* about drift between
index and directory (`warm-dig.mjs`, in the `try` around the manifest read) —
**make CI fail on it instead**, since a warning in a bot-run job is the same as
no check at all.

### 3.4 Auth, moderation, dormancy

**No accounts, no login, no submission form.** The GitHub PR *is* the auth: a
preset's maintainer is the handle that opened the PR. Building any identity
system here is strictly worse than the one already present.

**Dormancy over deletion.** An annual ping to each community maintainer; no
response flips `status: dormant`, the feed stops rebuilding, and the file and its
URL stay where they are. This is the only defence against a catalogue of forty
feeds nobody has read since 2027, it costs nothing to implement, and it costs a
lot of goodwill to introduce *after* people have contributed — so state the rule
in the contribution guide from day one.

**Deliberately not built:** per-user feed generation. That is the Dig page's job.
The feed is the shop window, not the shop.

---

## Suggested order

1. §1.1 fetch memo and §1.2 enrichment spacing/budget/visibility — prerequisites.
2. Run the four current presets for a week; answer the categories question in §2.
3. §1.3 commit-vs-build decision, while the catalogue is still four files.
4. §3.2 schema + §3.1 PR preview job.
5. §3.3 catalogue page, §3.4 contribution guide with the dormancy rule stated.

Steps 1 and 2 are independent and can run in parallel — 2 is just waiting.
