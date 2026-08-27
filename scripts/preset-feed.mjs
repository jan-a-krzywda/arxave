/**
 * preset-feed — the day's announcement, assayed against a preset, as RSS.
 *
 * One feed per preset in docs/presets/, written to docs/feeds/<slug>.xml and
 * committed by the same workflow that warms the cache. A subscriber gets the
 * preset's default view of today; anyone who wants to move the weights follows
 * the link back into the Dig, where the matrix is visible and a slider re-blends
 * with no fetch. The feed is the shop window, not the shop.
 *
 * THE RISK THIS FILE CARRIES: it is a second implementation of the assay.
 * `computeGrades()` in docs/assets/filter.js is the first. If they disagree, the
 * feed quietly recommends different papers than the page does for the same
 * preset, and nothing throws — the same class of silent divergence that
 * warm-dig's parse tests exist to prevent. So the blend lives in one small
 * exported function, `grade()`, pinned by fixtures in preset-feed.test.mjs
 * against hand-computed values taken from the browser's formula:
 *
 *     grade = Σ (w · cos(stone, row)) / Σ w      over rows that have a vector
 *
 * Rows without a vector leave the denominator entirely rather than scoring
 * zero — a core sample that failed to resolve must not drag a paper down.
 *
 * Usage:
 *   node scripts/preset-feed.mjs --presets ../docs/presets --out ../docs/feeds
 *
 * Flags:
 *   --presets   directory of preset claims (required)
 *   --out       directory to write <slug>.xml into (required)
 *   --endpoint  dig-cache URL (default: the project's deployed function)
 *   --top       how many papers per feed (default 8)
 *   --embed     embed URL (default: the project's deployed function)
 *   --site      absolute base URL used for links back into the Dig
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  DEFAULT_EMBED, DIM, MODEL, deLatex, embedChunk, fetchAbstracts, fetchEarlier,
  loadPresets, resolveEndpoint, sha256Hex,
} from './warm-dig.mjs';
import { enrichItems } from './enrich.mjs';
import { deMath } from './demath.mjs';

const READ_CHUNK = 500;
const BATCH = 64;    // under embed's MAX_TEXTS (96, measured), same as the warmer
/* Per category, and a window that has to reach a date rather than fill a
   screen — the warmer's number, for the same reason it is not the page's 200:
   quant-ph alone announces enough in a day to bottom the window out mid-run. */
const LOOKBACK_MAX = 400;
/* The canonical domain, not the github.io one Pages also answers on. Every
   link inside a feed is absolute and outlives the file it came in, so a wrong
   default here ships wrong URLs into people's readers. Verified against the
   live site: arxave.com serves /feeds/spin-qubits.xml. Overridable with
   $ARXAVE_SITE for a fork or a staging deploy. */
const DEFAULT_SITE = 'https://arxave.com/';

function arg(name, fallback = null) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/**
 * One stone's blended grade. The browser's formula, deliberately verbatim.
 *
 * `rows` are {vector, weight}; a row with no vector or a non-positive weight is
 * skipped on both sides of the fraction. Returns 0 when nothing scored, which
 * is what an empty denominator means in the page too.
 */
export function grade(stoneVector, rows) {
  let num = 0;
  let den = 0;
  for (const row of rows) {
    if (!row || !row.vector || !(row.weight > 0)) continue;
    num += row.weight * cosine(stoneVector, row.vector);
    den += row.weight;
  }
  return den > 0 ? num / den : 0;
}

/* ── The corpus centroid ──────────────────────────────────────────────────
 *
 * BYTE-IDENTICAL TO `CORPUS_CENTROID_B64` IN docs/assets/filter.js, and pinned
 * to it by the parity test. The reasoning lives there; the short version is
 * that SPECTER2's vectors sit in a cone whose axis carries no information
 * about the paper, and subtracting it is what makes a cosine over them mean
 * anything. Measured over 1241 warmed vectors, the axis accounts for 0.913 of
 * every unit vector's length.
 *
 * This file has to carry it because it is the second implementation of the
 * assay — the one this file's header already names as its standing risk. A
 * feed grading in the raw space while the page grades in the centred one is
 * exactly the silent divergence that header is about: both produce plausible
 * numbers, neither throws, and the feed quietly recommends different papers.
 *
 * Re-measure with `node scripts/measure-centroid.mjs` and update BOTH files.
 */
const CORPUS_CENTROID_B64 =
  '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';

export const CORPUS_CENTROID = (() => {
  const buf = Buffer.from(CORPUS_CENTROID_B64, 'base64');
  return Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
})();

/** L2-normalize a copy. */
function normalize(v) {
  let sum = 0;
  for (const x of v) sum += x * x;
  const n = Math.sqrt(sum);
  if (!n || !Number.isFinite(n)) return Array.from(v);
  return Array.from(v, (x) => x / n);
}

/**
 * Out of the cone: subtract the corpus centroid and renormalize. The browser's
 * `center()` in docs/assets/filter.js, verbatim — applied at the same point in
 * the pipeline, to the stone vectors and the row vectors together, so that
 * every cosine either side of the fence is taken in the same space.
 */
export function center(v) {
  if (!v) return v;
  const u = normalize(v);
  for (let i = 0; i < u.length; i++) u[i] -= CORPUS_CENTROID[i];
  return normalize(u);
}

const LABEL_MAX = 80;

