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
 * one calls per *paper*. This calls once per *train* — every unnamed wagon goes
 * into one request as a numbered group — and it sends titles, not abstracts,
 * because naming a cluster is a task the titles already determine. A nine-wagon
 * train is ~1k tokens end to end, and the 24-wagon worst case measured 6.9k;
 * ten abstracts alone would be ~15k. A whole day of naming costs less than one
 * enrichment.
 *
 *   POST /wagon-name  { wagons: [{ members: [{ id, title }, ...] }, ...] }
 *
 * With `cacheOnly: true` the request is a pure lookup: it answers from the
 * name cache and never calls a model, so it spends no budget and may carry up
 * to MAX_LOOKUP_WAGONS wagons. The page fires one on every haul.
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
 * THE SCARCE BUDGET IS REQUESTS, NOT TOKENS. The free tier meters requests per
 * minute — so naming a wagon per call meant a seven-wagon haul stopping halfway
 * with "4 of 7 named" and asking for a second press, while nowhere near the
 * token ceiling. One request for the whole train (`promptFor` in naming.ts)
 * removes the limit that was actually binding: measured 2026-08-14, 24 wagons
 * of 30 papers named in a single 3.3s call, 6.9k tokens against 250k/min.
 *
 * `LADDER` is what remains of the per-wagon fallback, and it is now a backstop
 * rather than the mechanism: if a model is full, refuses the request, or names
 * only some of the groups, the leftovers go to the next model. One metered call
 * per rung, four rungs, so a request is at most four calls however it fails.
 *
 * EVERY FAILURE IS A MISSING NAME, NEVER AN ERROR. No Gemini key, an exhausted
 * budget, a refused call, a timeout: the wagon comes back without a name and
 * the page shows "Wagon 3" exactly as it does today. A name is an embellishment
 * on a clustering that already happened locally, and it must never be the
 * reason a haul looks broken.
 */

