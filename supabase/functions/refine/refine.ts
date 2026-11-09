/**
 * The pure half of refine: request validation, the prompt, the response
 * validation, and the handler itself.
 *
 * Split out from index.ts so it can be tested without a database, an LLM key,
 * or a network — `fetch` and the usage meter both arrive as arguments. index.ts
 * is then nothing but reading env into those two and calling `handleRefine`.
 *
 * WHAT THIS IS: one optional, on-demand call. The page ranks a night of arXiv
 * with embeddings and arithmetic; a reader who wants a second opinion on one
 * card presses "Refine with AI" and this asks a hosted model whether the paper
 * fits their touchstones and what it adds over its nearest proven neighbours.
 * It is a garnish on a ranking that already happened, which is why every
 * provider fault is a clean error the button can dismiss rather than anything
 * the page depends on.
 *
 * THE PROVIDER SHAPE IS scripts/llm.mjs's: an OpenAI-compatible
 * `/chat/completions`, `Authorization: Bearer <key>`, a `json_object`
 * response_format, and the same read-the-content-out-of-choices access. The one
 * difference is where the key comes from — this function runs per request, so
 * the key is either the deployment's secret or the caller's own header.
 *
 * VALIDATION IS NOT DECORATION. A model reply is untrusted input: a relevance
 * of 0, an empty `why`, an `adds` of four thousand characters. The feed stores
 * what this returns, so each of those is thrown as `RefineError` (or clipped,
 * for the two prose fields) here rather than written.
 */

export const MAX_NEIGHBOURS = 5;    // the card shows three; five is the ceiling
export const MAX_TOUCHSTONES = 6;   // the page's "More touchstones" box
export const MAX_TITLE = 300;       // characters; arXiv titles run ~80
export const MAX_ABSTRACT = 3000;   // an abstract is ~1.5k
export const MAX_FIELD = 240;       // why and adds, per the contract
export const TIMEOUT_MS = 30_000;

/** A call failed, or returned something that did not validate. */
export class RefineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RefineError';
  }
}

export interface Paper {
  title: string;
  abstract: string;
}

export interface Neighbour {
  title: string;
  pct: number;
}

export interface RefineRequest {
  paper: Paper;
  neighbours: Neighbour[];
  touchstones: string[];
}

export interface Refine {
  relevance: number;
  novelty: number;
  why: string;
  adds: string;
}

/**
 * Collapse whitespace and clip. Cosmetic differences are not different inputs,
 * and an abstract arrives from arXiv with newlines and runs of spaces that cost
 * tokens to say nothing.
 */
