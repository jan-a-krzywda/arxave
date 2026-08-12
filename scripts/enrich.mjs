/**
 * enrich — what a paper asks, what it uses, and what it found, from Gemini.
 *
 * The feed's items carry an abstract, which is what the author wrote to be
 * indexed, not to be skimmed. This turns each one into three fixed fields —
 * research question, tools, summary — so a reader can decide in a glance
 * instead of a paragraph.
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

const SYSTEM = [
  'You summarize physics and computer science preprints for a working researcher',
  'who will decide from your three fields whether to open the paper.',
  'Be concrete and use the paper\'s own terminology. Never speculate beyond the',
  'abstract, and never editorialize about importance or novelty.',
].join(' ');

/* An explicit schema rather than "reply in JSON": the API enforces it, so a
   malformed response is a transport error rather than a parse surprise. */
const SCHEMA = {
  type: 'object',
  properties: {
    research_question: {
      type: 'string',
      description: 'The question the paper sets out to answer, one sentence.',
    },
    tools: {
      type: 'array',
      description: 'Methods, devices, materials or techniques used. 2-5 short noun phrases.',
      items: { type: 'string' },
    },
    summary: {
      type: 'string',
      description: 'What they did and what they found, two sentences at most.',
    },
  },
  required: ['research_question', 'tools', 'summary'],
};

export function promptFor(item) {
  return [
    `Title: ${item.title}`,
    item.authors ? `Authors: ${item.authors}` : '',
    '',
    `Abstract: ${String(item.abstract || '').slice(0, MAX_ABSTRACT)}`,
  ].filter(Boolean).join('\n');
}

/**
 * Gemini's response shape, reduced to our three fields, or null.
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
  const question = String(parsed.research_question ?? '').trim();
  const summary = String(parsed.summary ?? '').trim();
  const tools = Array.isArray(parsed.tools)
    ? parsed.tools.map((t) => String(t).trim()).filter(Boolean)
    : [];
  if (!question && !summary && !tools.length) return null;
  return { research_question: question, tools, summary };
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
    return items.map((it) => ({ ...it, enrichment: cache[it.arxivId]?.fields ?? null }));
  }

  const out = [];
  let called = 0;
  let hits = 0;
  let failed = 0;
  for (const item of items) {
    const cached = cache[item.arxivId];
    if (cached?.fields) {
      cached.seen = today;
      hits++;
      out.push({ ...item, enrichment: cached.fields });
      continue;
    }
    try {
      const fields = await callGemini(item, key, model);
      called++;
      if (fields) cache[item.arxivId] = { fields, seen: today, model };
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
