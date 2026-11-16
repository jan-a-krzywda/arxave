/**
 * threads — which of tonight's arXiv papers already have a GitHub Discussions
 * thread on the campfire repo.
 *
 *   POST /threads  { repo: "owner/name", ids: ["2401.12345", …] }   (≤ 25)
 *     → { threads: { "2401.12345": "https://github.com/…/discussions/7" | null } }
 *
 * The browser cannot ask GitHub this question: the REST search does not cover
 * Discussions and GraphQL needs a token. So this is a relay with an allow-list,
 * one search per request, and a short memory.
 *
 * THE ALLOW-LIST IS THE SECURITY MODEL. `THREADS_REPOS` names the repos this
 * deployment will search; anything else is a 400 before the token is touched.
 * Without it the function is a free GitHub GraphQL proxy wearing our token —
 * the same reasoning relay applies to hosts.
 *
 * A MISSING THREAD IS `null`, NOT AN ABSENT KEY, and that difference is the
 * page's whole action: `null` means "you are the first" and the card offers
 * Start thread, while an absent key means this function could not answer and
 * the card falls back to a plain search link. Hence an upstream fault is
 * `{ threads: {}, error }` at status 200. GitHub being down must never be the
 * reason a ranked haul looks broken.
 *
 * THE MATCH IS THE BRACKETED ID, because that is exactly what `threadTitle` in
 * docs/assets/cave-thread.mjs writes: `[2401.12345] Title`. A bare `includes`
 * would make 2401.1234 match a thread about 2401.12345, and the card would
 * link one paper's discussion from another's row.
 *
 * THE CACHE IS PER ISOLATE AND DELIBERATELY SHORT. A found URL lives 10
 * minutes — a discussion's address does not change. A `null` lives 2, because
 * someone may be opening that thread right now and ten minutes of "Start
 * thread" on a thread that exists is the one wait a reader would notice. It is
 * a cache, not a budget: a recycled isolate costs one search, not correctness.
 */

export const DEFAULT_REPO = 'jan-a-krzywda/arxave-campfire';
export const MAX_IDS = 25;
/** GitHub's own ceiling for one search page. */
export const SEARCH_LIMIT = 50;
export const TIMEOUT_MS = 5_000;
export const TTL_FOUND = 10 * 60_000;
export const TTL_MISS = 2 * 60_000;

const GITHUB = 'https://api.github.com/graphql';

/** GitHub's own shape, near enough: two non-empty name parts. */
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
/** A new-style id: 2401.12345. */
const NEW_ID = /^\d{4}\.\d{4,5}$/;
/** An old-style id: hep-th/9901001, math.GT/0309136. */
const OLD_ID = /^[a-z-]+(\.[A-Z]{2})?\/\d{7}$/;

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
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

export interface ThreadsRequest {
  repo: string;
  ids: string[];
}

/** One Discussion from a GraphQL search page. */
export interface ThreadNode {
  title?: string;
  url?: string;
}

export interface Deps {
  fetch: typeof fetch;
  /** Empty means "no GITHUB_TOKEN configured". */
  token: string;
  /** Lower-cased "owner/name" pairs from THREADS_REPOS. */
  repos: readonly string[];
  now?: () => number;
  log?: (message: string) => void;
}

/** `THREADS_REPOS`, comma-separated, as a comparison list. */
export function repoAllowList(value: string | undefined): string[] {
  return String(value ?? DEFAULT_REPO)
    .split(',')
    .map((repo) => repo.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * The request, or the sentence explaining why it is refused.
 *
 * Junk ids are dropped rather than refused — the page builds this list from
 * whatever a haul holds, and one unparseable card should cost one null, not
 * the whole request. More than MAX_IDS is refused: the caller batches, and a
 * silent truncation would paint the extra cards with the wrong answer.
 */
export function readRequest(
  body: unknown,
  allow: readonly string[] = repoAllowList(DEFAULT_REPO),
): ThreadsRequest | string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return 'Body must be a JSON object.';
  }
  const fields = body as Record<string, unknown>;

  const repo = typeof fields.repo === 'string' ? fields.repo.trim() : '';
  if (!REPO.test(repo)) return 'repo must be "owner/name".';
  if (!allow.includes(repo.toLowerCase())) return 'repo is not allowed.';

  if (!Array.isArray(fields.ids)) return 'ids must be an array.';

  const ids = new Set<string>();
  for (const raw of fields.ids) {
    if (typeof raw !== 'string') continue;
    const id = raw.trim().replace(/v\d+$/i, '');
    if (NEW_ID.test(id) || OLD_ID.test(id)) ids.add(id);
  }

  if (ids.size > MAX_IDS) return `at most ${MAX_IDS} ids.`;
  return { repo, ids: [...ids] };
}

