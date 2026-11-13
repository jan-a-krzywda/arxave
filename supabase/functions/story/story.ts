/**
 * The pure half of story: request validation, the prompt, the response
 * validation, and the handler itself.
 *
 * WHAT THIS IS: stage 8 of the Cave. A reader has ranked a night of arXiv,
 * picked a handful of papers, and presses "Tell me tonight's story". This asks
 * a hosted model for a short narrative around those picks — what moved tonight,
 * how they connect, what to read first — which is the one thing arithmetic on
 * embeddings cannot write. Every pick already exists on the page; this is a
 * garnish, so a provider fault is a clean error the button can dismiss.
 *
 * BUDGET: it shares `refine_usage_spend` with `refine` and `diamond`, so the
 * per-address and global daily caps are the deployment's, not this endpoint's.
 * One story is two calls' worth (a story over twelve abstracts is a much larger
 * generation than one refine); if the meter can grant only one, the one is
 * refunded and the answer is 429. A failed or invalid generation refunds both —
 * a call that produced no story is not a charge.
 *
 * THE KEY is the deployment's (`LLM_API_KEY`) unless the caller sent
 * `x-llm-key`, in which case it is theirs, it is used for that one provider
 * call, it is never logged or stored, and the meter is skipped entirely.
 *
 * VALIDATION IS NOT DECORATION. A model reply is untrusted input: a readFirst
 * that is not one of the picked ids, a thread joining a paper nobody sent, a
 * fictional 5000-character story. The page renders what comes back, so each of
 * those is thrown as `StoryError` here (or clipped, for the display lengths)
 * rather than shipped.
 */

export const MAX_PAPERS = 12;        // the contract's per-night ceiling
export const MAX_WAGONS = 24;        // and the map's wagon ceiling
export const MAX_ABSTRACT = 1200;    // clipped: twelve full abstracts is a lot of tokens
export const MAX_PAPER_TITLE = 300;  // characters; arXiv titles run ~80
export const MAX_PAPER_ID = 64;      // arXiv ids are ~20
export const MAX_WAGON = 120;
export const MAX_TOPIC = 120;
export const MAX_DIAMOND = 400;      // the diamond's two-sentence summary
export const MAX_CARE = 500;         // the reader's "what I care about" box
export const MAX_TITLE = 80;         // story title, per the contract
export const MAX_STORY = 2500;       // markdown, per the contract
export const MAX_THREADS = 4;
export const MAX_WHY = 200;

/** A story is two calls against the shared meter; refine is one. */
export const CALLS_PER_STORY = 2;

/* A story over twelve abstracts is a longer generation than one refine card;
   sixty seconds gives it room without holding an edge function open. */
export const TIMEOUT_MS = 60_000;

/** A call failed, or returned something that did not validate. */
export class StoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoryError';
  }
}

export interface StoryPaper {
  id: string;
  title: string;
  abstract: string;
  /** The wagon the map put it in, when the reader named them. */
  wagon?: string;
  /** Its main topic, when the map tagged it. */
  topic?: string;
  /** The paper's already-extracted diamond, when the reader has one. */
  diamond?: string;
}

export interface StoryWagon {
  name: string;
  size: number;
}

export interface StoryRequest {
  date: string;
  papers: StoryPaper[];
  wagons: StoryWagon[];
  care: string;
}

export interface StoryThread {
  ids: string[];
  why: string;
}

export interface Story {
  title: string;
  story: string;
  readFirst: string;
  threads: StoryThread[];
}

/**
 * Collapse whitespace and clip. Cosmetic differences are not different inputs,
 * and an abstract arrives from arXiv with newlines and runs of spaces that cost
 * tokens to say nothing. Story prose itself is never collapsed — markdown needs
 * its newlines — so only the input fields and the one-line output fields use it.
 */