/**
 * What to call a preset row in the feed.
 *
 * A touchstone is already a short phrase a reader wrote. A core sample's embed
 * text is its title and abstract run together in one line, so slicing a label
 * out of that yields half a title — `fetchCore` carries the title separately
 * for exactly this.
 */
export function rowLabel(row) {
  const label = String(row?.title || row?.text || '').trim().replace(/\s+/g, ' ');
  if (label.length <= LABEL_MAX) return label;
  return label.slice(0, LABEL_MAX - 1).trimEnd() + '…';
}

/**
 * The preset row this paper matched most strongly.
 *
 * The grade alone is a bare number: the item says 0.612 and the reader has no
 * way to tell whether that came from the line about valley splitting or the one
 * about charge noise. This names it, which both explains the recommendation and
 * tells someone whose feed has drifted which row to go and edit.
 *
 * Deliberately NOT part of `grade()` — that function mirrors the browser's
 * blend verbatim and is pinned to it, so nothing else may grow inside it.
 */
export function bestRow(stoneVector, rows) {
  let best = null;
  for (const row of rows) {
    if (!row || !row.vector || !(row.weight > 0)) continue;
    const c = cosine(stoneVector, row.vector);
    if (!best || c > best.cosine) best = { label: row.label || '', cosine: c };
  }
  return best && best.label ? best : null;
}

/** Both sides are unit vectors from the same model, so this is the dot. */
export function cosine(a, b) {
  if (a.length !== b.length) throw new Error(`dimension mismatch: ${a.length} vs ${b.length}`);
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/* arXiv stamps its announcement at midnight ET, which is 04:00 UTC, and that is
   the hour used below. Midnight UTC would be wrong in a way that shows: a
   reader in New York would render a paper announced on the 25th as the 24th. */
const ANNOUNCE_HOUR_UTC = 4;

/**
 * When a paper was announced, as RSS wants it — not when this file was built.
 *
 * Every item used to carry `new Date()`. For a preset with lookback_days > 1
 * that stamped a Friday paper and a Monday paper with the same second, and for
 * every preset it threw away the one fact a reader's sort column is for.
 *
 * `published` is a date, not an instant: arXiv announces a whole day at once,
 * so all of one day's papers would still tie. The item's rank is folded in as
 * minutes past the announcement hour, best first. That is cosmetic arithmetic
 * in service of one thing — the same thing the grade-in-the-body test guards:
 * **most readers re-sort by date, and that must not destroy the ranking.**
 * Ranks past 59 flatten onto the same minute rather than spilling into the next
 * hour; a feed that deep has bigger problems than a tie.
 *
 * Falls back to build time when a stone carries no date, which is what every
 * item did before this existed.
 */
/* The newest date in the feed, which is not items[0] — items are ordered by
   grade, so the top one is regularly an older paper from the lookback window. */
export function newestOf(items) {
  return items.reduce((best, it) => (it.published > best ? it.published : best), '');
}

export function itemDate(published, rank = 0, now = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(published || ''))) return now.toUTCString();
  const when = new Date(`${published}T00:00:00Z`);
  if (Number.isNaN(when.getTime())) return now.toUTCString();
  when.setUTCHours(ANNOUNCE_HOUR_UTC, Math.max(0, 59 - Math.min(rank, 59)), 0, 0);
  return when.toUTCString();
}

/**
 * Text on its way to a human, from a source that writes TeX.
 *
 * arXiv hands over the author's own source — `M\"uller`, `$|\sqrt{\mathrm{T}}
 * \rangle$`, `10^{-4}` — and every field on a card comes from it, either
 * directly or through a model that was told to copy the paper's terms exactly
 * and does. Rendering it raw prints backslashes at a reader, in the browser and
 * in a feed reader alike, which is why the fix is here and not a maths library
 * on the page: a feed reader runs no script.
 *
 * Two passes, and they are separate on purpose. `deLatex` is the accent and
 * Greek pass, byte-identical to a copy in filter.js because the two hash
 * abstracts against each other; `deMath` is display-only and knows nothing
 * about hashing.
 *
 * MATH FIRST, AND IT MATTERS. `deLatex` rewrites a braced group — `{\psi}` is
 * ψ, braces and all — which inside `\ket{\psi}` destroys the argument the
 * command needed and leaves `\ketψ`. Run the other way round, the math pass
 * expands the ket (with the same Greek table, which it imports), and what
 * reaches `deLatex` is the text-mode accents it exists for.
 */
export function readable(text) {
  return deLatex(deMath(String(text ?? '')));
}

/**
 * One item, with every human-facing string put through `readable`.
 *
 * Done once here rather than at each of the twenty places a field is
 * interpolated: the feed body, the arxave:* elements and the archive record all
 * render the same fields, and a field that got the treatment in two of the
 * three is the bug this shape exists to make impossible.
 */
export function readableItem(it) {
  const e = it.enrichment;
  return {
    ...it,
    title: readable(it.title),
    authors: readable(it.authors),
    abstract: readable(it.abstract),
    enrichment: e ? {
      ...e,
      result: readable(e.result),
      question: readable(e.question),
      prior: readable(e.prior),
      limits: readable(e.limits),
      figure_gloss: readable(e.figure_gloss),
      figure_caption: readable(e.figure_caption),
      tools: (e.tools || []).map(readable),
    } : e,
  };
}