import {
  generationConfig,
  ladderFrom,
  MAX_LOOKUP_WAGONS,
  MAX_WAGONS,
  parseResponse,
  promptFor,
  readWagons,
  retryAfterSeconds,
  type Rung,
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
/* A ladder, not a model. ARXAVE_NAME_MODELS overrides it as a comma-separated
   list, best first; ARXAVE_NAME_MODEL is the old single-model name and still
   works, pinning the ladder to one rung. naming.ts carries the reasoning and
   the per-model thinkingConfig each rung needs. */
const LADDER = ladderFrom(
  Deno.env.get('ARXAVE_NAME_MODELS') ?? Deno.env.get('ARXAVE_NAME_MODEL'),
);
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

/**
 * The request itself was refused — a bad model id, an unsupported field.
 * Distinct because it will fail identically for every remaining wagon on this
 * rung, so the answer is the next model rather than the next wagon.
 */
class BadRequest extends Error {}

async function callGemini(
  titles: string,
  count: number,
  rung: Rung,
): Promise<Record<number, { name: string; gloss: string }>> {
  const url = `${ENDPOINT}/${encodeURIComponent(rung.model)}:generateContent` +
    `?key=${encodeURIComponent(GEMINI_KEY)}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: 'user', parts: [{ text: titles }] }],
      /* NO THINKING, spelled the way this particular rung spells it — the
         field is not portable and the wrong one is a 400. naming.ts holds the
         per-model table and the measurements behind it.

         That the *right* answer is "no thinking" is its own measured claim.
         This started at 512 on the theory that thinking bought the right word
         order: a four-title wagon named "Silicon Valley Splitting" at budget 0
         and "Valley Splitting in Silicon" at 512. That read the evidence
         wrong. The real fault was the prompt, which asked for the field's
         terminology and never said to keep a paper's prepositional phrasing —
         so the model was free to compress into a compound that collides with a
         famous proper noun. Once SYSTEM says so outright, measured 2026-08-13
         on two wagons, twice each:

           3 titles, budget 0    260 / 257 tok   "Valley splitting in silicon" x2
           3 titles, budget 512  666 / 613 tok   drifts to "Valley splitting
                                                 and coupling in silicon"
           4 titles, budget 0    274 / 282 tok   "Valley splitting in silicon" x2

         Budget 0 is the *more* stable of the two as well as 2.4x cheaper:
         thinking mostly buys itself room to editorialize the label. A thinking
         budget cannot fix a prompt that never stated the constraint, and it is
         an expensive place to look for the fix. */
      generationConfig: generationConfig(rung),
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    if (resp.status === 429) {
      throw new RateLimited(retryAfterSeconds(resp.headers.get('retry-after'), text));
    }
    if (resp.status === 400 || resp.status === 404) {
      throw new BadRequest(`HTTP ${resp.status}: ${text.slice(0, 160)}`);
    }
    throw new Error(`HTTP ${resp.status}: ${text.slice(0, 160)}`);
  }
  return parseResponse(await resp.json(), count);
}

/** Write a generated name. A failed write only costs a regeneration later. */
async function store(
  key: string,
  fields: { name: string; gloss: string },
  size: number,
  model: string,
) {
  try {
    const resp = await fetch(REST, {
      method: 'POST',
      headers: restHeaders({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify([{
        wagon_key: key,
        name: fields.name,
        gloss: fields.gloss,
        model,
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

  /* A cache-only request looks up names and never generates one. The page
     fires it on every haul so a train whose wagons have been named before
     arrives already named, with no model call, no budget debit, and nothing
     for the reader to press. Misses come back as misses — and since no prompt
     is ever built, it may carry far more wagons than a naming request. */
  const cacheOnly = body.cacheOnly === true;

  const wagons = readWagons(body, cacheOnly ? MAX_LOOKUP_WAGONS : MAX_WAGONS);
  if (typeof wagons === 'string') return fail(400, wagons);

  const keys = await Promise.all(wagons.map(wagonKey));
  const names = await lookup(keys);

  /* Which distinct keys still need a call. Distinct matters: a haul can carry
     the same membership twice only by client error, but a retry after a
     partial failure very much can, and paying twice for it would be silly. */
  const missing = [...new Set(keys.filter((k) => !names[k]))];

  let generated = 0;
  let rateLimited = 0;   // seconds to wait, 0 when the provider never said to
  let starved = false;   // the meter refused, which is the only "come back tomorrow"
  let rung = 0;
  const used = new Set<string>();

  /* THE WHOLE TRAIN IN ONE CALL. Naming used to be a call per wagon, which
     spent the scarce budget (requests per minute) to save the abundant one
     (tokens per minute) — a seven-wagon train burned seven of a ~6/min
     allowance and stopped halfway. One request carrying every unnamed wagon as
     a numbered group costs ~1.5k tokens against a 250k/min ceiling and cannot
     be rate limited partway through, because there is no partway.

     What survives from the per-wagon design is the ladder underneath it: if a
     model is full, or refuses the request, or answers for only some of the
     groups, the *remaining* wagons go to the next model. Each attempt spends
     exactly one metered call and advances one rung, so a request makes at most
     LADDER.length calls no matter what goes wrong. */
  if (missing.length && GEMINI_KEY && !cacheOnly) {
    const client = await clientHash(req);
    let pending = missing;

    while (pending.length && rung < LADDER.length) {
      const model = LADDER[rung];

      /* One call, one debit — asked for immediately before spending it, so a
         request that dies on rung 1 does not hold rungs 2-4's budget. */
      if (await spend(client, 1) < 1) {
        starved = true;
        console.log(`wagon-name: budget spent with ${pending.length} wagons unnamed`);
        break;
      }
      used.add(model.model);

      const batch = pending.map((k) => wagons[keys.indexOf(k)]);
      let answered: Record<number, { name: string; gloss: string }> = {};
      try {
        answered = await callGemini(promptFor(batch), batch.length, model);
      } catch (err) {
        await refund(client, 1);   // a call that produced nothing is not a charge
        /* A 429 and a 400 are both verdicts on the model rather than on the
           titles: the next rung is a different minute-quota and a different
           request shape. Only the wait is worth carrying — if the ladder runs
           out, the shortest one is what the page should be told to wait. */
        if (err instanceof RateLimited) {
          rateLimited = rateLimited
            ? Math.min(rateLimited, err.retryAfter)
            : err.retryAfter;
          console.warn(`wagon-name: ${model.model} rate limited, next rung`);
        } else if (err instanceof BadRequest) {
          console.warn(`wagon-name: ${model.model} refused the request — ${err.message}`);
        } else {
          console.warn(
            `wagon-name: ${model.model} — ${err instanceof Error ? err.message : err}`,
          );
        }
        rung++;
        continue;
      }

      const named: string[] = [];
      for (const [at, fields] of Object.entries(answered)) {
        const key = pending[Number(at)];
        if (!key || names[key]) continue;
        names[key] = fields;
        generated++;
        named.push(key);
        await store(key, fields, wagons[keys.indexOf(key)].length, model.model);
      }
      if (!named.length) await refund(client, 1);   // a blocked or empty reply is not a name

      /* Whatever the model skipped goes to the next one. A model that answers
         for eight of nine groups is not going to find the ninth on a second
         look at the same titles, and a rung per attempt is what bounds the
         call count. */
      pending = pending.filter((k) => !names[k]);
      if (pending.length) {
        console.warn(`wagon-name: ${model.model} left ${pending.length} unnamed, next rung`);
      }
      rung++;
    }

    if (pending.length && !starved) {
      console.warn(
        `wagon-name: ${pending.length} unnamed after the ladder` +
          (rateLimited ? `, retry in ${rateLimited}s` : ''),
      );
    }
  }

  await touch(keys.filter((k) => names[k]));

  return ok({
    names,
    keys,
    /* Which rungs actually answered, in ladder order. A haul named entirely by
       the Gemma rungs is worth being able to see from the response alone —
       the names are looser, and the reason is the ladder, not the prompt. */
    models: [...used],
    model: LADDER[Math.min(rung, LADDER.length - 1)].model,
    cached: keys.filter((k) => names[k]).length - generated,
    generated,
    /* What the caller could not have: how many misses went unnamed, and why.
       The page uses this to say "6 of 9 named — daily limit reached" instead
       of silently showing three numbered wagons. */
    unnamed: missing.length - generated,
    capped: starved,
    /* Seconds, or 0. Distinct from `capped`: a spent budget is over until
       tomorrow, a rate limit is over in a minute, and telling a user to come
       back tomorrow when they could press again shortly is the worse error. */
    retryAfter: rateLimited,
    limit: cacheOnly ? MAX_LOOKUP_WAGONS : MAX_WAGONS,
    cacheOnly,
  });
});
