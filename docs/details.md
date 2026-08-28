---
layout: page
title: Details
permalink: /details/
gloss: how it works
nav_icon: details
---

<div class="cave-wall cave-wall-left" aria-hidden="true"></div>
<div class="cave-wall cave-wall-right" aria-hidden="true"></div>

<div class="status-banner">
  <strong>What the machine does, and what it refuses to do.</strong> The other
  three rooms hand you papers. This one says how they were picked — the actual
  arithmetic, with the measured numbers — so you can decide whether to believe
  the ranking before you spend an evening on what it put at the top.
</div>

<div class="toc-card" markdown="1">
**On this page**

* toc
{:toc}
</div>

## What arXave is

arXiv drops hundreds of papers a night. Nobody reads hundreds. So everyone reads
titles, picks twenty, and walks past the rest — including, some nights, the one
paper that would have changed what they built next month.

arXave washes the whole night pile against a description of what *you* work on,
grades every abstract it touches, and hands back a short list with a reason
attached to each one. The reason is the product. A ranking you cannot argue with
is a ranking you cannot trust.

Two goals, only two:

1. **Never miss the nugget that matters.**
2. **More tunnel swept per hour**, with less fool's gold carried home.

## The four rooms

| Room | What it is | When you want it |
|------|-----------|------------------|
| [Dig]({{ '/' | relative_url }}) | The assay itself, live in your tab. Describe your seam, pull tonight's arXiv, watch the ranking move as you tune it. | You want to *set up* a seam, or wash a night by hand. |
| [Stockpile]({{ '/stockpile/' | relative_url }}) | Everything ever hauled up and kept, by month and day, filterable by seam and grade. | You half-remember a paper, or want to see what a seam has been yielding. |
| [Haul]({{ '/haul/' | relative_url }}) | Tonight's pay dirt, split by seam, as feeds you can point a reader at. | You want papers to arrive without you visiting anything. |
| Details | This page. | Now. |

Dig is the workshop, Stockpile is the archive, Haul is the delivery. Same
papers, same grades, three ways in.

## How a paper gets its grade

There is no language model anywhere in the ranking. **A grade is a weighted mean
of cosine similarities**, taken between one paper's abstract and the rows of your
seam, in a space that has had a constant subtracted from it. That is the whole
assay, and every step of it is below.

