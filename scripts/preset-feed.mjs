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
 *   --top       how many papers per feed (default 15)
 *   --site      absolute base URL used for links back into the Dig
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  DIM, MODEL, fetchAbstracts, loadModel, loadPresets, resolveEndpoint, sha256Hex,
} from './warm-dig.mjs';
import { enrichItems } from './enrich.mjs';

const READ_CHUNK = 500;
const BATCH = 16;
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

/** Both sides are unit vectors from the same model, so this is the dot. */
export function cosine(a, b) {
  if (a.length !== b.length) throw new Error(`dimension mismatch: ${a.length} vs ${b.length}`);
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
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
 * Vectors for every text, cache first and the model for the rest.
 *
 * The feed runs right after the warmer in the same job, so in the normal case
 * every text is a hit and the model is never loaded. Embedding locally is the
 * fallback that keeps a cache outage from emptying the feed.
 */
async function vectorize(texts, endpoint) {
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
    const extractor = await loadModel();
    for (let i = 0; i < missing.length; i += BATCH) {
      const chunk = missing.slice(i, i + BATCH);
      const res = await extractor(chunk.map((m) => texts[m]), { pooling: 'mean', normalize: true });
      const rows = res.tolist();
      for (let r = 0; r < chunk.length; r++) out[chunk[r]] = rows[r];
    }
  }
  return out;
}


/**
 * Which papers make the feed.
 *
 * NOT an absolute grade threshold, and the measured reason is worth keeping:
 * bge-small cosines over arXiv abstracts sit in a high, narrow band. On
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
 * and the two above 2.5 were exactly the two a spin-qubit reader would want.
 * `maxItems` is a ceiling for an unusually rich day, not a target: a quiet day
 * is supposed to produce a short feed, and a day with nothing is supposed to
 * produce nothing. Padding to a fixed ten is how a feed teaches people to stop
 * opening it.
 */
export function selectItems(scored, opts = {}) {
  const minZ = Number.isFinite(opts.minZ) ? opts.minZ : 2.0;
  const maxItems = Number.isFinite(opts.maxItems) ? opts.maxItems : 15;
  const ranked = [...scored].sort((a, b) => b.grade - a.grade);
  if (!ranked.length) return [];

  const grades = ranked.map((r) => r.grade).sort((a, b) => a - b);
  const median = grades[Math.floor(grades.length / 2)];
  const devs = grades.map((g) => Math.abs(g - median)).sort((a, b) => a - b);
  const mad = devs[Math.floor(devs.length / 2)];

  /* A degenerate spread (every paper identical, or too few to have one) has no
     baseline to be above. Falling back to the plain top-N keeps the feed
     working on a day the statistics cannot speak to. */
  if (!(mad > 0)) return ranked.slice(0, maxItems).map((r) => ({ ...r, z: null }));

  return ranked
    .map((r) => ({ ...r, z: (r.grade - median) / (1.4826 * mad) }))
    .filter((r) => r.z >= minZ)
    .slice(0, maxItems);
}

export function renderFeed({ preset, slug, items, site, builtOn }) {
  const self = new URL(`feeds/${slug}.xml`, site).href;
  const digLink = new URL(`?preset=${encodeURIComponent(slug)}`, site).href;
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
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    '  <channel>',
    `    <title>${xmlEscape('The Dig — ' + (preset.name || slug))}</title>`,
    `    <link>${xmlEscape(digLink)}</link>`,
    `    <atom:link href="${xmlEscape(self)}" rel="self" type="application/rss+xml"/>`,
    `    <description>${xmlEscape(
      (preset.blurb || '') +
      ` Today's arXiv announcement, ranked against the ${preset.name || slug} preset.`)}</description>`,
    '    <language>en-us</language>',
    `    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>`,
    `    <pubDate>${new Date().toUTCString()}</pubDate>`,
  ];
  for (const it of items) {
    /* The grade is in the item body, not just implied by the order: a reader
       that re-sorts by date — most of them do — otherwise destroys the only
       signal this feed carries. */
    const e = it.enrichment;
    /* The three fields first, the abstract after. The enrichment exists to be
       skimmed; the abstract stays because it is the author's own words and the
       only part of this item nothing generated. */
    const body =
      `<p class="grade"><strong>Grade ${it.grade.toFixed(3)}</strong>` +
      (Number.isFinite(it.z) ? ` · ${it.z.toFixed(1)}\u03c3 above the day's baseline` : '') +
      (it.authors ? ` · ${xmlEscape(it.authors)}` : '') + '</p>' +
      (e ? (
        (e.research_question ? `<p><strong>Question.</strong> ${xmlEscape(e.research_question)}</p>` : '') +
        (e.tools?.length ? `<p><strong>Tools.</strong> ${xmlEscape(e.tools.join(' · '))}</p>` : '') +
        (e.summary ? `<p><strong>Summary.</strong> ${xmlEscape(e.summary)}</p>` : '')
      ) : '') +
      `<p><strong>Abstract.</strong> ${xmlEscape(it.abstract)}</p>` +
      `<p><a href="${xmlEscape(digLink)}">Tune this in the Dig</a></p>`;
    lines.push(
      '    <item>',
      `      <title>${xmlEscape(it.title || it.arxivId)}</title>`,
      `      <link>${xmlEscape(it.link)}</link>`,
      `      <guid isPermaLink="false">${xmlEscape(`arxave:${slug}:${builtOn}:${it.arxivId}`)}</guid>`,
      `      <pubDate>${new Date().toUTCString()}</pubDate>`,
      `      <description>${xmlEscape(body)}</description>`,
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
  const top = parseInt(arg('top', '15'), 10) || 15;
  let endpoint;
  try {
    endpoint = resolveEndpoint(arg('endpoint'), process.env.DIG_CACHE_URL);
  } catch (err) {
    console.error('preset-feed: ' + err.message);
    process.exit(2);
  }

  const { bySlug, failures } = await loadPresets(presetDir);
  if (failures.length) console.warn('preset-feed: ' + failures.join(' | '));
  await fs.mkdir(outDir, { recursive: true });

  const builtOn = new Date().toISOString().slice(0, 10);
  let written = 0;
  for (const [slug, { preset, rows }] of bySlug) {
    const categories = String(preset.scout?.categories ?? '')
      .split(',').map((c) => c.trim()).filter(Boolean);
    if (!categories.length) {
      console.warn(`preset-feed: ${slug} has no categories — skipped`);
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
    if (!stones.length) {
      console.warn(`preset-feed: ${slug} has no stones today — leaving the last feed in place`);
      continue;
    }

    const vectors = await vectorize(
      stones.map((s) => s.abstract).concat(rows.map((r) => r.text)), endpoint);
    const stoneVecs = vectors.slice(0, stones.length);
    const rowVecs = rows.map((r, i) => ({ weight: r.weight, vector: vectors[stones.length + i] }));

    const scored = stones.map((s, i) => ({ ...s, grade: grade(stoneVecs[i], rowVecs) }));
    const ranked = selectItems(scored, {
      minZ: preset.select?.min_z,
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
    if (ranked.length) {
      console.log(
        `preset-feed: ${slug} — ${ranked.length} of ${scored.length} stones, ` +
        `grades ${ranked[ranked.length - 1].grade.toFixed(3)}–${ranked[0].grade.toFixed(3)}`);
    }
    written++;
  }
  console.log(`preset-feed: wrote ${written} feed(s)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('preset-feed: ' + (err?.stack || err?.message || err));
    process.exit(1);
  });
}
