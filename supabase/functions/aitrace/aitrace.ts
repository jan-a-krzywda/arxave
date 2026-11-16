/**
 * aitrace — "AI trace": an LLM's guess at how likely each abstract was written
 * by an LLM. The Cave's ranking stage asks for the rows on screen when the
 * reader presses the button; the page caches every answer per paper.
 *
 *   POST /aitrace  { papers: [{ id, title, abstract }] }      (1..MAX_PAPERS)
 *     → { scores: { "<id>": { p: 0..100, why: "…" } } }
 *
 * A GUESS, AND THE PAGE SAYS SO. No detector reads machine text reliably, and
 * a model reading an abstract is no exception; the number is a hint for a
 * reader skimming forty papers, never a verdict on an author. That is also why
 * the prompt asks for the signals it used (`why`): a reader can disagree with a
 * reason, not with a bare percentage.
 *
 * Same door as story: the deployment's key or a BYO `x-llm-key`, the same
 * shared daily budget (`refine_usage_spend`), one call per press whatever the
 * batch size. index.ts wires the world in; everything here is testable.
 */

export const MAX_PAPERS = 10;       // one press covers the page's rows on screen
export const MAX_ABSTRACT = 1500;   // the whole abstract is the evidence
export const MAX_PAPER_TITLE = 300;
export const MAX_PAPER_ID = 64;
export const MAX_WHY = 120;
export const CALLS_PER_TRACE = 1;
export const TIMEOUT_MS = 45_000;

export class TraceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TraceError';
  }
}

export interface TracePaper {
  id: string;
  title: string;
  abstract: string;
}

export interface TraceScore {
  p: number;
  why: string;
}

function normalize(s: unknown, max: number): string {
  return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** The body → the papers, or the error message. Duplicate ids are dropped. */
export function readRequest(body: unknown): TracePaper[] | string {
  if (!isObject(body)) return 'Body must be a JSON object.';
  const raw = body.papers;
  if (!Array.isArray(raw) || !raw.length) return 'papers must be a non-empty array.';
  if (raw.length > MAX_PAPERS) return `At most ${MAX_PAPERS} papers per request.`;
  const seen = new Set<string>();
  const out: TracePaper[] = [];
  for (const row of raw) {
    if (!isObject(row)) return 'Each paper must be an object.';
    const id = normalize(row.id, MAX_PAPER_ID);
    const abstract = normalize(row.abstract, MAX_ABSTRACT);
    if (!id) return 'Each paper needs an id.';
    if (!abstract) return `Paper ${id} has no abstract.`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, title: normalize(row.title, MAX_PAPER_TITLE), abstract });
  }
  return out;
}

export const SYSTEM = [
  'You read arXiv abstracts and estimate, for each one, the probability that its text was',
  'written mostly by a large language model rather than by its authors.',
  'Judge the writing, not the science: a good or bad result says nothing here.',
  'Signals toward an LLM: stock phrases ("delve", "pivotal", "intricate", "a novel framework',
  'that", "paving the way", "underscores", "holistic", "seamlessly"), triads of adjectives,',
  'claims of broad impact with no number, a closing sentence that restates the opening,',
  'even rhythm with no domain shorthand.',
  'Signals toward a human: concrete numbers and units, field jargon used tersely, uneven',
  'sentences, an odd but precise word choice, a specific limitation stated plainly.',
  'Most abstracts are human-written; use 50 only when you truly cannot tell.',
  'Answer with JSON only: {"scores":[{"id":"<id>","p":<0-100 integer>,"why":"<at most 12 words>"}]},',
  'one entry per paper, in the order given.',
].join(' ');

export function promptFor(papers: TracePaper[]): string {
  return papers.map((p) => `[${p.id}] ${p.title}\n${p.abstract}`).join('\n\n');
}

export function buildMessages(papers: TracePaper[]): { role: string; content: string }[] {
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: promptFor(papers) },
  ];
}

function extractJson(text: string): Record<string, unknown> {
  const raw = String(text ?? '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : raw).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new TraceError('answer is not JSON');
  }
  if (!isObject(parsed)) throw new TraceError('answer is not a JSON object');
  return parsed;
}

/**
 * The model's answer → `{ id: { p, why } }` for the ids asked about. An entry
 * for an id nobody asked about is dropped; p is clamped to 0..100 and rounded;
 * an id with no usable p is left out rather than guessed.
 */
export function parseScores(text: string, ids: string[]): Record<string, TraceScore> {
  const parsed = extractJson(text);
  const rows = Array.isArray(parsed.scores) ? parsed.scores : [];
  const wanted = new Set(ids);
  const out: Record<string, TraceScore> = {};
  for (const row of rows) {
    if (!isObject(row)) continue;
    const id = normalize(row.id, MAX_PAPER_ID);
    const p = Number(row.p);
    if (!wanted.has(id) || !Number.isFinite(p) || id in out) continue;
    out[id] = {
      p: Math.round(Math.min(100, Math.max(0, p))),
      why: typeof row.why === 'string' ? normalize(row.why, MAX_WHY) : '',
    };
  }
  if (!Object.keys(out).length) throw new TraceError('no scores in answer');
  return out;
}

export interface UsageStore {
  spend(client: string, want: number): Promise<number>;
  refund(client: string, n: number): Promise<void>;
}

export interface Deps {
  fetch: typeof fetch;
  usage: UsageStore;
  apiKey: string;
  baseUrl: string;
  model: string;
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

/** The same salted handle story uses, so the shared meter sees one caller. */
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

async function callProvider(deps: Deps, key: string, papers: TracePaper[]) {
  const url = `${deps.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const resp = await deps.fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: deps.model,
      messages: buildMessages(papers),
      temperature: 0,
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new TraceError(`HTTP ${resp.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }
  const data = await resp.json().catch(() => null);
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new TraceError('no content in response');
  return parseScores(content, papers.map((p) => p.id));
}

/** The handler; a BYO `x-llm-key` skips the meter and is stored nowhere. */
export async function handleTrace(req: Request, deps: Deps): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return fail(405, 'POST only.');

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail(400, 'Body must be JSON.');
  }
  const papers = readRequest(body);
  if (typeof papers === 'string') return fail(400, papers);

  const byo = (req.headers.get('x-llm-key') ?? '').trim();
  const key = byo || deps.apiKey;
  if (!key) return fail(503, 'Server has no LLM_API_KEY; AI trace is disabled.');

  const log = deps.log ?? (() => {});
  let client = '';
  if (!byo) {
    client = await clientHash(req, deps.salt ?? 'arxave-refine');
    const granted = await deps.usage.spend(client, CALLS_PER_TRACE);
    if (granted < CALLS_PER_TRACE) {
      if (granted > 0) await deps.usage.refund(client, granted);
      log(`aitrace: budget (granted ${granted} of ${CALLS_PER_TRACE})`);
      return fail(429, 'budget');
    }
  }

  try {
    return ok({ scores: await callProvider(deps, key, papers) });
  } catch (err) {
    if (!byo) await deps.usage.refund(client, CALLS_PER_TRACE);
    const detail = err instanceof Error ? err.message : String(err);
    log(`aitrace: ${detail}`);
    return fail(502, detail);
  }
}