The same arithmetic runs in two places — [`docs/assets/filter.js`](https://github.com/jan-a-krzywda/arxave/blob/main/docs/assets/filter.js)
when you press the button, and [`scripts/preset-feed.mjs`](https://github.com/jan-a-krzywda/arxave/blob/main/scripts/preset-feed.mjs)
when the nightly feeds are built. Two implementations of one formula is a
standing risk: both produce plausible numbers, neither throws, and a divergence
shows up only as the feed quietly recommending papers the page would not. They
are pinned to each other by a parity test for exactly that reason.

### 1. Haul — the night's pile

arXiv's own listing, per category, through a small relay (a browser cannot fetch
arXiv directly — it sends no CORS header). Up to 400 per category.

The window counts **publishing days, not calendar days**. arXiv does not announce
on weekends, so a calendar lookback returns an empty haul every Monday.

### 2. Cut — every abstract becomes a vector

Each abstract goes through *the pick*: `allenai/specter2_base`, 768 dimensions,
trained on a citation graph so that papers which cite each other land near each
other. Your touchstones and core samples go through the same model, in the same
request shape — the blend below compares them directly, so a second model at the
same dimension would produce plausible scores and no error at all.

Vectors are cached and shared, keyed by model, dimension and a hash of the text,
so nobody pays to cut the same abstract twice. A nightly job warms that cache
before anyone asks, which is why a haul is usually a download rather than a
computation.

### 3. Centre — the step that makes cosine mean anything

**This is the one that matters, and it is the least obvious.**

SPECTER2's vectors do not spread over the sphere. They sit in a narrow cone.
Measured 2026-08-19 over 1241 warmed vectors, the mean of the unit vectors has
norm **0.913** — nine tenths of every vector points the same way as every other
vector, carrying nothing at all about the paper. A raw cosine reads that shared
direction along with the signal, so every pair of arXiv abstracts scores in a
narrow high band and everything the model actually said is the ordering *inside*
that band.

So every vector is pushed out of the cone before anything is compared:

```text
        v                                    û − μ
  û = ─────        centre(v)  =  c(v) = ───────────────
      ‖v‖                                  ‖û − μ‖
```

where **μ** is a fixed corpus centroid, measured once and shipped as a literal
in both files. What that buys, on the same 1241 vectors:

| pairwise cosine | p5 | p50 | p95 | spread |
|---|---|---|---|---|
| raw | 0.766 | 0.832 | 0.903 | 0.137 |
| centred | −0.300 | −0.030 | 0.385 | **0.685** |

Five times the spread, from subtracting a constant.

**This is not a re-ranking.** The ordering barely moves, because the shared
direction is shared. What changes is whether anything downstream can *read* the
ordering — a grade window 0.115 wide and a threshold table crammed between 0.92
and 0.96 were both measuring a signal a tenth the size of the offset sitting on
top of it.

**μ is fixed, not the night's own mean.** Centring on tonight's stones would make
a paper's grade depend on what else happened to be announced that night, and two
hauls of the same paper would disagree. It would also put two different
geometries behind one cache key. Measured once, shipped as a constant, a paper's
coordinates stay a property of the paper.

μ belongs to `allenai/specter2_base` and nothing else. A different model's cone
points somewhere else, and this constant would then subtract a direction that
means nothing — silently. Re-measure with `node scripts/measure-centroid.mjs`
when the pick changes, and update both files.

### 4. Blend — the grade

Everything is a unit vector in the centred space, so the cosine is just the dot
product:

```text
  cos(a, b) = a · b = Σ aᵢ bᵢ           (768 terms, both unit)
```

A paper's grade is the weighted mean of its cosine against every row of your
seam — each touchstone, each core sample, at whatever weight you set it:

```text
              Σ wᵣ · cos( c(paper), c(rowᵣ) )
  grade(p) = ────────────────────────────────      rows with wᵣ ≤ 0 skipped,
                        Σ wᵣ                        0 when nothing scored
```

That is the entire ranking function. Measured on one 631-stone night against the
spin-qubits preset, centred:

| | p5 | p50 | p95 | max |
|---|---|---|---|---|
| single feature cosine | −0.256 | 0.014 | 0.348 | 0.641 |
| blended grade | −0.266 | −0.136 | 0.294 | 0.465 |

A grade is a *mean* of a dozen cosines, and averaging pulls everything toward the
middle — which is why the grade column in the assay measures its colour ramp
against the night's own fifth percentile rather than a fixed scale. A fixed
domain drew that column as one flat bar whatever the numbers underneath it did.

No negative cosine is clamped to zero. Centred, the median pair scores about
−0.03 and a fifth-percentile pair scores −0.30: roughly half of every coupling
map is negative, and flattening those to zero would throw away half the
separation that centring just bought.

### 5. Gate — z-scores, not thresholds

A grade is not comparable between nights. A thin Tuesday and a fat Thursday give
different absolute numbers from the same seam. So the feed cuts on a **robust
z-score** — median and MAD, not mean and standard deviation, so one runaway paper
cannot move the bar it is being measured against:

```text
            grade − median(grades)
  z(p) =  ──────────────────────────        1.4826 · MAD ≈ σ for a normal
              1.4826 · MAD(grades)
```

Median and MAD are location- and scale-invariant, which is why the gate survived
the centring step untouched. Same night, before and after:

| | grade spread | top-paper z | papers z ≥ 2 |
|---|---|---|---|
| raw | 0.115 | 5.51 | 96 |
| centred | 0.560 | 5.46 | 98 |

Five times the grade spread and the z barely moves.

Defaults: `min_z 2.0` (the pay-dirt line), `soft_z 1.5` (the ship line),
`long_z 0.5`, `min_items 3`, `max_items 8`. A degenerate spread — every paper
identical, or too few to have one — has no baseline to be above, so the feed
falls back to plain top-N and every item is a long shot by definition.

**Why the ship line is not the pay-dirt line.** A gate that ships only `z ≥ min_z`
spends its one bit of information on the papers it is least sure about, and three
of four presets shipped completely empty on 2026-08-13. An empty file is what a
prospective subscriber sees when they click a feed link *before* subscribing. So
the feed ships down to `soft_z` and **labels** what it shipped. Lowering an
unlabelled bar teaches people to stop opening a feed; lowering a labelled one
does not, because the feed never claimed more than it had.

**Why there is a floor at all.** A pure z-gate punishes a preset that matches its
own category. Measured 2026-08-15 over a two-weekday corpus:

| preset | n | median | σ | best grade | best z | z ≥ 2 |
|---|---|---|---|---|---|---|
| quantum-machine-learning | 51 | 0.652 | 0.055 | 0.728 | 1.37 | 0 |
| spin-qubits | 62 | 0.617 | 0.035 | 0.684 | 1.92 | 0 |
| error-correction | 51 | 0.621 | 0.039 | 0.718 | 2.45 | 3 |

Quantum machine learning scouts quant-ph and matches half of it — 27 of 51 stones
above 0.65 — so the baseline rises *and* the spread widens, and the best paper of
the day lands 1.37σ out. That feed shipped empty while the page showed the same
papers at the top of the assay. **The better a preset fits its archive, the harder
its own gate bites**, which is why a relative gate cannot be the only rule.
`min_items` reaches down to `long_z` when fewer than three clear the ship line.
`max_items` is a ceiling for a rich day, never a target: a quiet day is supposed
to produce a short feed, and a day with nothing is supposed to produce nothing.

### 6. Read — the only place a language model appears

The handful of papers that clear the gate get read **in full**, by Gemini
(`gemini-3.7-flash`, with a fallback), and turned into the fixed card fields
below. Not the abstract — arXiv's own HTML rendering of the paper, trimmed to
introduction and conclusion, because *what the number was measured under* and
*what the previous best was* are stated there and nowhere else.

This runs **after** the ranking, on tens of papers a day rather than hundreds. It
cannot promote anything: a model never sees a paper the cosine already dropped,
and never changes the order of the ones it did not.

### 7. Ship

The graded, gated, read items become a feed per seam ([Haul]({{ '/haul/' | relative_url }}))
and a row per paper in the archive ([Stockpile]({{ '/stockpile/' | relative_url }})),
carrying the same fields, so a card read in December reads exactly as it did the
morning it shipped.

## The train, the wagons, and the graph

Ranking gives you an order. It does not tell you what the night was *about*. So
Dig also groups the haul, and draws it.

**The coupling map.** One N×N matrix of cosines over the centred stone vectors,
built once per haul:

```text
  S[i][j] = cos( c(paperᵢ), c(paperⱼ) )        symmetric, S[i][i] = 1
```

**The wagons.** Agglomerative clustering on S with **average linkage**, merging
the two groups with the highest mean similarity, updated in place by
Lance-Williams:

```text
                  1
  d(A, B)  =  ───────  Σ  Σ  S[a][b]           mean over all cross pairs
               |A||B|  a∈A b∈B

  merged row:  d(A∪B, M) = ( |A|·d(A,M) + |B|·d(B,M) ) / (|A| + |B|)
```

Wagons used to be connected components at a threshold, which is **single**
linkage — and single linkage chains: one paper sitting between two topics joins
them, so A–B–C becomes one wagon even when A and C share nothing. Measured
2026-08-20, same nights, single → average:

| haul | n | wagons | clustered (share of night) |
|---|---|---|---|
| mes-hall + quant-ph | 89 | 4 → 11 | 26 → 63 (29% → 71%) |
| four categories | 336 | 13 → 45 | 88 → 210 (26% → 63%) |
| four categories | 631 | 26 → 89 | 176 → 422 (28% → 67%) |

More wagons *and* more of the night placed — which is the tell that the old
clustering was not trading coverage for purity, it was chaining. Under single
linkage one wagon held all 89 stones at 58 of the slider's 101 positions.

**The cut.** The dendrogram is built once, in O(N²); cutting it at a threshold is
O(N), which is what makes the slider live. Default cut **0.46**, minimum wagon
size 3. Swept across three hauls:

| cut | 89 stones | 336 stones | 631 stones |
|---|---|---|---|
| 0.30 | 7 | 34 | 56 |
| 0.40 | 8 | 42 | 69 |
| **0.46** | **11** | **45** | **89** |
| 0.50 | 10 | 37 | 75 |
| 0.60 | 3 | 11 | 28 |
| 0.65 | 1 | 3 | 16 |

0.46 is the default because it is where the sweep lands on all three. The
readable band is about 0.35–0.55: below 0.25 groups swallow each other, above
0.60 they crumble. None of these numbers transfer if the pick, the centroid, or
the linkage changes.

**The graph.** A force layout over the same matrix, with an edge wherever the
cosine clears the cut. Clustered stones are carried to their wagon's slot;
loose stones are pushed around by repulsion and pulled by springs whose rest
length shortens as the cosine rises:

```text
  t = (cos − cut) / (1 − cut)        L = 92 − 46·t        F = (d − L)·k·(0.4 + t)
```

Springs act only on edges with a loose stone at one end. An edge *inside* a wagon
joins two already-placed stones, and it was exactly those springs — faithfully
reconstructing the cosine geometry of a tight topical cluster — that drew every
wagon as a straight line.

Naming a wagon is a separate, explicit button, because it calls a metered API and
the threshold slider re-forms every wagon on each nudge. Settle the threshold,
then ask.

## Bands: pay dirt, worth a look, long shot

| Band | What it means |
|------|---------------|
| **Pay dirt** | `z ≥ min_z`. The assay was confident. Read these. |
| **Worth a look** | `soft_z ≤ z < min_z`. Shipped honestly, labelled honestly. |
| **Long shot** | Under the ship line, or a night with no spread to measure against. In the feed because the floor guarantees a minimum haul, not because the assay backed it. |

The band is a confidence label, not a second gate. That is what makes shipping
below the pay-dirt line honest instead of padding.

**"No pay dirt today" is information.** An empty top band means the dig ran and
found nothing exceptional — a different message from a feed that looks broken, so
it is said out loud rather than left as absence.

## Reading a card

Every paper ships folded. A card opens with the byline and the one-line finding,
and everything else sits in six drawers you open only if the finding earns it:

| Drawer | What is inside |
|--------|----------------|
| **Figure** | The paper's own key figure — named by the model, because Figure 1 is very often only the schematic — with a caption rewritten for someone who has not read the paper. |
| **Asks** | The question the paper set itself, taken from the introduction where it is stated plainly rather than from the abstract where it is implied by the answer. |
| **Before** | What the best previous answer was, and how far this moves it. The single most valuable field, and the one an abstract almost never gives: "3.4 ms" means nothing, "3.4 ms, was 1.1 ms on the same device" means everything. |
| **But** | The conditions and assumptions the number is under. Empty when the paper states none — never invented to fill the slot. |
| **Tools** | The methods, hardware, or codebase it leans on, for filtering by eye. |
| **Abstract** | The original abstract, unedited. |

Nothing in a card restates the paper. The abstract is already a summary and it is
the author's own; a generated paragraph beside it would have to be better than it
to be worth the reader's eye. Every field is instead something the abstract makes
a reader dig for.

The fold is the point. A month of open cards is not a page anyone scrolls.

## Seams and presets

A **seam** is one dig setup: the touchstones, the core samples, the weights, and
the gate. A **preset** is a seam this repo ships as a claim about what matters in
one tunnel — currently spin qubits, quantum error correction, and quantum machine
learning. Each preset drives a nightly feed on the [Haul]({{ '/haul/' | relative_url }}).

Inside [Dig]({{ '/' | relative_url }}) you set one in three stages:

1. **Haul the stones** — where the pile comes from, and how wide a window.
2. **Filter** — **touchstones** (free text, one thought per row) and **core
   samples** (papers you already care about, by DOI or arXiv ID, or a `.bib`
   upload), each with a weight. These are the `rowᵣ` in the blend above.
3. **Assay** — how much comes up, and where the gate sits.

Take a preset, bend it, keep it. Edits save themselves, and a claim exports as
JSON and imports again — including on someone else's machine, which is the point:
a seam is the most transferable thing here.

Dig narrow. "Quantum computing" is not a seam, it is the whole mountain —
everything comes through it, and by the table in §5 a preset that matches its own
category is the one whose gate bites hardest.

**A touchstone's length matters.** A one-word touchstone and a paragraph-long one
are not directly comparable: longer text is more specific, and the cosine reads
that. The per-row weights are the mitigation.

## What is deliberately not a signal

Nothing about a paper except its text reaches the grade. Not the venue, not the
author list, not the institution, not how many people are posting about it, not
how confident the abstract sounds. There is no citation count in the browser
assay and no popularity term anywhere in it.

That is the pyrite defence. Fool's gold costs double — the evenings you spend on
it, plus the real nugget you did not pick up because your hands were full — and
every one of those excluded signals is a way pyrite gets picked up.

The honest consequence: on a night with nothing for your preset, the assay comes
out dark and the feed comes out short. That is the truth about the night. An
earlier colour ramp reported every night as a good one, which is the failure this
is the fix for.

## Where the compute runs

The Dig page is static. Nothing you type is uploaded to arXave, because there is
no arXave server to upload it to — touchstones, core samples and weights live in
your browser tab and survive a reload because they are stored there.

Two things do leave the tab, both to a Supabase edge function:

- **`embed`** — the pick. It runs server-side, so your browser downloads no
  model. Text sent there is embedded and thrown away.
- **`relay`** — arXiv itself, server-side, because the browser cannot reach it.

**One thing to know about the cache.** Published text — arXiv abstracts, core
sample abstracts, and the touchstones this repo ships as presets — additionally
goes into a shared vector cache keyed by a hash of the text, so nobody pays to
cut the same text twice. **A touchstone you typed yourself never enters that
cache.** Reads on it are public, and a hash of a short phrase is one dictionary
away from the phrase.

You can point the page at your own encoder. Set `window.ARXAVE_EMBED` to any
OpenAI-shaped `/v1/embeddings` — your own LM Studio, Ollama, or a paid endpoint —
and it will use that instead. The request and response shapes are identical
either way, which is why there is one code path and not two. Note that the
centroid in §3 is measured for SPECTER2 specifically.

<div class="wip-note" markdown="1">
Earlier versions of this page ran the encoder inside the browser and promised
that nothing you typed left the tab. That is no longer how it works, and the
paragraph above replaces that promise.
</div>

## The other shaft: the CLI

Everything above is the machine behind this website. There is a second, older
one: a Python pipeline you run on your own machine, against your own corpus, with
your own model keys. It is a different design — a language model reads and judges
every paper, which costs real money per night and buys a written brief rather
than a ranking you can tune live.

```
scout  ->  summarize  ->  filter  ->  refs  ->  connect  ->  rank  ->  brief
haul       chip open      first       read      match to     weigh    hold up
the pile   each rock      sieve       the vein  your bag     stone    the gold
```

```bash
uv venv --python 3.11
uv pip install -e ".[dev]"
cp .env.example .env          # one LLM key, or a local LM Studio
$EDITOR config/arxave.yaml    # your topics — this is your seam

arxave run                    # whole pipeline -> briefs/<today>.md
arxave render                 # rebuild any past brief, zero LLM calls
arxave serve                  # local UI at http://127.0.0.1:8765
```

Every stage is idempotent and resumable, so an interrupted run picks up where it
stopped rather than starting over or double-charging. Everything it touches —
kept *and* thrown back, with the score that decided which — lands in `papers.db`,
so you can change your seam and re-wash an old pile without re-fetching, and "did
I see this in March?" is a question the bag can answer.

Its ranking uses three signals and only three: model judgment against your seam,
citation centrality inside your own library, and crowd attention — and crowd
attention **saturates**, so a paper everyone is shouting about cannot outrank one
that actually touches your work.

### Why its bibliographies come from arXiv, not a citation index

The obvious way to find a paper's references is a citation index. It does not
work for the papers arXave exists to catch. Measured against the live OpenAlex
API on 2026-07-20:

1. **Index lag.** Of 61 papers scouted that morning, a sample of 12 resolved in
   OpenAlex **zero** times. A same-day preprint is simply not there yet.
2. **Preprint records carry no reference list.** Even when an arXiv DOI resolves,
   the record is a stub — the references live on the *published* version, under a
   different DOI. arXiv:2112.08863 ("Semiconductor Spin Qubits") resolves to
   `W4320341678` with **0** references, while the Rev. Mod. Phys. record for the
   same paper, `W4380590907`, has **664**.

So it reads the bibliography out of the paper's own LaTeX source, which every
preprint ships with itself. Zero index lag, works on a day-one preprint — exactly
the paper arXave cares about. OpenAlex stays as a fallback.

A missing reference list is a fact about the index, not about the paper, so the
brief is written to read correctly when no connection exists: the model must name
which of your topics a paper touches, and is forbidden from claiming a paper is
disconnected from your library.

## What is not built yet <span class="wip">WIP</span>

Said plainly, because a tool that overstates itself is pyrite about itself.

- **Corpus signal in the browser** — title-only today. Needs full abstract
  embeddings.
- **Crowd attention** — Scirate sits behind a bot challenge, so the signal is
  parked and its slider stays disabled until another source exists.
- **Citation overlap in the browser** — needs a backend; only the CLI has it.
- **An LLM refine step in Dig** — not wired up.
- **A shared store** — one nightly run feeding a store that miners can open to
  each other. A bag is only worth so much alone; the point of a bag is opening it
  in front of another miner. Not built.

<div class="cave-footnote" markdown="1">
**Where every number on this page comes from.** The centroid, the cone
measurements, the ramp domains, the linkage change and the threshold sweep are
measured constants in `docs/assets/filter.js`, re-measurable with
`scripts/measure-centroid.mjs`. The blend, the z-score, the gate defaults and the
band rules are `grade`, `selectItems` and `bandOf` in `scripts/preset-feed.mjs`,
pinned to the browser's by a parity test. The card fields are `scripts/enrich.mjs`
and `scripts/fulltext.mjs`. The CLI's three signals are `src/arxave/rank.py`. The
OpenAlex measurements were taken against the live API on 2026-07-20.

Every measurement is dated because none of them are universal: they are properties
of one embedding model on one archive, and the first thing to do after changing
either is to take them again.
</div>

<link rel="stylesheet" href="{{ '/assets/style.css' | relative_url }}?v={{ site.time | date: '%s' }}">
