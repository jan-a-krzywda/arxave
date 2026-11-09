/**
 * sieve-ui — everything the Sieve page does that is not the DOM and not the
 * arithmetic: fetch, parse, embed, remember, render-to-a-string.
 *
 * WHY THIS IS A FILE OF ITS OWN. sieve.js needs a document, a `Dig` button and
 * `localStorage`, so it cannot be tested with `node --test`. The parts that can
 * go wrong silently — an RSS item read with the wrong tag, a cache key built
 * from a different string than the warmer used, a vector index taken
 * positionally, a slider position that cannot be read back — are all in this
 * file, and every one of them is exercised by scripts/sieve-ui.test.mjs with no
 * DOM and no network (every fetch is injectable).
 *
 * WHAT IT DELIBERATELY DOES NOT DO: deLatex. scripts/warm-dig.mjs converts TeX
 * escapes in abstracts to Unicode before hashing, so an abstract carrying
 * `L\"uders` misses the shared dig-cache here. That is a more expensive
 * embedding, not a wrong one: the model reads the same abstract, and a
 * candidate is never compared against itself.
 * ponytail: cache hit rate is lower for TeX-bearing abstracts; copy deLatex
 * from docs/assets/filter.js if that ever matters.
 */

/* The cache key, and the same two strings docs/assets/filter.js,
   scripts/warm-dig.mjs and supabase/functions/embed/hf.ts carry. A same-shaped
   vector from a different model scores plausibly and ranks the wrong papers, so
   the model is checked on every reply rather than assumed. */
export const MODEL = 'allenai/specter2_base';
export const DIM = 768;

/* ── text ───────────────────────────────────────────────────────────────── */

/**
 * Collapse exactly as the server and the warmer do, so all sides hash the same
 * string. Verbatim from docs/assets/filter.js and scripts/warm-dig.mjs.
 */
export function cacheKeyText(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

/**
 * The exact string a corpus paper was embedded under by scripts/corpus-build.mjs
 * (`cacheKeyText(coreEmbedText(title, abstract))`). Built the same way here, so
 * a paper the warmer has already cut is a cache hit instead of a second bill.
 */
export function paperEmbedText(title, abstract) {
  const body = abstract || title || '';
  return cacheKeyText(((title || '') + ' ' + body).trim());
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** XML entities → characters. Unknown entities are left alone rather than eaten. */
export function decodeEntities(text) {
  return String(text ?? '').replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (match, body) => {
    if (body[0] !== '#') return ENTITIES[body.toLowerCase()] ?? match;
    const code = body[1] === 'x' || body[1] === 'X'
      ? parseInt(body.slice(2), 16)
      : parseInt(body.slice(1), 10);
    return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
      ? String.fromCodePoint(code)
      : match;
  });
}

/** Transcribed from docs/assets/filter.js: titles go into innerHTML. */
export function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* '.../abs/2508.12345v2' → '2508.12345'. The feed drops the version suffix and
   the search API keeps it, so dedup only works on the bare id. */
export function bareArxivId(raw) {
  return String(raw || '').trim()
    .replace(/^.*\/abs\//, '')
    .replace(/^arxiv:/i, '')
    .replace(/v\d+$/, '');
}

/** 'YYYY-MM-DD' for a date the feed phrased some other way, or '' if unreadable. */
function isoDate(text) {
  const d = new Date(String(text || '').trim());
  return isNaN(d) ? '' : d.toISOString().slice(0, 10);
}

/**
 * Every `<block>…</block>` body in an XML document, as raw text. A regex rather
 * than DOMParser because this file also runs under `node --test`, and arXiv's
 * two feeds are flat lists of flat items — the one shape a regex reads exactly.
 */
function blocks(xml, name) {
  const re = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(String(xml)))) out.push(m[1]);
  return out;
}

/** The text of the first `<name>` in `block`, decoded and collapsed. */
function tag(block, name) {
  const m = String(block).match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() : '';
}

