/**
 * The pure half of wagon-name: the cache key, the prompt, and the parse.
 *
 * Split out from index.ts so it can be tested without a database, a Gemini
 * key, or a network. The key function especially — it is the one piece both
 * the browser and the server have to agree on, and a silent divergence there
 * files every name under a hash nobody looks up.
 */

/** A wagon as the client describes it: its member papers, id and title. */
export interface Member {
  id: string;
  title: string;
}

export interface WagonName {
  name: string;
  gloss: string;
}

// ── Caps. This endpoint is public and it spends money; these are load-bearing.
export const MAX_WAGONS = 24;      // a haul that clusters into more than this is noise
export const MAX_MEMBERS = 60;     // titles per wagon; beyond this adds no signal
export const MAX_TITLE = 400;      // characters; arXiv titles run ~80
export const MAX_ID = 64;

/** Collapse whitespace so cosmetic differences are not different cache keys. */
export function normalizeTitle(s: string): string {
  return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);
}

/**
 * The cache key for one wagon: sha256 over its sorted `id\ttitle` lines.
 *
 * IDS ALONE WOULD BE THE OBVIOUS KEY, AND IT WOULD BE POISONABLE. The titles
 * are what the model is shown, and they arrive from the client — so keying on
 * ids alone would let anyone name a real wagon by sending real ids with made-up
 * titles, and everyone after them would read that name from cache. Folding the
 * titles into the key means a client that lies only ever poisons a key nobody
 * else computes; the honest wagon still hashes to its own entry. The cost of
 * that safety is nil in practice: two people hauling the same day get the same
 * titles from the same arXiv listing, so they still collide on a hit.
 *
 * Sorted, because a wagon is a set — component order comes out of a DFS and is
 * not stable across thresholds even when the membership is identical.
 */
export async function wagonKey(members: Member[]): Promise<string> {
  const lines = members
    .map((m) => `${String(m.id ?? '').trim()}\t${normalizeTitle(m.title)}`)
    .sort();
  const bytes = new TextEncoder().encode(lines.join('\n'));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export const SYSTEM = [
  'You name clusters of academic preprints that an embedding model grouped by',
  'abstract similarity. You are given the titles of one cluster. Reply with a',
  'label naming the specific research topic they share, and a one-sentence',
  'gloss of what holds them together.',
  'The label is a noun phrase of two to five words, in the field\'s own',
  'terminology, specific enough to distinguish this cluster from a neighbouring',
  'one — "Valley splitting in Si/SiGe", not "Quantum computing" and not',
  '"Physics papers". Keep the phrasing a paper would use, prepositions and',
  'all — "Valley splitting in silicon", never the compressed compound',
  '"Silicon valley splitting", which reads as an unrelated proper noun.',
  'Never invent a topic no title supports: if the titles have',
  'little in common, say so in the gloss and give the label the broadest',
  'accurate name. Do not editorialize about importance or novelty.',
].join(' ');

/* An enforced schema rather than "reply in JSON", for the reason enrich.mjs
   gives: the API validates it, so a malformed reply is a transport error and
   not a parse surprise downstream. */
export const SCHEMA = {
  type: 'object',
  properties: {
    name: {
      type: 'string',
      description: 'The shared topic as a 2-5 word noun phrase, in the field\'s terminology.',
    },
    gloss: {
      type: 'string',
      description: 'One sentence on what these papers have in common.',
    },
  },
  required: ['name', 'gloss'],
};

/** The user turn: just the titles, numbered. Abstracts are not worth the tokens. */
export function promptFor(members: Member[]): string {
  const titles = members
    .slice(0, MAX_MEMBERS)
    .map((m, i) => `${i + 1}. ${normalizeTitle(m.title)}`)
    .join('\n');
  return `These ${Math.min(members.length, MAX_MEMBERS)} preprints clustered together:\n\n${titles}`;
}

/**
 * Gemini's reply reduced to a name and gloss, or null.
 *
 * Null rather than a throw on anything unexpected — a truncated response, a
 * safety block with no candidate, an empty parts array. The caller treats null
 * as "this wagon keeps its number", which is exactly the pre-LLM UI.
 */
export function parseResponse(body: unknown): WagonName | null {
  const b = body as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const text = b?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) return null;
  let parsed: { name?: unknown; gloss?: unknown };
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const name = String(parsed.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const gloss = String(parsed.gloss ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!name) return null;
  return { name, gloss };
}

/**
 * How long to wait after a 429, in whole seconds.
 *
 * Gemini does not send Retry-After on a free-tier quota rejection; it puts the
 * number in the message body ("Please retry in 49.711726874s"), so both are
 * read and the header wins when it is there. The 60-second fallback is only for
 * a 429 that says neither — better to overshoot than to hammer a limit that has
 * already been hit.
 */
export function retryAfterSeconds(header: string | null, body: string): number {
  const fromHeader = Number(header);
  if (Number.isFinite(fromHeader) && fromHeader > 0) return Math.ceil(fromHeader);
  const m = body.match(/retry in ([\d.]+)\s*s/i);
  return m ? Math.ceil(Number(m[1])) : 60;
}

/**
 * Validate a request body into wagons, or return the error message.
 *
 * Every cap is checked here rather than at the point of use, so index.ts can
 * assume a well-formed request and the caps are all readable in one place.
 */
export function readWagons(body: Record<string, unknown>): Member[][] | string {
  const raw = body.wagons;
  if (!Array.isArray(raw) || raw.length === 0) {
    return 'Field "wagons" must be a non-empty array.';
  }
  if (raw.length > MAX_WAGONS) {
    return `Too many wagons: ${raw.length} > ${MAX_WAGONS}.`;
  }
  const out: Member[][] = [];
  for (const w of raw) {
    const members = (w as { members?: unknown })?.members;
    if (!Array.isArray(members) || members.length === 0) {
      return 'Every wagon needs a non-empty "members" array.';
    }
    if (members.length > MAX_MEMBERS) {
      return `A wagon has ${members.length} members, over the ${MAX_MEMBERS} cap.`;
    }
    const parsed: Member[] = [];
    for (const m of members) {
      const id = String((m as { id?: unknown })?.id ?? '').trim();
      const title = normalizeTitle((m as { title?: unknown })?.title as string);
      if (!id || id.length > MAX_ID) {
        return `Every member needs an "id" of 1..${MAX_ID} characters.`;
      }
      if (!title) return 'Every member needs a non-empty "title".';
      parsed.push({ id, title });
    }
    out.push(parsed);
  }
  return out;
}
