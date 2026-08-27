/**
 * enrich — the decision a reader has to make about a paper, from Gemini.
 *
 * The feed's items carry an abstract, which is what the author wrote to be
 * indexed, not to be skimmed. This turns each one into fixed fields so a reader
 * can decide in a glance instead of a paragraph.
 *
 * WHY FIELDS AND NOT A SUMMARY. The abstract is already a summary, and it is
 * the author's own. A generated paragraph next to it has to be better than it
 * to be worth the reader's eye, and it never is. So nothing here restates the
 * paper: every field is something the abstract makes the reader dig for.
 *
 *   kind      new result / new method / theory / review / incremental. One
 *             phrase that catches the case grading cannot see: the third paper
 *             this year from the same group on the same device.
 *   result    the finding with its number. "Improved coherence" is what the
 *             abstract says; "T2* = 3.4 ms" is what the reader wants.
 *   question  what the paper set out to answer. From the introduction, where it
 *             is stated plainly, rather than from the abstract, where it is
 *             usually implied by the answer.
 *   prior     what the best previous answer was, and how far this moves it. The
 *             single most valuable field and the one an abstract almost never
 *             gives: a number alone means nothing, "3.4 ms, was 1.1 ms on the
 *             same device" means everything.
 *   tools     what it was done with, for filtering by eye.
 *   limits    the conditions and assumptions the number is under. This is the
 *             field that makes the others credible — a feed that only ever
 *             sells stops being read. Empty when the paper states none, never
 *             invented to fill the slot.
 *   figure    which figure to show. The model names one, because it has read
 *             the paper and Figure 1 is very often only the schematic.
 *   gloss     that figure's caption, rewritten for someone who has not read the
 *             paper. The author's own caption is written for a reader forty
 *             pages in — "(b) as in Fig. 3, with \u03b4 = 0" — and on a feed card,
 *             stripped of that context, it says nothing. So the model writes
 *             the caption the card needs: what is plotted, and what it shows.
 *
 * EVERY PAPER IN THE FEED IS READ IN FULL. `prior` and `limits` are stated in
 * the introduction and the discussion and nowhere else; from an abstract alone
 * the model either guesses or returns nothing, so an abstract-tier card is a
 * card with two of its six fields permanently blank. `fulltext.mjs` fetches
 * arXiv's own HTML rendering and trims it.
 *
 * THIS USED TO BE THE TOP BAND ONLY, on the reasoning that a reader deciding
 * whether to spend an evening is deciding it about pay dirt. That was wrong in
 * the direction that matters: a long shot is exactly the paper a reader knows
 * least about, and "no baseline given" on it is indistinguishable from "the
 * model was never shown the introduction". The cost is bounded by the feed and
 * not by the announcement — the ranking picks a handful out of ~100 abstracts
 * before this runs, so this is tens of calls a day, not hundreds. What is never
 * read in full is a paper the ranking already dropped.
 *
 * THE VOICE IS DELIBERATE. Short words, dropped articles, fragments — the same
 * voice the rest of arXave is written in, and it buys something beyond tone: it
 * makes a field that has nothing to say obviously empty instead of padding it
 * to a sentence. What it must never touch is the substance. Quantities, units,
 * and the paper's own terms are copied exactly; only the words between them get
 * shortened. "Was 1.1 ms. Now 3.4 ms. Same chip." is the register. "Coherence
 * much big" is a bug.
 *
 * ONLY THE SELECTED PAPERS ARE SENT. The feed picks a handful out of ~100
 * abstracts before this runs, so the cost is a few calls a day, not a hundred.
 *
 * RESULTS ARE CACHED ON DISK, keyed by arXiv id and committed with the feed. A
 * paper that stays in the feed for several days is enriched once. The cache is
 * pruned by age so it cannot grow forever, and it records which tier a record
 * came from: a paper briefed from its abstract on a day arXiv had no HTML for
 * it yet is re-read the next morning rather than served stale and shallow.
 *
 * FAILURE IS ALWAYS SOFT. No key, a refused call, a malformed response, a
 * timeout, a paper with no HTML rendering — every one of them degrades one step
 * (full text → abstract → nothing) and the feed still builds. An LLM is an
 * embellishment on a feed whose ranking is already done; it must never be the
 * reason a morning has no feed.
 */