/** XML text nodes. Ampersand first, or the escapes escape each other. */
export function xmlEscape(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function fromBase64(b64) {
  const buf = Buffer.from(b64, 'base64');
  return Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4));
}

async function cacheRead(endpoint, shas) {
  const hits = new Map();
  for (let i = 0; i < shas.length; i += READ_CHUNK) {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, dim: DIM, sha: shas.slice(i, i + READ_CHUNK) }),
    });
    if (!resp.ok) {
      console.warn(`preset-feed: cache read HTTP ${resp.status} — embedding locally instead`);
      return hits;
    }
    const body = await resp.json();
    for (const [sha, b64] of Object.entries(body.hits ?? {})) hits.set(sha, fromBase64(b64));
  }
  return hits;
}

/**
 * Vectors for every text, cache first and the pick for the rest.
 *
 * The feed runs right after the warmer in the same job, so in the normal case
 * every text is a hit and the pick is never called. Calling it is the fallback
 * that keeps a cache outage from emptying the feed.
 */
async function vectorize(texts, endpoint, embedUrl) {
  const shas = await Promise.all(texts.map(sha256Hex));
  const hits = await cacheRead(endpoint, [...new Set(shas)]);
  const out = new Array(texts.length);
  const missing = [];
  for (let i = 0; i < texts.length; i++) {
    const hit = hits.get(shas[i]);
    if (hit) out[i] = hit;
    else missing.push(i);
  }
  console.log(`preset-feed: ${texts.length - missing.length}/${texts.length} vectors from the cache`);
  if (missing.length) {
    for (let i = 0; i < missing.length; i += BATCH) {
      const chunk = missing.slice(i, i + BATCH);
      const rows = await embedChunk(chunk.map((m) => texts[m]), embedUrl);
      for (let r = 0; r < chunk.length; r++) out[chunk[r]] = rows[r];
    }
  }
  return out;
}


/* The three bands, and the only place their names are written down. A band is
   not a second gate: it is the label the reader gets for the confidence the
   assay actually had, which is what makes shipping past `min_z` honest rather
   than padding. docs/feeds/feed.xsl paints them and must use the same slugs. */
export const BAND_LABEL = {
  paydirt: 'Pay dirt',
  look: 'Worth a look',
  longshot: 'Long shot',
};

export const SELECT_DEFAULTS = {
  min_z: 2.0, soft_z: 1.5, long_z: 0.5, min_items: 3, max_items: 8,
};

/**
 * Which band a z falls in.
 *
 * `min_z` is the pay-dirt line and `soft_z` is the ship line; everything under
 * `soft_z` in a feed got there through the floor, and says so. A null z is the
 * no-spread day: there is no baseline, so no confidence can be claimed and the
 * item is a long shot by definition.
 */
export function bandOf(z, opts = {}) {
  const minZ = Number.isFinite(opts.minZ) ? opts.minZ : SELECT_DEFAULTS.min_z;
  const softZ = Number.isFinite(opts.softZ) ? opts.softZ : SELECT_DEFAULTS.soft_z;
  if (!Number.isFinite(z)) return 'longshot';
  if (z >= minZ) return 'paydirt';
  if (z >= Math.min(softZ, minZ)) return 'look';
  return 'longshot';
}

/**
 * What the day amounted to, in one line.
 *
 * An empty top band is information, not absence — a reader who is told "no pay
 * dirt today" learns that the dig ran and found nothing exceptional, which is a
 * different message from a feed that looks broken. Rides in the channel so it
 * is visible before any item is opened.
 */
export function tallyOf(items) {
  if (!items.length) return '';
  const n = { paydirt: 0, look: 0, longshot: 0 };
  for (const it of items) n[it.band || 'longshot']++;
  const rest = [
    n.look ? `${n.look} worth a look` : '',
    n.longshot ? `${n.longshot} long shot${n.longshot === 1 ? '' : 's'}` : '',
  ].filter(Boolean).join(' · ');
  if (!n.paydirt) return `No pay dirt today${rest ? ' — ' + rest : ''}.`;
  return [`${n.paydirt} pay dirt`, rest].filter(Boolean).join(' · ') + '.';
}

/**
 * One day of one feed, small enough to keep forever.
 *
 * THE STOCKPILE IS NOT THE FEED. A feed is a file that gets overwritten every
 * morning: yesterday's spin-qubits ranking exists only in whatever reader
 * happened to poll for it, and in git, which is not a place anyone browses.
 * That loses the one thing a daily assay accumulates — a record of what this
 * seam actually yielded over a month, which is how someone decides whether to
 * keep reading it at all.
 *
 * So every shipped item is written flat, by month, with the whole card kept:
 * the ranking, every brief field, the figure and its gloss, and the abstract.
 *
 * THE ABSTRACT IS KEPT, and that is a reversal. It used to be dropped as the
 * one big field that was one hop away on arXiv anyway — measured on the
 * 2026-08-20 build, 4 feeds × 15 items ≈ 13 kB a day with abstracts against
 * ≈ 1.4 kB without. But the stockpile is now the place a paper is read rather
 * than merely counted, and a browsing page that has to open arxiv.org to show
 * an abstract is not that place. At ~13 kB a day a year is under 5 MB, spread
 * over twelve month files that load one at a time, which the page can still
 * hold in memory.
 */
