/**
 * refine — the optional, on-demand LLM second opinion behind a result card.
 *
 *   POST /refine  { paper: { title, abstract }, neighbours: [{ title, pct }],
 *                   touchstones: [ "…" ] }
 *     → { relevance: 1..5, novelty: 1..5, why, adds }
 *
 * The page ranks a night of arXiv with embeddings and arithmetic and needs no
 * key to do it. This is the one door that spends money, and it spends it only
 * when a reader presses "Refine with AI" on one card — so the whole design is
 * about bounding that spend and keeping the key out of everything but the
 * provider call.
 *
 * THE KEY IS THE DEPLOYMENT'S OWN by default (`LLM_API_KEY`), and a reply that
 * arrived with `x-llm-key` uses the caller's instead and skips the meter
 * entirely: it is their key and their money. The header is never logged, never
 * stored, and never echoed — refine.ts carries that reasoning.
 *
 * THE BUDGET IS A POSTGRES ROW, not an isolate-local Map. refine.ts's sibling
 * `embed` keeps its per-IP bucket in memory and says honestly that a recycle
 * resets it; that is fine for CPU and not fine for a metered third-party API.
 * `refine_usage_spend` checks the per-IP and global daily caps in one
 * transaction, which is the durability this needs and the reason for
 * supabase/refine-usage.sql.
 *
 * There is no cache here: the input is one card and a set of touchstones, and
 * two readers asking about the same paper with different interests are asking
 * different questions. So every press is a call, which is exactly why the cap
 * is 30 a day per address and not "unlimited".
 */

import { type Deps, handleRefine, type UsageStore } from './refine.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

/* The grader's key, same secret the nightly rank uses (see
   config/quantum-systems.yml, `llm.api_key_env: LLM_API_KEY`). */
const API_KEY = Deno.env.get('LLM_API_KEY') ?? '';
/* Same provider shape as scripts/llm.mjs: an OpenAI-compatible base URL and a
   model id. REFINE_BASE_URL overrides the sailresearch default for anyone
   pointing the function at their own compatible endpoint. */
const BASE_URL = Deno.env.get('REFINE_BASE_URL') ?? 'https://api.sailresearch.com/v1';
const MODEL = Deno.env.get('REFINE_MODEL') ?? 'deepseek-ai/DeepSeek-V4.1-Flash-1017';

/* Salts the client hash so the meter table holds no raw IP addresses. Rotating
   it resets everyone's day, which is a blunt way to clear a stuck one. */
const CLIENT_SALT = Deno.env.get('REFINE_SALT') ?? 'arxave-refine';

/* Per client per UTC day, and a global ceiling underneath it so a botnet
   spreading across addresses still cannot run up the bill. Contract defaults. */
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
        console.warn(`refine: budget check failed HTTP ${resp.status} — granting nothing`);
        return 0;
      }
      const granted = Number(await resp.json());
      return Number.isFinite(granted) && granted > 0 ? Math.min(granted, want) : 0;
    } catch (err) {
      console.warn(`refine: budget check threw — ${err instanceof Error ? err.message : err}`);
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
      /* A lost refund costs the caller one refine from tomorrow's allowance. */
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

Deno.serve((req) => handleRefine(req, deps));