function normalize(s: unknown, max: number): string {
  return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Validate a request body into the shape the prompt needs, or return the error
 * message. Every cap is checked here so `handleRefine` can assume a well-formed
 * request and the caps are readable in one place.
 */
export function readRequest(body: Record<string, unknown>): RefineRequest | string {
  const paper = body?.paper as Record<string, unknown> | undefined;
  if (!paper || typeof paper !== 'object' || Array.isArray(paper)) {
    return 'Field "paper" must be an object with "title" and "abstract".';
  }
  const title = normalize(paper.title, MAX_TITLE);
  const abstract = normalize(paper.abstract, MAX_ABSTRACT);
  if (!title) return 'Field "paper.title" must be a non-empty string.';
  if (!abstract) return 'Field "paper.abstract" must be a non-empty string.';

  const rawNeighbours = body.neighbours;
  if (rawNeighbours !== undefined && !Array.isArray(rawNeighbours)) {
    return 'Field "neighbours" must be an array.';
  }
  const nList = (rawNeighbours ?? []) as unknown[];
  if (nList.length > MAX_NEIGHBOURS) {
    return `Too many neighbours: ${nList.length} > ${MAX_NEIGHBOURS}.`;
  }
  const neighbours: Neighbour[] = [];
  for (const n of nList) {
    const row = n as Record<string, unknown> | undefined;
    const nTitle = normalize(row?.title, MAX_TITLE);
    const pct = Number(row?.pct);
    if (!nTitle) return 'Every neighbour needs a non-empty "title".';
    if (!Number.isFinite(pct)) return 'Every neighbour needs a numeric "pct".';
    neighbours.push({ title: nTitle, pct });
  }

  const rawTouch = body.touchstones;
  if (rawTouch !== undefined && !Array.isArray(rawTouch)) {
    return 'Field "touchstones" must be an array.';
  }
  const tList = (rawTouch ?? []) as unknown[];
  if (tList.length > MAX_TOUCHSTONES) {
    return `Too many touchstones: ${tList.length} > ${MAX_TOUCHSTONES}.`;
  }
  const touchstones: string[] = [];
  for (const t of tList) {
    if (typeof t !== 'string') return 'Every touchstone must be a string.';
    const s = normalize(t, MAX_ABSTRACT);
    if (s) touchstones.push(s);   // a blank box is an absent touchstone, not an error
  }

  return { paper: { title, abstract }, neighbours, touchstones };
}

export const SYSTEM = [
  'You judge one new preprint for a reader who has already ranked a night of',
  'arXiv and wants a second opinion on this card. You are given the paper\'s',
  'title and abstract, the titles of its nearest already-proven neighbours',
  'with their citation percentiles, and the reader\'s own touchstones. Judge',
  'from the supplied text only; do not credit claims the text does not make.',
  'Return ONLY a JSON object, no prose and no markdown fence:',
  '{"relevance":1-5 int, "novelty":1-5 int, "why":string, "adds":string}',
  'relevance is how well the paper fits the touchstones; novelty is how much',
  'it goes beyond its neighbours. why is one sentence naming the concrete',
  'reason, not a restatement of the abstract. adds is one sentence on what',
  'this paper has that its neighbours do not. Both prose fields are at most',
  '240 characters.',
].join(' ');

/**
 * The user turn: the paper, its nearest proven neighbours, and the touchstones.
 * The neighbour provenance is stated as a percentile rather than a raw count
 * because a raw count means nothing without the window it came from, and the
 * model was never given the window.
 */
export function promptFor(req: RefineRequest): string {
  const neighbours = req.neighbours.length
    ? req.neighbours
      .map((n) => `- ${n.title} (citation percentile ${n.pct})`)
      .join('\n')
    : '(none given)';
  const touchstones = req.touchstones.length
    ? req.touchstones.map((t) => `- ${t}`).join('\n')
    : '(none given)';

  return [
    'PAPER:',
    `Title: ${req.paper.title}`,
    `Abstract: ${req.paper.abstract}`,
    '',
    'NEAREST PROVEN PAPERS:',
    neighbours,
    '',
    'TOUCHSTONES:',
    touchstones,
    '',
    'Return the JSON object now.',
  ].join('\n');
}

/** The two turns sent to the model, OpenAI-shaped. */
export function buildMessages(req: RefineRequest): { role: string; content: string }[] {
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: promptFor(req) },
  ];
}