export function archiveEntry(items) {
  return items.map((raw) => {
    const it = readableItem(raw);
    const e = it.enrichment || null;
    return {
      id: it.arxivId,
      title: it.title || it.arxivId,
      link: it.link,
      authors: it.authors || '',
      grade: Number(it.grade.toFixed(3)),
      z: Number.isFinite(it.z) ? Number(it.z.toFixed(1)) : null,
      band: it.band || 'longshot',
      matched: it.matched ? it.matched.label : '',
      announced: it.published || '',
      kind: e?.kind || '',
      result: e?.result || '',
      question: e?.question || '',
      prior: e?.prior || '',
      limits: e?.limits || '',
      tools: e?.tools?.length ? e.tools.join(' · ') : '',
      code: e?.code || '',
      figure: e?.figure_url || '',
      /* The gloss when there is one, the paper's own caption when there is not.
         Which of the two it was does not survive into the archive, because
         nothing downstream renders them differently. */
      caption: e?.figure_gloss || e?.figure_caption || '',
      abstract: it.abstract || '',
    };
  });
}

/**
 * Merge one day into one month file, and keep the day idempotent.
 *
 * Re-running the builder on the same date REPLACES that date's entry rather
 * than appending to it — the workflow can be re-run by hand after a failure,
 * and a stockpile that shows a day twice is worse than one that shows it late.
 */
export function mergeMonth(prior, date, feeds) {
  const days = { ...(prior?.days || {}) };
  days[date] = feeds;
  const ordered = {};
  for (const d of Object.keys(days).sort()) ordered[d] = days[d];
  return { month: date.slice(0, 7), days: ordered };
}

/**
 * The stockpile's table of contents: which months exist, and what each day in
 * them yielded. The page draws its calendar off this alone, so opening the
 * stockpile costs one small request and a month file is only fetched when
 * somebody actually looks at a day inside it.
 */
export function archiveIndex(months) {
  const out = { months: [] };
  for (const m of Object.keys(months).sort().reverse()) {
    const days = months[m];
    out.months.push({
      month: m,
      days: Object.keys(days).sort().reverse().map((date) => ({
        date,
        feeds: Object.fromEntries(Object.entries(days[date]).map(([slug, f]) => [
          slug, { items: f.items.length, paydirt: f.items.filter((i) => i.band === 'paydirt').length },
        ])),
      })),
    });
  }
  return out;
}

/**
 * Which papers make the feed.
 *
 * NOT an absolute grade threshold, and the measured reason is worth keeping:
 * cosines over arXiv abstracts sit in a high, narrow band. On
 * 2026-08-12 the 94 cond-mat.mes-hall + quant-ph abstracts scored between
 * 0.498 and 0.735 against the spin-qubits preset, median 0.605. A cut at 0.65
 * kept ten papers, eight of which were generic quant-ph. The absolute number
 * says almost nothing; the *distance from the day's own baseline* says a lot.
 *
 * So the gate is a robust z-score — median and MAD, not mean and stdev, so a
 * handful of genuinely on-topic papers cannot drag the baseline up toward
 * themselves. Same day, scored this way:
 *
 *     z >= 3.0 -> 1 paper    z >= 2.5 -> 2    z >= 2.0 -> 2    z >= 1.5 -> 5
 *
 * EVERY ABSOLUTE NUMBER IN THIS COMMENT WAS MEASURED ON THE OLD PICK
 * (`bge-small-en-v1.5`, 384-dim) and is stale: the medians, the sigmas, and
 * the 0.65 that kept ten papers all describe a cosine distribution that no
 * longer exists. **The gate itself is not stale**, and that is the point of
 * having built it this way — median and MAD are location- and scale-invariant,
 * so a z of 2.5 means the same thing under any embedding, and none of the
 * tuned constants below refer to a raw cosine. Re-measure the tables when
 * convenient; do not re-tune `minZ`, `softZ` or `longZ` on the assumption that
 * the model change moved them, because it did not.
 *
 * THAT ARGUMENT WAS CHECKED, NOT JUST ASSERTED, when centring arrived. The
 * grades it reads are now taken in the centred space, which is a change of
 * both location and scale — precisely what median/MAD is meant to absorb.
 * Measured 2026-08-19 over one 631-stone day, spin-qubits preset:
 *
 *                    grade spread   top-paper z   papers z>=2
 *     raw                0.115          4.68          92
 *     centred            0.560          5.46          98
 *
 * Five times the grade spread and the z barely moves, which is the invariance
 * doing its job. So the bands stay where they are. What centring buys the feed
 * is not a different cut but a defensible one: a z computed over a 0.115-wide
 * grade window was dividing signal by a MAD of the same order as the noise.
 *
 * and the two above 2.5 were exactly the two a spin-qubit reader would want.
 * `maxItems` is a ceiling for an unusually rich day, not a target: a quiet day
 * is supposed to produce a short feed, and a day with nothing is supposed to
 * produce nothing. Padding to a fixed ten is how a feed teaches people to stop
 * opening it.
 *
 * THE FAILURE THE FLOOR EXISTS FOR. A z-gate measures a paper against the
 * day's own spread, so it punishes a preset that matches its own category.
 * Measured 2026-08-15 over a two-weekday corpus, same rows, same `grade()`:
 *
 *     preset                     n   median   sigma   best grade   best z   z>=2
 *     quantum-machine-learning  51    0.652   0.055        0.728     1.37      0
 *     spin-qubits               62    0.617   0.035        0.684     1.92      0
 *     error-correction          51    0.621   0.039        0.718     2.45      3
 *
 * quantum-machine-learning scouts quant-ph and matches half of it — 27 of 51
 * stones above 0.65 — so the baseline rises AND the spread widens, and the
 * best paper of the day lands 1.37 sigma out. That feed shipped empty while
 * the page showed the same papers at the top of the assay. The better a preset
 * fits its archive, the harder its own gate bites: a pure relative gate cannot
 * be the only rule.
 *
 * WHY THE SHIP LINE IS NOT THE PAY-DIRT LINE. A gate that ships only z >= minZ
 * is one bit of information — in or out — and it spends that bit on the papers
 * it is least sure about. Three of four presets shipped empty on 2026-08-13,
 * and an empty file is what a prospective subscriber sees when they click the
 * feed link before subscribing: the catalogue's own shop window, dark.
 *
 * So the feed ships down to `softZ` and *labels* what it shipped. `minZ` stops
 * being the cut and becomes the pay-dirt line: above it the assay is confident,
 * between softZ and minZ it is interested, and a reader can skip a "Long shot"
 * in the second it takes to read the chip. Lowering an unlabelled bar is what
 * teaches people to stop opening a feed; lowering a labelled one does not,
 * because the feed never claimed more than it had.
 *
 * `minItems` is the floor under all of it: if fewer than that clear `softZ`,
 * reach down to `longZ` and ship that many as long shots. `maxItems` remains a
 * ceiling for a rich day, never a target.
 */
