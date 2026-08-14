/**
 * warm-dig — fill the shared vector cache before anyone asks for it.
 *
 * Runs nightly in CI, after arXiv's announcement. It fetches the same feeds the
 * browser fetches, embeds the same abstracts with the same model, and PUTs the
 * vectors into `dig-cache`. By the time a human presses "Haul the stones", the
 * minute of embedding has already been paid.
 *
 * WHY THIS IS A NODE SCRIPT AND NOT PART OF THE PYTHON BATCH:
 *   The vectors have to come from the *same* model and the *same* quantization
 *   the browser uses, because a haul mixes cached stone vectors with locally
 *   embedded touchstones in one matrix (docs/dig-spec.md §5.6). A Python
 *   embedder would be a different implementation of "bge-small" — close, but
 *   systematically offset, and the offset would land inside the very cosine
 *   margin the ranking lives in. Running transformers.js with `dtype: 'q8'`
 *   here means the warmed vectors are the ones the browser would have computed.
 *
 * WHY NOT IN THE EDGE FUNCTION: embedding 130 abstracts is ~60 s of pure CPU,
 * far past a Supabase edge isolate's CPU budget. CI has no such limit.
 *
 * Usage:
 *   DIG_WRITE_KEY=… node scripts/warm-dig.mjs --categories "quant-ph,cond-mat.mes-hall"
 *
 * Flags:
 *   --categories   comma-separated arXiv categories (required)
 *   --lookback     weekdays of history to warm as well (default 1: tonight only)
 *   --max-results  per-category cap on the search-API window (default 400)
 *   --presets      directory of preset claims to warm as well (docs/presets)
 *   --endpoint     dig-cache URL (default: the project's deployed function)
 *   --dry-run      fetch and embed, write nothing
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { XMLParser } from 'fast-xml-parser';
import { env, pipeline } from '@huggingface/transformers';

// Must match docs/assets/filter.js exactly — these three strings are the cache key.
export const MODEL = 'Xenova/bge-small-en-v1.5';
export const DIM = 384;
export const DTYPE = 'q8';

/* Park the model outside node_modules. transformers.js defaults its Node cache
   to `node_modules/@huggingface/transformers/.cache/`, which `npm install`
   recreates on every CI run — so the download can never be cached there, no
   matter what path the workflow saves. A stable sibling directory can be. */
env.cacheDir = process.env.HF_CACHE_DIR ||
  path.join(path.dirname(fileURLToPath(import.meta.url)), '.model-cache');

/* The model is a 32 MB unauthenticated pull from huggingface.co, and CI egress
   IPs are shared, so a 429 on a cold cache is ordinary rather than exceptional.
   Retry a few times before giving up — the alternative is a red job for a
   condition that clears on its own in seconds. */
const MODEL_LOAD_ATTEMPTS = 4;
const MODEL_LOAD_BACKOFF_MS = 5_000;

const BATCH = 16;
const DEFAULT_ENDPOINT =
  'https://ugxxakguqgpxpdfhgtsb.supabase.co/functions/v1/dig-cache';
const PUT_CHUNK = 200;   // stays under the function's MAX_ITEMS
const READ_CHUNK = 500;  // stays under the function's MAX_SHAS

/* The polite-pool contact OpenAlex asks for. Only affects rate limiting, and
   only the warmer's own requests — the page sends its own. */
const OPENALEX_MAILTO = process.env.OPENALEX_MAILTO || 'j.a.krzywda@gmail.com';

function arg(name, fallback = null) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const DRY_RUN = process.argv.includes('--dry-run');

/** Collapse exactly as filter.js and store.py do — all three must agree. */
export function cacheKeyText(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

/* ── LaTeX escapes → Unicode ─────────────────────────────────────────────
 *
 * BYTE-IDENTICAL TO deLatex() IN docs/assets/filter.js. The reasoning lives
 * there; the short version is that the announcement feed carries the author's
 * LaTeX (`L\"uders`, `$\Omega$`, `1{\deg}`) while the search API — which the
 * browser reads for any day past tonight — has already converted it. Two
 * spellings of one abstract are two cache keys, so the lookback pass missed on
 * every abstract carrying an escape. The parity test pins the two copies
 * together; edit one and you must edit the other.
 */
export const GREEK = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε',
  zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'θ', iota: 'ι', kappa: 'κ',
  lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', varpi: 'π', rho: 'ρ',
  varrho: 'ρ', sigma: 'σ', varsigma: 'ς', tau: 'τ', upsilon: 'υ', phi: 'φ',
  varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
  Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
};

