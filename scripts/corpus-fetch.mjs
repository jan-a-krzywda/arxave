/**
 * corpus-fetch — S1: the fixed corpus window, with citation counts.
 *
 * One job: every paper arXiv submitted to a category inside the window, and the
 * `cited_by_count` OpenAlex holds for it. Nothing here embeds, ranks or scores;
 * S2 samples this file and turns it into vectors.
 *
 * WHY THE WINDOW, NOT TONIGHT. The sieve ranks last night's papers against a
 * fixed set of older ones, so that "looks like papers that mattered" has
 * something to point at. The default window (2025-09-01 … 2025-12-31) is chosen
 * to be 10–14 months old: old enough that citations have settled, recent enough
 * that the vocabulary is still the reader's.
 *
 * WHY PER CATEGORY PER WEEK, AND PAGED. The search API caps one answer at
 * `max_results` and quietly truncates the rest, so a whole window in a single
 * query would come back short with nothing to show for it — the same silent
 * under-fetch `filter.js` measured on a single day. Slicing the window per
 * category per week keeps every answer small enough to be complete, and `start`
 * paging walks past the 2000-paper cap; a page shorter than the cap is the last
 * page. arXiv asks for one request every three seconds, so the wait is real,
 * injectable, and spent between calls.
 *
 * WHY `cat` IS THE QUERIED CATEGORY, NOT `primary_category`. The corpus buckets
 * `pct` by the paper's category, and a bucket of one paper would be a percentile
 * of exactly 0.5. The mandated Atom reader here is `parseAtom` (warm-dig.mjs),
 * which carries id, title, abstract and published and deliberately not the
 * category element; rather than re-parse the XML, a paper is filed under the
 * category whose query returned it. A cross-listed paper therefore sits in the
 * bucket of the first configured category that matched it, which is the same
 * first-match rule `fetchEarlier` and the page use for dedupe.
 *
 * Usage:
 *   node scripts/corpus-fetch.mjs --from 2025-09-01 --to 2025-12-31 \
 *     --categories quant-ph,cond-mat.mes-hall --out corpus-raw.json
 *
 * Flags:
 *   --from        first day of the window (YYYY-MM-DD, default 2025-09-01)
 *   --to          last day of the window  (YYYY-MM-DD, default 2025-12-31)
 *   --categories  comma-separated arXiv categories (default the sieve's two)
 *   --out         where to write corpus-raw.json (default corpus-raw.json)
 *   --help        print this and exit
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseAtom } from './warm-dig.mjs';

export const DEFAULT_FROM = '2025-09-01';
export const DEFAULT_TO = '2025-12-31';
export const DEFAULT_CATEGORIES = ['quant-ph', 'cond-mat.mes-hall'];

const ARXIV = 'https://export.arxiv.org/api/query';
const OPENALEX = 'https://api.openalex.org/works';

/* arXiv's own ceiling on one search page, and the stop condition for paging. */
export const ARXIV_PAGE = 2000;
/* arXiv's documented politeness: one request every three seconds. */
const ARXIV_WAIT_MS = 3000;
/* OpenAlex reads at most 50 DOIs per `filter=doi:a|b|…` request. */
const OPENALEX_BATCH = 50;
/* Total tries, not retries — the ladder llm.mjs uses: one attempt plus the two
   the contract allows on a 429 or a 5xx. */
const ATTEMPTS = 3;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const retryable = (status) => status === 429 || status >= 500;

/** '2025-09-01' → '20250901', for the submittedDate range. */
const compact = (day) => day.replace(/-/g, '');