export function selectItems(scored, opts = {}) {
  const minZ = Number.isFinite(opts.minZ) ? opts.minZ : SELECT_DEFAULTS.min_z;
  const maxItems = Number.isFinite(opts.maxItems) ? opts.maxItems : SELECT_DEFAULTS.max_items;
  const minItems = Number.isFinite(opts.minItems) ? opts.minItems : SELECT_DEFAULTS.min_items;
  const softZ = Number.isFinite(opts.softZ) ? opts.softZ : SELECT_DEFAULTS.soft_z;
  const longZ = Number.isFinite(opts.longZ) ? opts.longZ : SELECT_DEFAULTS.long_z;
  const ranked = [...scored].sort((a, b) => b.grade - a.grade);
  if (!ranked.length) return [];

  const grades = ranked.map((r) => r.grade).sort((a, b) => a - b);
  const median = grades[Math.floor(grades.length / 2)];
  const devs = grades.map((g) => Math.abs(g - median)).sort((a, b) => a - b);
  const mad = devs[Math.floor(devs.length / 2)];

  /* A degenerate spread (every paper identical, or too few to have one) has no
     baseline to be above. Falling back to the plain top-N keeps the feed
     working on a day the statistics cannot speak to — and every one of those
     items is a long shot, because there is no spread to be confident against. */
  if (!(mad > 0)) {
    return ranked.slice(0, maxItems)
      .map((r) => ({ ...r, z: null, band: 'longshot' }));
  }

  const withZ = ranked.map((r) => ({ ...r, z: (r.grade - median) / (1.4826 * mad) }));
  /* The ship line never rises above the pay-dirt line: setting minZ below softZ
     means a stricter feed, not a feed with a band that cannot be reached. */
  const shipBar = Math.min(softZ, minZ);
  const floorN = Math.min(minItems, maxItems);
  let out = withZ.filter((r) => r.z >= shipBar);
  if (out.length < floorN) {
    /* The floor reaches past the ship line and no further than longZ, so a day
       with nothing on it produces a short list of admitted long shots rather
       than a file that reads as broken. */
    out = withZ.filter((r) => r.z >= Math.min(longZ, shipBar)).slice(0, floorN);
  }
  return out.slice(0, maxItems)
    .map((r) => ({ ...r, band: bandOf(r.z, { minZ, softZ }) }));
}