export const SPECIALS = {
  ss: 'ß', o: 'ø', O: 'Ø', l: 'ł', L: 'Ł', aa: 'å', AA: 'Å',
  ae: 'æ', AE: 'Æ', oe: 'œ', OE: 'Œ', i: 'i', j: 'j',
  deg: '°', degree: '°', textdegree: '°',
};

const COMBINING = {
  '`': '̀', "'": '́', '^': '̂', '~': '̃', '"': '̈',
  '=': '̄', '.': '̇', c: '̧', v: '̌', u: '̆',
  r: '̊', H: '̋', k: '̨',
};

const ACCENT_SRC = '\\\\([`\'"^~=.]|[cvruHk](?=\\{))\\s*(?:\\{\\\\?([A-Za-z])\\}|\\\\?([A-Za-z]))';
const ACCENT_BARE = new RegExp(ACCENT_SRC, 'g');
const ACCENT_BRACED = new RegExp('\\{' + ACCENT_SRC + '\\}', 'g');

function accent(m, acc, braced, bare) {
  return ((braced || bare) + COMBINING[acc]).normalize('NFC');
}

function command(m, cmd) {
  if (Object.prototype.hasOwnProperty.call(GREEK, cmd)) return GREEK[cmd];
  if (Object.prototype.hasOwnProperty.call(SPECIALS, cmd)) return SPECIALS[cmd];
  return m;
}

export function deLatex(text) {
  let s = String(text || '');
  s = s.replace(ACCENT_BRACED, accent).replace(ACCENT_BARE, accent);
  s = s.replace(/\{\\([A-Za-z]+)\}/g, command).replace(/\\([A-Za-z]+) ?/g, command);
  return s;
}

export async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(cacheKeyText(text));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function toBase64(vector) {
  const floats = Float32Array.from(vector);
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength).toString('base64');
}

/**
 * One category's announcement feed → the abstracts that will be hauled.
 *
 * Mirrors parseAnnouncementRSS in filter.js, including the two decisions that
 * change what gets hashed: replacements are dropped (they are old papers, not
 * tonight's haul), and the "arXiv:… Announce Type:…" header is stripped off the
 * description so only the abstract is embedded. Diverge on either and the
 * warmer caches vectors under hashes the browser never asks for.
 */
export function parseFeed(xml) {
  /* htmlEntities is load-bearing, not tidiness. Without it fast-xml-parser
     decodes the five named XML entities but leaves numeric character
     references alone — `&#8722;` stays as those eight characters, where the
     browser's DOMParser gives back a minus sign. Physics abstracts are full of
     numeric refs, so the two sides would hash differently for exactly those
     papers and cache them under keys the browser never asks for: a permanent,
     silent miss on the papers most worth caching. Verified 2026-08-11 against
     `&amp; &lt; &gt; &quot; &#8722; &#x3b1;`. */
  const parser = new XMLParser({
    ignoreAttributes: false, trimValues: true, htmlEntities: true,
  });
  const doc = parser.parse(xml);
  const raw = doc?.rss?.channel?.item ?? [];
  const items = Array.isArray(raw) ? raw : [raw];

  const out = [];
  for (const item of items) {
    const announce = String(item['arxiv:announce_type'] ?? 'new').trim();
    if (announce !== 'new' && announce !== 'cross') continue;

    const link = String(item.link ?? '');
    /* Bare, because the earlier-days pass dedupes against these ids and the
       search API spells the version suffix the feed omits (#49). */
    const arxivId = bareArxivId(link);
    if (!arxivId) continue;

    const desc = String(item.description ?? '');
    const m = desc.match(/Abstract:\s*([\s\S]*)$/);
    const abstract = cacheKeyText(deLatex(m ? m[1] : desc));
    if (!abstract) continue;

    /* Title and authors are for the feed to display, never for the cache key —
       `abstract` above is the only hashed field, and it must stay byte-for-byte
       what the browser hashes. Adding display fields here cannot move it. */
    const creators = item['dc:creator'];
    out.push({
      arxivId,
      abstract,
      title: cacheKeyText(String(item.title ?? '')),
      authors: cacheKeyText(String(Array.isArray(creators) ? creators.join(', ') : (creators ?? ''))),
      link: link || ('https://arxiv.org/abs/' + arxivId),
    });
  }
  return out;
}

