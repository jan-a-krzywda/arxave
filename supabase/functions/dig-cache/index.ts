/**
 * dig-cache — the shared vector cache behind Stage 1 of the Dig.
 *
 * Embedding a day of abstracts in the browser costs ~60 s. The vectors are
 * ~200 kB. So the second person to haul a given day should download, not
 * re-embed. This function is that download.
 *
 * Keyed on the sha256 of the text, never on an arXiv id: the same table serves
 * abstracts, touchstones and core samples, and a revised abstract is a
 * different text and so a miss rather than a stale hit. `model` and `dim` are
 * in the key because a 384-dim bge vector and a 768-dim Gemini one for the same
 * text are not interchangeable — mixing them yields plausible garbage and no
 * error (see docs/dig-spec.md §5.6).
 *
 *   POST /dig-cache  { model, dim, sha: ["<hex>", ...] }
 *     → { model, dim, hits: { "<hex>": "<base64 float32le>", ... }, misses: n }
 *
 *   PUT  /dig-cache  { model, dim, items: [{ sha, vector, source? }] }
 *     header: x-dig-key: $DIG_WRITE_KEY
 *     → { written: n }
 *
 * READS ARE PUBLIC, WRITES ARE NOT — deliberately. A returned vector is
 * unverifiable by the client: it cannot tell a correct embedding from a crafted
 * one, and a poisoned vector silently reorders someone's ranking. So the only
 * writer is the warmer (scripts/warm-dig.mjs), which holds DIG_WRITE_KEY and
 * runs the same model and quantization as the browser.
 */

import { base64ToHex, floatsInHex, hexToBase64, sha256 } from './codec.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const WRITE_KEY = Deno.env.get('DIG_WRITE_KEY') ?? '';
const REST = `${SUPABASE_URL}/rest/v1/dig_vectors`;

// ── Caps. This endpoint is public; these are load-bearing. ───────────────
const MAX_SHAS = 600;          // a generous day of arXiv across several archives
const MAX_ITEMS = 600;
const MAX_DIM = 4096;
const SHA_RE = /^[0-9a-f]{64}$/;
const REST_CHUNK = 200;        // keeps the PostgREST query string well short of any limit

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-dig-key',
  'Access-Control-Max-Age': '86400',
};