/** The JSON body, tolerating a ```json fence the model wrapped it in. */
function extractJson(text: string): Record<string, unknown> {
  const raw = String(text ?? '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : raw).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new RefineError('refine is not JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RefineError('refine is not a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function intInRange(value: unknown, lo: number, hi: number, field: string): number {
  if (!Number.isInteger(value) || (value as number) < lo || (value as number) > hi) {
    throw new RefineError(
      `${field} must be an integer ${lo}-${hi}, got ${JSON.stringify(value)}`,
    );
  }
  return value as number;
}

/**
 * A model reply reduced to the refine the card shows, or `RefineError`.
 *
 * Fields are validated in the order the contract names them so a reply with
 * several problems reports the first rather than a compound message. The two
 * prose fields are clipped rather than rejected: an over-long `why` is still a
 * useful `why`, and 240 characters is a display limit, not a correctness one.
 */
export function parseRefine(text: string): Refine {
  const obj = extractJson(text);
  const relevance = intInRange(obj.relevance, 1, 5, 'relevance');
  const novelty = intInRange(obj.novelty, 1, 5, 'novelty');
  const why = normalize(obj.why, MAX_FIELD);
  const adds = normalize(obj.adds, MAX_FIELD);
  if (!why) throw new RefineError('why must be a non-empty string');
  if (!adds) throw new RefineError('adds must be a non-empty string');
  return { relevance, novelty, why, adds };
}

// ── The handler, with the two outer-world things injected. ────────────────

/**
 * The daily meter, in front of the deployment's own key. `spend` grants up to
 * `want` calls against the per-client and global caps and returns how many it
 * actually granted (which may be zero); `refund` hands back a call the
 * provider then refused, so a bad afternoon upstream is not a charge.
 */
export interface UsageStore {
  spend(client: string, want: number): Promise<number>;
  refund(client: string, n: number): Promise<void>;
}

export interface Deps {
  fetch: typeof fetch;
  usage: UsageStore;
  /** The deployment's own key. Empty means "no key configured". */
  apiKey: string;
  baseUrl: string;
  model: string;
  /** Salts the client hash so the meter holds no raw IP addresses. */
  salt?: string;
  log?: (message: string) => void;
}

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-llm-key',
  'Access-Control-Max-Age': '86400',
};

export function fail(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

export function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

/** A stable per-caller handle that is not an IP address. */
export async function clientHash(req: Request, salt: string): Promise<string> {
  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() ||
    req.headers.get('cf-connecting-ip') || 'unknown';
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${salt}:${ip}`),
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
    .slice(0, 32);
}

/**
 * One call to the provider. The key is used here and nowhere else — it is never
 * logged, never returned, and never put in an error message, which is the whole
 * reason the caller's own key can be passed straight through.
 */
async function callProvider(deps: Deps, key: string, req: RefineRequest): Promise<Refine> {
  const url = `${deps.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const resp = await deps.fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: deps.model,
      messages: buildMessages(req),
      temperature: 0,
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new RefineError(`HTTP ${resp.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }
  const data = await resp.json().catch(() => null);
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new RefineError('no content in response');
  return parseRefine(content);
}

/**
 * The request handler. Pure enough to test: everything that touches the world
 * is a `Deps` field.
 *
 * A BYO KEY (`x-llm-key`) SPENDS NOTHING AND IS STORED NOWHERE. The browser
 * sends it only when the reader typed one, and it replaces the deployment's key
 * for this one call — including past the meter, because it is the caller's
 * money being spent, not the deployer's.
 */
export async function handleRefine(req: Request, deps: Deps): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return fail(405, 'POST only.');

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return fail(400, 'Body must be JSON.');
  }

  const request = readRequest(body);
  if (typeof request === 'string') return fail(400, request);

  const byo = (req.headers.get('x-llm-key') ?? '').trim();
  const key = byo || deps.apiKey;
  if (!key) return fail(503, 'Server has no LLM_API_KEY; refinement is disabled.');

  let client = '';
  if (!byo) {
    client = await clientHash(req, deps.salt ?? 'arxave-refine');
    if (await deps.usage.spend(client, 1) < 1) {
      (deps.log ?? (() => {}))('refine: budget spent');
      return fail(429, 'budget');
    }
  }

  try {
    return ok(await callProvider(deps, key, request));
  } catch (err) {
    /* A call that produced nothing is not a charge — but only the meter's own
       calls are refunded; a BYO call never debited it. */
    if (!byo) await deps.usage.refund(client, 1);
    const detail = err instanceof Error ? err.message : String(err);
    (deps.log ?? (() => {}))(`refine: ${detail}`);
    return fail(502, detail);
  }
}