function normalize(s: unknown, max: number): string {
  return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** A string or number rendered as a short label; anything else is absent. */
function label(v: unknown, max: number): string {
  return typeof v === 'string' || typeof v === 'number' ? normalize(v, max) : '';
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Validate a request body into the shape the prompt needs, or return the error
 * message. Every cap is checked here so `handleStory` can assume a well-formed
 * request and the caps are readable in one place.
 */
export function readRequest(body: Record<string, unknown>): StoryRequest | string {
  if (!isObject(body)) return 'Body must be a JSON object.';

  const date = typeof body.date === 'string' ? body.date.trim() : '';
  /* Date.parse alone is not enough: it rolls 2026-02-30 over to 2 March, so
     the round trip is what makes the field a real calendar day. */
  const day = new Date(`${date}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(day.getTime()) ||
    day.toISOString().slice(0, 10) !== date
  ) {
    return 'Field "date" must be a YYYY-MM-DD date.';
  }

  if (!Array.isArray(body.papers)) return 'Field "papers" must be an array.';
  if (body.papers.length === 0) return 'Field "papers" must hold at least one paper.';
  if (body.papers.length > MAX_PAPERS) {
    return `Too many papers: ${body.papers.length} > ${MAX_PAPERS}.`;
  }
  const papers: StoryPaper[] = [];
  const ids = new Set<string>();
  for (const p of body.papers) {
    if (!isObject(p)) return 'Every paper must be an object.';
    const id = normalize(p.id, MAX_PAPER_ID);
    if (!id) return 'Every paper needs a non-empty "id".';
    if (ids.has(id)) return `Duplicate paper id "${id}".`;
    const title = normalize(p.title, MAX_PAPER_TITLE);
    const abstract = normalize(p.abstract, MAX_ABSTRACT);
    if (!title) return `Paper "${id}" needs a non-empty "title".`;
    if (!abstract) return `Paper "${id}" needs a non-empty "abstract".`;

    const paper: StoryPaper = { id, title, abstract };
    const wagon = label(p.wagon, MAX_WAGON);
    const topic = label(p.topic, MAX_TOPIC);
    /* The page may send the diamond's summary as text. An object form is
       ignored rather than stringified into the prompt as "[object Object]". */
    const diamond = oneLine(p.diamond, MAX_DIAMOND);
    if (wagon) paper.wagon = wagon;
    if (topic) paper.topic = topic;
    if (diamond) paper.diamond = diamond;
    ids.add(id);
    papers.push(paper);
  }

  const rawWagons = body.wagons;
  if (rawWagons !== undefined && !Array.isArray(rawWagons)) {
    return 'Field "wagons" must be an array.';
  }
  const wList = (rawWagons ?? []) as unknown[];
  if (wList.length > MAX_WAGONS) {
    return `Too many wagons: ${wList.length} > ${MAX_WAGONS}.`;
  }
  const wagons: StoryWagon[] = [];
  for (const w of wList) {
    if (!isObject(w)) return 'Every wagon must be an object with "name" and "size".';
    const name = label(w.name, MAX_WAGON);
    const size = Number(w.size);
    if (!name) return 'Every wagon needs a non-empty "name".';
    if (!Number.isFinite(size)) return `Wagon "${name}" needs a numeric "size".`;
    wagons.push({ name, size });
  }

  if (body.care !== undefined && typeof body.care !== 'string') {
    return 'Field "care" must be a string.';
  }
  const care = normalize(body.care, MAX_CARE);

  return { date, papers, wagons, care };
}

export const SYSTEM = [
  'You write the nightly story for one reader of an arXiv digest. You are given',
  "tonight's picked papers for their field (each with an id, title and abstract,",
  "sometimes its wagon and topic and diamond), the night's wagons, and what the",
  'reader says they care about. Write a short, vivid but accurate story of the',
  "night in the reader's field: what moved tonight, how the picked papers",
  'connect, and what to read first and why. Refer to every paper by its id in',
  'square brackets, like [2401.00001], never by number or title alone. Use only',
  'what the abstracts say: do not invent results, numbers, or papers that are',
  'not listed. Addressing the reader as "you" is fine, and the story is markdown.',
  'Return ONLY a JSON object, no prose and no markdown fence:',
  '{"title":string <=80 chars, "story":markdown <=2500 chars,',
  '"readFirst":"<id of one picked paper>", "threads":[{"ids":["<id>","<id>"],',
  '"why":string <=200 chars}]}',
  'threads holds 0 to 4 real connections; each ids array names two or more',
  'picked papers by id, and why says in one sentence what actually links them.',
].join(' ');

/**
 * The user turn: the night, the picks, the wagons, and the reader. Ids are
 * shown on their own so the model has exactly one handle to quote.
 */
export function promptFor(req: StoryRequest): string {
  const papers = req.papers.map((p) => {
    const meta = [p.wagon ? `wagon: ${p.wagon}` : '', p.topic ? `topic: ${p.topic}` : '']
      .filter(Boolean).join(' · ');
    return [
      `[${p.id}] ${p.title}`,
      ...(meta ? [meta] : []),
      ...(p.diamond ? [`diamond: ${p.diamond}`] : []),
      `Abstract: ${p.abstract}`,
    ].join('\n');
  }).join('\n\n');
  const wagons = req.wagons.length
    ? req.wagons.map((w) => `- ${w.name} (${w.size} papers)`).join('\n')
    : '(not named)';

  return [
    `DATE: ${req.date}`,
    '',
    'WHAT THE READER CARES ABOUT:',
    req.care || '(none given)',
    '',
    `PICKED PAPERS (${req.papers.length}):`,
    papers,
    '',
    "TONIGHT'S WAGONS:",
    wagons,
    '',
    'Return the JSON object now.',
  ].join('\n');
}

/** The two turns sent to the model, OpenAI-shaped. */
export function buildMessages(req: StoryRequest): { role: string; content: string }[] {
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
    throw new StoryError('story is not JSON');
  }
  if (!isObject(parsed)) throw new StoryError('story is not a JSON object');
  return parsed;
}

/** A model field as a one-line string; anything but a string is absent. */
function oneLine(v: unknown, max: number): string {
  return typeof v === 'string' ? normalize(v, max) : '';
}

/** Markdown keeps its shape; only the ends are trimmed and the tail clipped. */
function prose(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

/**
 * A model reply reduced to the story the reader sees, or `StoryError`.
 *
 * `paperIds` is what makes the reply checkable: a readFirst or a thread id that
 * is not one of tonight's picks is a hallucination the page cannot link, so it
 * fails here (and the handler refunds) rather than rendering as a dead
 * reference. Display lengths are clipped instead of rejected, and surplus
 * threads past the fourth are dropped: both are still an accurate story.
 */
export function parseStory(text: string, paperIds: string[]): Story {
  const obj = extractJson(text);
  const ids = new Set(paperIds);

  const title = oneLine(obj.title, MAX_TITLE);
  if (!title) throw new StoryError('title must be a non-empty string');
  const story = prose(obj.story, MAX_STORY);
  if (!story) throw new StoryError('story must be a non-empty string');

  const readFirst = oneLine(obj.readFirst, MAX_PAPER_ID);
  if (!readFirst || !ids.has(readFirst)) {
    throw new StoryError(
      `readFirst must be one of the picked paper ids, got ${JSON.stringify(obj.readFirst)}`,
    );
  }

  const rawThreads = obj.threads ?? [];
  if (!Array.isArray(rawThreads)) throw new StoryError('threads must be an array');
  const threads: StoryThread[] = [];
  for (const t of rawThreads.slice(0, MAX_THREADS)) {
    if (!isObject(t)) throw new StoryError('every thread must be an object');
    const tIds = Array.isArray(t.ids)
      ? t.ids.map((id) => oneLine(id, MAX_PAPER_ID)).filter(Boolean)
      : [];
    if (tIds.length < 2) {
      throw new StoryError('every thread must name at least two paper ids');
    }
    for (const id of tIds) {
      if (!ids.has(id)) {
        throw new StoryError(`thread names a paper that was not picked: ${id}`);
      }
    }
    const why = oneLine(t.why, MAX_WHY);
    if (!why) throw new StoryError('every thread needs a non-empty "why"');
    threads.push({ ids: tIds, why });
  }

  return { title, story, readFirst, threads };
}

// ── The handler, with the two outer-world things injected. ────────────────

/**
 * The daily meter, in front of the deployment's own key. `spend` grants up to
 * `want` calls against the per-client and global caps and returns how many it
 * actually granted (which may be zero); `refund` hands back calls the provider
 * then refused or answered uselessly, so a bad afternoon upstream is not a
 * charge.
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
async function callProvider(deps: Deps, key: string, req: StoryRequest): Promise<Story> {
  const url = `${deps.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const resp = await deps.fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: deps.model,
      messages: buildMessages(req),
      /* A story may be vivid; refine's 0 is for a judgement that must not
         wobble. 0.4 keeps prose alive without turning it into fiction. */
      temperature: 0.4,
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new StoryError(`HTTP ${resp.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }
  const data = await resp.json().catch(() => null);
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new StoryError('no content in response');
  return parseStory(content, req.papers.map((p) => p.id));
}

/**
 * The request handler. Pure enough to test: everything that touches the world
 * is a `Deps` field.
 *
 * A BYO KEY (`x-llm-key`) SPENDS NOTHING AND IS STORED NOWHERE, exactly as in
 * refine: it replaces the deployment's key for this one call and skips the
 * meter, because it is the caller's money being spent, not the deployer's.
 */
export async function handleStory(req: Request, deps: Deps): Promise<Response> {
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
  if (!key) return fail(503, 'Server has no LLM_API_KEY; stories are disabled.');

  const log = deps.log ?? (() => {});
  let client = '';
  if (!byo) {
    client = await clientHash(req, deps.salt ?? 'arxave-refine');
    const granted = await deps.usage.spend(client, CALLS_PER_STORY);
    if (granted < CALLS_PER_STORY) {
      /* A story is all or nothing: half a budget is refunded, not charged as
         one call for half a story. */
      if (granted > 0) await deps.usage.refund(client, granted);
      log(`story: budget (granted ${granted} of ${CALLS_PER_STORY})`);
      return fail(429, 'budget');
    }
  }

  try {
    return ok(await callProvider(deps, key, request));
  } catch (err) {
    /* A call that produced nothing is not a charge — but only the meter's own
       calls are refunded; a BYO call never debited it. */
    if (!byo) await deps.usage.refund(client, CALLS_PER_STORY);
    const detail = err instanceof Error ? err.message : String(err);
    log(`story: ${detail}`);
    return fail(502, detail);
  }
}

