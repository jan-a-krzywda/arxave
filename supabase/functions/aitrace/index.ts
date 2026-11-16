/**
 * aitrace — the AI-trace button's door. Wiring only: aitrace.ts holds the caps,
 * the prompt, the parse and the handler, so the tests run with no network.
 *
 * Everything that touches the world is story's, unchanged: the deployment's LLM
 * key (or the caller's own `x-llm-key`, which skips the meter), the same
 * OpenAI-compatible provider, and the one daily budget shared with refine,
 * diamond and story (`refine_usage_spend`), so a reader cannot multiply their
 * allowance by moving between buttons. One press is one call.
 */

import { type Deps, handleTrace, type UsageStore } from './aitrace.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

/* The grader's key, same secret the nightly rank and refine use. */
const API_KEY = Deno.env.get('LLM_API_KEY') ?? '';
/* Same provider shape as refine: an OpenAI-compatible base URL and a model id,
   so a deployment pointing one at its own endpoint points both. */
const BASE_URL = Deno.env.get('REFINE_BASE_URL') ?? 'https://api.sailresearch.com/v1';
/* A short judgement over ten abstracts: refine's model unless told otherwise. */
const MODEL = Deno.env.get('AITRACE_MODEL') ?? Deno.env.get('REFINE_MODEL') ??
  'deepseek-ai/DeepSeek-V4.1-Flash-1017';

/* The same salt as refine: the meter is one table, so one hash keeps a caller's
   refine, diamond, story and trace counted against the same row. */
const CLIENT_SALT = Deno.env.get('REFINE_SALT') ?? 'arxave-refine';

/* The same caps. Contract defaults: 30 calls a day per address, 500 across
   everyone — one pot for every LLM door together. */
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
        console.warn(`aitrace: budget check failed HTTP ${resp.status} — granting nothing`);
        return 0;
      }
      const granted = Number(await resp.json());
      return Number.isFinite(granted) && granted > 0 ? Math.min(granted, want) : 0;
    } catch (err) {
      console.warn(`aitrace: budget check threw — ${err instanceof Error ? err.message : err}`);
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
      /* A lost refund costs the caller one call from tomorrow's allowance. */
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

Deno.serve((req) => handleTrace(req, deps));