export function renderFeed({ preset, slug, items, site, builtOn }) {
  const self = new URL(`feeds/${slug}.xml`, site).href;
  const digLink = new URL(`?preset=${encodeURIComponent(slug)}`, site).href;
  const tally = tallyOf(items);
  /* A browser opening a .xml gets the raw tree and a scolding about missing
     style information; readers ignore the stylesheet entirely. Since the RSS
     link on the page is something people will click before they subscribe,
     the first impression is worth one static XSL.

     Relative, unlike every other URL in this file: browsers refuse to apply a
     cross-origin XSLT, so an absolute arxave.com href would silently stop
     transforming the moment a feed is read from the github.io mirror or a
     fork's Pages domain. The stylesheet is the file's neighbour either way. */
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<?xml-stylesheet type="text/xsl" href="feed.xsl"?>',
    /* The arxave namespace exists because browsers do not implement XSLT's
       disable-output-escaping: the stylesheet cannot turn the escaped HTML in
       <description> back into markup, and prints the tags instead. Readers want
       that HTML, so it stays — and the stylesheet renders from these structured
       elements instead, which need no unescaping. */
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" ' +
      'xmlns:arxave="https://arxave.com/ns/feed">',
    '  <channel>',
    `    <title>${xmlEscape('The Dig — ' + (preset.name || slug))}</title>`,
    `    <link>${xmlEscape(digLink)}</link>`,
    `    <atom:link href="${xmlEscape(self)}" rel="self" type="application/rss+xml"/>`,
    /* The tally rides in the description as well as in its own element: a
       reader shows the description and never sees arxave:*, and the one thing
       worth knowing before opening an item is whether the top band is empty. */
    `    <description>${xmlEscape(
      (preset.blurb || '') +
      ` Today's arXiv announcement, ranked against the ${preset.name || slug} preset.` +
      (tally ? ' ' + tally : ''))}</description>`,
    ...(tally ? [`    <arxave:tally>${xmlEscape(tally)}</arxave:tally>`] : []),
    '    <language>en-us</language>',
    `    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>`,
    /* lastBuildDate is when this file was written; pubDate is when its contents
       were announced. They are the same on a normal morning and differ on a
       rebuild, which is the case that makes keeping them separate worth it. */
    `    <pubDate>${itemDate(newestOf(items), 0)}</pubDate>`,
  ];
  for (const [rank, raw] of items.entries()) {
    const it = readableItem(raw);
    const e = it.enrichment;
    /* ORDER IS THE DESIGN HERE. Most readers show a list of items truncated to
       roughly their first line, so for a lot of subscribers that line *is* the
       item. It holds the band, the kind, and the finding with its number, and
       everything that only supports it comes after — each part in its own fold.

       EVERYTHING BELOW THE FINDING IS FOLDED, and that is the whole shape of a
       card: title, authors, one line of finding, and six closed drawers. A feed
       is a list, and a list where every item spends a screen on itself is not a
       list — a reader who wants the figure, the caveat or the author's own
       abstract opens the one drawer they want, on the one paper they want it
       for. A reader that strips <details> gets everything inline, which is
       exactly where it all sat before.

       The grade is in the body and not merely implied by the order, because a
       reader that re-sorts by date — most of them do — otherwise destroys the
       only signal this feed carries. The matched row rides the same line: it is
       what turns 0.612 from a bare number into a reason, and it tells someone
       whose feed has drifted which preset row to go and edit. */
    /* The band leads the decision line. It is the one field that says how much
       to trust everything after it, and an unenriched item has nothing else on
       that line at all — so the band is what guarantees a first line exists. */
    const band = it.band || 'longshot';
    const bandChip = `<strong class="band band-${band}">${xmlEscape(BAND_LABEL[band])}</strong>`;
    const said = e
      ? (e.kind ? xmlEscape(e.kind) : '') +
        (e.result ? `${e.kind ? ' — ' : ''}${xmlEscape(e.result)}` : '')
      : '';
    const decision = `<p class="verdict">${bandChip}${said ? ' ' + said : ''}</p>`;
    const provenance = [
      `<strong>Grade ${it.grade.toFixed(3)}</strong>`,
      Number.isFinite(it.z) ? `${it.z.toFixed(1)}σ above the day's baseline` : '',
      it.matched ? `matched “${xmlEscape(it.matched.label)}”` : '',
      it.authors ? xmlEscape(it.authors) : '',
    ].filter(Boolean).join(' · ');
    /* One drawer, and it is empty when its field is. A fold whose summary
       promises a figure and opens on nothing is worse than a card with one
       fewer drawer. */
    const fold = (label, inner) =>
      inner ? `<details class="fold"><summary>${label}</summary>${inner}</details>` : '';
    /* The figure is hotlinked, never copied: the image lives on arxiv.org and
       this repository stays text. Wrapped in a link to the paper so a tap on it
       goes somewhere, and given a caption as alt text so a reader that blocks
       remote images still says what was there. The gloss is preferred over the
       author's own caption — see enrich.mjs — and the caption is the fallback
       for a record written before the gloss existed. */
    const caption = e?.figure_gloss || e?.figure_caption || '';
    const body =
      decision +
      `<p class="grade">${provenance}</p>` +
      (e?.figure_url
        ? fold('Figure',
            `<p class="figure"><a href="${xmlEscape(it.link)}">` +
            `<img src="${xmlEscape(e.figure_url)}" alt="${xmlEscape(caption || 'Figure')}"/>` +
            `</a></p>` +
            (caption ? `<p class="figure-caption">${xmlEscape(caption)}</p>` : ''))
        : '') +
      (e ? (
        fold('Asks', e.question ? `<p>${xmlEscape(e.question)}</p>` : '') +
        fold('Before', e.prior ? `<p>${xmlEscape(e.prior)}</p>` : '') +
        fold('But', e.limits ? `<p>${xmlEscape(e.limits)}</p>` : '') +
        fold('Tools',
          (e.tools?.length ? `<p>${xmlEscape(e.tools.join(' · '))}</p>` : '') +
          (e.code ? `<p><strong>Code.</strong> <a href="${xmlEscape(e.code)}">${xmlEscape(e.code)}</a></p>` : ''))
      ) : '') +
      fold('Abstract', `<p>${xmlEscape(it.abstract)}</p>`) +
      `<p><a href="${xmlEscape(digLink)}">Tune this in the Dig</a></p>`;
    const fields = [
      /* The same day pubDate carries, in a form a consumer can read without
         parsing RFC-822 — the XSL below is XSLT 1.0, which has no date
         arithmetic at all, and the archive wants a sortable key anyway. */
      it.published ? `      <arxave:announced>${xmlEscape(it.published)}</arxave:announced>` : '',
      `      <arxave:band>${band}</arxave:band>`,
      `      <arxave:bandname>${xmlEscape(BAND_LABEL[band])}</arxave:bandname>`,
      `      <arxave:grade>${it.grade.toFixed(3)}</arxave:grade>`,
      Number.isFinite(it.z) ? `      <arxave:z>${it.z.toFixed(1)}</arxave:z>` : '',
      it.matched ? `      <arxave:matched>${xmlEscape(it.matched.label)}</arxave:matched>` : '',
      it.authors ? `      <arxave:authors>${xmlEscape(it.authors)}</arxave:authors>` : '',
      e?.kind ? `      <arxave:kind>${xmlEscape(e.kind)}</arxave:kind>` : '',
      e?.result ? `      <arxave:result>${xmlEscape(e.result)}</arxave:result>` : '',
      e?.question ? `      <arxave:question>${xmlEscape(e.question)}</arxave:question>` : '',
      e?.prior ? `      <arxave:prior>${xmlEscape(e.prior)}</arxave:prior>` : '',
      e?.limits ? `      <arxave:limits>${xmlEscape(e.limits)}</arxave:limits>` : '',
      e?.code ? `      <arxave:code>${xmlEscape(e.code)}</arxave:code>` : '',
      e?.figure_url ? `      <arxave:figure>${xmlEscape(e.figure_url)}</arxave:figure>` : '',
      caption
        ? `      <arxave:figurecaption>${xmlEscape(caption)}</arxave:figurecaption>` : '',
      e?.tools?.length
        ? `      <arxave:tools>${xmlEscape(e.tools.join(' · '))}</arxave:tools>` : '',
      `      <arxave:abstract>${xmlEscape(it.abstract)}</arxave:abstract>`,
    ].filter(Boolean);

    lines.push(
      '    <item>',
      `      <title>${xmlEscape(it.title || it.arxivId)}</title>`,
      `      <link>${xmlEscape(it.link)}</link>`,
      `      <guid isPermaLink="false">${xmlEscape(`arxave:${slug}:${builtOn}:${it.arxivId}`)}</guid>`,
      `      <pubDate>${itemDate(it.published, rank)}</pubDate>`,
      `      <description>${xmlEscape(body)}</description>`,
      ...fields,
      '    </item>',
    );
  }
  lines.push('  </channel>', '</rss>', '');
  return lines.join('\n');
}