function absUrl(id) { return 'https://arxiv.org/abs/' + id; }

/* ── the two feeds arXiv answers with ───────────────────────────────────── */

/**
 * One category's announcement feed (rss.arxiv.org) → candidates.
 *
 * Replacements are dropped: they are old papers with a new version, not
 * tonight's haul. The description is `arXiv:ID vN Announce Type: new \nAbstract:
 * …`, so the header is cut before it reaches the embedding — it is the same
 * boilerplate on every paper and would only add noise.
 */
export function parseAnnouncementRSS(xmlText, wantedCat) {
  const out = [];
  for (const item of blocks(xmlText, 'item')) {
    const announce = tag(item, 'arxiv:announce_type') || 'new';
    if (announce !== 'new' && announce !== 'cross') continue;

    const id = bareArxivId(tag(item, 'link'));
    if (!id) continue;

    const desc = tag(item, 'description');
    const abstract = (desc.match(/Abstract:\s*([\s\S]*)$/) || [null, desc])[1].trim();

    const authors = [];
    for (const who of blocks(item, 'dc:creator')) {
      for (const name of decodeEntities(who).split(',')) {
        const trimmed = cacheKeyText(name);
        if (trimmed) authors.push(trimmed);
      }
    }

    out.push({
      id,
      title: tag(item, 'title'),
      abstract,
      authors,
      primary_category: tag(item, 'category') || wantedCat,
      published: isoDate(tag(item, 'pubDate')),
      abs_url: absUrl(id),
    });
  }
  return out;
}

/** The search API's Atom feed — the only source that can reach past tonight. */
export function parseAtomEntries(xmlText) {
  const out = [];
  for (const entry of blocks(xmlText, 'entry')) {
    const id = bareArxivId(tag(entry, 'id'));
    if (!id) continue;
    const authors = [];
    for (const m of String(entry).matchAll(/<name\b[^>]*>([\s\S]*?)<\/name>/gi)) {
      const name = cacheKeyText(decodeEntities(m[1]));
      if (name) authors.push(name);
    }
    const term = String(entry).match(/<category\b[^>]*\bterm="([^"]+)"/i);
    out.push({
      id,
      title: tag(entry, 'title'),
      abstract: tag(entry, 'summary'),
      authors,
      primary_category: term ? term[1] : '',
      published: tag(entry, 'published').slice(0, 10),
      abs_url: absUrl(id),
    });
  }
  return out;
}

/**
 * The oldest day a `lookback`-day window reaches, as a 'YYYY-MM-DD' the search
 * API's `published` strings compare against. Weekends are skipped because arXiv
 * announces nothing on them, so "3 days back" is three announcements ago and
 * not a Saturday.
 */
export function cutoffDate(onDate, lookbackDays) {
  const cursor = new Date(Date.UTC(onDate.getUTCFullYear(), onDate.getUTCMonth(), onDate.getUTCDate()));
  let remaining = Math.max(lookbackDays, 1);
  while (remaining > 0) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
    const dow = cursor.getUTCDay();
    if (dow >= 1 && dow <= 5) remaining -= 1;
  }
  return cursor.toISOString().slice(0, 10);
}

/* ── the relay ──────────────────────────────────────────────────────────── */

