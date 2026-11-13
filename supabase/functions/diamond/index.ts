/**
 * diamond — "Extract the diamond" on one paper: a summary, three take-home
 * messages, three open questions, and who should read it.
 *
 *   POST /diamond  { paper: { id, title, abstract, authors? } }
 *     → { summary: "≤300 chars",
 *         takeaways: [3 × "≤160"], questions: [3 × "≤160"],
 *         readIf: "≤160" }
 *
 * The page ranks a night of arXiv with embeddings and arithmetic and needs no
 * key to do it. This is one of the doors that spends money, and it spends it
 * only when a reader presses "Extract the diamond" on one card — so the whole
 * design is about bounding that spend and keeping the key out of everything but
 * the provider call.
 *
 * THE KEY IS THE DEPLOYMENT'S OWN by default (`LLM_API_KEY`), and a reply that
 * arrived with `x-llm-key` uses the caller's instead and skips the meter
 * entirely: it is their key and their money. The header is never logged, never
 * stored, and never echoed — diamond.ts carries that reasoning.
 *
 * THE BUDGET IS SHARED WITH refine, ON PURPOSE. `refine_usage_spend` is the
 * same RPC, the same caps (`REFINE_IP_DAILY`, `REFINE_DAILY_CAP`) and the same
 * salt (`REFINE_SALT`), so refine, diamond and story draw on one per-address
 * and one global daily allowance instead of three. One press is one call, which
 * is why there is no cache here: the same paper asked by two readers is the
 * same question, but the answer is cheap enough that the meter is the whole
 * design and a second table would only drift.
 */

import { type Deps, handleDiamond, type UsageStore } from './diamond.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

/* The grader's key, same secret the nightly rank uses (see
   config/quantum-systems.yml, `llm.api_key_env: LLM_API_KEY`). */
const API_KEY = Deno.env.get('LLM_API_KEY') ?? '';
/* The same provider shape and base URL as refine; the model is its own env so
   the diamond can be pointed at a cheaper model than refine's without moving
   either. DIAMOND_MODEL wins, then REFINE_MODEL, then refine's default. */
const BASE_URL = Deno.env.get('REFINE_BASE_URL') ?? 'https://api.sailresearch.com/v1';
const MODEL = Deno.env.get('DIAMOND_MODEL') ?? Deno.env.get('REFINE_MODEL') ??
  'deepseek-ai/DeepSeek-V4.1-Flash-1017';

/* Salts the client hash so the meter table holds no raw IP addresses. The same
   secret refine uses: one salt, one client key space, one allowance. */
const CLIENT_SALT = Deno.env.get('REFINE_SALT') ?? 'arxave-refine';

/* Per client per UTC day, and a global ceiling underneath it — refine's env
   names and defaults, because it is refine's meter row. */
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
        console.warn(`diamond: budget check failed HTTP ${resp.status} — granting nothing`);
        return 0;
      }
      const granted = Number(await resp.json());
      return Number.isFinite(granted) && granted > 0 ? Math.min(granted, want) : 0;
    } catch (err) {
      console.warn(`diamond: budget check threw — ${err instanceof Error ? err.message : err}`);
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
      /* A lost refund costs the caller one diamond from tomorrow's allowance. */
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

Deno.serve((req) => handleDiamond(req, deps));