/**
 * When arXiv last rebuilt this feed, as a UTC date string, or '' if it says.
 *
 * Load-bearing for a failure that otherwise reports success. arXiv rebuilds the
 * announcement around 04:00 UTC — `pubDate` is midnight ET, which *is* 04:00
 * UTC — and serves the previous day's listing until it does. A run before that
 * fetches yesterday, finds every abstract already cached from yesterday's run,
 * prints "865 already cached, 4 to embed" and exits 0, having warmed nothing
 * anyone will ask for. That is exactly what happened on 2026-08-12: the job
 * fired at 03:38 UTC against a feed built at 04:00:21, and the morning's
 * readers embedded all 94 abstracts themselves.
 */
export function feedBuildDate(xml) {
  const parser = new XMLParser({ ignoreAttributes: false, trimValues: true });
  const channel = parser.parse(xml)?.rss?.channel ?? {};
  const raw = String(channel.lastBuildDate ?? channel.pubDate ?? '').trim();
  if (!raw) return '';
  const when = new Date(raw);
  return Number.isNaN(when.getTime()) ? '' : when.toISOString().slice(0, 10);
}

/**
 * OpenAlex ships abstracts as an inverted index; the page rebuilds the prose
 * from it and embeds that. Mirrors fetchCoreFromOpenAlex in filter.js, stop
 * condition included: it walks positions from 0 until one is missing, so a gap
 * truncates rather than throwing. Reproduce the truncation, not the intent —
 * the goal is the browser's string, not the best possible string.
 */
export function reconstructAbstract(invIdx) {
  if (!invIdx) return '';
  const posToWord = {};
  for (const word of Object.keys(invIdx)) {
    for (const p of invIdx[word]) posToWord[p] = word;
  }
  const words = [];
  for (let pos = 0; posToWord[pos] !== undefined; pos++) words.push(posToWord[pos]);
  return words.join(' ');
}

/**
 * The exact text a core sample is cached under: title, a space, abstract.
 *
 * Diverge here and preset core samples cache under keys the page never asks
 * for — the same silent failure parseFeed is pinned against. When OpenAlex has
 * no abstract the page falls back to the title alone, which then appears twice
 * in the embedded string; that is what it hashes, so that is what we hash.
 */
export function coreEmbedText(title, abstract) {
  const body = abstract || title || '';
  return ((title || '') + ' ' + body).trim();
}

/** One preset's cacheable texts. Typed touchstones never come through here. */
export function presetUnits(preset, slug) {
  const units = [];
  for (const t of preset.touchstones ?? []) {
    const text = (t.text ?? '').trim();
    // `weight` and `kind` are inert here — the warmer only embeds. They ride
    // along so the feed builder can assay from the same rows the warmer warmed,
    // rather than re-deriving them and drifting.
    if (text) {
      units.push({
        text,
        source: `preset:${slug}`,
        kind: 'touchstone',
        weight: Number.isFinite(parseFloat(t.weight)) ? parseFloat(t.weight) : 1.0,
      });
    }
  }
  return units;
}

/**
 * The form of a DOI that OpenAlex actually resolves.
 *
 * `/works/10.1038/nature02693` is a 404 — verified 2026-08-12, along with the
 * two forms that do work. OpenAlex wants either the full doi.org URL or the
 * `doi:` prefix, and the bare string is the one everybody types. Normalizing to
 * `doi:` also makes the slash-bearing DOI safe to percent-encode whole.
 */
export function doiKey(doi) {
  const bare = String(doi || '').trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
    .replace(/^doi:/i, '');
  return bare ? 'doi:' + bare.toLowerCase() : '';
}

export async function fetchCore(doi, slug) {
  const key = doiKey(doi);
  if (!key) throw new Error(`${doi}: not a DOI`);
  const url = 'https://api.openalex.org/works/' + encodeURIComponent(key) +
    '?mailto=' + encodeURIComponent(OPENALEX_MAILTO);
  const resp = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!resp.ok) throw new Error(`${doi}: OpenAlex HTTP ${resp.status}`);
  const data = await resp.json();
  const text = coreEmbedText(data.title ?? '', reconstructAbstract(data.abstract_inverted_index));
  if (!text) throw new Error(`${doi}: no title and no abstract`);
  /* `title` is inert to the warmer, which only embeds `text`. It rides along so
     the feed can name the row a paper matched: the embed text is title and
     abstract run together, and cutting a label out of that gives half a title. */
  return {
    text, title: (data.title ?? '').trim(),
    source: `preset:${slug}`, kind: 'core', weight: 1.0, doi: doiKey(doi),
  };
}