/** `base` (a relay URL, maybe already carrying a query) + the target URL. */
export function relayUrl(base, url) {
  const p = String(base || '');
  if (p.endsWith('?') || p.endsWith('=')) return p + encodeURIComponent(url);
  if (p.indexOf('?') === -1) return p + '?url=' + encodeURIComponent(url);
  return p + '&url=' + encodeURIComponent(url);
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cameFromCache(resp) {
  /* A proxy the reader supplied sends no such header. Unknown means "assume it
     went upstream": pacing an already-cheap call is a small cost, skipping a
     pace on an expensive one is the failure the pacing exists to prevent. */
  try {
    const tagHeader = resp.headers && resp.headers.get('x-relay-cache');
    return tagHeader === 'hit' || tagHeader === 'stale';
  } catch (_) {
    return false;
  }
}

/* 429 and the 5xx family are "ask again shortly"; a 403 or a 404 is a verdict on
   the URL, and retrying it only spends the budget we are trying to protect. */
function worthRetrying(status) {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

/* How long the server asked us to wait, capped at 30 s. arXiv's gateway sends
   no Retry-After at all, which is why there is a backoff underneath this. */
function retryAfterMs(resp) {
  let raw = '';
  try { raw = (resp.headers && resp.headers.get('Retry-After')) || ''; } catch (_) { return 0; }
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 30000);
  const when = Date.parse(raw);
  return isNaN(when) ? 0 : Math.max(0, Math.min(when - Date.now(), 30000));
}

/**
 * A relay fetcher that paces itself. arXiv's rate is one request per three
 * seconds counted per *client*, and because the relay does the fetching the
 * client is the relay, shared by everyone on the page — so the page waits
 * between calls that actually went upstream (see `x-relay-cache`).
 *
 * Built as a closure rather than a module-level function so the pace state is
 * per page load and the whole thing is injectable in tests.
 */
export function createRelay({ relayBase, fetchImpl = fetch, sleep = sleepMs, gap = 3000, tries = 3 } = {}) {
  let lastUpstreamAt = 0;
  return async function fetchViaRelay(url, opts) {
    const remaining = lastUpstreamAt ? gap - (Date.now() - lastUpstreamAt) : 0;
    if (remaining > 0) await sleep(remaining);

    let resp = null;
    let lastErr = null;
    for (let attempt = 0; attempt < tries; attempt++) {
      if (attempt > 0) await sleep(retryAfterMs(resp) || gap * 2 ** (attempt - 1));
      try {
        resp = await fetchImpl(relayUrl(relayBase, url), opts || {});
      } catch (err) {
        resp = null;
        lastErr = err;
        continue;
      }
      lastErr = null;
      if (!cameFromCache(resp)) lastUpstreamAt = Date.now();
      if (resp.ok || !worthRetrying(resp.status)) return resp;
    }
    if (resp) return resp;       // out of attempts: hand back the last refusal
    throw lastErr || new Error('relay unreachable');
  };
}

/* "HTTP 429 — Rate exceeded" reads like the reader did something too fast,
   which is almost never what happened: the limit is shared. */
export async function relayFailure(resp) {
  let body = '';
  try { body = (await resp.text()).slice(0, 200); } catch (_) { /* nothing to add */ }
  if (resp.status === 429) {
    return 'arXiv is throttling the shared relay (HTTP 429) — everyone on this page '
      + 'fetches through one server. Wait a minute and dig again.';
  }
  return 'HTTP ' + resp.status + (body ? ' — ' + body : '');
}

/**
 * Tonight's announcement across every scouted category, deduped by id, plus the
 * search API when the reader asked for more than one day.
 *
 * ONE CATEGORY MUST NOT TAKE THE OTHERS DOWN WITH IT, so the try covers the
 * whole per-category leg — relay call, body, parse. A single bad feed used to
 * reject a whole haul and throw away the categories that had already arrived.
 * Every feed failing is an error; some failing is a warning.
 */
export async function fetchAnnouncement({ categories, lookback = 1, fetchViaRelay, maxResults = 300, now = new Date() }) {
  const seen = new Set();
  const candidates = [];
  const failures = [];

  for (const cat of categories) {
    try {
      const resp = await fetchViaRelay('https://rss.arxiv.org/rss/' + encodeURIComponent(cat));
      if (!resp.ok) throw new Error(await relayFailure(resp));
      for (const paper of parseAnnouncementRSS(await resp.text(), cat)) {
        if (seen.has(paper.id)) continue;
        seen.add(paper.id);
        candidates.push(paper);
      }
    } catch (err) {
      failures.push(cat + ' → ' + ((err && err.message) || String(err)));
    }
  }

  if (lookback > 1) {
    const query = categories.map((c) => 'cat:' + c).join('+OR+');
    const url = 'https://export.arxiv.org/api/query?search_query=' + query
      + '&sortBy=submittedDate&sortOrder=descending&max_results=' + maxResults + '&start=0';
    try {
      const resp = await fetchViaRelay(url);
      if (!resp.ok) throw new Error(await relayFailure(resp));
      const cutoff = cutoffDate(now, lookback);
      for (const paper of parseAtomEntries(await resp.text())) {
        if (paper.published && paper.published < cutoff) break;
        if (seen.has(paper.id)) continue;
        seen.add(paper.id);
        candidates.push(paper);
      }
    } catch (err) {
      failures.push('lookback → ' + ((err && err.message) || String(err)));
    }
  }

  if (!candidates.length && failures.length) {
    throw new Error('arXiv scout failed: ' + failures.join(' | '));
  }
  return { candidates: candidates.slice(0, maxResults), failures };
}

/* ── the corpus ─────────────────────────────────────────────────────────── */

/** Thrown when corpus.json or corpus.vec.bin is not there — the demo-mode signal. */
export class CorpusMissing extends Error {}

/** base + name, with exactly one slash between them. */
export function joinUrl(base, name) {
  const b = String(base ?? '');
  return (b === '' || b.endsWith('/') ? b : b + '/') + name;
}

/**
 * corpus.json + corpus.vec.bin from the site's own assets. A 404 is not an
 * error the reader should see raw: it is the signal that this build predates the
 * corpus, which the page answers with demo mode.
 */
export async function loadCorpusFrom(base, { fetchImpl = fetch } = {}) {
  const jsonResp = await fetchImpl(joinUrl(base, 'corpus.json'));
  if (!jsonResp.ok) throw new CorpusMissing(`corpus.json answered HTTP ${jsonResp.status}`);
  const json = await jsonResp.json();
  const binResp = await fetchImpl(joinUrl(base, 'corpus.vec.bin'));
  if (!binResp.ok) throw new CorpusMissing(`corpus.vec.bin answered HTTP ${binResp.status}`);
  return { json, bin: await binResp.arrayBuffer() };
}

/* A seeded generator, so the demo corpus is the same 40 papers on every load —
   a page whose ranking changes between reloads cannot be reasoned about. */
function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function unit(values) {
  let sum = 0;
  for (const v of values) sum += v * v;
  const norm = Math.sqrt(sum) || 1;
  return values.map((v) => v / norm);
}

const DEMO_TOPICS = ['Superconducting qubits', 'Topological matter', 'Quantum optics', 'Spin sensing'];

/**
 * A synthetic 40-paper corpus, in the same shape S2 writes: four topics of ten
 * papers each, unit vectors quantised to int8 exactly as `corpus.vec.bin` is.
 *
 * The page has to be openable before the real corpus exists (and it exists on a
 * branch that may not be deployed yet), so this stands in: real geometry — four
 * separated directions — so the sliders and the ranking do something visible
 * rather than shuffling noise.
 */
export function demoCorpus({ n = 40, dim = DIM, k = DEMO_TOPICS.length, seed = 7 } = {}) {
  const rnd = lcg(seed);
  const centres = centresFor(k, dim, rnd);
  const rows = [];
  const ids = [];
  const titles = [];
  const pct = [];
  const cluster = [];
  for (let i = 0; i < n; i++) {
    const c = i % k;
    rows.push(unit(centres[c].map((v) => v + 0.45 * (rnd() * 2 - 1))));
    ids.push(`demo.${String(i + 1).padStart(4, '0')}`);
    titles.push(`${DEMO_TOPICS[c]} — demo paper ${i + 1}`);
    pct.push(Number((1 - i / n).toFixed(5)));
    cluster.push(c);
  }

  const mean = new Float32Array(dim);
  for (const row of rows) for (let d = 0; d < dim; d++) mean[d] += row[d] / n;
  /* S2 writes centroids of the *centred* vectors, re-normalised, and the sliders
     are read through those centroids — an uncentred one here would score every
     demo paper against a direction nothing else is measured in. */
  const centroids = centres.map((centre) => centredUnit(centre, mean).map((v) => Number(v.toFixed(4))));

  let scale = 0;
  for (const row of rows) for (const v of row) scale = Math.max(scale, Math.abs(v));
  const bin = new Int8Array(n * dim);
  for (let i = 0; i < n; i++) {
    for (let d = 0; d < dim; d++) {
      const v = rows[i][d];
      bin[i * dim + d] = Math.round(Math.max(-scale, Math.min(scale, v)) / scale * 127);
    }
  }

  return {
    json: {
      built_on: 'demo', model: MODEL, dim, n, scale,
      mean: Array.from(mean, (v) => Number(v.toFixed(5))),
      window: { from: 'demo', to: 'demo' },
      ids,
      titles,
      pct,
      cluster,
      clusters: centroids.map((centroid, id) => ({
        id, label: DEMO_TOPICS[id], size: n / k, centroid,
      })),
    },
    bin: bin.buffer,
  };
}

/** `vec - mean`, L2-normalised — the same convention as sieve-core's centreUnit. */
function centredUnit(vec, mean) {
  return unit(vec.map((v, d) => v - mean[d]));
}

function centresFor(k, dim, rnd) {
  const centres = [];
  for (let c = 0; c < k; c++) {
    centres.push(unit(Array.from({ length: dim }, () => rnd() * 2 - 1)));
  }
  return centres.map((v) => v.map((x) => Number(x.toFixed(4))));
}

/**
 * Demo candidates, already centred by `loadCorpus` — the page can be driven
 * end to end with no network at all, which is what "testable before the corpus
 * exists" has to mean on a laptop with the relay down.
 * ponytail: 12 papers, no abstracts; a real haul replaces them.
 */
export function demoCandidates(corpus, count = 12) {
  const { dim, vecs, ids, titles } = corpus;
  const out = [];
  for (let i = 0; i < Math.min(count, corpus.n); i++) {
    out.push({
      id: ids[i],
      title: titles[i],
      abstract: '',
      abs_url: '',
      demo: true,
      vec: vecs.slice(i * dim, (i + 1) * dim),
    });
  }
  return out;
}

/* ── embedding, with and without the shared cache ───────────────────────── */

function normalise(vector) {
  const v = Float32Array.from(vector);
  let sum = 0;
  for (const x of v) sum += x * x;
  const norm = Math.sqrt(sum);
  if (norm > 0 && Number.isFinite(norm)) for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}

/**
 * The hosted pick, one OpenAI-shaped call per chunk: unit vector per text, in
 * the order they were handed over.
 *
 * `index` IS LOAD-BEARING. An OpenAI-shaped reply is allowed to come back out of
 * order, and reading it positionally would attach every vector to the wrong
 * abstract with nothing to notice — so a duplicate or out-of-range index is an
 * error rather than a guess. The model is checked too: two models at the same
 * dimension produce plausible scores and no error at all.
 *
 * NO CACHE HERE, and that is the point: this is the path typed touchstones take,
 * and a hash of someone's own sentence sitting in a public table is one
 * dictionary away from the sentence.
 */
export async function embedTexts({
  texts, embedUrl, fetchImpl = fetch, chunk = 64, model = MODEL, dim = DIM, onProgress,
}) {
  const vectors = [];
  for (let i = 0; i < texts.length; i += chunk) {
    const slice = texts.slice(i, i + chunk);
    let resp;
    try {
      resp = await fetchImpl(embedUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: slice }),
      });
    } catch (err) {
      throw new Error('Could not reach the pick: ' + ((err && err.message) || err));
    }

    let data = null;
    try { data = await resp.json(); } catch (_) { /* fall through to the status */ }

    if (!resp.ok) {
      if (resp.status === 503 && data && data.warming) {
        throw new Error('The pick is warming up (about ' + (data.retryAfter || 20)
          + 's). This happens on the first cut after a quiet spell — press again shortly.');
      }
      throw new Error((data && data.error) || ('The pick answered HTTP ' + resp.status));
    }
    if (data && data.model && data.model !== model) {
      throw new Error('The pick is running ' + data.model + ', but this page reads ' + model
        + '. Same-shaped vectors from a different model would rank the wrong papers — refusing rather than guessing.');
    }
    if (data && data.dim && data.dim !== dim) {
      throw new Error('The pick returned ' + data.dim + '-dim vectors, but this page reads ' + dim + '.');
    }

    const rows = (data && data.data) || [];
    if (rows.length !== slice.length) {
      throw new Error('The pick returned ' + rows.length + ' vectors for ' + slice.length + ' texts.');
    }
    const ordered = new Array(slice.length);
    for (const row of rows) {
      const at = typeof row.index === 'number' ? row.index : -1;
      if (at < 0 || at >= slice.length || ordered[at]) {
        throw new Error('The pick returned a vector with a bad index.');
      }
      ordered[at] = normalise(row.embedding);
    }
    for (const v of ordered) vectors.push(v);
    if (onProgress) onProgress(vectors.length, texts.length);
  }
  return vectors;
}

