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
  DEFAULT_EMBED, DIM, MODEL, embedChunk, fetchAbstracts, fetchEarlier,
  loadPresets, resolveEndpoint, sha256Hex,
} from './warm-dig.mjs';
import { enrichItems } from './enrich.mjs';

const READ_CHUNK = 500;
const BATCH = 128;   // under embed's MAX_TEXTS (400), same as the warmer
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

/** "read" -> "Read". The verdict is stored lowercase and shown capitalised. */
export function titleCase(word) {
  const w = String(word ?? '');
  return w ? w[0].toUpperCase() + w.slice(1) : '';
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
    `    <pubDate>${new Date().toUTCString()}</pubDate>`,
  ];
  for (const it of items) {
    const e = it.enrichment;
    /* ORDER IS THE DESIGN HERE. Most readers show a list of items truncated to
       roughly their first line, so for a lot of subscribers that line *is* the
       item. It holds the decision — verdict, kind, and the finding with its
       number — and everything that only supports the decision comes after it.

       The grade is in the body and not merely implied by the order, because a
       reader that re-sorts by date — most of them do — otherwise destroys the
       only signal this feed carries. The matched row rides the same line: it is
       what turns 0.612 from a bare number into a reason, and it tells someone
       whose feed has drifted which preset row to go and edit.

       The abstract stays, last. It is the author's own words and the only part
       of the item nothing generated, which makes it the reader's check on
       everything above it. */
    /* The band leads the decision line, ahead of the verdict. It is the one
       field that says how much to trust everything after it, and an unenriched
       item has nothing else on that line at all — so the band, not the verdict,
       is what guarantees a first line exists. */
    const band = it.band || 'longshot';
    const bandChip = `<strong class="band band-${band}">${xmlEscape(BAND_LABEL[band])}</strong>`;
    const said = e
      ? (e.verdict ? xmlEscape(titleCase(e.verdict)) : '') +
        (e.verdict && e.kind ? ' · ' : '') +
        (e.kind ? xmlEscape(e.kind) : '') +
        (e.headline ? `${e.verdict || e.kind ? ' — ' : ''}${xmlEscape(e.headline)}` : '')
      : '';
    const decision = `<p class="verdict">${bandChip}${said ? ' ' + said : ''}</p>`;
    const provenance = [
      `<strong>Grade ${it.grade.toFixed(3)}</strong>`,
      Number.isFinite(it.z) ? `${it.z.toFixed(1)}σ above the day's baseline` : '',
      it.matched ? `matched “${xmlEscape(it.matched.label)}”` : '',
      it.authors ? xmlEscape(it.authors) : '',
    ].filter(Boolean).join(' · ');
    const body =
      decision +
      `<p class="grade">${provenance}</p>` +
      (e ? (
        (e.so_what ? `<p><strong>So what.</strong> ${xmlEscape(e.so_what)}</p>` : '') +
        (e.caveat ? `<p><strong>But.</strong> ${xmlEscape(e.caveat)}</p>` : '') +
        (e.tools?.length ? `<p><strong>Tools.</strong> ${xmlEscape(e.tools.join(' · '))}</p>` : '')
      ) : '') +
      `<p class="abstract"><strong>Abstract.</strong> ${xmlEscape(it.abstract)}</p>` +
      `<p><a href="${xmlEscape(digLink)}">Tune this in the Dig</a></p>`;
    const fields = [
      `      <arxave:band>${band}</arxave:band>`,
      `      <arxave:bandname>${xmlEscape(BAND_LABEL[band])}</arxave:bandname>`,
      `      <arxave:grade>${it.grade.toFixed(3)}</arxave:grade>`,
      Number.isFinite(it.z) ? `      <arxave:z>${it.z.toFixed(1)}</arxave:z>` : '',
      it.matched ? `      <arxave:matched>${xmlEscape(it.matched.label)}</arxave:matched>` : '',
      it.authors ? `      <arxave:authors>${xmlEscape(it.authors)}</arxave:authors>` : '',
      e?.verdict ? `      <arxave:verdict>${xmlEscape(e.verdict)}</arxave:verdict>` : '',
      e?.kind ? `      <arxave:kind>${xmlEscape(e.kind)}</arxave:kind>` : '',
      e?.headline ? `      <arxave:headline>${xmlEscape(e.headline)}</arxave:headline>` : '',
      e?.so_what ? `      <arxave:sowhat>${xmlEscape(e.so_what)}</arxave:sowhat>` : '',
      e?.caveat ? `      <arxave:caveat>${xmlEscape(e.caveat)}</arxave:caveat>` : '',
      e?.tools?.length
        ? `      <arxave:tools>${xmlEscape(e.tools.join(' · '))}</arxave:tools>` : '',
      `      <arxave:abstract>${xmlEscape(it.abstract)}</arxave:abstract>`,
    ].filter(Boolean);

    lines.push(
      '    <item>',
      `      <title>${xmlEscape(it.title || it.arxivId)}</title>`,
      `      <link>${xmlEscape(it.link)}</link>`,
      `      <guid isPermaLink="false">${xmlEscape(`arxave:${slug}:${builtOn}:${it.arxivId}`)}</guid>`,
      `      <pubDate>${new Date().toUTCString()}</pubDate>`,
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
    const stoneVecs = vectors.slice(0, stones.length);
    const rowVecs = rows.map((r, i) => ({
      weight: r.weight, vector: vectors[stones.length + i], label: rowLabel(r),
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

  console.log(`preset-feed: wrote ${written} feed(s)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('preset-feed: ' + (err?.stack || err?.message || err));
    process.exit(1);
  });
}
