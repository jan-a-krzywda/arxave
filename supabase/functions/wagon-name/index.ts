/**
 * wagon-name — the shared name cache behind the train, and the one endpoint
 * that spends money on a stranger's behalf.
 *
 * A wagon is a connected component of the coupling map. Today the page calls
 * them "Wagon 1..n" and shows the most central title underneath, which is
 * serviceable and says nothing. This turns a wagon's titles into a topic label
 * and a one-line gloss.
 *
 * THE ECONOMICS ARE WHY THIS IS AFFORDABLE AND enrich.mjs's SHAPE IS NOT. That
 * one calls per *paper*. This calls per *wagon* — a haul of ~150 stones makes
 * five to fifteen — and it sends titles, not abstracts, because naming a
 * cluster is a task the titles already determine. Ten titles is ~200 tokens
 * against ~15k for ten abstracts. A whole day of naming costs less than one
 * enrichment.
 *
 *   POST /wagon-name  { wagons: [{ members: [{ id, title }, ...] }, ...] }
 *     → { names: { "<key>": { name, gloss } }, keys: ["<key>", ...],
 *         cached: n, generated: n, spent: n, budget: { remaining } }
 *
 * READS ARE FREE, GENERATION IS BUDGETED — the same asymmetry as dig-cache,
 * for a different reason. There the worry was a poisoned vector nobody could
 * verify; here a name is checkable on sight against the titles beside it, so
 * the risk is not truth but cost. Hence: cache hits are unlimited and unmetered,
 * and only a miss debits a per-client and a global daily budget in Postgres.
 *
 * `keys` comes back in request order so the client can map its wagons onto the
 * names without recomputing the hash — but the hash is the client's to verify,
 * and naming.ts's `wagonKey` is the shared definition.
 *
 * EVERY FAILURE IS A MISSING NAME, NEVER AN ERROR. No Gemini key, an exhausted
 * budget, a refused call, a timeout: the wagon comes back without a name and
 * the page shows "Wagon 3" exactly as it does today. A name is an embellishment
 * on a clustering that already happened locally, and it must never be the
 * reason a haul looks broken.
 */

import {
  MAX_WAGONS,
  parseResponse,
  promptFor,
  readWagons,
  retryAfterSeconds,
  SCHEMA,
  SYSTEM,
  wagonKey,
} from './naming.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const GEMINI_KEY = Deno.env.get('GEMINI_API_KEY') ?? '';
/* Salts the client hash so the budget table holds no raw IP addresses. Any
   stable random string; changing it resets everyone's budget, which is a
   blunt but real way to clear a stuck day. */
const CLIENT_SALT = Deno.env.get('WAGON_NAME_SALT') ?? 'arxave-wagon-name';

const REST = `${SUPABASE_URL}/rest/v1/wagon_names`;
const RPC = `${SUPABASE_URL}/rest/v1/rpc/wagon_name_spend`;

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const MODEL = Deno.env.get('ARXAVE_NAME_MODEL') ?? 'gemini-2.5-flash';
const TIMEOUT_MS = 30_000;

/* ── The budget. ────────────────────────────────────────────────────────
   Per client per UTC day, and a global ceiling underneath it so a botnet
   spreading across addresses still cannot run up the bill. Both are enforced
   in one Postgres transaction (`wagon_name_spend`), not in an isolate's
   memory: the embed function's per-IP bucket resets whenever Deno recycles the
   isolate, which is fine for CPU and not fine for a metered API. */
const CLIENT_DAILY = Number(Deno.env.get('WAGON_NAME_CLIENT_DAILY') ?? '40');
const GLOBAL_DAILY = Number(Deno.env.get('WAGON_NAME_GLOBAL_DAILY') ?? '600');

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

