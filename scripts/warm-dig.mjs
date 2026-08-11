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
 *   --categories  comma-separated arXiv categories (required)
 *   --endpoint    dig-cache URL (default: the project's deployed function)
 *   --dry-run     fetch and embed, write nothing
 */

import { pathToFileURL } from 'node:url';
import { XMLParser } from 'fast-xml-parser';
import { pipeline } from '@huggingface/transformers';

// Must match docs/assets/filter.js exactly — these three strings are the cache key.
const MODEL = 'Xenova/bge-small-en-v1.5';
const DIM = 384;
const DTYPE = 'q8';

const BATCH = 16;
const DEFAULT_ENDPOINT =
  'https://ugxxakguqgpxpdfhgtsb.supabase.co/functions/v1/dig-cache';
const PUT_CHUNK = 200;   // stays under the function's MAX_ITEMS

function arg(name, fallback = null) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const DRY_RUN = process.argv.includes('--dry-run');

/** Collapse exactly as filter.js and store.py do — all three must agree. */
export function cacheKeyText(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

async function sha256Hex(text) {
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
    const arxivId = link.replace(/^.*\/abs\//, '').trim();
    if (!arxivId) continue;

    const desc = String(item.description ?? '');
    const m = desc.match(/Abstract:\s*([\s\S]*)$/);
    const abstract = cacheKeyText(m ? m[1] : desc);
    if (!abstract) continue;

    out.push({ arxivId, abstract });
  }
  return out;
}

async function fetchAbstracts(category) {
  const url = 'https://rss.arxiv.org/rss/' + encodeURIComponent(category);
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'arxave-warmer/0.1 (+https://github.com/jan-a-krzywda/arxave)' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) throw new Error(`${category}: HTTP ${resp.status}`);
  return parseFeed(await resp.text());
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
  for (const cat of categories) {
    try {
      for (const s of await fetchAbstracts(cat)) {
        if (seen.has(s.arxivId)) continue;
        seen.add(s.arxivId);
        stones.push(s);
      }
    } catch (err) {
      failures.push(`${cat} → ${err.message}`);
    }
  }
  if (stones.length === 0) {
    console.error('warm-dig: nothing to warm.' + (failures.length ? ' ' + failures.join(' | ') : ''));
    process.exit(failures.length ? 1 : 0);
  }
  if (failures.length) console.warn('warm-dig: some feeds failed — ' + failures.join(' | '));
  console.log(`warm-dig: ${stones.length} abstracts from ${categories.join(', ')}`);

  // Skip what is already cached: on a re-run, or when the browser's own hauls
  // have already covered the day, this makes the job seconds instead of a minute.
  const shas = await Promise.all(stones.map((s) => sha256Hex(s.abstract)));
  let known = new Set();
  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, dim: DIM, sha: [...new Set(shas)] }),
    });
    if (resp.ok) known = new Set(Object.keys((await resp.json()).hits ?? {}));
    else console.warn(`warm-dig: cache read HTTP ${resp.status} — warming everything`);
  } catch (err) {
    console.warn(`warm-dig: cache unreachable (${err.message}) — warming everything`);
  }

  const todo = [];
  for (let i = 0; i < stones.length; i++) {
    if (!known.has(shas[i])) todo.push({ ...stones[i], sha: shas[i] });
  }
  console.log(`warm-dig: ${known.size} already cached, ${todo.length} to embed`);
  if (todo.length === 0) return;

  const extractor = await pipeline('feature-extraction', MODEL, { dtype: DTYPE });

  const items = [];
  for (let i = 0; i < todo.length; i += BATCH) {
    const chunk = todo.slice(i, i + BATCH);
    const out = await extractor(chunk.map((s) => s.abstract), { pooling: 'mean', normalize: true });
    const rows = out.tolist();
    for (let r = 0; r < rows.length; r++) {
      if (rows[r].length !== DIM) {
        throw new Error(`model returned ${rows[r].length} dims, expected ${DIM}`);
      }
      items.push({
        sha: chunk[r].sha,
        vector: toBase64(rows[r]),
        source: 'arxiv:' + chunk[r].arxivId,
      });
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