import fs from 'node:fs/promises';

import { fetchFullText } from './fulltext.mjs';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
/* gemini-2.5-flash retires 2026-10-16, and its free tier is what forced this
   change: 250 requests a day is under a cold start plus a re-run. 3.7-flash is
   the current stable Flash. Overridable, but note that a model from the 2.5
   line will not understand the request shape built below. */
const DEFAULT_MODEL = process.env.ARXAVE_ENRICH_MODEL || 'gemini-3.7-flash';
/* MEASURED 2026-08-25: a full-text call to 3.7-flash aborted at 60s. A 6.2k-token
   prompt against a model that is regularly answering "high demand" needs more
   room than an abstract did, and a timeout here costs the whole brief. */
const TIMEOUT_MS = 150_000;
const MAX_ABSTRACT = 6_000;   // characters; longer is padding, not signal
const CACHE_DAYS = 30;
/* Longest the API may ask us to wait before we give up and ship the item from
   its abstract. Above this it is a daily allowance, not a per-minute one. */
const RETRY_CAP_MS = 90_000;
/* Backoff step for a busy model, which is a different failure from a quota.
   MEASURED 2026-08-27: three attempts spaced 3s and 6s give up nine seconds
   into a spike, and a spike lasts longer than that — a rebuild of one morning
   lost seven of nineteen papers to 503s while every retry was still inside the
   first ten seconds. The steps are multiples of this, so five attempts sit out
   about fifty seconds before the fallback below is asked. */
const BUSY_RETRY_MS = 5_000;
const BUSY_ATTEMPTS = 5;
/* The understudy. A 503 is this model being full, not the request being wrong,
   so the same prompt on another model of the same family is the one retry with
   a real chance of a different answer. VERIFIED 2026-08-27: 3.6-flash accepts
   the identical v1beta request shape — schema, mime type and thinking level —
   and answers the same prompt in the same JSON. Set empty to switch off. */
const FALLBACK_MODEL = process.env.ARXAVE_ENRICH_FALLBACK ?? 'gemini-3.6-flash';
/* A floor on the gap between calls, sized to the ceiling it has to stay under.
   MEASURED 2026-08-25: the free tier's limit is
   GenerateRequestsPerMinutePerProjectPerModel, and at a 2s gap — 30 a minute —
   the run was throttled on nearly every call and recovered only by waiting out
   the delays it was handed. 6.5s is a shade over nine a minute, which clears
   the published free-tier RPM with room for the retries.

   ON A PAID KEY the ceiling is far higher and that pause is pure waiting, so
   the default is 1s — enough to keep a burst from arriving as one spike, small
   enough not to be felt. If this key is ever moved back to the free tier, set
   ARXAVE_ENRICH_GAP_MS=6500; the retry path will survive it either way, just
   slowly. */
const MIN_GAP_MS = Number(process.env.ARXAVE_ENRICH_GAP_MS || 1_000);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* Which papers are read in full: every one that reached the feed, whatever its
   band. Empty means no band filter at all, which is deliberately not the same
   as listing the three known bands — an item whose band is missing or new is
   read rather than silently demoted to its abstract.

   The cap is a fuse, not a policy. It sits above `--top`'s default of 8 with
   room to spare, so it binds only when a run is asked for far more papers per
   feed than a person reads in a morning, and an unusual day cannot silently
   become a hundred full-paper calls. */
export const DEEP_BANDS = new Set();
export const DEEP_MAX = 24;

/* Bumped whenever the field set changes. A cached record from an older shape is
   treated as a miss and re-generated, because the alternative is a feed where
   some items carry a figure gloss and some a raw LaTeX caption, with nothing
   in the code saying which era an item came from. */
export const SHAPE = 4;

export const KINDS = ['new result', 'new method', 'theory', 'review', 'incremental'];