function fail(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function restHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

/** Validate and normalize the (model, dim) half of the key. */
function readKey(body: Record<string, unknown>): { model: string; dim: number } | string {
  const model = typeof body.model === 'string' ? body.model.trim() : '';
  const dim = Number(body.dim);
  if (!model) return 'Field "model" must be a non-empty string.';
  if (!Number.isInteger(dim) || dim < 1 || dim > MAX_DIM) {
    return `Field "dim" must be an integer in 1..${MAX_DIM}.`;
  }
  return { model, dim };
}

async function handleRead(body: Record<string, unknown>): Promise<Response> {
  const key = readKey(body);
  if (typeof key === 'string') return fail(400, key);

  const raw = body.sha;
  if (!Array.isArray(raw) || raw.length === 0) {
    return fail(400, 'Field "sha" must be a non-empty array of sha256 hex strings.');
  }
  if (raw.length > MAX_SHAS) {
    return fail(413, `Too many hashes: ${raw.length} > ${MAX_SHAS}.`);
  }
  const shas: string[] = [];
  for (const s of raw) {
    if (typeof s !== 'string' || !SHA_RE.test(s)) {
      return fail(400, 'Every "sha" element must be a 64-char lowercase sha256 hex string.');
    }
    shas.push(s);
  }
  const wanted = [...new Set(shas)];

  const hits: Record<string, string> = {};
  for (let i = 0; i < wanted.length; i += REST_CHUNK) {
    const chunk = wanted.slice(i, i + REST_CHUNK);
    const url = `${REST}?select=text_sha,vector` +
      `&model=eq.${encodeURIComponent(key.model)}` +
      `&dim=eq.${key.dim}` +
      `&text_sha=in.(${chunk.join(',')})`;
    const resp = await fetch(url, { headers: restHeaders() });
    if (!resp.ok) {
      return fail(502, `cache read failed: HTTP ${resp.status} ${(await resp.text()).slice(0, 200)}`);
    }
    for (const row of await resp.json() as { text_sha: string; vector: string }[]) {
      hits[row.text_sha] = hexToBase64(row.vector);
    }
  }

  /* A hit is proof someone still wants this text, which is what keeps it out of
     the retention prune. Best-effort: a failed touch costs a re-embed in a
     week, never a wrong answer, so it must not fail the read. */
  const touched = Object.keys(hits);
  if (touched.length) {
    const today = new Date().toISOString().slice(0, 10);
    for (let i = 0; i < touched.length; i += REST_CHUNK) {
      const chunk = touched.slice(i, i + REST_CHUNK);
      const url = `${REST}?model=eq.${encodeURIComponent(key.model)}` +
        `&dim=eq.${key.dim}&text_sha=in.(${chunk.join(',')})`;
      fetch(url, {
        method: 'PATCH',
        headers: restHeaders({ Prefer: 'return=minimal' }),
        body: JSON.stringify({ seen_at: today }),
      }).catch(() => {});
    }
  }

  return ok({
    model: key.model,
    dim: key.dim,
    hits,
    misses: wanted.length - touched.length,
  });
}

async function handleWrite(req: Request, body: Record<string, unknown>): Promise<Response> {
  if (!WRITE_KEY) return fail(503, 'Server has no DIG_WRITE_KEY; writes are disabled.');
  const given = req.headers.get('x-dig-key') ?? '';
  // Constant-time-ish: compare fixed-length digests rather than the raw strings.
  const [a, b] = await Promise.all([sha256(given), sha256(WRITE_KEY)]);
  if (a !== b) return fail(403, 'Bad or missing x-dig-key.');

  const key = readKey(body);
  if (typeof key === 'string') return fail(400, key);

  const raw = body.items;
  if (!Array.isArray(raw) || raw.length === 0) {
    return fail(400, 'Field "items" must be a non-empty array.');
  }
  if (raw.length > MAX_ITEMS) return fail(413, `Too many items: ${raw.length} > ${MAX_ITEMS}.`);

  const today = new Date().toISOString().slice(0, 10);
  const rows: Record<string, unknown>[] = [];
  for (const item of raw as Record<string, unknown>[]) {
    const sha = typeof item.sha === 'string' ? item.sha : '';
    if (!SHA_RE.test(sha)) return fail(400, `Bad sha: ${String(item.sha).slice(0, 16)}`);
    if (typeof item.vector !== 'string') {
      return fail(400, `Item ${sha.slice(0, 8)} is missing a base64 "vector".`);
    }
    let hex: string;
    try {
      hex = base64ToHex(item.vector);
    } catch {
      return fail(400, `Item ${sha.slice(0, 8)} has a "vector" that is not valid base64.`);
    }
    if (floatsInHex(hex) !== key.dim) {
      return fail(400,
        `Item ${sha.slice(0, 8)} carries ${floatsInHex(hex)} floats, expected dim=${key.dim}.`);
    }
    rows.push({
      text_sha: sha,
      model: key.model,
      dim: key.dim,
      vector: hex,
      source: typeof item.source === 'string' ? item.source.slice(0, 200) : null,
      seen_at: today,
    });
  }

  /* merge-duplicates, not replace: the same (text, model, dim) must always give
     the same vector, so a second write is either identical or a bug. Letting
     the first one stand keeps the cache reproducible. */
  for (let i = 0; i < rows.length; i += REST_CHUNK) {
    const resp = await fetch(REST, {
      method: 'POST',
      headers: restHeaders({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify(rows.slice(i, i + REST_CHUNK)),
    });
    if (!resp.ok) {
      return fail(502, `cache write failed: HTTP ${resp.status} ${(await resp.text()).slice(0, 200)}`);
    }
  }

  return ok({ written: rows.length });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST' && req.method !== 'PUT') {
    return fail(405, 'POST to read, PUT to write.');
  }
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return fail(500, 'Server is missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.');
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return fail(400, 'Body must be JSON.');
  }

  try {
    return req.method === 'POST' ? await handleRead(body) : await handleWrite(req, body);
  } catch (err) {
    return fail(500, err instanceof Error ? err.message : String(err));
  }
});