function bytesFromBase64(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeVector(b64, dim) {
  const bytes = bytesFromBase64(b64);
  if (bytes.length !== dim * 4) {
    throw new Error('cached vector is ' + bytes.length + ' bytes, expected ' + (dim * 4));
  }
  /* The invariant is ours to hold, not the server's — normalise on ingest. */
  return normalise(new Float32Array(bytes.buffer, bytes.byteOffset, dim));
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(cacheKeyText(text)));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Ask the shared dig-cache for these texts → `{ shas, hits: { sha: vector } }`.
 * Every failure is a miss, never an error: the cache is an optimization and the
 * page must work with it down, empty, or opted out.
 *
 * Only PUBLISHED text is ever passed in here — arXiv abstracts, in practice. A
 * touchstone never reaches this function (see embedTexts).
 */
export async function cacheLookup({
  texts, cacheUrl, fetchImpl = fetch, model = MODEL, dim = DIM, chunk = 500,
}) {
  const empty = { shas: [], hits: {} };
  if (!cacheUrl || !texts.length || !(globalThis.crypto && crypto.subtle)) return empty;
  let shas;
  try {
    shas = await Promise.all(texts.map(sha256Hex));
  } catch (_) {
    return empty;
  }
  const unique = [...new Set(shas)];
  const hits = {};
  try {
    for (let c = 0; c < unique.length; c += chunk) {
      const resp = await fetchImpl(cacheUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, dim, sha: unique.slice(c, c + chunk) }),
      });
      if (!resp.ok) return { shas, hits: {} };
      const data = await resp.json();
      for (const [sha, vector] of Object.entries(data.hits || {})) {
        try { hits[sha] = decodeVector(vector, dim); } catch (_) { /* a bad row is a miss */ }
      }
    }
  } catch (_) {
    return { shas, hits: {} };
  }
  return { shas, hits };
}