/** A stable per-caller handle that is not an IP address. */
async function clientHash(req: Request): Promise<string> {
  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() ||
    req.headers.get('cf-connecting-ip') || 'unknown';
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${CLIENT_SALT}:${ip}`),
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
    .slice(0, 32);
}

/** Names already known for these keys. A read failure is an empty cache. */
async function lookup(keys: string[]): Promise<Record<string, { name: string; gloss: string }>> {
  const hits: Record<string, { name: string; gloss: string }> = {};
  if (!keys.length) return hits;
  const url = `${REST}?select=wagon_key,name,gloss` +
    `&wagon_key=in.(${[...new Set(keys)].join(',')})`;
  const resp = await fetch(url, { headers: restHeaders() });
  if (!resp.ok) {
    console.warn(`wagon-name: cache read failed HTTP ${resp.status}`);
    return hits;
  }
  for (const row of await resp.json() as { wagon_key: string; name: string; gloss: string }[]) {
    hits[row.wagon_key] = { name: row.name, gloss: row.gloss ?? '' };
  }
  return hits;
}

/**
 * Mark these keys wanted today. `seen` is what the prune reads, so a wagon
 * that keeps re-forming morning after morning is never re-generated.
 * Best-effort: a failed touch costs one regeneration in a month's time.
 */
async function touch(keys: string[]): Promise<void> {
  if (!keys.length) return;
  const url = `${REST}?wagon_key=in.(${[...new Set(keys)].join(',')})`;
  try {
    await fetch(url, {
      method: 'PATCH',
      headers: restHeaders({ Prefer: 'return=minimal' }),
      body: JSON.stringify({ seen: new Date().toISOString().slice(0, 10) }),
    });
  } catch (err) {
    console.warn(`wagon-name: touch failed — ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Ask Postgres for permission to make `want` calls. Returns how many were
 * granted, which may be fewer than asked and may be zero. A failure here
 * grants nothing: if the meter is broken, the correct behaviour for an
 * endpoint spending someone else's money is to stop, not to sail on unmetered.
 */
async function spend(client: string, want: number): Promise<number> {
  if (want <= 0) return 0;
  try {
    const resp = await fetch(RPC, {
      method: 'POST',
      headers: restHeaders(),
      body: JSON.stringify({
        p_client: client,
        p_want: want,
        p_client_cap: CLIENT_DAILY,
        p_global_cap: GLOBAL_DAILY,
      }),
    });
    if (!resp.ok) {
      console.warn(`wagon-name: budget check failed HTTP ${resp.status} — granting nothing`);
      return 0;
    }
    const granted = Number(await resp.json());
    return Number.isFinite(granted) && granted > 0 ? Math.min(granted, want) : 0;
  } catch (err) {
    console.warn(`wagon-name: budget check threw — ${err instanceof Error ? err.message : err}`);
    return 0;
  }
}

/** Hand a granted-but-unused call back, so a Gemini failure is not a charge. */
async function refund(client: string, n: number): Promise<void> {
  if (n <= 0) return;
  try {
    await fetch(RPC, {
      method: 'POST',
      headers: restHeaders(),
      body: JSON.stringify({
        p_client: client,
        p_want: -n,
        p_client_cap: CLIENT_DAILY,
        p_global_cap: GLOBAL_DAILY,
      }),
    });
  } catch {
    /* A lost refund costs the caller one name from tomorrow's allowance. */
  }
}

/**
 * The provider said "too many requests". Distinct from every other failure
 * because it is the only one where trying the *next* wagon is actively wrong.
 */
class RateLimited extends Error {
  constructor(readonly retryAfter: number) {
    super(`rate limited, retry in ~${retryAfter}s`);
  }
}

async function callGemini(titles: string): Promise<{ name: string; gloss: string } | null> {
  const url = `${ENDPOINT}/${encodeURIComponent(MODEL)}:generateContent` +
    `?key=${encodeURIComponent(GEMINI_KEY)}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: 'user', parts: [{ text: titles }] }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: 'application/json',
        responseSchema: SCHEMA,
        /* NO THINKING. The prompt does the work instead, and that is a
           measured claim rather than a preference.

           This started at 512 on the theory that thinking bought the right
           word order: a four-title wagon named "Silicon Valley Splitting" at
           budget 0 and "Valley Splitting in Silicon" at 512. That read the
           evidence wrong. The real fault was the prompt, which asked for the
           field's terminology and never said to keep a paper's prepositional
           phrasing — so the model was free to compress into a compound that
           collides with a famous proper noun. Once SYSTEM says so outright,
           measured 2026-08-13 on two wagons, twice each:

             3 titles, budget 0    260 / 257 tok   "Valley splitting in silicon" x2
             3 titles, budget 512  666 / 613 tok   drifts to "Valley splitting
                                                   and coupling in silicon"
             4 titles, budget 0    274 / 282 tok   "Valley splitting in silicon" x2

           Budget 0 is the *more* stable of the two as well as 2.4x cheaper:
           thinking mostly buys itself room to editorialize the label. A
           thinking budget cannot fix a prompt that never stated the
           constraint, and it is an expensive place to look for the fix. */
        thinkingConfig: { thinkingBudget: 0 },
      },
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    if (resp.status === 429) {
      throw new RateLimited(retryAfterSeconds(resp.headers.get('retry-after'), text));
    }
    throw new Error(`HTTP ${resp.status}: ${text.slice(0, 160)}`);
  }
  return parseResponse(await resp.json());
}

/** Write a generated name. A failed write only costs a regeneration later. */
async function store(key: string, fields: { name: string; gloss: string }, size: number) {
  try {
    const resp = await fetch(REST, {
      method: 'POST',
      headers: restHeaders({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify([{
        wagon_key: key,
        name: fields.name,
        gloss: fields.gloss,
        model: MODEL,
        members: size,
        seen: new Date().toISOString().slice(0, 10),
      }]),
    });
    if (!resp.ok) console.warn(`wagon-name: store failed HTTP ${resp.status}`);
  } catch (err) {
    console.warn(`wagon-name: store threw — ${err instanceof Error ? err.message : err}`);
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return fail(405, 'Only POST is accepted.');

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return fail(400, 'Body must be JSON.');
  }

  const wagons = readWagons(body);
  if (typeof wagons === 'string') return fail(400, wagons);

  const keys = await Promise.all(wagons.map(wagonKey));
  const names = await lookup(keys);

  /* Which distinct keys still need a call. Distinct matters: a haul can carry
     the same membership twice only by client error, but a retry after a
     partial failure very much can, and paying twice for it would be silly. */
  const missing = [...new Set(keys.filter((k) => !names[k]))];

  let generated = 0;
  let granted = 0;
  let rateLimited = 0;   // seconds to wait, 0 when the provider never said to
  if (missing.length && GEMINI_KEY) {
    const client = await clientHash(req);
    granted = await spend(client, missing.length);

    /* Sequential, not Promise.all. The budget is small enough that latency is
       a second or two, and a burst of parallel calls into a rate-limited API
       is how a granted budget turns into a wall of 429s. */
    for (let i = 0; i < granted; i++) {
      const key = missing[i];
      const wagon = wagons[keys.indexOf(key)];
      try {
        const fields = await callGemini(promptFor(wagon));
        if (fields) {
          names[key] = fields;
          generated++;
          await store(key, fields, wagon.length);
        } else {
          await refund(client, 1);   // a blocked or truncated reply is not a name
        }
      } catch (err) {
        /* A 429 is the one failure where continuing is actively wrong. THE
           BINDING LIMIT IS REQUESTS PER MINUTE, NOT THE DAILY BUDGET: measured
           2026-08-13, this key's free tier allows 5 requests/min on
           gemini-2.5-flash, so a first haul with ten new wagons would 429 on
           the sixth and, without this branch, march through the remaining four
           collecting one 429 each. Stop at the first, hand back every call the
           meter granted and we did not spend, and tell the page how long to
           wait. The wagons keep their numbers and the next press picks up where
           this left off, because the ones already named are now cache hits. */
        if (err instanceof RateLimited) {
          rateLimited = err.retryAfter;
          await refund(client, granted - i);
          console.warn(`wagon-name: rate limited after ${generated}, retry in ${err.retryAfter}s`);
          break;
        }
        console.warn(`wagon-name: ${key.slice(0, 12)} — ${err instanceof Error ? err.message : err}`);
        await refund(client, 1);
      }
    }
    if (granted < missing.length) {
      console.log(`wagon-name: budget capped ${missing.length} misses at ${granted}`);
    }
  }

  await touch(keys.filter((k) => names[k]));

  return ok({
    names,
    keys,
    model: MODEL,
    cached: keys.filter((k) => names[k]).length - generated,
    generated,
    /* What the caller could not have: how many misses went unnamed, and why.
       The page uses this to say "6 of 9 named — daily limit reached" instead
       of silently showing three numbered wagons. */
    unnamed: missing.length - generated,
    capped: missing.length > granted && !!GEMINI_KEY,
    /* Seconds, or 0. Distinct from `capped`: a spent budget is over until
       tomorrow, a rate limit is over in a minute, and telling a user to come
       back tomorrow when they could press again shortly is the worse error. */
    retryAfter: rateLimited,
    limit: MAX_WAGONS,
  });
});
