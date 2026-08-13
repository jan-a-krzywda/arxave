/**
 * enrich — the decision a reader has to make about a paper, from Gemini.
 *
 * The feed's items carry an abstract, which is what the author wrote to be
 * indexed, not to be skimmed. This turns each one into fixed fields so a reader
 * can decide in a glance instead of a paragraph.
 *
 * WHY THESE FIELDS AND NOT A SUMMARY. The abstract is already a summary, and it
 * is the author's own. A generated paragraph next to it has to be better than
 * it to be worth the reader's eye, and it never is. So nothing here restates
 * the paper: every field is something the abstract makes the reader dig for.
 *
 *   verdict   read or skim — the decision itself, first, because most readers
 *             truncate an item to its first line and that line has to carry it.
 *   kind      new result / new method / theory / review / incremental. One
 *             phrase that catches the case grading cannot see: the third paper
 *             this year from the same group on the same device.
 *   headline  the finding with its number. "Improved coherence" is what the
 *             abstract says; "T2* = 3.4 ms" is what the reader wants.
 *   so_what   the one line of consequence. What changes if it holds.
 *   caveat    the condition the number is under. This is the field that makes
 *             the other four credible — a feed that only ever sells stops
 *             being read. Empty when the abstract states no limit, never
 *             invented to fill the slot.
 *   tools     what it was done with, for filtering by eye.
 *
 * `caveat` and `headline` are the two the abstract most often withholds, and
 * both get better with the paper's full text rather than its abstract. That is
 * the natural next tier here; the schema is shaped so it can arrive without
 * moving anything else.
 *
 * ONLY THE SELECTED PAPERS ARE SENT. The feed picks a handful out of ~100
 * abstracts before this runs, so the cost is a few calls a day, not a hundred:
 * ranking is the cheap local model's job and prose is the expensive one's, and
 * inverting that order is how a daily job becomes a monthly bill.
 *
 * RESULTS ARE CACHED ON DISK, keyed by arXiv id and committed with the feed. A
 * paper that stays in the feed for several days is enriched once. The cache is
 * pruned by age so it cannot grow forever.
 *
 * FAILURE IS ALWAYS SOFT. No key, a refused call, a malformed response, a
 * timeout — every one of them returns the item unenriched and the feed still
 * builds with its abstract. An LLM is an embellishment on a feed whose ranking
 * is already done; it must never be the reason a morning has no feed.
 */

import fs from 'node:fs/promises';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = process.env.ARXAVE_ENRICH_MODEL || 'gemini-2.5-flash';
const TIMEOUT_MS = 45_000;
const MAX_ABSTRACT = 6_000;   // characters; longer is padding, not signal
const CACHE_DAYS = 30;

/* Bumped whenever the field set changes. A cached record from an older shape is
   treated as a miss and re-generated, because the alternative is a feed where
   some items have a verdict and some have a "Question." heading, with nothing
   in the code saying which era an item came from. */
export const SHAPE = 2;

export const VERDICTS = ['read', 'skim'];
export const KINDS = ['new result', 'new method', 'theory', 'review', 'incremental'];

const SYSTEM = [
  'You brief a working researcher on physics and computer science preprints.',
  'They will decide from your fields alone whether to open the paper, so lead',
  'with the decision and the finding, never with methodology.',
  'Do not summarize the abstract — it is printed directly below your fields and',
  'they can read it themselves. Give them what it makes them dig for: the',
  'number, the consequence, and the condition the number is under.',
  'Use the paper\'s own terminology, quote its quantities with units, and never',
  'state anything the abstract does not support. Do not editorialize about',
  'importance or novelty beyond the two judgements asked of you below.',
].join(' ');

/* An explicit schema rather than "reply in JSON": the API enforces it, so a
   malformed response is a transport error rather than a parse surprise. The
   enums matter most — a free-text verdict would arrive as "worth a skim" and
   every consumer downstream would have to guess. */
const SCHEMA = {
  type: 'object',
  properties: {
    verdict: {
      type: 'string',
      enum: VERDICTS,
      description:
        '"read" if a researcher in this area should open the paper today; ' +
        '"skim" if the fields above are enough unless it touches their exact problem.',
    },
    kind: {
      type: 'string',
      enum: KINDS,
      description:
        'What sort of contribution this is. Use "incremental" when it extends ' +
        'the authors\' own prior result rather than opening anything new.',
    },
    headline: {
      type: 'string',
      description:
        'The central finding as a headline, one sentence. Include the key ' +
        'quantity with its units when the abstract gives one. Never restate ' +
        'the title.',
    },
    so_what: {
      type: 'string',
      description:
        'One sentence on what changes for people working in this area if the ' +
        'result holds. Consequence, not restatement.',
    },
    caveat: {
      type: 'string',
      description:
        'The condition the result was obtained under, or the limitation the ' +
        'authors state: sample count, temperature, post-selection, simulation ' +
        'rather than measurement. One short clause. Return an empty string if ' +
        'the abstract states none — do not invent one.',
    },
    tools: {
      type: 'array',
      description: 'Methods, devices, materials or techniques used. 2-5 short noun phrases.',
      items: { type: 'string' },
    },
  },
  required: ['verdict', 'kind', 'headline', 'so_what', 'caveat', 'tools'],
  /* Gemini emits properties in this order, which is also the order the feed
     renders them — handy when reading raw responses while tuning the prompt. */
  propertyOrdering: ['verdict', 'kind', 'headline', 'so_what', 'caveat', 'tools'],
};