/**
 * `embedTexts` with the shared cache in front of it, for candidate abstracts
 * (which are already public) — the same split docs/assets/filter.js makes.
 */
export async function embedCandidates({
  texts, embedUrl, cacheUrl, fetchImpl = fetch, chunk = 64, model = MODEL, dim = DIM, onProgress,
}) {
  const look = await cacheLookup({ texts, cacheUrl, fetchImpl, model, dim });
  const vectors = new Array(texts.length);
  const missing = [];
  for (let i = 0; i < texts.length; i++) {
    const hit = look.shas.length ? look.hits[look.shas[i]] : null;
    if (hit) vectors[i] = hit;
    else missing.push(i);
  }
  const cached = texts.length - missing.length;
  if (onProgress) onProgress(cached, texts.length);
  if (missing.length) {
    const fresh = await embedTexts({
      texts: missing.map((i) => texts[i]),
      embedUrl, fetchImpl, chunk, model, dim,
      onProgress: onProgress && ((done, total) => onProgress(cached + done, total)),
    });
    missing.forEach((at, i) => { vectors[at] = fresh[i]; });
  }
  vectors.cached = cached;
  return vectors;
}

/* ── what survives a reload ─────────────────────────────────────────────── */

/**
 * localStorage, wrapped so it cannot take the page down. Safari in private mode
 * throws on both halves, and a full quota throws on write — neither is a reason
 * for the Dig button to stop working.
 */
