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
 */

const ALLOWED_HOSTS = new Set([
  'export.arxiv.org',
  'rss.arxiv.org',
  'arxiv.org',
  'scirate.com',
]);

const MAX_BYTES = 8 * 1024 * 1024;   // refuse to stream anything huge
const UPSTREAM_TIMEOUT_MS = 20_000;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function fail(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
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

  let resp: Response;
  try {
    resp = await fetch(upstream, {
      headers: {
        // arXiv asks API clients to identify themselves.
        'User-Agent': 'arxave-filter/0.1 (+https://github.com/jan-a-krzywda/arxave)',
        'Accept': req.headers.get('Accept') ?? '*/*',
      },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    return fail(502, `Upstream fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const declared = Number(resp.headers.get('Content-Length') ?? '0');
  if (declared > MAX_BYTES) return fail(502, 'Upstream response too large to relay.');

  const body = await resp.arrayBuffer();
  if (body.byteLength > MAX_BYTES) return fail(502, 'Upstream response too large to relay.');

  return new Response(body, {
    status: resp.status,
    headers: {
      ...CORS,
      'Content-Type': resp.headers.get('Content-Type') ?? 'application/octet-stream',
      // arXiv's daily listing is stable for minutes; scite counts move slowly.
      'Cache-Control': 'public, max-age=300',
    },
  });
});