/**
 * Every preset's touchstones and core samples, ready to embed.
 *
 * WHY PRESET TOUCHSTONES MAY BE CACHED AND TYPED ONES MAY NOT (spec §6c.3):
 * the rule is provenance, not row kind. "Nothing you type leaves this tab" is
 * about *typed* text — a sha256 of a short private phrase is one dictionary
 * lookup from the phrase. A preset phrase is text this repository published;
 * its hash discloses nothing that `git show` does not. The page enforces the
 * same line from the other side: a preset row that the user edits loses its
 * provenance flag and goes back to being embedded locally.
 */
export async function loadPresets(dir) {
  let names;
  try {
    names = (await fs.readdir(dir))
      .filter((n) => n.endsWith('.json') && n !== 'index.json')
      .sort();
  } catch (err) {
    throw new Error(`--presets ${dir}: ${err.message}`);
  }

  /* index.json is what the page offers as buttons; the directory is what gets
     warmed. A preset in one and not the other is either an invisible preset or
     a button that loads uncached text, and neither announces itself. Warn
     rather than fail: a mismatched manifest is a page problem, and stopping
     here would take the night's abstracts down with it. */
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(dir, 'index.json'), 'utf8'));
    const listed = new Set((manifest.presets ?? []).map((p) => p.slug + '.json'));
    const onDisk = new Set(names);
    const missing = [...onDisk].filter((n) => !listed.has(n));
    const phantom = [...listed].filter((n) => !onDisk.has(n));
    if (missing.length) console.warn(`warm-dig: not in index.json — ${missing.join(', ')}`);
    if (phantom.length) console.warn(`warm-dig: in index.json but not on disk — ${phantom.join(', ')}`);
  } catch (err) {
    console.warn(`warm-dig: no readable index.json in ${dir} — the page will show no presets`);
  }
  const units = [];
  const failures = [];
  const bySlug = new Map();
  for (const name of names) {
    const slug = name.replace(/\.json$/, '');
    const preset = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'));
    const rows = presetUnits(preset, slug);
    units.push(...rows);
    bySlug.set(slug, { preset, rows });
    for (const core of preset.cores ?? []) {
      if (!core.doi) continue;
      try {
        const unit = await fetchCore(core.doi, slug);
        unit.weight = Number.isFinite(parseFloat(core.weight)) ? parseFloat(core.weight) : 1.0;
        units.push(unit);
        bySlug.get(slug).rows.push(unit);
      } catch (err) {
        failures.push(err.message);
      }
    }
  }
  return { units, presets: names.length, failures, bySlug };
}

export async function fetchAbstracts(category) {
  const url = 'https://rss.arxiv.org/rss/' + encodeURIComponent(category);
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'arxave-warmer/0.1 (+https://github.com/jan-a-krzywda/arxave)' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) throw new Error(`${category}: HTTP ${resp.status}`);
  const xml = await resp.text();
  return { stones: parseFeed(xml), builtOn: feedBuildDate(xml) };
}

/* ── The earlier days ────────────────────────────────────────────────────
 *
 * The announcement feed carries one night, so until now that was the whole of
 * what the warmer covered: a haul with `lookback > 1` read the search API for
 * the earlier days and found them cold, whoever ran it paying the embedding for
 * everyone. The page's own lookback pass is mirrored below — same query, same
 * cutoff, same stop condition — so the days it asks for are the days that were
 * warmed.
 *
 * BYTE-IDENTICAL TO cutoffDate() IN docs/assets/filter.js, held there by the
 * parity test. Weekdays, not days: arXiv does not announce on the weekend, so
 * counting calendar days back from a Monday would ask for two empty days and
 * warm one real one.
 */
export function cutoffDate(onDate, lookbackDays) {
  const cursor = new Date(Date.UTC(onDate.getUTCFullYear(), onDate.getUTCMonth(), onDate.getUTCDate()));
  let remaining = Math.max(lookbackDays, 1);
  while (remaining > 0) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
    const dow = cursor.getUTCDay();
    if (dow >= 1 && dow <= 5) remaining -= 1;
  }
  return cursor.toISOString().substring(0, 10);
}