export function readStore(storage, key, fallback) {
  try {
    const raw = storage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (_) {
    return fallback;
  }
}

export function writeStore(storage, key, value) {
  try {
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch (_) {
    return false;
  }
}

/* ── results, as strings ────────────────────────────────────────────────── */

const round = (v, digits) => (Number.isFinite(v) ? v.toFixed(digits) : '—');

/**
 * One result card. A string rather than DOM nodes so the escaping is testable
 * with `node --test` — the titles arrive from arXiv.
 *
 * The title is a link to arXiv except in demo mode, where there is no paper
 * behind it and a link would be a lie.
 */
export function cardHtml(item) {
  const landmark = (item.landmarks && item.landmarks[0]) || null;
  const title = escapeHtml(item.title || item.id);
  const heading = item.abs_url
    ? `<a href="${escapeHtml(item.abs_url)}" rel="noopener">${title}</a>`
    : title;
  const chips = [
    `<span class="sv-chip sv-chip-fit">fit ${item.fit >= 0 ? '+' : ''}${round(item.fit, 1)}</span>`,
    `<span class="sv-chip sv-chip-impact">impact ${round(item.impact, 2)}</span>`,
    landmark ? `<span class="sv-chip sv-chip-like">looks like: ${escapeHtml(landmark.title)}</span>` : '',
  ].join('');
  return `<article class="sv-card">
      <h3 class="sv-card-title">${heading}</h3>
      <p class="sv-why">${chips}</p>
      <button type="button" class="sv-refine" data-refine="${escapeHtml(item.id)}">Refine with AI</button>
      <div class="sv-refine-out" id="sv-refine-${escapeHtml(item.id)}"></div>
    </article>`;
}

/**
 * The refiner's answer, or its refusal, as one shape either way. A 429 from
 * `/refine` is the daily budget rather than a fault, so it is said in words
 * instead of shown as a status code.
 */
export function refineResultFrom(status, data) {
  if (status === 429 || (data && data.error === 'budget')) {
    return { error: 'The AI refine budget for today is spent — try again tomorrow, or use your own API key.' };
  }
  if (status === 503) {
    return { error: 'AI refinement is not configured on this deployment. Use your own API key, or read the paper.' };
  }
  if (!data) return { error: `The refiner answered HTTP ${status}.` };
  if (data.error) return { error: String(data.error) };
  return data;
}

export function refineHtml(result) {
  if (!result) return '';
  if (result.error) return `<p class="sv-refine-err">${escapeHtml(result.error)}</p>`;
  const scores = [
    Number.isFinite(result.relevance) ? `relevance ${result.relevance}/5` : '',
    Number.isFinite(result.novelty) ? `novelty ${result.novelty}/5` : '',
  ].filter(Boolean).map((text) => `<span class="sv-chip">${escapeHtml(text)}</span>`).join('');
  return (scores ? `<p class="sv-why">${scores}</p>` : '')
    + (result.why ? `<p class="sv-refine-text">${escapeHtml(result.why)}</p>` : '')
    + (result.adds ? `<p class="sv-refine-text sv-refine-adds">${escapeHtml(result.adds)}</p>` : '');
}
