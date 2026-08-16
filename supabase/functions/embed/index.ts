/**
 * embed — the pick, hosted. One model, server-side, for every text the page
 * needs a vector for.
 *
 * WHY THIS IS NOW THE ONLY PICK. The page used to carry its own: 32 MB of
 * transformers.js and a WASM encoder, downloaded per browser, behind a
 * "Sharpen the pick" button. That bought independence and cost a minute of
 * frozen CPU on any day the shared cache had not already covered — and it
 * pinned the model choice to whatever had an ONNX build small enough to ship,
 * which is why the pick was a general-purpose text embedder rather than one
 * that had ever seen a citation graph. Moving the encoder here unpins that:
 * the browser downloads nothing, and the model becomes a server-side decision
 * that can change without every visitor re-downloading a pick.
 *
 * The model and the answer-shape arithmetic live in `hf.ts`; this file is the
 * door — validation, caps, and turning failures into something the page can
 * say out loud.
 *
 *   POST /embed  { "input": ["text", ...] }
 *   → { "model": "...", "dim": 768,
 *       "data": [{ "index": 0, "embedding": [...] }, ...] }
 *
 * Request and response stay OpenAI-shaped, unchanged from when this called
 * Gemini, so the page has one code path whether it talks to this function or
 * to a user's own `/v1/embeddings`.
 *
 * This endpoint is public and billed to whoever deploys it, so the caps below
 * are load-bearing, not decoration.
 */

import {
  DIM,
  MODEL,
  ModelWarmingError,
  toVectors,
  UPSTREAM,
  UPSTREAM_BATCH,
  warmingSeconds,
} from './hf.ts';

// ── Abuse caps ──────────────────────────────────────────────────────────
/* Measured 2026-08-16 against the deployed function with ~1.5 kB abstracts:
   96 texts answered in 26 s, 128 died with 546 WORKER_RESOURCE_LIMIT. This was
   400 — a number the function could not actually serve, so an honest caller
   asking for 200 got an opaque platform error instead of a refusal it could
   read. A cap should describe what the thing does. */
const MAX_TEXTS = 96;
const MAX_CHARS_PER_TEXT = 6_000; // an abstract is ~1.5k
const MAX_TOTAL_CHARS = 800_000;
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX_TEXTS_PER_IP = 3_000;   // ~7 full runs an hour per address

/**
 * Per-IP budget, in-memory. Edge isolates recycle, so this is a speed bump
 * against casual abuse, not a guarantee — pair it with the project's own
 * function rate limits if this ever gets popular.
 */
const buckets = new Map<string, { used: number; resetAt: number }>();

function spend(ip: string, texts: number): boolean {
  const now = Date.now();
  const b = buckets.get(ip);
  if (!b || now > b.resetAt) {
    buckets.set(ip, { used: texts, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  if (b.used + texts > RATE_MAX_TEXTS_PER_IP) return false;
  b.used += texts;
  return true;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function fail(status: number, message: string, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ error: message, ...extra }), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

async function embedChunk(texts: string[], token: string): Promise<number[][]> {
  const resp = await fetch(UPSTREAM, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      inputs: texts,
      /* SPECTER2 tops out at 512 tokens. Without this an over-long text is a
         hard error for the whole batch; with it the tail is cut, which is what
         the model would have seen anyway. */
      truncate: true,
      /* Wait rather than 503 on a cold model. A first call after an idle
         period pays ~20 s of load; without this the page would have to
         implement the retry itself, and every client would implement it
         differently. The 503 path below still exists because HF gives up
         waiting before this function's own timeout does. */
      options: { wait_for_model: true },
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!resp.ok) {
    const text = await resp.text();
    let parsed: unknown = null;
    try { parsed = JSON.parse(text); } catch { /* HF sometimes answers HTML */ }

    /* 503 is the model loading, which is a wait and not a fault — the page
       says "warming up" and offers the button again rather than showing a
       stack trace for a condition that clears itself. */
    if (resp.status === 503) throw new ModelWarmingError(warmingSeconds(parsed));

    /* 401 means the deploy is misconfigured, not that the caller did anything
       wrong. Say which secret, because the alternative is reading HF's HTML
       error page out of a browser console. */
    if (resp.status === 401 || resp.status === 403) {
      throw new Error(
        'The embedding upstream refused this deployment\'s credentials. ' +
        'Check the HF_TOKEN function secret — it needs the ' +
        '"Make calls to Inference Providers" permission.',
      );
    }

    if (resp.status === 402) {
      throw new Error(
        'The embedding upstream reports the deployment\'s inference credits are spent.',
      );
    }

    throw new Error(`embedding upstream HTTP ${resp.status}: ${text.slice(0, 300)}`);
  }

  return toVectors(await resp.json(), texts.length, DIM);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return fail(405, 'POST only.');

  const token = Deno.env.get('HF_TOKEN');
  if (!token) {
    return fail(500, 'Server is missing HF_TOKEN. Set it with `supabase secrets set`.');
  }

  let body: { input?: unknown };
  try {
    body = await req.json();
  } catch {
    return fail(400, 'Body must be JSON.');
  }

  const input = body.input;
  if (!Array.isArray(input) || input.length === 0) {
    return fail(400, 'Field "input" must be a non-empty array of strings.');
  }
  if (input.length > MAX_TEXTS) {
    return fail(413, `Too many texts: ${input.length} > ${MAX_TEXTS}. Lower "Max results" or trim the .bib.`);
  }

  const texts: string[] = [];
  let totalChars = 0;
  for (const t of input) {
    if (typeof t !== 'string') return fail(400, 'Every element of "input" must be a string.');
    const clipped = t.slice(0, MAX_CHARS_PER_TEXT);
    totalChars += clipped.length;
    texts.push(clipped);
  }
  if (totalChars > MAX_TOTAL_CHARS) {
    return fail(413, `Payload too large: ${totalChars} chars > ${MAX_TOTAL_CHARS}.`);
  }

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? 'unknown';
  if (!spend(ip, texts.length)) {
    return fail(429, 'Hourly embedding budget for your address is spent. Try later, or switch the page to "Own key".');
  }

  const vectors: number[][] = [];
  try {
    for (let i = 0; i < texts.length; i += UPSTREAM_BATCH) {
      vectors.push(...await embedChunk(texts.slice(i, i + UPSTREAM_BATCH), token));
    }
  } catch (err) {
    /* A wait and a fault are different answers. 503 + retryAfter is what lets
       the page say "warming up, about 20s" instead of "something broke". */
    if (err instanceof ModelWarmingError) {
      return fail(503, err.message, { retryAfter: Math.ceil(err.retryAfter), warming: true });
    }
    return fail(502, err instanceof Error ? err.message : String(err));
  }

  return new Response(
    JSON.stringify({
      model: MODEL,
      dim: DIM,
      data: vectors.map((embedding, index) => ({ index, embedding, object: 'embedding' })),
    }),
    { headers: { ...CORS, 'Content-Type': 'application/json' } },
  );
});