const SYSTEM = [
  'You brief a working researcher on physics and computer science preprints.',
  'They decide from your fields alone whether to open the paper, so lead with',
  'the finding, never with methodology.',
  'Do not summarize the paper — its abstract is printed directly below your',
  'fields and they can read it themselves. Give them what it makes them dig',
  'for: the number, what the number was before, and the conditions it holds',
  'under.',
  '',
  'WRITE IN CLIPPED, PLAIN ENGLISH. Drop articles and filler. Short sentences,',
  'fragments are fine. "Was 1.1 ms. Now 3.4 ms. Same chip." not "The authors',
  'report a substantial improvement in the coherence time."',
  'THE COMPRESSION IS ON THE WORDS, NEVER ON THE SUBSTANCE. Copy every quantity,',
  'unit, symbol and technical term exactly as the paper writes it. Never round a',
  'number, never drop a unit, never swap the paper\'s term for a simpler one.',
  'Vague-but-short is a failure; an empty field is better than a padded one.',
  '',
  'Never state anything the text does not support, and do not editorialize about',
  'importance or novelty beyond the one judgement asked of you below.',
].join('\n');

/* An explicit schema rather than "reply in JSON": the API enforces it, so a
   malformed response is a transport error rather than a parse surprise. The
   enum matters most — a free-text `kind` would arrive as "a new-ish method" and
   every consumer downstream would have to guess. */
const SCHEMA = {
  type: 'object',
  properties: {
    kind: {
      type: 'string',
      enum: KINDS,
      description:
        'What sort of contribution this is. Use "incremental" when it extends ' +
        'the authors\' own prior result rather than opening anything new.',
    },
    result: {
      type: 'string',
      description:
        'The central finding, one or two clipped sentences. Include the key ' +
        'quantity with its units exactly as given. Never restate the title.',
    },
    question: {
      type: 'string',
      description:
        'What the paper set out to answer, one clipped sentence. Take it from ' +
        'the introduction when you have the full text. The question, not the answer.',
    },
    prior: {
      type: 'string',
      description:
        'What the best previous answer was and how far this moves it. Name the ' +
        'prior approach or result the paper measures itself against, and give ' +
        'the old number when the paper gives one: "was 1.1 ms (Smith 2024)". ' +
        'Return an empty string if the text does not say — never guess a ' +
        'baseline and never cite a work the paper does not.',
    },
    tools: {
      type: 'array',
      description: 'Methods, devices, materials or techniques used. 2-5 short noun phrases.',
      items: { type: 'string' },
    },
    limits: {
      type: 'string',
      description:
        'The conditions and assumptions the result holds under: sample count, ' +
        'temperature, post-selection, simulation rather than measurement, an ' +
        'asymptotic regime, a noise model. Prefer what the paper states in its ' +
        'own limitations or discussion. One or two clipped clauses. Return an ' +
        'empty string if it states none — do not invent one.',
    },
    figure: {
      type: 'string',
      description:
        'The id of the one figure that best shows the result, copied exactly ' +
        'from the FIGURES list given to you (for example "S4.F2"). Not ' +
        'necessarily Figure 1, which is often only a schematic. Empty string ' +
        'if no figures were listed or none of them shows the finding.',
    },
    gloss: {
      type: 'string',
      description:
        'A caption for that figure, written for someone who has not read the ' +
        'paper. Say what is plotted on each axis and what the figure shows, in ' +
        'one or two clipped sentences. Do not copy the paper\'s own caption and ' +
        'do not refer to panels, equations, other figures or symbols the reader ' +
        'has not been given ("as in Fig. 3", "for the Hamiltonian of Eq. 2"). ' +
        'Empty string when the figure field is empty.',
    },
  },
  required: ['kind', 'result', 'question', 'prior', 'tools', 'limits', 'figure', 'gloss'],
  /* Gemini emits properties in this order, which is also the order the feed
     renders them — handy when reading raw responses while tuning the prompt. */
  propertyOrdering: ['kind', 'result', 'question', 'prior', 'tools', 'limits', 'figure', 'gloss'],
};

/**
 * The user turn: always the abstract, plus the trimmed paper when there is one.
 *
 * The abstract stays in even at the full-text tier. It is the authors' own
 * statement of what matters, it is short, and it costs nothing next to 24k
 * characters of body — and dropping it would mean the two tiers disagree about
 * what the paper claims for reasons that have nothing to do with the paper.
 *
 * The figure list is ids and captions only. That is enough for the model to
 * pick one by what it shows, and it means no image is ever uploaded: the whole
 * figure feature costs zero extra tokens beyond a few caption lines.
 */
