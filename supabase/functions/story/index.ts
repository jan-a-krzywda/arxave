/**
 * story — "Tell me tonight's story": stage 8 of the Cave, and the second
 * endpoint spending the deployment's LLM key.
 *
 *   POST /story  { date: "YYYY-MM-DD",
 *                  papers: [{ id, title, abstract, wagon?, topic?, diamond? }],
 *                  wagons: [{ name, size }], care?: "…" }
 *     → { title, story (markdown), readFirst, threads: [{ ids, why }] }
 *
 * It is refine's design with a bigger request and a bigger answer, so the whole
 * of that file's reasoning applies: the machine ranks a night of arXiv for free
 * and this is one door that costs money, opened only when the reader presses
 * the button. The key stays out of everything but the provider call, a BYO
 * `x-llm-key` is the caller's own money and skips the meter, and the budget is
 * a Postgres row (`refine_usage_spend`) rather than an isolate-local Map so it
 * survives a recycle, a cold start and two isolates at once.
 *
 * THE BUDGET IS SHARED with refine and diamond on purpose: one per-IP and one
 * global daily cap across all of them, so a reader cannot multiply their
 * allowance by moving between buttons. Caps and the hashing salt are the same
 * secrets (`REFINE_IP_DAILY`, `REFINE_DAILY_CAP`, `REFINE_SALT`) for the same
 * reason. One story costs two calls' worth; story.ts does the grant, the
 * partial-grant refund and the 429.
 *
 * There is no cache: two readers picking the same six papers still care about
 * different things, so every press is a call — which is exactly why the shared
 * cap is a day's allowance and not "unlimited".
 */

import { type Deps, handleStory, type UsageStore } from './story.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

/* The grader's key, same secret the nightly rank and refine use. */
const API_KEY = Deno.env.get('LLM_API_KEY') ?? '';
/* Same provider shape as refine: an OpenAI-compatible base URL and a model id,
   so a deployment pointing one at its own endpoint points both. */
const BASE_URL = Deno.env.get('REFINE_BASE_URL') ?? 'https://api.sailresearch.com/v1';
/* A story is a longer generation than a refine card, so it can have its own
   model without giving the other endpoints one. */
const MODEL = Deno.env.get('STORY_MODEL') ?? Deno.env.get('REFINE_MODEL') ??
  'deepseek-ai/DeepSeek-V4.1-Flash-1017';

/* The same salt as refine: the meter is one table, so one hash keeps a caller's
   refine, diamond and story counted against the same row. */
const CLIENT_SALT = Deno.env.get('REFINE_SALT') ?? 'arxave-refine';

/* The same caps. Contract defaults: 30 calls a day per address, 500 across
   everyone — one pot for refine, diamond and story together. */
const CLIENT_DAILY = Number(Deno.env.get('REFINE_IP_DAILY') ?? '30');
const GLOBAL_DAILY = Number(Deno.env.get('REFINE_DAILY_CAP') ?? '500');

const RPC = `${SUPABASE_URL}/rest/v1/rpc/refine_usage_spend`;

function restHeaders(): Record<string, string> {
  return {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };
}

/**
 * The meter, over PostgREST. A failure here grants nothing: if the meter is
 * broken, the correct behaviour for an endpoint spending someone else's money
 * is to stop, not to sail on unmetered.
 */
const usage: UsageStore = {
  async spend(client: string, want: number): Promise<number> {
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
        console.warn(`story: budget check failed HTTP ${resp.status} — granting nothing`);
        return 0;
      }
      const granted = Number(await resp.json());
      return Number.isFinite(granted) && granted > 0 ? Math.min(granted, want) : 0;
    } catch (err) {
      console.warn(`story: budget check threw — ${err instanceof Error ? err.message : err}`);
      return 0;
    }
  },

  async refund(client: string, n: number): Promise<void> {
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
      /* A lost refund costs the caller one story from tomorrow's allowance. */
    }
  },
};

const deps: Deps = {
  fetch,
  usage,
  apiKey: API_KEY,
  baseUrl: BASE_URL,
  model: MODEL,
  salt: CLIENT_SALT,
  log: (message) => console.log(message),
};

Deno.serve((req) => handleStory(req, deps));
