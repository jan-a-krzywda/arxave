/**
 * The pure half of diamond: request validation, the prompt, the response
 * validation, and the handler itself.
 *
 * Split out from index.ts so it can be tested without a database, an LLM key,
 * or a network — `fetch` and the usage meter both arrive as arguments. index.ts
 * is then nothing but reading env into those two and calling `handleDiamond`.
 *
 * WHAT THIS IS: stage 7's "Extract the diamond" on one paper. A reader who has
 * already decided a preprint is worth their evening presses it and gets the
 * shape of the paper without opening it — a two-sentence summary, three
 * concrete take-home messages, three open questions, and one line saying who
 * should read it. It is a garnish on a ranking that already happened, which is
 * why every provider fault is a clean error the panel can dismiss rather than
 * anything the page depends on.
 *
 * THE BUDGET IS `refine`'s, deliberately: the same `refine_usage_spend` row,
 * the same `REFINE_IP_DAILY` / `REFINE_DAILY_CAP` caps and the same
 * `REFINE_SALT`, so refine, diamond and story share one per-address and one
 * global daily allowance rather than each opening a fresh one. This function
 * spends one call per press and refunds it when the provider fails or answers
 * with something that does not validate.
 *
 * THE PROVIDER SHAPE IS scripts/llm.mjs's, the same one refine.ts calls: an
 * OpenAI-compatible `/chat/completions`, `Bearer` auth, a `json_object`
 * response_format, and the content read out of `choices`.
 *
 * VALIDATION IS NOT DECORATION. A model reply is untrusted input: two
 * takeaways, four questions, a summary of nine hundred characters. The panel
 * renders what this returns, so a wrong count is a `DiamondError` here rather
 * than a row that looks broken, and over-long prose is clipped because a
 * 160-character cap is a display limit, not a correctness one.
 */

export const MAX_TITLE = 300;       // characters; arXiv titles run ~80
export const MAX_ABSTRACT = 3000;   // an abstract is ~1.5k
export const MAX_AUTHORS = 300;     // a long author list, still one line
export const MAX_SUMMARY = 300;     // the contract's summary cap
export const MAX_ITEM = 160;        // each takeaway, question and readIf
export const TAKEAWAYS = 3;         // exactly three, per the contract
export const QUESTIONS = 3;
export const TIMEOUT_MS = 30_000;

/** A call failed, or returned something that did not validate. */
export class DiamondError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiamondError';
  }
}

export interface DiamondPaper {
  /** The bare arXiv id: the check that this is a paper and not a stray body. */
  id: string;
  title: string;
  abstract: string;
  /** Optional; empty when the caller did not send one. */
  authors: string;
}

export interface DiamondRequest {
  paper: DiamondPaper;
}