export function promptFor(item, full = null) {
  const figures = (full?.figures || [])
    .map((f) => `${f.id}: ${f.caption.slice(0, 300)}`)
    .join('\n');
  return [
    `Title: ${item.title}`,
    item.authors ? `Authors: ${item.authors}` : '',
    '',
    `Abstract: ${String(item.abstract || '').slice(0, MAX_ABSTRACT)}`,
    full?.text ? `\nFULL TEXT (bibliography and appendices removed, middle may be\nelided; the introduction and the conclusion are what you need):\n${full.text}` : '',
    figures ? `\nFIGURES (id: caption) — name one of these ids in the "figure" field:\n${figures}` : '',
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
    kind: oneOf(parsed.kind, KINDS),
    result: String(parsed.result ?? '').trim(),
    question: String(parsed.question ?? '').trim(),
    /* An absent `prior` or `limits` is a real answer — a paper arXiv has no
       HTML rendering for has no introduction to read, and plenty of papers
       state no limitation —
       so neither blocks the record and the feed simply omits the line. What
       must not happen is a fabricated baseline. */
    prior: String(parsed.prior ?? '').trim(),
    limits: String(parsed.limits ?? '').trim(),
    tools: Array.isArray(parsed.tools)
      ? parsed.tools.map((t) => String(t).trim()).filter(Boolean)
      : [],
    figure: String(parsed.figure ?? '').trim(),
    gloss: String(parsed.gloss ?? '').trim(),
  };
  /* The kind is a label on a paper, not a description of it. A record carrying
     only that says nothing, and rendering "incremental" over a bare abstract is
     worse than rendering the abstract. */
  if (!fields.result && !fields.question && !fields.tools.length) return null;
  return fields;
}

/**
 * How long the API says to wait, in ms, or null if it did not say.
 *
 * A 429 carries a RetryInfo detail with a `retryDelay` like "27s". Honouring it
 * is the difference between a rate limit (which clears on its own) and a spent
 * daily quota (which does not) — and the two are the same status code, so
 * without this there is no way to tell them apart from a log.
 */
export function retryDelayMs(body) {
  const info = (body?.error?.details || [])
    .find((d) => String(d['@type'] || '').endsWith('RetryInfo'));
  const m = String(info?.retryDelay || '').match(/^([\d.]+)s$/);
  return m ? Math.ceil(parseFloat(m[1]) * 1000) : null;
}

/** What a 429 was actually about — "quota exceeded" alone does not say. */
export function quotaReason(body) {
  const fail = (body?.error?.details || [])
    .find((d) => String(d['@type'] || '').endsWith('QuotaFailure'));
  const v = fail?.violations?.[0];
  return v ? `${v.quotaId || 'quota'} (${v.quotaMetric || '?'})` : '';
}

/**
 * One call, retried while the API is willing to say when to come back.
 *
 * MEASURED 2026-08-25, and the reason this exists: the SHAPE bump invalidated
 * every cached record at once, so a morning that normally makes a handful of
 * calls made twenty-four back to back and was rate-limited after six. Two
 * thirds of the feed shipped unenriched. The burst is a one-off — tomorrow is
 * cache hits again — but a job that cannot survive its own migration will not
 * survive the next one either.
 *
 * A spent daily quota is not waited out: the delay it asks for is hours, and a
 * feed that is late is worse than a feed that is honest. The cap decides that
 * without having to parse which quota it was.
 */
/**
 * The request body.
 *
 * VERIFIED AGAINST THE LIVE API 2026-08-25, because the documentation for the
 * 3 line describes a shape v1beta does not accept. `response_format` and a
 * top-level `thinking_level` are both rejected outright —
 * `Unknown name "thinking_level" at 'generation_config'` — and the 2.5 spelling
 * below, `responseMimeType` beside `responseSchema`, is still what works on
 * gemini-3.7-flash. Do not "modernise" this from the docs without making the
 * call first.
 *
 * `thinkingConfig` is the one thing that genuinely arrived with the 3 line, and
 * it matters because thinking tokens bill as output at five times the input
 * rate. Measured on a real 6.2k-token full-text prompt, `thinkingLevel: 'low'`
 * returned `thoughtsTokenCount: 0` and slightly fuller `limits` than
 * `thinkingBudget: 0` did — so the floor costs nothing here and is not worth
 * trading quality for. This is an extraction task: the paper states the number
 * and the model copies it.
 */