/** '…/abs/2508.12345v2', 'arXiv:2508.12345' → '2508.12345'. Mirrors filter.js. */
export function bareArxivId(raw) {
  return String(raw || '').trim()
    .replace(/^.*\/abs\//, '')
    .replace(/^arxiv:/i, '')
    .replace(/v\d+$/, '');
}

/**
 * The search API's Atom → the same stones parseFeed yields.
 *
 * The abstract goes through deLatex and cacheKeyText exactly as the feed's does.
 * That is the whole point of warming this source: the API already spells its
 * math in Unicode, so before deLatex the two sources hashed one paper to two
 * keys (#53), and warming one did nothing for the other.
 */
export function parseAtom(xml) {
  const parser = new XMLParser({
    ignoreAttributes: false, trimValues: true, htmlEntities: true,
  });
  const raw = parser.parse(xml)?.feed?.entry ?? [];
  const entries = Array.isArray(raw) ? raw : [raw];

  const out = [];
  for (const entry of entries) {
    const arxivId = bareArxivId(entry?.id ?? '');
    if (!arxivId) continue;
    const abstract = cacheKeyText(deLatex(String(entry.summary ?? '')));
    if (!abstract) continue;
    out.push({
      arxivId,
      abstract,
      published: String(entry.published ?? '').trim().substring(0, 10),
      link: 'https://arxiv.org/abs/' + arxivId,
    });
  }
  return out;
}

/**
 * Everything the page's lookback pass would ask for, back to the cutoff.
 *
 * ONE REQUEST PER CATEGORY, WHICH IS NOT WHAT THE PAGE SENDS. The page ORs its
 * categories into a single query under one `max_results`, and a reader scouting
 * two archives gets a window that reaches days back. The warmer covers four, so
 * the same shape spent the same 200 slots across twice the volume and bottomed
 * out mid-day: measured 2026-08-14, the single-query warm reached only 75 of
 * the 88 papers a quant-ph + cond-mat.mes-hall haul asks for on 2026-08-12,
 * leaving 13 cold on the boundary day. Per category, each gets the full window,
 * so any subset a reader scouts is covered at least as deeply as they scout it.
 *
 * The stop condition is the page's: the window is sorted newest first, so the
 * first paper older than the cutoff ends the list rather than filtering it — a
 * paper resubmitted into an old slot must not drag the window in behind it.
 */
export async function fetchEarlier(categories, lookback, maxResults, now = new Date()) {
  const cutoff = cutoffDate(now, lookback);
  const seen = new Set();
  const out = [];
  const failures = [];
  for (const cat of categories) {
    const url = 'https://export.arxiv.org/api/query?' +
      'search_query=cat:' + encodeURIComponent(cat) +
      '&sortBy=submittedDate&sortOrder=descending' +
      '&max_results=' + maxResults +
      '&start=0';
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'arxave-warmer/0.1 (+https://github.com/jan-a-krzywda/arxave)' },
        signal: AbortSignal.timeout(60_000),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      for (const s of withinCutoff(parseAtom(await resp.text()), cutoff)) {
        if (seen.has(s.arxivId)) continue;   // a cross-list is one abstract
        seen.add(s.arxivId);
        out.push(s);
      }
    } catch (err) {
      failures.push(`${cat} → ${err.message}`);
    }
    // arXiv asks for one request every three seconds, and means it.
    if (cat !== categories[categories.length - 1]) await new Promise((r) => setTimeout(r, 3_000));
  }
  if (failures.length && !out.length) throw new Error(`search API: ${failures.join(' | ')}`);
  if (failures.length) console.warn('warm-dig: some lookback windows failed — ' + failures.join(' | '));
  return out;
}

/** The page's loop: take from the newest until one falls past the cutoff. */
export function withinCutoff(candidates, cutoff) {
  const out = [];
  for (const c of candidates) {
    if (c.published && c.published < cutoff) break;
    out.push(c);
  }
  return out;
}

/**
 * Where to talk to the cache: the flag, then the environment, then the default.
 *
 * `||`, not `??`, and validated rather than trusted. **An unset GitHub Actions
 * variable interpolates to the empty string**, not to nothing, so
 * `env: DIG_CACHE_URL: ${{ vars.NOT_SET }}` hands this the empty string — which
 * `??` accepts as a perfectly good endpoint. The failure then lands twenty
 * seconds later, inside `fetch`, as `TypeError: Failed to parse URL from`,
 * after the whole day has been embedded and with nowhere to put it. Resolving
 * and validating up front turns that into an exit(2) in the first second.
 */