export interface Diamond {
  summary: string;
  takeaways: string[];
  questions: string[];
  readIf: string;
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
 * Strip the URL wrapper and version suffix a caller may hand over:
 * `https://arxiv.org/abs/2401.12345v2` → `2401.12345`. Same rule as
 * scripts/warm-dig.mjs's `bareArxivId`, so a link copied out of the page is
 * accepted and the prompt carries the id arXiv itself uses.
 */
export function bareArxivId(raw: unknown): string {
  return String(raw ?? '').trim()
    .replace(/^.*\/abs\//, '')
    .replace(/^arxiv:/i, '')
    .replace(/v\d+$/, '');
}

/* New ids are `YYMM.NNNN` or `YYMM.NNNNN` (`2401.12345`); the classic ones are
   `archive.SUBJ/YYMMNNN` (`quant-ph/9701055`, `math.GT/0309136`,
   `cond-mat.mes-hall/0212001`). Anything else is a caller bug, not a paper. */
const ARXIV_ID = /^(?:\d{4}\.\d{4,5}|[a-z][a-z-]*(?:\.[a-z-]{2,})?\/\d{7})$/i;

export function isArxivId(raw: unknown): boolean {
  return ARXIV_ID.test(bareArxivId(raw));
}

/**
 * Validate a request body into the shape the prompt needs, or return the error
 * message. Every cap is checked here so `handleDiamond` can assume a
 * well-formed request and the caps are readable in one place.
 */
export function readRequest(body: Record<string, unknown>): DiamondRequest | string {
  const paper = body?.paper as Record<string, unknown> | undefined;
  if (!paper || typeof paper !== 'object' || Array.isArray(paper)) {
    return 'Field "paper" must be an object with "id", "title" and "abstract".';
  }
  const id = bareArxivId(paper.id);
  if (!ARXIV_ID.test(id)) return 'Field "paper.id" must be an arXiv id.';
  const title = normalize(paper.title, MAX_TITLE);
  const abstract = normalize(paper.abstract, MAX_ABSTRACT);
  if (!title) return 'Field "paper.title" must be a non-empty string.';
  if (!abstract) return 'Field "paper.abstract" must be a non-empty string.';
  /* Feeds carry authors as one joined string; an array is tolerated because a
     hand-written curl is likelier to spell it that way. Absent is fine. */
  const authors = normalize(
    Array.isArray(paper.authors) ? paper.authors.join(', ') : paper.authors,
    MAX_AUTHORS,
  );

  return { paper: { id, title, abstract, authors } };
}

export const SYSTEM = [
  'You write a reading card for one physics preprint, for a physics-literate',
  'reader who has not opened it. Work only from the title and abstract you are',
  'given; never credit a claim the text does not make, and say plainly when a',
  'number is not stated. Return ONLY a JSON object, no prose and no markdown',
  'fence:',
  '{"summary":string,"takeaways":[string,string,string],',
  '"questions":[string,string,string],"readIf":string}',
  'summary is at most 300 characters, two sentences, plain words: what was done',
  'and what came out. takeaways is exactly 3 entries of at most 160 characters',
  'each, concrete and non-overlapping, answering what was shown, by what method,',
  'and how big the effect or the gain was. questions is exactly 3 entries of at',
  'most 160 characters each: what the paper leaves open, or what a careful',
  'reader should ask before trusting it. readIf is at most 160 characters and',
  'names who should read this paper and why.',
].join(' ');

/** The user turn: the paper, as the feeds spell it. */
export function promptFor(req: DiamondRequest): string {
  const p = req.paper;
  return [
    'PAPER:',
    `arXiv id: ${p.id}`,
    `Title: ${p.title}`,
    `Authors: ${p.authors || '(none given)'}`,
    `Abstract: ${p.abstract}`,
    '',
    'Return the JSON object now.',
  ].join('\n');
}

/** The two turns sent to the model, OpenAI-shaped. */
export function buildMessages(req: DiamondRequest): { role: string; content: string }[] {
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
    throw new DiamondError('diamond is not JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new DiamondError('diamond is not a JSON object');
  }
  return parsed as Record<string, unknown>;
}

/**
 * Exactly `count` non-empty strings, each clipped to `MAX_ITEM`.
 *
 * NOTHING IS PADDED: two takeaways is a reply that did not answer the question,
 * and a panel that shows two where the contract promises three would rather
 * hear "try again" than invent the third.
 */
function items(value: unknown, count: number, field: string): string[] {
  if (!Array.isArray(value)) throw new DiamondError(`${field} must be an array`);
  if (value.length !== count) {
    throw new DiamondError(`${field} must have exactly ${count} entries, got ${value.length}`);
  }
  return value.map((v, i) => {
    if (typeof v !== 'string') throw new DiamondError(`${field}[${i}] must be a string`);
    const s = normalize(v, MAX_ITEM);
    if (!s) throw new DiamondError(`${field}[${i}] must be a non-empty string`);
    return s;
  });
}

/**
 * A model reply reduced to the diamond the panel shows, or `DiamondError`.
 *
 * Fields are validated in the order the contract names them so a reply with
 * several problems reports the first rather than a compound message. The four
 * prose fields are clipped rather than rejected; the counts are not.
 */
export function parseDiamond(text: string): Diamond {
  const obj = extractJson(text);
  const summary = normalize(obj.summary, MAX_SUMMARY);
  if (!summary) throw new DiamondError('summary must be a non-empty string');
  const takeaways = items(obj.takeaways, TAKEAWAYS, 'takeaways');
  const questions = items(obj.questions, QUESTIONS, 'questions');
  const readIf = normalize(obj.readIf, MAX_ITEM);
  if (!readIf) throw new DiamondError('readIf must be a non-empty string');
  return { summary, takeaways, questions, readIf };
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
async function callProvider(deps: Deps, key: string, req: DiamondRequest): Promise<Diamond> {
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
    throw new DiamondError(`HTTP ${resp.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }
  const data = await resp.json().catch(() => null);
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new DiamondError('no content in response');
  return parseDiamond(content);
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
export async function handleDiamond(req: Request, deps: Deps): Promise<Response> {
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
  if (!key) return fail(503, 'Server has no LLM_API_KEY; diamonds are disabled.');

  let client = '';
  if (!byo) {
    /* The default salt is refine's, on purpose: one meter, one client hash. */
    client = await clientHash(req, deps.salt ?? 'arxave-refine');
    if (await deps.usage.spend(client, 1) < 1) {
      (deps.log ?? (() => {}))('diamond: budget spent');
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
    (deps.log ?? (() => {}))(`diamond: ${detail}`);
    return fail(502, detail);
  }
}