export function requestBody(prompt) {
  return {
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.2,
      thinkingConfig: { thinkingLevel: 'low' },
      responseMimeType: 'application/json',
      responseSchema: SCHEMA,
    },
  };
}

async function callGemini(prompt, apiKey, model, { attempts = BUSY_ATTEMPTS, sleep = wait } = {}) {
  const url = `${ENDPOINT}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  let last = '';
  for (let n = 0; n < attempts; n++) {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify(requestBody(prompt)),
    });
    if (resp.ok) return parseResponse(await resp.json());

    const raw = await resp.text();
    let body = null;
    try { body = JSON.parse(raw); } catch { /* not JSON; the raw text is the message */ }
    const reason = quotaReason(body);
    last = `HTTP ${resp.status}${reason ? ` ${reason}` : ''}: ` +
      `${String(body?.error?.message || raw).slice(0, 200)}`;

    /* MEASURED 2026-08-25 while probing this model: 503 "experiencing high
       demand" comes back often enough to lose items to it, and unlike a quota
       it clears in seconds. It carries no RetryInfo, so the delay is ours. */
    if (resp.status === 503 && n < attempts - 1) {
      console.log('enrich: model busy, retrying');
      await sleep(BUSY_RETRY_MS * (n + 1));
      continue;
    }
    if (resp.status !== 429 || n === attempts - 1) break;
    /* MEASURED 2026-08-25: a spent DAILY allowance does not reliably ask for an
       hour. It asked for 13s, then 53s, and the delay is honoured and the call
       retried and refused again — seventeen items each burning two pointless
       waits turned a three-minute job into ten. The quota's own name is the
       only dependable signal, so read that rather than inferring from how long
       it says to wait: a per-minute limit is worth sitting out, a per-day one
       is not, whatever number comes attached. */
    const daily = /PerDay/i.test(quotaReason(body));
    const asked = retryDelayMs(body);
    if (daily || asked === null || asked > RETRY_CAP_MS) {
      last += daily ? ' (daily allowance — not waiting)'
        : asked === null ? ' (no retry delay given)'
        : ` (asked for ${Math.round(asked / 1000)}s — not waiting)`;
      break;
    }
    console.log(`enrich: rate limited, waiting ${Math.round(asked / 1000)}s`);
    await sleep(asked);
  }
  throw new Error(last);
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
 * A usable cached record, or null.
 *
 * An older field set counts as a miss, and so does a shallower one: a paper
 * briefed from its abstract before the feed read everything in full must be
 * re-read rather than served without the two fields that requires. This is the
 * path that migrates the cache — no record is deleted, each is simply re-made
 * the first morning its paper comes back round.
 */
export function cachedFields(rec, wantDeep = false) {
  if (!rec?.fields) return null;
  if (rec.shape !== SHAPE) return null;
  if (wantDeep && rec.depth !== 'full') return null;
  return rec.fields;
}

/** Which items get read in full: all of them, in feed order, up to the fuse. */
export function deepSet(items) {
  const ids = new Set();
  for (const it of items) {
    if (ids.size >= DEEP_MAX) break;
    if (!DEEP_BANDS.size || DEEP_BANDS.has(it.band)) ids.add(it.arxivId);
  }
  return ids;
}

/**
 * The model named a figure id; turn it into something the feed can render.
 *
 * Falls back to the first figure rather than to nothing when the id does not
 * match — a hallucinated "S3.F1" should cost the *best* figure, not the only
 * one. Returns null when the paper has no figures at all, which is normal for
 * a theory paper.
 */
export function resolveFigure(full, id) {
  const figures = full?.figures || [];
  if (!figures.length) return null;
  return figures.find((f) => f.id === id) || figures[0];
}

/**
 * Enrich items in place-ish: returns a new array, each item with `enrichment`
 * set when one is available. Cache hits cost nothing; misses cost one call.
 */
export async function enrichItems(items, { cachePath, apiKey, model = DEFAULT_MODEL, readFullText = fetchFullText } = {}) {
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
  const deep = deepSet(items);

  if (!key) {
    console.warn('enrich: no GEMINI_API_KEY — feeding abstracts unenriched');
    return items.map((it) => ({ ...it, enrichment: cachedFields(cache[it.arxivId]) }));
  }

  const out = [];
  let called = 0;
  let hits = 0;
  let failed = 0;
  let fellBack = 0;
  let read = 0;
  let lastCall = 0;
  for (const item of items) {
    const wantDeep = deep.has(item.arxivId);
    const cached = cache[item.arxivId];
    const fresh = cachedFields(cached, wantDeep);
    if (fresh) {
      cached.seen = today;
      hits++;
      out.push({ ...item, enrichment: fresh });
      continue;
    }
    /* The read has its own try, so a paper whose HTML is malformed enough to
       throw still gets its abstract-tier brief instead of no brief at all: one
       degradation step, never two. `fetchFullText` already swallows the errors
       it expects; this is for the ones it does not. */
    let full = null;
    if (wantDeep) {
      try {
        full = await readFullText(item.arxivId);
        if (full) read++;
      } catch (err) {
        console.warn(`enrich: ${item.arxivId} full text — ${err.message}`);
      }
    }
    try {
      /* Spaced from the previous call, not from the previous item: a cache hit
         costs nothing and should not be charged a pause. */
      const since = Date.now() - lastCall;
      if (called && since < MIN_GAP_MS) await wait(MIN_GAP_MS - since);
      lastCall = Date.now();
      const prompt = promptFor(item, full);
      let usedModel = model;
      let fields;
      try {
        fields = await callGemini(prompt, key, model);
      } catch (err) {
        /* Only for a busy model. A 400 is a request this account cannot make
           and asking a second model would fail the same way a second time; a
           429 is an allowance that belongs to the key, not to the model. */
        if (!FALLBACK_MODEL || FALLBACK_MODEL === model || !/HTTP 503/.test(err.message)) throw err;
        console.warn(`enrich: ${item.arxivId} — ${model} busy, asking ${FALLBACK_MODEL}`);
        fields = await callGemini(prompt, key, FALLBACK_MODEL);
        usedModel = FALLBACK_MODEL;
        fellBack++;
      }
      called++;
      if (fields) {
        /* The figure and the repository links are read off the paper, not
           generated, but they live in the same record — otherwise a cache hit
           tomorrow would render the brief without the picture it was written
           around, and re-fetching the HTML to recover them would undo the
           saving the cache exists for. */
        const named = fields.figure;
        const fig = resolveFigure(full, named);
        fields.figure = fig?.id || '';
        fields.figure_url = fig?.src || '';
        fields.figure_caption = fig?.caption || '';
        /* The gloss was written about the figure the model *named*. When that
           id did not match and resolveFigure fell back to the first figure, the
           gloss now describes a plot nobody is looking at, which is worse than
           no caption at all — so it is dropped and the author's own caption
           carries the card. */
        fields.figure_gloss = fig && fig.id === named ? fields.gloss : '';
        delete fields.gloss;
        fields.code = full?.code?.[0] || '';
        cache[item.arxivId] = {
          fields, seen: today, model: usedModel, shape: SHAPE,
          depth: full ? 'full' : 'abstract',
        };
      }
      out.push({ ...item, enrichment: fields });
    } catch (err) {
      failed++;
      console.warn(`enrich: ${item.arxivId} — ${err.message}`);
      out.push({ ...item, enrichment: null });
    }
  }
  console.log(`enrich: ${hits} cached, ${called} generated (${read} read in full` +
    `${fellBack ? `, ${fellBack} on ${FALLBACK_MODEL}` : ''}), ${failed} failed`);

  if (cachePath) {
    try {
      await fs.writeFile(cachePath, JSON.stringify(pruneCache(cache, today), null, 1) + '\n');
    } catch (err) {
      console.warn(`enrich: could not write ${cachePath} — ${err.message}`);
    }
  }
  return out;
}
