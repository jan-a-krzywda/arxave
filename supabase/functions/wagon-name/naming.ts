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

/**
 * One rung of the model ladder: a model id and the only thing that differs
 * between models in this request body — how each wants to be told not to think.
 *
 * THE THINKING FIELD IS NOT COSMETIC AND IT IS NOT PORTABLE. Sending the wrong
 * one is a hard 400, not a warning, measured 2026-08-14 against each model:
 *
 *   gemini-3.5-flash-lite   thinkingBudget → 400 INVALID_ARGUMENT; wants thinkingLevel
 *   gemini-3.1-flash-lite   thinkingBudget: 0 accepted
 *   gemma-4-31b-it          any thinkingConfig → 400 "Thinking budget is not
 *   gemma-4-26b-a4b-it        supported for this model"
 *
 * So the fragment travels with the model id rather than being a constant, and
 * an id nobody listed here gets `null` — no thinkingConfig at all, which every
 * model accepts and only costs thinking tokens on one that would have honoured
 * a budget of zero.
 */
export interface Rung {
  model: string;
  thinking: Record<string, unknown> | null;
}

/**
 * The ladder, generous-quota-last.
 *
 * WHY A LADDER AND NOT A BIGGER MODEL. The binding limit is requests per
 * minute on a free-tier key, and it is metered per model — so a 429 on rung 1
 * says nothing about rung 2's budget. A haul of ten wagons cannot be named by
 * any single free-tier model in one press (measured 2026-08-14: this key 429s
 * on the 7th call within a minute); across four models it can. Falling down
 * the ladder costs a little naming quality and saves the user a second press,
 * which is the right trade for a garnish on a clustering that already happened.
 *
 * Ordered best-first, and every rung was checked on 2026-08-14 to accept
 * systemInstruction and responseSchema and to return a usable name on a real
 * three-title wagon. The Gemma rungs are last because they are the loosest
 * with the field's terminology, not because they failed.
 */
export const LADDER: Rung[] = [
  { model: 'gemini-3.5-flash-lite', thinking: { thinkingLevel: 'low' } },
  { model: 'gemini-3.1-flash-lite', thinking: { thinkingBudget: 0 } },
  { model: 'gemma-4-31b-it', thinking: null },
  { model: 'gemma-4-26b-a4b-it', thinking: null },
];

/** What each known model wants in `thinkingConfig`, for ids that arrive by env. */
const THINKING: Record<string, Record<string, unknown> | null> = Object.fromEntries(
  LADDER.map((r) => [r.model, r.thinking]),
);

/**
 * The ladder to actually climb, from a comma-separated env override or the
 * default above. An unknown id is taken at its word and sent no thinkingConfig,
 * because a wrong one is a 400 and a missing one never is.
 */
export function ladderFrom(env?: string | null): Rung[] {
  const ids = String(env ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!ids.length) return LADDER;
  return ids.map((model) => ({ model, thinking: THINKING[model] ?? null }));
}

export interface WagonName {
  name: string;
  gloss: string;
}

// ── Caps. This endpoint is public and it spends money; these are load-bearing.
export const MAX_WAGONS = 24;      // a haul that clusters into more than this is noise
/* Cache-only lookups never reach a model, so the prompt-size reason for
   MAX_WAGONS does not apply to them — only the cost of one wider cache read,
   which a train of this size makes once per haul. */
export const MAX_LOOKUP_WAGONS = 120;
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
  'abstract similarity. You are given several numbered groups of titles. Name',
  'every group: for each, a label naming the specific research topic its titles',
  'share, and a one-sentence gloss of what holds them together. Return one entry',
  'per group, carrying that group\'s number, and never merge or skip a group —',
  'two groups may be close neighbours and still need labels that tell them apart.',
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
   not a parse surprise downstream.

   `group` is the load-bearing field. A model handed nine groups can return
   eight, or return them in an order of its own choosing, and an array position
   would then silently file every name after the gap under the wrong wagon —
   which is worse than no name at all, because a wrong name is checkable only
   by someone who reads the titles. Carrying the number makes a dropped group a
   missing key rather than a shifted one. */