export function resolveEndpoint(flag, env) {
  const endpoint = flag || env || DEFAULT_ENDPOINT;
  try {
    new URL(endpoint);
  } catch {
    throw new Error(`--endpoint is not a valid URL: ${JSON.stringify(endpoint)}`);
  }
  return endpoint;
}

export async function loadModel() {
  for (let attempt = 1; ; attempt++) {
    try {
      return await pipeline('feature-extraction', MODEL, { dtype: DTYPE });
    } catch (err) {
      if (attempt >= MODEL_LOAD_ATTEMPTS) throw err;
      const wait = MODEL_LOAD_BACKOFF_MS * attempt;
      console.warn(
        `warm-dig: model load failed (${err.message}); ` +
        `retrying in ${wait / 1000}s (${attempt}/${MODEL_LOAD_ATTEMPTS - 1})`,
      );
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

async function main() {
  const categories = (arg('categories') ?? '')
    .split(',').map((c) => c.trim()).filter(Boolean);
  if (categories.length === 0) {
    console.error('warm-dig: --categories is required, e.g. --categories "quant-ph"');
    process.exit(2);
  }
  let endpoint;
  try {
    endpoint = resolveEndpoint(arg('endpoint'), process.env.DIG_CACHE_URL);
  } catch (err) {
    console.error('warm-dig: ' + err.message);
    process.exit(2);
  }
  const writeKey = process.env.DIG_WRITE_KEY ?? '';
  if (!writeKey && !DRY_RUN) {
    console.error('warm-dig: $DIG_WRITE_KEY is unset. Set it, or pass --dry-run.');
    process.exit(2);
  }

  // Dedupe across categories: a cross-listed paper is one abstract, not two.
  const seen = new Set();
  const stones = [];
  const failures = [];
  const builtOn = new Set();
  for (const cat of categories) {
    try {
      const feed = await fetchAbstracts(cat);
      if (feed.builtOn) builtOn.add(feed.builtOn);
      for (const s of feed.stones) {
        if (seen.has(s.arxivId)) continue;
        seen.add(s.arxivId);
        stones.push(s);
      }
    } catch (err) {
      failures.push(`${cat} → ${err.message}`);
    }
  }

  /* Warming yesterday is not a warm run, and it must not exit 0. See
     feedBuildDate: every abstract is already cached, so the numbers look
     healthier than a real run does. */
  const today = new Date().toISOString().slice(0, 10);
  const stale = [...builtOn].filter((d) => d < today);
  if (builtOn.size && stale.length === builtOn.size) {
    console.error(
      `warm-dig: the feed is still ${[...builtOn].join(', ')} — arXiv has not ` +
      `built ${today} yet (it rebuilds ~04:00 UTC). Warming this would cache ` +
      `yesterday again. Run later.`,
    );
    process.exit(3);
  }
  if (stale.length) {
    console.warn(`warm-dig: some feeds are still on ${stale.join(', ')}, not ${today}`);
  }
  if (stones.length === 0) {
    console.error('warm-dig: nothing to warm.' + (failures.length ? ' ' + failures.join(' | ') : ''));
    process.exit(failures.length ? 1 : 0);
  }
  if (failures.length) console.warn('warm-dig: some feeds failed — ' + failures.join(' | '));
  console.log(`warm-dig: ${stones.length} abstracts from ${categories.join(', ')}`);

  /* The earlier days ride on the same model load, and only their misses cost
     anything: a day already warmed by yesterday's run is a cache hit here, so
     the steady-state price of --lookback is one HTTP request. It is worth
     paying every night rather than once, because a paper submitted to an old
     slot only appears in this window afterwards. Failure is a warning, never
     fatal — tonight is what people read, and it is already in hand. */
  const lookback = parseInt(arg('lookback', '1'), 10) || 1;
  /* Deeper than the page's 200, because this window has to reach the cutoff
     rather than fill a screen: cs.AI alone announced 211 papers on 2026-08-14,
     so 200 does not survive one day of a busy archive, let alone `lookback` of
     them. Over-fetching is nearly free — the surplus is one cache read that
     hits — while under-fetching is silent, and lands as a cold boundary day. */
  const maxResults = parseInt(arg('max-results', '400'), 10) || 400;
  if (lookback > 1) {
    try {
      const earlier = await fetchEarlier(categories, lookback, maxResults);
      let added = 0;
      for (const s of earlier) {
        if (seen.has(s.arxivId)) continue;
        seen.add(s.arxivId);
        stones.push(s);
        added++;
      }
      console.log(
        `warm-dig: ${added} more from the ${lookback - 1} weekday(s) before ` +
        `today, back to ${cutoffDate(new Date(), lookback)}`,
      );
    } catch (err) {
      console.warn(`warm-dig: the lookback window failed (${err.message}) — tonight is warmed anyway`);
    }
  }

  /* Presets ride along with the day's abstracts rather than in their own job:
     they share the model load, which is the expensive part, and they are a
     handful of texts against several hundred. Their vectors never change, so
     after the first warm every later run finds them cached and skips them. */
  const units = stones.map((s) => ({ text: s.abstract, source: 'arxiv:' + s.arxivId }));
  const presetDir = arg('presets');
  if (presetDir) {
    const loaded = await loadPresets(presetDir);
    if (loaded.failures.length) {
      console.warn('warm-dig: some core samples failed — ' + loaded.failures.join(' | '));
    }
    console.log(`warm-dig: ${loaded.units.length} preset texts from ${loaded.presets} preset(s)`);
    units.push(...loaded.units);
  }

  // Skip what is already cached: on a re-run, or when the browser's own hauls
  // have already covered the day, this makes the job seconds instead of a minute.
  const shas = await Promise.all(units.map((u) => sha256Hex(u.text)));
  const unique = [...new Set(shas)];
  let known = new Set();
  try {
    /* Chunked, because the four popular archives together announce ~870 papers
       a day and the endpoint caps a read at MAX_SHAS. Sending them all in one
       request earns a 413, which this code treats as "cache unavailable" — so
       the whole night's work would be re-embedded rather than skipped, and
       nothing would look broken. */
    for (let i = 0; i < unique.length; i += READ_CHUNK) {
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL, dim: DIM, sha: unique.slice(i, i + READ_CHUNK) }),
      });
      if (!resp.ok) {
        console.warn(`warm-dig: cache read HTTP ${resp.status} — warming everything`);
        known = new Set();
        break;
      }
      for (const sha of Object.keys((await resp.json()).hits ?? {})) known.add(sha);
    }
  } catch (err) {
    console.warn(`warm-dig: cache unreachable (${err.message}) — warming everything`);
    known = new Set();
  }

  const todo = [];
  const queued = new Set();
  for (let i = 0; i < units.length; i++) {
    // Two categories can carry the same abstract, and two presets the same core
    // sample. Embedding it twice writes the same row twice.
    if (known.has(shas[i]) || queued.has(shas[i])) continue;
    queued.add(shas[i]);
    todo.push({ ...units[i], sha: shas[i] });
  }
  console.log(`warm-dig: ${known.size} already cached, ${todo.length} to embed`);
  if (todo.length === 0) return;

  const extractor = await loadModel();

  const items = [];
  for (let i = 0; i < todo.length; i += BATCH) {
    const chunk = todo.slice(i, i + BATCH);
    const out = await extractor(chunk.map((u) => u.text), { pooling: 'mean', normalize: true });
    const rows = out.tolist();
    for (let r = 0; r < rows.length; r++) {
      if (rows[r].length !== DIM) {
        throw new Error(`model returned ${rows[r].length} dims, expected ${DIM}`);
      }
      items.push({ sha: chunk[r].sha, vector: toBase64(rows[r]), source: chunk[r].source });
    }
    process.stdout.write(`\rwarm-dig: embedded ${items.length} / ${todo.length}`);
  }
  process.stdout.write('\n');

  if (DRY_RUN) {
    console.log(`warm-dig: --dry-run, ${items.length} vectors not written`);
    return;
  }

  let written = 0;
  for (let i = 0; i < items.length; i += PUT_CHUNK) {
    const resp = await fetch(endpoint, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-dig-key': writeKey },
      body: JSON.stringify({ model: MODEL, dim: DIM, items: items.slice(i, i + PUT_CHUNK) }),
    });
    if (!resp.ok) {
      throw new Error(`cache write HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    }
    written += (await resp.json()).written ?? 0;
  }
  console.log(`warm-dig: wrote ${written} vectors`);
}

// Importable for tests; only the CLI invocation runs the job.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('warm-dig: ' + (err?.stack ?? err));
    process.exit(1);
  });
}