/**
 * The one GraphQL call, as a string: a Discussions search scoped to the repo
 * and the titles. Ids in an OR chain are what makes this one call instead of
 * twenty-five; `first: 50` is the most a search page returns and more than 25
 * ids can fill, which is why the nodes are read as a set rather than by order.
 *
 * `JSON.stringify` quotes the search string so nothing in an id can end the
 * GraphQL literal — the ids are already regex-checked, but the escaping is
 * the kind that stays right if that check ever loosens.
 */
export function queryFor(repo: string, ids: readonly string[]): string {
  const search = `repo:${repo} in:title ${ids.join(' OR ')}`;
  return `query { search(type: DISCUSSION, first: ${SEARCH_LIMIT}, query: ${
    JSON.stringify(search)
  }) { nodes { ... on Discussion { title url } } } }`;
}

/**
 * Each id to its thread's URL, or null. The bracketed id is the match;
 * unmatched ids and nodes for other paper numbers are both simply absent.
 */
export function matchThreads(
  ids: readonly string[],
  nodes: readonly ThreadNode[],
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const id of ids) {
    const tag = `[${id}]`;
    const node = nodes.find((n) =>
      typeof n?.url === 'string' && n.url !== '' &&
      typeof n?.title === 'string' && n.title.includes(tag)
    );
    out[id] = node?.url || null;
  }
  return out;
}

// ── the isolate-local memory ──────────────────────────────────────────────

const cache = new Map<string, { url: string | null; at: number }>();
/* A cap, not a policy: an isolate that lives long enough to hold more than
   this is answering more distinct papers than a page can show, and the oldest
   entry is the one least likely to be asked again. */
const CACHE_MAX = 1_000;

export function resetCache(): void {
  cache.clear();
}

const cacheKey = (repo: string, id: string): string => `${repo.toLowerCase()}\n${id}`;

/** The cached answer, or `undefined` when there is none or it has expired. */
function recall(key: string, at: number): string | null | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (at - hit.at > (hit.url ? TTL_FOUND : TTL_MISS)) {
    cache.delete(key);
    return undefined;
  }
  return hit.url;
}

function remember(key: string, url: string | null, at: number): void {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { url, at });
}

// ── the handler, with the network injected. ───────────────────────────────

/**
 * One GraphQL search. Any refusal, any GraphQL error, any timeout is thrown
 * as a plain Error whose message is safe to hand the caller: it names the
 * status and GitHub's own sentence, never the token.
 */
async function search(
  deps: Deps,
  repo: string,
  ids: readonly string[],
): Promise<ThreadNode[]> {
  const resp = await deps.fetch(GITHUB, {
    method: 'POST',
    headers: {
      Authorization: `bearer ${deps.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      /* GitHub rejects a request with no User-Agent. */
      'User-Agent': 'arxave-threads',
    },
    body: JSON.stringify({ query: queryFor(repo, ids) }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`GitHub HTTP ${resp.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }
  const data = await resp.json().catch(() => null);
  const first = data?.errors?.[0]?.message;
  if (first) throw new Error(`GitHub: ${String(first).slice(0, 200)}`);
  const nodes = data?.data?.search?.nodes;
  if (!Array.isArray(nodes)) throw new Error('GitHub: no search result');
  return nodes;
}

/**
 * The request handler. Everything that touches the world is a `Deps` field,
 * so the tests run with no network and no token.
 */
export async function handleThreads(req: Request, deps: Deps): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return fail(405, 'POST only.');

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail(400, 'Body must be JSON.');
  }

  const request = readRequest(body, deps.repos);
  if (typeof request === 'string') return fail(400, request);
  if (!request.ids.length) return ok({ threads: {} });

  if (!deps.token) {
    (deps.log ?? (() => {}))('threads: no GITHUB_TOKEN');
    return ok({ threads: {}, error: 'no GITHUB_TOKEN' });
  }

  const at = (deps.now ?? Date.now)();
  const threads: Record<string, string | null> = {};
  const pending: string[] = [];
  for (const id of request.ids) {
    const hit = recall(cacheKey(request.repo, id), at);
    if (hit === undefined) pending.push(id);
    else threads[id] = hit;
  }

  if (pending.length) {
    try {
      const found = matchThreads(pending, await search(deps, request.repo, pending));
      for (const [id, url] of Object.entries(found)) {
        threads[id] = url;
        remember(cacheKey(request.repo, id), url, at);
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      (deps.log ?? (() => {}))(`threads: ${detail}`);
      /* Not a 5xx: the page falls back to a search link on an empty answer. */
      return ok({ threads: {}, error: detail });
    }
  }

  return ok({ threads });
}
