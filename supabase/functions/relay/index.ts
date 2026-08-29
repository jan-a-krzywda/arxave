/**
 * relay — CORS shim for the sources that refuse browser requests.
 *
 * Measured 2026-07-28: export.arxiv.org, rss.arxiv.org and scirate.com send no
 * Access-Control-Allow-Origin header on any endpoint, so the browser filter
 * page cannot fetch them directly. This function does the GET server-side and
 * replays it with permissive CORS.
 *
 * Strictly an allowlisted GET proxy — it is public, so it must never become an
 * open relay.
 *
 *   GET /relay?url=https%3A%2F%2Fexport.arxiv.org%2Fapi%2Fquery%3F...
 *
 * IT IS ALSO A SHARED CACHE, and that is not a nicety. Because the fetch
 * happens here, arXiv sees one client no matter how many people are on the
 * page, and it throttles per client. Measured 2026-08-29, the day after the
 * page was shared: export.arxiv.org answered 429 "Rate exceeded" and hauls
 * started failing for everyone at once. Caching turns N visitors into one
 * upstream call per URL per FRESH_MS; see cache.ts for the policy and the
 * reasoning behind each window.
 *
 * Every response carries `x-relay-cache: hit | stale | miss | bypass`, which
 * the page reads to decide whether it needs to pace itself (a hit cost arXiv
 * nothing, so there is nothing to pace).
 */

import {
  cacheControlFor,
  type CacheEntry,
  freshness,
  isCacheable,
  MAX_CACHE_BYTES,
  MemoryCache,
  SingleFlight,
} from './cache.ts';

const ALLOWED_HOSTS = new Set([
  'export.arxiv.org',
  'rss.arxiv.org',
  'arxiv.org',
  'scirate.com',
]);

const MAX_BYTES = 8 * 1024 * 1024;   // refuse to stream anything huge
const UPSTREAM_TIMEOUT_MS = 20_000;

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const REST = `${SUPABASE_URL}/rest/v1/relay_cache`;

const memory = new MemoryCache();
const flight = new SingleFlight<CacheEntry>();

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Expose-Headers': 'x-relay-cache, x-relay-age',
  'Access-Control-Max-Age': '86400',
};

function fail(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      ...CORS,
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'x-relay-cache': 'bypass',
    },
  });
}

function serve(entry: CacheEntry, disposition: string): Response {
  return new Response(entry.body, {
    status: entry.status,
    headers: {
      ...CORS,
      'Content-Type': entry.contentType,
      'Cache-Control': cacheControlFor(entry.status),
      'x-relay-cache': disposition,
      'x-relay-age': String(Math.max(0, Math.round((Date.now() - entry.fetchedAt) / 1000))),
    },
  });
}

// ── The durable half of the cache ────────────────────────────────────────
// Best-effort throughout: a database that is down or unmigrated must cost a
// cache hit, never a haul. Every path here falls back to going upstream.

const dbConfigured = () => Boolean(SUPABASE_URL && SERVICE_KEY);

function restHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function dbRead(url: string): Promise<CacheEntry | undefined> {
  if (!dbConfigured()) return undefined;
  try {
    const q = `${REST}?select=status,content_type,body,fetched_at&url=eq.${encodeURIComponent(url)}&limit=1`;
    const resp = await fetch(q, { headers: restHeaders() });
    if (!resp.ok) return undefined;
    const rows = await resp.json() as {
      status: number; content_type: string; body: string; fetched_at: string;
    }[];
    if (!rows.length) return undefined;
    const fetchedAt = Date.parse(rows[0].fetched_at);
    if (!Number.isFinite(fetchedAt)) return undefined;
    return {
      status: rows[0].status,
      contentType: rows[0].content_type,
      body: rows[0].body,
      fetchedAt,
    };
  } catch {
    return undefined;
  }
}

async function dbWrite(url: string, entry: CacheEntry): Promise<void> {
  if (!dbConfigured()) return;
  try {
    await fetch(REST, {
      method: 'POST',
      headers: restHeaders({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify({
        url,
        status: entry.status,
        content_type: entry.contentType,
        body: entry.body,
        fetched_at: new Date(entry.fetchedAt).toISOString(),
      }),
    });
  } catch {
    /* A write we lost is a re-fetch later, which is the behaviour we had
       before this cache existed. Never worth failing the request over. */
  }
}

/** The stored copy, newest layer first. */
async function lookup(url: string): Promise<CacheEntry | undefined> {
  const local = memory.get(url);
  if (local) return local;
  const stored = await dbRead(url);
  if (stored && freshness(stored) !== 'expired') {
    memory.set(url, stored);
    return stored;
  }
  return undefined;
}

// ── Upstream ─────────────────────────────────────────────────────────────

async function fetchUpstream(upstream: URL, accept: string): Promise<CacheEntry> {
  const resp = await fetch(upstream, {
    headers: {
      // arXiv asks API clients to identify themselves.
      'User-Agent': 'arxave-filter/0.1 (+https://github.com/jan-a-krzywda/arxave)',
      'Accept': accept,
    },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });

  const declared = Number(resp.headers.get('Content-Length') ?? '0');
  if (declared > MAX_BYTES) throw new Error('Upstream response too large to relay.');

  const body = await resp.text();
  if (body.length > MAX_BYTES) throw new Error('Upstream response too large to relay.');

  return {
    status: resp.status,
    contentType: resp.headers.get('Content-Type') ?? 'application/octet-stream',
    body,
    fetchedAt: Date.now(),
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'GET') return fail(405, 'Only GET is relayed.');

  const target = new URL(req.url).searchParams.get('url');
  if (!target) return fail(400, 'Missing ?url= parameter.');

  let upstream: URL;
  try {
    upstream = new URL(target);
  } catch {
    return fail(400, 'The ?url= parameter is not a valid URL.');
  }

  if (upstream.protocol !== 'https:' && upstream.protocol !== 'http:') {
    return fail(400, 'Only http(s) targets are relayed.');
  }
  if (!ALLOWED_HOSTS.has(upstream.hostname)) {
    return fail(
      403,
      `Host ${upstream.hostname} is not on the relay allowlist ` +
      `(${[...ALLOWED_HOSTS].join(', ')}).`,
    );
  }

  // Normalized so two people spelling the same query differently share an entry.
  const key = upstream.toString();

  const cached = await lookup(key);
  if (cached && freshness(cached) === 'fresh') return serve(cached, 'hit');

  const accept = req.headers.get('Accept') ?? '*/*';
  let fetched: CacheEntry;
  try {
    /* One upstream call per URL even when a dozen presses arrive together —
       without this, a simultaneous crowd all miss the cache and all go to
       arXiv, which is the pile-on the cache was meant to prevent. */
    fetched = await flight.run(key, async () => {
      const raced = memory.get(key);            // filled while we queued?
      if (raced && freshness(raced) === 'fresh') return raced;
      return await fetchUpstream(upstream, accept);
    });
  } catch (err) {
    /* Upstream is unreachable. A stale copy beats an error for a listing that
       is rebuilt once a night. */
    if (cached) return serve(cached, 'stale');
    return fail(502, `Upstream fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  /* A 429 or a 5xx says something about this second, not about this URL. If we
     are holding yesterday's copy, that is the better answer — and handing it
     over is what stops the retries that keep the limit exceeded. */
  if (fetched.status >= 400 && cached) return serve(cached, 'stale');

  if (isCacheable(fetched.status, fetched.body.length)) {
    memory.set(key, fetched);
    await dbWrite(key, fetched);
  }

  return serve(fetched, fetched.body.length > MAX_CACHE_BYTES ? 'bypass' : 'miss');
});