/** A day string plus `n` calendar days, e.g. addDays('2025-09-29', 3) → '2025-10-02'. */
function addDays(day, n) {
  const d = new Date(day + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * `from`..`to` inclusive, chopped into 7-day slices; the last slice is clipped
 * to `to`. ISO day strings compare lexicographically, so no Date maths is needed
 * for the bounds.
 *
 * sliceWeeks('2025-09-01', '2025-09-20') →
 *   [{from:'2025-09-01',to:'2025-09-07'}, {from:'2025-09-08',to:'2025-09-14'},
 *    {from:'2025-09-15',to:'2025-09-20'}]
 */
export function sliceWeeks(from, to) {
  const slices = [];
  let cursor = from;
  while (cursor <= to) {
    const weekEnd = addDays(cursor, 6);
    const end = weekEnd < to ? weekEnd : to;
    slices.push({ from: cursor, to: end });
    cursor = addDays(end, 1);
  }
  return slices;
}

/**
 * `papers` → Map id → pct, each paper's citation percentile within its own
 * category, in [0,1], ties sharing the mean rank.
 *
 * The value is `(count(< v) + 0.5 × count(== v)) / m`, which is the mean-rank
 * percentile: for a group of tied values the mean of their ranks, rescaled to
 * [0,1]. A category of one paper gets 0.5 by construction, the same 0.5 the
 * scoring contract gives a lone candidate.
 */
export function percentiles(papers) {
  const byCat = new Map();
  for (const p of papers) {
    if (!byCat.has(p.cat)) byCat.set(p.cat, []);
    byCat.get(p.cat).push(p);
  }

  const out = new Map();
  for (const group of byCat.values()) {
    const sorted = [...group].sort((a, b) => a.cites - b.cites);
    const m = sorted.length;
    let i = 0;
    while (i < m) {
      let j = i;
      while (j < m && sorted[j].cites === sorted[i].cites) j += 1;
      const pct = (i + 0.5 * (j - i)) / m;
      for (let k = i; k < j; k += 1) out.set(sorted[k].id, pct);
      i = j;
    }
  }
  return out;
}

/** One arXiv search page: a category, a week, and a `start` offset. */
function arxivUrl(cat, slice, start) {
  const query = `cat:${cat} AND submittedDate:[${compact(slice.from)}0000 TO ${compact(slice.to)}2359]`;
  return `${ARXIV}?search_query=${encodeURIComponent(query)}` +
    `&start=${start}&max_results=${ARXIV_PAGE}` +
    '&sortBy=submittedDate&sortOrder=ascending';
}

/** `10.48550/arXiv.2509.01234`, the DOI arXiv mints for a paper. */
const arxivDoi = (id) => `10.48550/arXiv.${id}`;

/** OpenAlex spells DOIs as full URLs, lower-cased; ours are bare and mixed case. */
const normalizeDoi = (doi) => String(doi ?? '').trim()
  .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
  .replace(/^doi:/i, '')
  .toLowerCase();

/** One batch of DOIs → the OpenAlex works URL. `mailto` only when we have one. */
function openAlexUrl(ids, mailto) {
  const filter = ids.map((id) => `doi:${arxivDoi(id)}`).join('|');
  const params = [`filter=${filter}`, `per-page=${OPENALEX_BATCH}`, 'select=doi,cited_by_count'];
  if (mailto) params.push('mailto=' + encodeURIComponent(mailto));
  return `${OPENALEX}?${params.join('&')}`;
}

/**
 * One URL → an OK response, retrying a 429 or a 5xx up to `ATTEMPTS` tries. Any
 * other status, or the last try, throws with the source named so a failure in a
 * log says which service fell over.
 */
async function request(url, { fetchImpl, sleep, what }) {
  for (let attempt = 1; ; attempt += 1) {
    const resp = await fetchImpl(url);
    if (resp.ok) return resp;
    if (retryable(resp.status) && attempt < ATTEMPTS) {
      console.warn(`corpus-fetch: ${what} HTTP ${resp.status} — retrying ` +
                   `(${attempt}/${ATTEMPTS - 1})`);
      await sleep(ARXIV_WAIT_MS);
      continue;
    }
    throw new Error(`${what} HTTP ${resp.status}`);
  }
}

/** Every id's citation count from OpenAlex, batched 50 DOIs per request. */
async function fetchCitations(ids, { fetchImpl, sleep, env }) {
  const citeByDoi = new Map();
  const mailto = env?.OPENALEX_MAILTO;
  for (let i = 0; i < ids.length; i += OPENALEX_BATCH) {
    const batch = ids.slice(i, i + OPENALEX_BATCH);
    const resp = await request(openAlexUrl(batch, mailto),
      { fetchImpl, sleep, what: 'OpenAlex' });
    const data = await resp.json();
    let known = 0;
    for (const row of data?.results ?? []) {
      const key = normalizeDoi(row.doi);
      if (!key) continue;
      citeByDoi.set(key, Number.isFinite(row.cited_by_count) ? row.cited_by_count : 0);
      known += 1;
    }
    console.log(`corpus-fetch: OpenAlex ${i + batch.length}/${ids.length} → ${known} known`);
  }
  return citeByDoi;
}

/**
 * The corpus window → the `corpus-raw.json` object.
 *
 * All I/O sits behind `fetchImpl` and `sleep`, and the clock behind `now`, so
 * the tests pin the whole pipeline with a fake fetch and never touch a socket.
 * `to` is clipped to `now`: a window that reaches into the future has no papers
 * to find and would otherwise cost one request per empty week.
 */
export async function buildRaw({
  categories = DEFAULT_CATEGORIES,
  from = DEFAULT_FROM,
  to = DEFAULT_TO,
  fetchImpl = fetch,
  sleep = wait,
  now = new Date(),
  env = process.env,
} = {}) {
  const cap = (now instanceof Date ? now.toISOString() : String(now)).slice(0, 10);
  const end = to > cap ? cap : to;
  const slices = sliceWeeks(from, end);

  /* arXiv owns a global three-second budget, so the wait is spent between every
     pair of calls, whichever category or week they belong to. */
  let arxivCalls = 0;
  const arxivGet = async (url) => {
    if (arxivCalls > 0) await sleep(ARXIV_WAIT_MS);
    arxivCalls += 1;
    return request(url, { fetchImpl, sleep, what: 'arXiv' });
  };

  const seen = new Set();
  const papers = [];
  for (const cat of categories) {
    for (const slice of slices) {
      for (let start = 0; ; start += ARXIV_PAGE) {
        const resp = await arxivGet(arxivUrl(cat, slice, start));
        const page = parseAtom(await resp.text());
        let added = 0;
        for (const entry of page) {
          if (seen.has(entry.arxivId)) continue;
          seen.add(entry.arxivId);
          papers.push({ id: entry.arxivId, title: entry.title, abstract: entry.abstract, cat });
          added += 1;
        }
        console.log(`corpus-fetch: ${cat} ${slice.from}..${slice.to} start=${start} ` +
                    `→ ${page.length} listed, ${added} new`);
        if (page.length < ARXIV_PAGE) break;
      }
    }
  }

  const citeByDoi = await fetchCitations(papers.map((p) => p.id), { fetchImpl, sleep, env });
  /* Citations first, then percentiles: `pct` is a rank over `cites`, so it must
     read them off the papers, not off a parallel map. OpenAlex does not know
     every paper, and not knowing a paper is not the same as knowing it has no
     citations — the contract scores both as 0. */
  for (const p of papers) p.cites = citeByDoi.get(normalizeDoi(arxivDoi(p.id))) ?? 0;
  const pct = percentiles(papers);

  const out = papers
    .map((p) => ({
      id: p.id, title: p.title, abstract: p.abstract, cat: p.cat,
      cites: p.cites, pct: pct.get(p.id),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  console.log(`corpus-fetch: ${out.length} papers across ${categories.length} categories, ` +
              `${citeByDoi.size} known to OpenAlex`);
  return { window: { from, to: end }, categories, papers: out };
}

const USAGE = `corpus-fetch — fetch the sieve corpus window from arXiv and OpenAlex.

Usage:
  node scripts/corpus-fetch.mjs --from ${DEFAULT_FROM} --to ${DEFAULT_TO} \\
    --categories ${DEFAULT_CATEGORIES.join(',')} --out corpus-raw.json

Flags:
  --from        first day of the window (YYYY-MM-DD, default ${DEFAULT_FROM})
  --to          last day of the window  (YYYY-MM-DD, default ${DEFAULT_TO})
  --categories  comma-separated arXiv categories (default ${DEFAULT_CATEGORIES.join(',')})
  --out         where to write corpus-raw.json (default corpus-raw.json)
  --help        print this and exit`;

function arg(name, fallback = null) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(USAGE);
    return;
  }
  const categories = (arg('categories') ?? DEFAULT_CATEGORIES.join(','))
    .split(',').map((c) => c.trim()).filter(Boolean);
  if (categories.length === 0) {
    console.error('corpus-fetch: --categories is empty, e.g. --categories "quant-ph"');
    process.exit(2);
  }
  const from = arg('from', DEFAULT_FROM);
  const to = arg('to', DEFAULT_TO);
  const outFile = arg('out', 'corpus-raw.json');

  console.log(`corpus-fetch: ${from}..${to} for ${categories.join(', ')}`);
  const raw = await buildRaw({ categories, from, to });

  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await fs.writeFile(outFile, JSON.stringify(raw, null, 2) + '\n');
  console.log(`corpus-fetch: ${raw.papers.length} papers → ${outFile}`);
}

// Importable for tests; only the CLI invocation touches the network and disk.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('corpus-fetch: ' + (err?.stack ?? err));
    process.exit(1);
  });
}