export function promptFor(item) {
  return [
    `Title: ${item.title}`,
    item.authors ? `Authors: ${item.authors}` : '',
    '',
    `Abstract: ${String(item.abstract || '').slice(0, MAX_ABSTRACT)}`,
  ].filter(Boolean).join('\n');
}

/** An enum field, or '' — never a value no consumer downstream knows. */
function oneOf(value, allowed) {
  const v = String(value ?? '').trim().toLowerCase();
  return allowed.includes(v) ? v : '';
}

/**
 * Gemini's response shape, reduced to our fields, or null.
 *
 * Returns null rather than throwing on anything unexpected — a truncated
 * response (`finishReason: MAX_TOKENS`), a safety block with no candidate, an
 * empty parts array. The caller treats null as "no enrichment for this one".
 */
export function parseResponse(body) {
  const text = body?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const fields = {
    verdict: oneOf(parsed.verdict, VERDICTS),
    kind: oneOf(parsed.kind, KINDS),
    headline: String(parsed.headline ?? '').trim(),
    so_what: String(parsed.so_what ?? '').trim(),
    /* An absent caveat is a real answer — plenty of abstracts state no
       limitation — so it never blocks the record, and the feed simply omits
       the line. What must not happen is a fabricated one. */
    caveat: String(parsed.caveat ?? '').trim(),
    tools: Array.isArray(parsed.tools)
      ? parsed.tools.map((t) => String(t).trim()).filter(Boolean)
      : [],
  };
  /* The verdict and the kind are labels on a paper, not a description of it. A
     record carrying only those says nothing, and rendering "Skim ·
     incremental" over a bare abstract is worse than rendering the abstract. */
  if (!fields.headline && !fields.so_what && !fields.tools.length) return null;
  return fields;
}

async function callGemini(item, apiKey, model) {
  const url = `${ENDPOINT}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: 'user', parts: [{ text: promptFor(item) }] }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: 'application/json',
        responseSchema: SCHEMA,
      },
    }),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 160)}`);
  return parseResponse(await resp.json());
}

/** Drop entries nobody has seen in a month, so the committed cache stays small. */
export function pruneCache(cache, today = new Date().toISOString().slice(0, 10)) {
  const cutoff = new Date(Date.parse(today) - CACHE_DAYS * 86_400_000)
    .toISOString().slice(0, 10);
  const kept = {};
  for (const [id, rec] of Object.entries(cache || {})) {
    if ((rec?.seen ?? '') >= cutoff) kept[id] = rec;
  }
  return kept;
}

/** A usable cached record, or null — an older field set counts as a miss. */
export function cachedFields(rec) {
  if (!rec?.fields) return null;
  return rec.shape === SHAPE ? rec.fields : null;
}

/**
 * Enrich items in place-ish: returns a new array, each item with `enrichment`
 * set when one is available. Cache hits cost nothing; misses cost one call.
 */
export async function enrichItems(items, { cachePath, apiKey, model = DEFAULT_MODEL } = {}) {
  const key = apiKey || process.env.GEMINI_API_KEY || '';
  let cache = {};
  if (cachePath) {
    try {
      cache = JSON.parse(await fs.readFile(cachePath, 'utf8'));
    } catch {
      cache = {};
    }
  }
  const today = new Date().toISOString().slice(0, 10);

  if (!key) {
    console.warn('enrich: no GEMINI_API_KEY — feeding abstracts unenriched');
    return items.map((it) => ({ ...it, enrichment: cachedFields(cache[it.arxivId]) }));
  }

  const out = [];
  let called = 0;
  let hits = 0;
  let failed = 0;
  for (const item of items) {
    const cached = cache[item.arxivId];
    const fresh = cachedFields(cached);
    if (fresh) {
      cached.seen = today;
      hits++;
      out.push({ ...item, enrichment: fresh });
      continue;
    }
    try {
      const fields = await callGemini(item, key, model);
      called++;
      if (fields) cache[item.arxivId] = { fields, seen: today, model, shape: SHAPE };
      out.push({ ...item, enrichment: fields });
    } catch (err) {
      failed++;
      console.warn(`enrich: ${item.arxivId} — ${err.message}`);
      out.push({ ...item, enrichment: null });
    }
  }
  console.log(`enrich: ${hits} cached, ${called} generated, ${failed} failed`);

  if (cachePath) {
    try {
      await fs.writeFile(cachePath, JSON.stringify(pruneCache(cache, today), null, 1) + '\n');
    } catch (err) {
      console.warn(`enrich: could not write ${cachePath} — ${err.message}`);
    }
  }
  return out;
}
