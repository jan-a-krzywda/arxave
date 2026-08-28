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
  three rooms hand you papers. This one says how they were picked, so you can
  decide whether to believe the ranking before you spend an evening on what it
  put at the top.
</div>

## What arXave is

arXiv drops hundreds of papers a night. Nobody reads hundreds. So everyone reads
titles, picks twenty, and walks past the rest — including, some nights, the one
paper that would have changed what they built next month.

arXave washes the whole night pile against a description of what *you* work on,
grades every rock it touches, and hands back a short list with a reason attached
to each one. The reason is the product. A ranking you cannot argue with is a
ranking you cannot trust.

Two goals, only two:

1. **Never miss the nugget that matters.**
2. **More tunnel swept per hour**, with less fool's gold carried home.

## The four rooms

| Room | What it is | When you want it |
|------|-----------|------------------|
| [Dig]({{ '/' | relative_url }}) | The filter itself, live in your tab. Describe your seam, pull tonight's arXiv, watch the ranking move as you tune it. | You want to *set up* a seam, or wash a night by hand. |
| [Stockpile]({{ '/stockpile/' | relative_url }}) | Everything ever hauled up and kept, by month and day, filterable by seam and grade. | You half-remember a paper, or want to see what a seam has been yielding. |
| [Haul]({{ '/haul/' | relative_url }}) | Tonight's pay dirt, split by seam, as feeds you can point a reader at. | You want papers to arrive without you visiting anything. |
| Details | This page. | Now. |

Dig is the workshop, Stockpile is the archive, Haul is the delivery. Same
papers, same grades, three ways in.

## How a rock gets graded

The nightly run is seven stages. Each one is idempotent and resumable, so an
interrupted run picks up where it stopped rather than starting over or
double-charging.

```
scout  ->  summarize  ->  filter  ->  refs  ->  connect  ->  rank  ->  brief
haul       chip open      first       read      match to     weigh    hold up
the pile   each rock      sieve       the vein  your bag     stone    the gold
```

- **scout** — pull the night's pile out of arXiv. The window counts *publishing*
  days, not calendar days; arXiv does not announce on weekends, so a calendar
  lookback returns an empty haul every Monday.
- **summarize** — a small model chips each rock open: what it asks, what it
  found, what it admits it did not do.
- **filter** — first sieve. A rock that misses your seam goes back on the pile —
  but it is written down first, with the score that threw it back.