export const SCHEMA = {
  type: 'object',
  properties: {
    groups: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          group: {
            type: 'integer',
            description: 'The number of the group being named, exactly as given.',
          },
          name: {
            type: 'string',
            description: 'The shared topic as a 2-5 word noun phrase, in the field\'s terminology.',
          },
          gloss: {
            type: 'string',
            description: 'One sentence on what these papers have in common.',
          },
        },
        required: ['group', 'name', 'gloss'],
      },
    },
  },
  required: ['groups'],
};

/**
 * The `generationConfig` for one rung: the shared half, plus that model's own
 * way of being told not to think — or nothing, when it has no such setting.
 */
export function generationConfig(rung: Rung): Record<string, unknown> {
  return {
    temperature: 0.2,
    responseMimeType: 'application/json',
    responseSchema: SCHEMA,
    ...(rung.thinking ? { thinkingConfig: rung.thinking } : {}),
  };
}

/**
 * The user turn: every wagon in the train, as numbered groups of titles.
 *
 * ONE REQUEST FOR THE WHOLE TRAIN, NOT ONE PER WAGON. This used to send a
 * wagon at a time, and the free tier's limit is requests per minute — so a
 * seven-wagon train spent seven of a ~6/min allowance and stopped halfway with
 * "4 of 7 named". The token limits are nowhere near as tight: a typical train
 * is ~1.5k tokens against a 250k/min ceiling, and the absolute worst case here
 * (MAX_WAGONS groups of MAX_TITLES titles) is around 12k. Trading a scarce
 * budget for an abundant one costs nothing and makes the common press a single
 * call that cannot be rate limited partway through.
 *
 * Titles per group are capped tighter than `MAX_MEMBERS` because naming is a
 * task with sharply diminishing returns — the topic of a thirty-paper cluster
 * is evident in the first dozen titles, and the rest is tokens spent to say it
 * again. The count is stated so the model knows it is naming a bigger group
 * than it can see.
 */
export const MAX_TITLES = 12;   // titles shown per group in the batched prompt

export function promptFor(wagons: Member[][]): string {
  const groups = wagons.map((members, g) => {
    const shown = members.slice(0, MAX_TITLES);
    const more = members.length - shown.length;
    const head = `group ${g + 1} (${members.length} preprint${members.length === 1 ? '' : 's'}` +
      `${more > 0 ? `, ${shown.length} shown` : ''}):`;
    const titles = shown.map((m) => `  - ${normalizeTitle(m.title)}`).join('\n');
    return `${head}\n${titles}`;
  });
  return `Name each of these ${wagons.length} group${wagons.length === 1 ? '' : 's'} ` +
    `of preprints:\n\n${groups.join('\n\n')}`;
}

/**
 * Gemini's reply reduced to a name per group index (0-based), or an empty map.
 *
 * An empty map rather than a throw on anything unexpected — a truncated
 * response, a safety block with no candidate, an empty parts array. The caller
 * treats a missing group as "this wagon keeps its number", which is exactly the
 * pre-LLM UI, and a partial reply names the wagons it did answer for.
 *
 * `count` is what the request asked for, and every returned group number is
 * checked against it. A model that invents "group 14" of a nine-group train is
 * hallucinating a wagon; dropping it is the only safe reading, since there is
 * nothing it could correctly refer to.
 */
export function parseResponse(body: unknown, count: number): Record<number, WagonName> {
  const out: Record<number, WagonName> = {};
  const b = body as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const text = b?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) return out;
  let parsed: { groups?: unknown };
  try {
    parsed = JSON.parse(text);
  } catch {
    return out;
  }
  const groups = Array.isArray(parsed?.groups) ? parsed.groups : [];
  for (const g of groups) {
    const row = g as { group?: unknown; name?: unknown; gloss?: unknown };
    const idx = Number(row?.group) - 1;          // the prompt numbers from 1
    if (!Number.isInteger(idx) || idx < 0 || idx >= count) continue;
    if (out[idx]) continue;                      // first answer for a group wins
    const name = String(row.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const gloss = String(row.gloss ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (name) out[idx] = { name, gloss };
  }
  return out;
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
export function readWagons(
  body: Record<string, unknown>,
  maxWagons: number = MAX_WAGONS,
): Member[][] | string {
  const raw = body.wagons;
  if (!Array.isArray(raw) || raw.length === 0) {
    return 'Field "wagons" must be a non-empty array.';
  }
  if (raw.length > maxWagons) {
    return `Too many wagons: ${raw.length} > ${maxWagons}.`;
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
