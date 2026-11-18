---
layout: page
title: Details
permalink: /details/
gloss: how it works
nav_icon: details
---

<div class="cave-wall cave-wall-left" aria-hidden="true"></div>
<div class="cave-wall cave-wall-right" aria-hidden="true"></div>

<!-- Details, v12. Brief by rule: a table, a diagram or a control wherever a
     paragraph would do. The diagrams are TikZ (docs/diagrams/*.tex), compiled
     to SVG once and served as files; the calculator below re-implements
     promiseScore and orderNight from the page's own modules, so the numbers it
     shows are the numbers the ranking uses. -->

<div class="status-banner">
  <strong>How the Cave picks papers.</strong> No language model ranks anything.
  Every grade is a cosine, a percentile or a z-score, and every one is below —
  with the code that computes it and the paper it comes from.
</div>

<div class="toc-card" markdown="1">
**On this page**

* toc
{:toc}
</div>

## The six stages

<figure class="dt-fig">
  <img src="{{ '/diagrams/cave-flow.svg' | relative_url }}" width="560" alt="Dig, Train, Map, Priorities, Ranking, Story. Dig and Train fetch and embed; Map, Priorities and Ranking are arithmetic in the tab; Story and a few buttons call an LLM.">
  <figcaption>Blue: arithmetic in your tab. Green: embedding. Gold: an LLM call — never in the ranking. <a href="https://github.com/jan-a-krzywda/arxave/blob/main/docs/diagrams/cave-flow.tex">TikZ</a></figcaption>
</figure>

<div class="dt-stages" id="dt-stages">
  <div class="dt-tabs" role="tablist" aria-label="Stages"></div>
  <div class="dt-panel" role="tabpanel" aria-live="polite"></div>
</div>

## The grades

<figure class="dt-fig dt-fig-sm">
  <img src="{{ '/diagrams/cave-grades.svg' | relative_url }}" width="380" alt="Tonight's paper among corpus papers: Match is its cosine to a topic centroid or your words, Impact reads its 15 nearest corpus papers, Surprise is one minus its cosine to the nearest well-cited paper.">
  <figcaption>One paper, three questions, one pass over the corpus. <a href="https://github.com/jan-a-krzywda/arxave/blob/main/docs/diagrams/cave-grades.tex">TikZ</a></figcaption>
</figure>

| Grade | Raw value | Graded as | Code |
|---|---|---|---|
| **Match** | max cos to your words, else weighted mean cos to topic centroids | Φ(z), z vs corpus weighted median / MAD | `fitRaw`, `prepare` |
| **Impact** | citation percentile of the 15 nearest corpus papers, weighted cos⁺·(p+0.05) | Φ((x − μ)/σ), field's `promise_ref` | `rank` |
| **Surprise** | 1 − cos to nearest corpus paper with pct ≥ 0.75 | Φ((x − μ)/σ), field's `promise_ref` | `rank` |
| **Exp.** | logistic probe on the vector (96 train / 24 test, 92% held out) | 100 − P(theory) | `axisProbability` |
| **AI trace** | LLM's guess that the abstract is machine-written | its %, labelled a guess | `aitrace` fn |

Code: [`sieve-core.mjs`](https://github.com/jan-a-krzywda/arxave/blob/main/docs/assets/sieve-core.mjs),
[`cave-stage-ranking.mjs`](https://github.com/jan-a-krzywda/arxave/blob/main/docs/assets/cave-stage-ranking.mjs).

### Try it

Move a paper through the formula. Same code path as the Ranking card.

<div class="dt-calc" id="dt-calc">
  <div class="dt-calc-in">
    <label>Field
      <select data-k="field"><option value="quantum">Quantum</option><option value="ai">AI</option></select>
    </label>
    <label>Impact z <output data-o="zi"></output><input type="range" data-k="zi" min="-3" max="3" step="0.1" value="1"></label>
    <label>Novelty z <output data-o="zn"></output><input type="range" data-k="zn" min="-3" max="3" step="0.1" value="0.5"></label>
    <label>Match z <output data-o="zf"></output><input type="range" data-k="zf" min="-3" max="3" step="0.1" value="0.8"></label>
    <label>Surprise slider <output data-o="s"></output><input type="range" data-k="s" min="0" max="100" step="5" value="50"></label>
    <label>Topic match slider <output data-o="m"></output><input type="range" data-k="m" min="0" max="100" step="5" value="50"></label>
    <label class="dt-check"><input type="checkbox" data-k="solo"> single author (penalty slider at 50)</label>
  </div>
  <table class="dt-calc-out">
    <tbody>
      <tr><th>raw impact / novelty</th><td data-r="raw"></td></tr>
      <tr><th>β = 1.5·s − 1.25</th><td data-r="beta"></td></tr>
      <tr><th>sd = √(1 + β² + 2βρ)</th><td data-r="sd"></td></tr>
      <tr><th>Impact · Surprise · Match</th><td data-r="grades"></td></tr>
      <tr><th>Promise = Φ((zᵢ + β zₙ)/sd)</th><td data-r="promise"></td></tr>
      <tr><th>Row bar = (1−w)·Promise + w·Match − penalty</th><td data-r="rel"></td></tr>
    </tbody>
  </table>
</div>

<details class="dt-more">
<summary>Why novelty counts <em>against</em> a paper at Surprise 50</summary>
<div markdown="1">

Leave-one-out over the quantum corpus (each paper scored against the other 4 999):

| Signal vs own citation percentile | Spearman | AUC (top vs bottom quartile) |
|---|---|---|
| Impact | +0.28 | 0.67 |
| Novelty | −0.30 | 0.30 |
| old score (tonight's percentiles, ½ + ½) | — | 0.48 |
| Impact with novelty at β = −0.5 | — | **0.71** |

Far-from-everything papers are, on average, the ones nobody cites. Surprise 100 (β = +0.25) still lets you ask for them.
</div>
</details>

## The fields

Dig's **first** category picks the field: `cs.AI` first → AI, `quant-ph` first → Quantum. A list with both says so at load and offers the switch.

| | Quantum | AI |
|---|---|---|
| Categories | `quant-ph`, `cond-mat.mes-hall` | `cs.AI`, `cs.LG` |
| Corpus | 5 000 papers, Sep–Dec 2025 | 5 000 papers, Sep–Dec 2025 (top 2 500 cited + 2 500 random) |
| Topic tree | 12 leaves · 5 parents | 14 leaves · 6 parents |
| Seeds | 300 (25 per leaf) | 350 (25 per leaf, by title rules) |
| Leave-one-out seed recall | 0.927 | 0.926 |
| Impact μ / σ | 0.628 / 0.099 | 0.749 / 0.132 |
| Novelty μ / σ | 0.150 / 0.041 | 0.125 / 0.039 |
| ρ(impact, novelty) | −0.434 | −0.544 |
| Axes | Theory ↔ Experiment, ML for quantum | none yet |

A field is a whole pack — corpus, vectors, tree, axes — because a grade only means something against its own background.
Files: [`docs/assets/corpus/`](https://github.com/jan-a-krzywda/arxave/tree/main/docs/assets/corpus).

## Launch links

A launch link is `arxave.com/<field>/<slug>`: one publishing day in the field's own categories, ranked by one written phrase, landing on the ranking with no card to press. GitHub Pages has no rewrite rules, so the path arrives at the 404 page, which turns it into `/?launch=<field>/<slug>`; the Cave puts the clean address back into the bar, so a reload or a copied link means the same launch. Anything else — an unknown slug, a field that is not one of the two — stays a 404, never a half-started Cave.

While the run is going, a three-wagon train above the cards says which step is in hand (Dig, Embed, Rank), and the sliders come back at their defaults: the ranking belongs to the link, not to your last visit.

| Link | Digs | Prefers |
|---|---|---|
| [`/ai/llms`](https://arxave.com/ai/llms) | `cs.AI`, `cs.CL` ⚠ | — |
| [`/quantum/spin-qubits`](https://arxave.com/quantum/spin-qubits) | `cond-mat.mes-hall`, `quant-ph` | — |
| [`/ai/reinforcement-learning`](https://arxave.com/ai/reinforcement-learning) | `cs.LG`, `cs.AI` | `rl` |
| [`/quantum/quantum-error-correction`](https://arxave.com/quantum/quantum-error-correction) | `quant-ph` | `qec` |
| [`/ai/llm-agents`](https://arxave.com/ai/llm-agents) | `cs.AI`, `cs.LG` | `agents` |
| [`/quantum/superconducting-qubits`](https://arxave.com/quantum/superconducting-qubits) | `quant-ph`, `cond-mat.mes-hall` | `ft-roadmaps` |
| [`/ai/diffusion-models`](https://arxave.com/ai/diffusion-models) | `cs.LG`, `cs.CV` ⚠ | `generative` |
| [`/quantum/neutral-atoms`](https://arxave.com/quantum/neutral-atoms) | `quant-ph`, `physics.atom-ph` ⚠ | `cold-atoms` |
| [`/ai/interpretability`](https://arxave.com/ai/interpretability) | `cs.LG`, `cs.AI` | `interp` |
| [`/quantum/quantum-algorithms`](https://arxave.com/quantum/quantum-algorithms) | `quant-ph` | `opt-qalgo` |
| [`/ai/ai-safety`](https://arxave.com/ai/ai-safety) | `cs.AI`, `cs.LG` | `safety` |
| [`/quantum/quantum-sensing`](https://arxave.com/quantum/quantum-sensing) | `quant-ph`, `cond-mat.mes-hall` | `sensing` |

⚠ the field's corpus does not carry this code yet, so the first launch of that link embeds a new pack — about a minute before the ranking. The launch table is data in [`cave-launch.mjs`](https://github.com/jan-a-krzywda/arxave/blob/main/docs/assets/cave-launch.mjs); the phrases are the proposal's, [verbatim](https://github.com/jan-a-krzywda/arxave/blob/main/docs/superpowers/plans/2026-11-18-launch-presets-proposal.md).

**Your words go out when you send them.** Typing in the Priorities box no longer embeds anything: the text is kept, and one press of **Embed & rank** embeds it and re-ranks. A launch presses that button for you, with the link's phrase. Rank tonight without pressing it and the ranking uses the old vectors, and the note says your words were ignored; if the embed service is down, a launch still reaches the ranking on the old order and says why.

## The geometry

<figure class="dt-fig">
  <img src="{{ '/diagrams/cave-centre.svg' | relative_url }}" width="420" alt="Raw SPECTER2 vectors sit in a narrow cone; subtracting the corpus mean and renormalising spreads them around the sphere.">
  <figcaption>Subtract the corpus mean μ, renormalise. <a href="https://github.com/jan-a-krzywda/arxave/blob/main/docs/diagrams/cave-centre.tex">TikZ</a></figcaption>
</figure>

| pairwise cos (1 241 vectors, 2026-08-19) | p5 | p50 | p95 | spread |
|---|---|---|---|---|
| raw | 0.766 | 0.832 | 0.903 | 0.137 |
| centred | −0.300 | −0.030 | 0.385 | **0.685** |

SPECTER2 vectors share one direction (‖mean‖ = 0.913) [3, 4]. Centring is not a re-ranking — it makes the ranking *readable*.
Each field centres on its own corpus mean, after the same int8 clip the corpus was stored with (`corpusSpace`).

<details class="dt-more">
<summary>Topics, wagons and the clip, in one table</summary>
<div markdown="1">

| Piece | Rule | Number |
|---|---|---|
| Topic of a paper | nearest leaf centroid; runner-up kept if within | 0.03 cos |
| Leaf centroid | mean of its seed papers | 25 seeds |
| Topic weights | Prefer / Equal / Avoid / Off | 1.5 / 1 / 0.5 / excluded |
| Wagons | average linkage on the cos matrix [7] | cut 0.20–0.70, auto-picked |
| Largest wagon | capped so no blob swallows the night | ≤ 20% (floor 12) |
| Corpus clip | every component clamped before centring | ±0.25 (int8) |
| Match z | weighted median and 1.4826·MAD [6] | robust to one outlier |

</div>
</details>

## What leaves your tab

| Call | Sends | Model | When |
|---|---|---|---|
| `relay` | category, date range | — | Dig |
| `embed` | abstracts; your Priorities box | SPECTER2 [1, 2] | Train; **Embed & rank** |
| `wagon-name` | titles only | Gemini flash-lite, DeepSeek V4.1 Flash as fallback | Map, on the button |
| `diamond` | one paper | DeepSeek V4.1 Flash (default) | Ranking → Summarize |
| `aitrace` | abstracts on screen | DeepSeek V4.1 Flash (default) | Ranking → AI trace button |
| `story` | ≤ 12 picks | DeepSeek V4.1 Flash (default) | Story |

Abstracts are cached by text hash so nobody pays twice. **What you type is never cached.**
Everything else — weights, picks, stories — lives in your browser's storage.

## Not built yet <span class="wip">WIP</span>

| | Status |
|---|---|
| Haul, Stockpile | greyed out in the bar while the Cave is rebuilt |
| Discuss threads | button greyed; GitHub Discussions wiring parked |
| AI-field axes | no Theory ↔ Experiment probe for AI yet |
| Bring your own LLM key | not on this page |
| Command-line pipeline | separate, older design in [<code>src/arxave/</code>](https://github.com/jan-a-krzywda/arxave/tree/main/src/arxave) |

## Sources

<ol class="dt-refs">
  <li>Singh et al., <em>SciRepEval: A Multi-Format Benchmark for Scientific Document Representations</em>, EMNLP 2023. <a href="https://arxiv.org/abs/2211.13308">arXiv:2211.13308</a> — SPECTER2.</li>
  <li>Cohan et al., <em>SPECTER: Document-level Representation Learning using Citation-informed Transformers</em>, ACL 2020. <a href="https://arxiv.org/abs/2004.07180">arXiv:2004.07180</a></li>
  <li>Ethayarajh, <em>How Contextual are Contextualized Word Representations?</em>, EMNLP 2019. <a href="https://arxiv.org/abs/1909.00512">arXiv:1909.00512</a> — the cone.</li>
  <li>Mu &amp; Viswanath, <em>All-but-the-Top: Simple and Effective Postprocessing for Word Representations</em>, ICLR 2018. <a href="https://arxiv.org/abs/1702.01417">arXiv:1702.01417</a> — subtract the mean.</li>
  <li>Priem, Piwowar &amp; Orr, <em>OpenAlex: A fully-open index of scholarly works</em>, 2022. <a href="https://arxiv.org/abs/2205.01833">arXiv:2205.01833</a> — the corpus' citation counts.</li>
  <li>Leys et al., <em>Detecting outliers: Do not use standard deviation around the mean, use absolute deviation around the median</em>, J. Exp. Soc. Psychol. 49 (2013). <a href="https://doi.org/10.1016/j.jesp.2013.03.013">doi</a> — MAD × 1.4826.</li>
  <li>Lance &amp; Williams, <em>A general theory of classificatory sorting strategies: 1. Hierarchical systems</em>, Comput. J. 9 (1967). <a href="https://doi.org/10.1093/comjnl/9.4.373">doi</a> — average linkage update.</li>
  <li>arXiv, <a href="https://info.arxiv.org/help/api/">API documentation</a> — the nightly listing.</li>
</ol>

<p class="cave-footnote">Every number here is a property of one model on one archive, and is dated or reproducible:
<code>scripts/cave-promise-ref.mjs</code>, <code>scripts/cave-topics.mjs</code>, <code>scripts/measure-centroid.mjs</code>.</p>

<link rel="stylesheet" href="{{ '/assets/style.css' | relative_url }}?v={{ site.time | date: '%s' }}">
<link rel="stylesheet" href="{{ '/assets/details.css' | relative_url }}?v={{ site.time | date: '%s' }}">
<script type="module" src="{{ '/assets/details.mjs' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
