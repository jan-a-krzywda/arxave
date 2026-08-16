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

> **Superseded 2026-08-16 — bands.** The paragraph above is still right about
> the danger and wrong about the only defence. Its unstated assumption is that a
> feed has one bit to spend, in or out, so the only way to protect the reader is
> to spend it strictly. That cost more than it saved: three of four feeds shipped
> empty on the day measured above, and an empty XML file is what a prospective
> subscriber sees when they click the feed link *before* subscribing — the
> catalogue's own shop window, dark, on a day the page was showing those same
> papers at the top of the assay.
>
> So the feed now ships down to `soft_z` and **labels** what it shipped:
> **Pay dirt** above `min_z`, **Worth a look** between the two, **Long shot**
> below. `min_z` is unchanged at 2.0 and still names the papers the assay stood
> behind — it stopped being the thing that decides alone who travels. The
> 12-CNOT paper at z≈1.9 now ships wearing a *Worth a look* chip, which is an
> accurate description of it, and a reader skips it in the second it takes to
> read the chip. **The rule that replaces the one above: never ship an unlabelled
> paper below `min_z`.** Lowering an unmarked bar is what teaches people to stop
> opening a feed; lowering a labelled one does not, because the feed never
> claimed more than it had.
>
> **What the ship line must not be set to, and why.** A z cut is a cut on the
> *day's own distribution*, so low down it returns a fixed quantile of the
> announcement and nothing else. Simulated over four preset shapes — a tight
> blob, a wide blob, a blob with 2 real hits, a blob with 6 — the counts at each
> bar are:
>
> | shape | z≥1.0 | z≥1.5 | z≥2.0 | z≥2.5 | z≥3.0 |
> |---|---|---|---|---|---|
> | pure blob, sd 0.02 | 10 | 4 | 1 | 0 | 0 |
> | pure blob, sd 0.05 | 12 | 4 | 2 | 0 | 0 |
> | blob + 2 real hits | 12 | 5 | 2 | **2** | **2** |
> | blob + 6 real hits | 14 | 8 | 6 | **6** | **6** |
>
> At z≥1.0 the count is ~11 whether or not the preset found anything — the bar
> is inside the bulk, where the normal approximation holds and every preset
> looks identical. Only past z≈2 does the count start carrying information,
> because that is where a real cluster of on-topic papers is the *only* thing
> that produces a tail. **So "how many shipped" is not a quality signal at any
> low bar and must never be read as one; the band split is.** Measured over the
> 2026-08-12→16 window at the defaults below, the four live presets ship 8 / 3 /
> 8 / 8 papers and 5 / 0 / 3 / 2 pay dirt — the counts converge, the pay dirt
> does not.
>
> Ship line was 1.0 for one commit and shipped 14–15 per preset, all four
> hitting the ceiling: a fixed ~8% slice of the announcement. **1.5 is the
> default** and the ceiling dropped to 8.
>
> **The open problem this does not solve.** z has no absolute anchor, so no
> setting of it can distinguish "this preset had a good day" from "this preset
> had a normal day". The anchor that would is already in every preset file: the
> **core samples are on-topic by construction**, so scoring a preset's cores
> against its own touchstones gives a per-preset reference for what an on-topic
> paper scores, fixed across days. Ship against that and a quiet day is quiet
> because the grades are low, not because the day's own median moved. Not built.
>
> `min_items` remains the floor and now reaches down to a fifth number,
> `long_z` (default 0.5), so a night with nothing on it produces a short list of
> admitted long shots rather than a file that reads as broken. Setting `long_z`
> up to the ship line restores the old empty-or-nothing behaviour in one number.
> The counts to watch are in the manifest: `feeds[slug].paydirt` beside
> `feeds[slug].items`. **If the pay-dirt count sits at zero for a fortnight, the
> preset is the problem, not the gate** — that is the signal the old strict cut
> was destroying by shipping nothing either way.

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

## Part 4 — Where user-defined feeds actually go

> Written 2026-08-14 alongside the issue #50 fixes. Amends §3.4's flat "no
> per-user feeds" into three tiers, because "accept everything" and "curate
> everything" are both wrong and the split between them is cheap.

**Tier 1 — private feed, automatic, unlisted.** A claim serialises to a hash;
the nightly job builds `feeds/u/<hash>.xml` from the same warm dig cache. No PR,
no name, no review, not in `index.json`. This is where "accept all" is safe:
nobody's catalogue is polluted by it, and the marginal cost is near zero because
enrichment is keyed by `arxivId` and already shared (Part 1). It is also the
honest answer to "can I have my own feed" — yes, immediately, no gatekeeping.

**Tier 2 — the catalogue, entered by demand rather than by taste.** A private
feed becomes a candidate when someone other than its author subscribes, or when
its author opens a PR. Then §3.1's build-and-show-the-output review applies. The
promotion rule matters more than the review: "this feed has readers" is
evidence, and "this feed sounds interesting" is not.

**Tier 3 — dormancy**, exactly as §3.4 already specifies.

### Grouping similar setups — compare outputs, not phrasings

The obvious move is to cluster presets by embedding their touchstones and
taking cosines. Don't. Two people describing the same seam in different
vocabulary score low; two people describing different seams in shared jargon
score high. Both errors are invisible to the person being told.

**Compare what the feeds ship.** Build both over the same 7 days and take the
Jaccard overlap of the arXiv IDs that cleared each one's gate. Above ~0.6 they
are the same feed however differently they are written, and the bot can say
something falsifiable:

> `ships 4 of the same 5 papers as spin-qubits this week — co-maintain that one
> instead of adding a slug?`

This is the "coordinate similar people" mechanism, and it pays twice: a preset
with two maintainers survives one of them going quiet, which is the failure
§3.4's dormancy ping is otherwise left to catch alone.

**Dependency.** Overlap scoring needs feed history. If §1.3 moves feeds from
committed XML to build output, keep a small per-day ledger of
`slug → [arxivIds]` — a few KB a day, and the only thing overlap needs. Decide
this *with* §1.3, not after it.

---

## Suggested order

1. §1.1 fetch memo and §1.2 enrichment spacing/budget/visibility — prerequisites.
2. Run the four current presets for a week; answer the categories question in §2.
3. §1.3 commit-vs-build decision, while the catalogue is still four files.
4. §3.2 schema + §3.1 PR preview job.
5. §3.3 catalogue page, §3.4 contribution guide with the dormancy rule stated.
6. §4 tier 1 (hash-addressed private feeds), then the overlap ledger.

**Done since.** The gate is on the Dig page: stage 3 carries `select`
(`min_z`, `soft_z`, `min_items`, `max_items`) as live controls, and the readout
beside them counts — against the night on screen — how many papers a feed built
from this claim would carry. `gateOver` in `docs/assets/filter.js` is a second
implementation of `selectItems`, held to it by `tests/js/gate.test.js`; change
one and change both. This is what §3.1's "review by output" needs a person to be
able to do before they open the PR, and what makes §4 tier 1 a setting someone
can tune rather than a number they inherit. Claims also gained **Clear**, and
carry `select` on export — so an exported claim is a preset file with its cut
already set.

`docs/feeds/index.json` — the feed manifest, written by
`preset-feed.mjs` and read by the page — landed with the issue #50 fixes. It
already carries `items` and `updated` per slug, so §3.3's catalogue page has its
data source and the page no longer links a feed before it exists.

Steps 1 and 2 are independent and can run in parallel — 2 is just waiting.
