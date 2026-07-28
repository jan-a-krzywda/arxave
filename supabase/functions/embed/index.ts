/**
 * embed — hosted embeddings so the filter page is one click, no key, no
 * LM Studio, no Ollama.
 *
 * The key lives here (function secret GEMINI_API_KEY), never in the browser.
 * Request/response are OpenAI-shaped so the page has a single code path
 * whether it talks to this function or to a user's own /v1/embeddings.
 *
 *   POST /embed  { "input": ["text", ...] }
 *   → { "model": "...", "data": [{ "index": 0, "embedding": [...] }, ...] }
 *
 * This endpoint is public and billed to whoever deploys it, so the caps below
 * are load-bearing, not decoration.
 */

const MODEL = 'gemini-embedding-001';
const DIMS = 768;                 // 3072 default is needless payload for cosine
const UPSTREAM = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:batchEmbedContents`;
const UPSTREAM_BATCH = 100;       // Gemini's per-call request cap

// ── Abuse caps ──────────────────────────────────────────────────────────
const MAX_TEXTS = 400;            // a day of arXiv + topics + a fat .bib
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

function fail(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

async function embedChunk(texts: string[], key: string): Promise<number[][]> {
  const resp = await fetch(`${UPSTREAM}?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: texts.map((text) => ({
        model: `models/${MODEL}`,
        content: { parts: [{ text }] },
        taskType: 'SEMANTIC_SIMILARITY',
        outputDimensionality: DIMS,
      })),
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!resp.ok) {
    const detail = (await resp.text()).slice(0, 300);
    throw new Error(`embedding upstream HTTP ${resp.status}: ${detail}`);
  }

  const data = await resp.json();
  const out = (data.embeddings ?? []).map((e: { values: number[] }) => e.values);
  if (out.length !== texts.length) {
    throw new Error(`embedding upstream returned ${out.length} vectors for ${texts.length} texts`);
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return fail(405, 'POST only.');

  const key = Deno.env.get('GEMINI_API_KEY');
  if (!key) return fail(500, 'Server is missing GEMINI_API_KEY. Set it with `supabase secrets set`.');

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
      vectors.push(...await embedChunk(texts.slice(i, i + UPSTREAM_BATCH), key));
    }
  } catch (err) {
    return fail(502, err instanceof Error ? err.message : String(err));
  }

  return new Response(
    JSON.stringify({
      model: MODEL,
      data: vectors.map((embedding, index) => ({ index, embedding, object: 'embedding' })),
    }),
    { headers: { ...CORS, 'Content-Type': 'application/json' } },
  );
});