async function main() {
  const presetDir = arg('presets');
  const outDir = arg('out');
  if (!presetDir || !outDir) {
    console.error('preset-feed: --presets and --out are both required');
    process.exit(2);
  }
  const site = arg('site') || process.env.ARXAVE_SITE || DEFAULT_SITE;
  const top = parseInt(arg('top', '8'), 10) || 8;
  let endpoint;
  let embedUrl;
  try {
    endpoint = resolveEndpoint(arg('endpoint'), process.env.DIG_CACHE_URL);
    embedUrl = resolveEndpoint(arg('embed'), process.env.EMBED_URL, DEFAULT_EMBED);
  } catch (err) {
    console.error('preset-feed: ' + err.message);
    process.exit(2);
  }

  const { bySlug, failures } = await loadPresets(presetDir);
  if (failures.length) console.warn('preset-feed: ' + failures.join(' | '));
  await fs.mkdir(outDir, { recursive: true });

  const builtOn = new Date().toISOString().slice(0, 10);

  /* The feed manifest: which feeds exist and what shipped in them. The page
     links off this rather than off the preset slug, so a preset added today
     cannot offer a feed URL that only appears tonight. Merged, not rewritten —
     a preset skipped this morning keeps the last feed and its last count. */
  const manifestPath = path.join(outDir, 'index.json');
  let priorFeeds = {};
  try {
    priorFeeds = JSON.parse(await fs.readFile(manifestPath, 'utf8'))?.feeds ?? {};
  } catch (_) { /* first run */ }
  const feeds = {};
  /* What today added to the stockpile, gathered as the feeds are built and
     written once at the end — a per-slug write would leave a half-day in the
     month file if a later preset threw. */
  const archiveToday = {};

  let written = 0;
  for (const [slug, { preset, rows }] of bySlug) {
    const categories = String(preset.scout?.categories ?? '')
      .split(',').map((c) => c.trim()).filter(Boolean);
    if (!categories.length) {
      console.warn(`preset-feed: ${slug} has no categories — skipped`);
      if (priorFeeds[slug]) feeds[slug] = priorFeeds[slug];
      continue;
    }

    const seen = new Set();
    const stones = [];
    for (const cat of categories) {
      try {
        for (const s of (await fetchAbstracts(cat)).stones) {
          if (seen.has(s.arxivId)) continue;
          seen.add(s.arxivId);
          stones.push(s);
        }
      } catch (err) {
        console.warn(`preset-feed: ${slug} · ${err.message}`);
      }
    }
    /* The same window the Dig reads, not just tonight's announcement. A preset
       with lookback_days > 1 ranks several weekdays on the page; a feed built
       from one night ranked a different, smaller set and could disagree with
       the page about the same preset on the same morning. `fetchEarlier` is one
       request per category back to the page's own cutoff, deduped against the
       RSS ids above — a cross-list is one abstract either way. */
    const lookback = parseInt(preset.scout?.lookback_days, 10) || 1;
    if (lookback > 1) {
      try {
        for (const s of await fetchEarlier(categories, lookback, LOOKBACK_MAX)) {
          if (seen.has(s.arxivId)) continue;
          seen.add(s.arxivId);
          stones.push(s);
        }
      } catch (err) {
        console.warn(
          `preset-feed: ${slug} lookback failed (${err.message}) — tonight only`);
      }
    }
    if (!stones.length) {
      console.warn(`preset-feed: ${slug} has no stones today — leaving the last feed in place`);
      if (priorFeeds[slug]) feeds[slug] = priorFeeds[slug];
      continue;
    }

    const vectors = await vectorize(
      stones.map((s) => s.abstract).concat(rows.map((r) => r.text)), endpoint, embedUrl);
    /* Centred here, once, before anything scores — the page does the same at
       the same point (`state.A = vectors.map(center)`). `grade()` itself stays
       verbatim: the transform is on the inputs, not in the blend, so the
       function the fixtures pin is still the function the browser runs. */
    const stoneVecs = vectors.slice(0, stones.length).map(center);
    const rowVecs = rows.map((r, i) => ({
      weight: r.weight, vector: center(vectors[stones.length + i]), label: rowLabel(r),
    }));

    const scored = stones.map((s, i) => ({
      ...s,
      grade: grade(stoneVecs[i], rowVecs),
      matched: bestRow(stoneVecs[i], rowVecs),
    }));
    const ranked = selectItems(scored, {
      minZ: preset.select?.min_z,
      minItems: preset.select?.min_items,
      softZ: preset.select?.soft_z,
      longZ: preset.select?.long_z,
      maxItems: Number.isFinite(preset.select?.max_items) ? preset.select.max_items : top,
    });
    if (!ranked.length) {
      console.log(`preset-feed: ${slug} — nothing cleared the bar today (${scored.length} scored)`);
    }

    const enriched = await enrichItems(ranked, {
      cachePath: path.join(outDir, 'enrichment.json'),
    });

    const xml = renderFeed({ preset, slug, items: enriched, site, builtOn });
    await fs.writeFile(path.join(outDir, `${slug}.xml`), xml);
    /* The manifest carries the pay-dirt count beside the total, because that is
       what the catalogue's RSS menu should say: "5 today, 1 pay dirt" is a
       different invitation from "5 today" when four of them are long shots. */
    feeds[slug] = {
      name: preset.name || slug,
      items: enriched.length,
      paydirt: enriched.filter((it) => it.band === 'paydirt').length,
      updated: builtOn,
    };
    /* An empty morning is still a day in the stockpile: "this seam yielded
       nothing on the 14th" is a fact about the seam, and a calendar with a hole
       in it reads as a build that failed. */
    archiveToday[slug] = {
      name: preset.name || slug,
      tally: tallyOf(enriched),
      items: archiveEntry(enriched),
    };
    if (ranked.length) {
      console.log(
        `preset-feed: ${slug} — ${ranked.length} of ${scored.length} stones, ` +
        `grades ${ranked[ranked.length - 1].grade.toFixed(3)}–${ranked[0].grade.toFixed(3)}` +
        ` · ${tallyOf(ranked)}`);
    }
    written++;
  }
  /* Slugs no longer in the preset directory drop out of the manifest, so the
     page stops offering them the moment the preset goes — the XML file itself
     is left alone, since its subscribers' URLs still resolve. */
  const ordered = {};
  for (const slug of bySlug.keys()) if (feeds[slug]) ordered[slug] = feeds[slug];
  await fs.writeFile(manifestPath,
    JSON.stringify({ built: builtOn, feeds: ordered }, null, 2) + '\n');

  /* The stockpile. By month, because a file per day is a thousand files in
     three years and a single file is one that grows without bound: a month is
     the unit the browsing page loads at once, and the index below is what it
     opens with. Nothing is ever pruned — the whole point of keeping it is that
     the record goes back further than the feed does. */
  if (Object.keys(archiveToday).length) {
    const archiveDir = path.join(outDir, 'archive');
    await fs.mkdir(archiveDir, { recursive: true });
    const month = builtOn.slice(0, 7);
    const monthPath = path.join(archiveDir, `${month}.json`);
    let priorMonth = null;
    try { priorMonth = JSON.parse(await fs.readFile(monthPath, 'utf8')); } catch (_) { /* new month */ }
    /* One copy of each item, under its day. The month file used to carry a
       second `items` map keyed by date as well, which doubled the file and —
       because it was rebuilt from today alone rather than merged — held only
       the newest day, so the page it fed showed one day per month. */
    const merged = mergeMonth(priorMonth, builtOn, archiveToday);
    await fs.writeFile(monthPath, JSON.stringify(merged) + '\n');

    const indexPath = path.join(archiveDir, 'index.json');
    let priorIndex = { months: [] };
    try { priorIndex = JSON.parse(await fs.readFile(indexPath, 'utf8')); } catch (_) { /* first run */ }
    const summary = archiveIndex({ [month]: merged.days }).months[0];
    const others = (priorIndex.months || []).filter((m) => m.month !== month);
    const months = [summary, ...others].sort((a, b) => (a.month < b.month ? 1 : -1));
    await fs.writeFile(indexPath,
      JSON.stringify({ built: builtOn, months }, null, 2) + '\n');
    console.log(`preset-feed: stockpiled ${builtOn} (${Object.keys(archiveToday).length} feed(s))`);
  }

  console.log(`preset-feed: wrote ${written} feed(s)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('preset-feed: ' + (err?.stack || err?.message || err));
    process.exit(1);
  });
}