- **refs** — read the vein. Each paper's bibliography comes straight out of its
  arXiv e-print source (`.bbl`/`.bib`), not from a citation index. See
  [below](#why-the-bibliography-comes-from-arxiv) for why that matters.
- **connect** — intersect that bibliography with your own corpus. Where they
  cross is the "Connection" line on the card.
- **rank** — weigh every surviving stone on the signals actually present.
- **brief** — a larger model holds up the top N and argues why each looks like
  gold.

### The three signals, and the ones deliberately missing

Ranking scores a paper on three things, and only three:

1. **Match to your seam** — model judgment against the touchstones you wrote.
2. **Centrality in your own library** — how much of your corpus this paper's
   bibliography actually touches.
3. **Crowd attention** — and this one *saturates*, on purpose. A paper everyone
   is shouting about cannot outrank one that genuinely touches your work.

Not signals at all: venue, author fame, institution, press release, how confident
the abstract sounds. That is the pyrite defence. Fool's gold costs double — the
evenings you spend on it, plus the real nugget you did not pick up because your
hands were full — and every one of those excluded signals is a way pyrite gets
picked up.

Where a signal is missing, the ranking renormalises over the signals that *are*
present. A paper is never scored "nobody cares" because a source was unreachable.

## Bands: pay dirt, worth a look, long shot

A grade is not comparable between nights — a thin Tuesday and a fat Thursday
produce different absolute numbers from the same seam. So a paper's band is set
on its **z-score against that night's own spread**:

| Band | What it means |
|------|---------------|
| **Pay dirt** | Above the pay-dirt line. The assay was confident. Read these. |
| **Worth a look** | Over the ship line but under the pay-dirt line. Shipped honestly, labelled honestly. |
| **Long shot** | Under the ship line, or a night with no spread to measure against. In the feed because the floor guarantees a minimum haul, not because the assay backed it. |

The band is a confidence label, not a second gate. That is what makes shipping
below the pay-dirt line honest instead of padding. On a night with no spread,
nothing can be claimed, so everything is a long shot by definition.

**"No pay dirt today" is information.** An empty top band means the dig ran and
found nothing exceptional — a different message from a feed that looks broken,
so it is said out loud rather than left as absence.

## Reading a card

Every paper ships folded. A card opens with the byline and the one-line finding,
and everything else sits in six drawers you open only if the finding earns it:

| Drawer | What is inside |
|--------|----------------|
| **Figure** | The paper's own key figure, with a gloss saying what to look at. |
| **Asks** | The question the paper set itself. |
| **Before** | What the state of things was before this paper. |
| **But** | The caveat. What it does not show, and what the authors concede. |
| **Tools** | The methods, hardware, or codebase it leans on. |
| **Abstract** | The original abstract, unedited. |

The fold is the point. A month of open cards is not a page anyone scrolls, and a
card read in the Stockpile in December reads exactly as it did the morning it
shipped, because it is built from the same archived fields.

## Seams and presets

A **seam** is one dig setup: the touchstones, the core samples, the weights and
the gate. A **preset** is a seam this repo ships as a claim about what matters in
one tunnel — currently spin qubits, quantum error correction, and quantum machine
learning. Each preset feeds a nightly feed on the [Haul]({{ '/haul/' | relative_url }}).

Inside [Dig]({{ '/' | relative_url }}) you set a seam in three stages:

1. **Haul the stones** — where the pile comes from, and how wide a window.
2. **Filter** — **touchstones** (free text, one thought per row), **core samples**
   (papers you already care about, by DOI or arXiv ID, or a `.bib` upload), and
   the weight on each.
3. **Assay** — how much comes up, and where the gate sits.

Take a preset, bend it, keep it. Edits save themselves, and a claim can be
exported as JSON and imported again — including on someone else's machine, which
is the point: a seam is the most transferable thing here.

Dig narrow. "Quantum computing" is not a seam, it is the whole mountain —
everything comes through it, and nearly all of it is pyrite.

## Where the compute runs

The Dig page is static. Nothing you type is uploaded to arXave, because there is
no arXave server to upload it to — touchstones, core samples and weights live in
your browser tab and survive a reload because they are stored there, not on a
server.

Two things do leave the tab, and both go to a Supabase edge function:

- **`embed`** — the *pick*, the model that turns text into a vector
  (`allenai/specter2_base`, trained on a citation graph, so papers that cite each
  other land near each other). It runs server-side, so your browser downloads no
  model. Text sent there is embedded and thrown away.
- **`relay`** — arXiv itself, because a browser cannot fetch arXiv directly:
  it sends no CORS header.

**One thing to know about the cache.** Published text — arXiv abstracts, core
sample abstracts, and the touchstones this repo ships as presets — additionally
goes into a shared vector cache keyed by a hash of the text, so nobody pays for
the same cut twice. **A touchstone you typed yourself never enters that cache.**
Reads on it are public, and a hash of a short phrase is one dictionary away from
the phrase.

<div class="wip-note" markdown="1">
Earlier versions of this page embedded in the browser and promised nothing you
typed left the tab. That is no longer how it works, and the paragraph above
replaces that promise.
</div>

## Why the bibliography comes from arXiv

The obvious way to find a paper's references is a citation index. It does not
work for the papers arXave exists to catch. Measured against the live OpenAlex
API on 2026-07-20:

1. **Index lag.** Of 61 papers scouted that morning, a sample of 12 resolved in
   OpenAlex **zero** times. A same-day preprint is simply not there yet.
2. **Preprint records carry no reference list.** Even when an arXiv DOI does
   resolve, the record is a stub — the references live on the *published*
   version, under a different DOI. arXiv:2112.08863 ("Semiconductor Spin Qubits")
   resolves to `W4320341678` with **0** references, while the Rev. Mod. Phys.
   record for the same paper, `W4380590907`, has **664**.

So arXave reads the bibliography out of the paper's own LaTeX source, which every
preprint ships with itself. Zero index lag, works on a day-one preprint — exactly
the paper arXave cares about. OpenAlex stays as a fallback for the ones the
`.bbl` route cannot connect.

A missing reference list is a fact about the index, not about the paper, so the
brief is written to read correctly when no connection exists: the model must name
which of your topics a paper touches, and is forbidden from claiming a paper is
disconnected from your library.

## Running it yourself

The site is one way in. The other is the CLI, which runs the same pipeline on
your machine against your own corpus, with your own model keys:

```bash
uv venv --python 3.11
uv pip install -e ".[dev]"
cp .env.example .env          # one LLM key, or a local LM Studio
$EDITOR config/arxave.yaml    # your topics — this is your seam

arxave run                    # whole pipeline -> briefs/<today>.md
arxave render                 # rebuild any past brief, zero LLM calls
arxave serve                  # local UI at http://127.0.0.1:8765
```

Two models, two roles. A **light** one does per-paper work (summarize, filter)
and runs once per scouted paper, so it eats most of the cost. A **heavy** one
writes the brief and runs only for the top N. They are configured separately and
can point at different providers.

Everything the pipeline touches — kept *and* thrown back, with the score that
decided which — lands in `papers.db`. So you can change your seam later and
re-wash an old pile without re-fetching or re-paying, and "did I see this in
March?" is a question the bag can answer.

Full setup in the [README]({{ site.github_repo }}#readme).

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
**Where the numbers on this page come from.** The band rules are
`bandOf` in `scripts/preset-feed.mjs`; the drawers are the six folds built in
`docs/stockpile.md` and the feed stylesheet; the ranking signals are `rank.py`.
The OpenAlex measurements were taken against the live API on 2026-07-20 and are
recorded in the README.
</div>

<link rel="stylesheet" href="{{ '/assets/style.css' | relative_url }}">
