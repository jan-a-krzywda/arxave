/**
 * `node --test scripts/corpus-fetch.test.mjs`.
 *
 * Every expectation is hand-computed from `sieve2-spec.md` (the S1 contract) and
 * written out as a literal — the percentile fractions, the week slices and the
 * whole `corpus-raw.json` object — never read back from this file's own output.
 * Nothing touches the network: `fetchImpl` and `sleep` are both injected and the
 * Atom and OpenAlex bodies are built here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ARXIV_PAGE, arxivIdFromUrl, buildRaw, percentiles, sliceWeeks,
} from './corpus-fetch.mjs';

/* ── fixtures ──────────────────────────────────────────────────────────── */

function atom(entries) {
  return '<?xml version="1.0" encoding="UTF-8"?>' +
    '<feed xmlns="http://www.w3.org/2005/Atom">' + entries.join('') + '</feed>';
}

function entry({ id, title = 'Paper ' + id, summary = 'Abstract ' + id }) {
  return `<entry><id>http://arxiv.org/abs/${id}</id>` +
    '<published>2025-09-02T00:00:00Z</published>' +
    `<title>${title}</title><summary>${summary}</summary></entry>`;
}

const ok = (body, isJson) => ({
  ok: true, status: 200,
  text: async () => (isJson ? JSON.stringify(body) : body),
  json: async () => (isJson ? body : JSON.parse(body)),
});
const down = (status) => ({ ok: false, status, text: async () => '', json: async () => ({}) });

/** The OpenAlex row shape for one paper OpenAlex still keys by the arXiv DOI. */
const citeRow = (id, n) => ({ doi: `https://doi.org/10.48550/arxiv.${id}`, cited_by_count: n });

/* The real OpenAlex row for a preprint since published: the work's own DOI is
   the journal DOI, so only `locations` still name the arXiv id. Querying
   arXiv.2509.01234 came back with doi 10.1002/aidi.202500214 and
   cited_by_count 11. */
const PREPRINT_ROW = {
  doi: 'https://doi.org/10.1002/aidi.202500214',
  cited_by_count: 11,
  locations: [
    { landing_page_url: 'https://doi.org/10.1002/aidi.202500214' },
    { landing_page_url: 'http://arxiv.org/abs/2509.01234',
      pdf_url: 'https://arxiv.org/pdf/2509.01234' },
    { landing_page_url: 'https://doi.org/10.48550/arxiv.2509.01234' },
  ],
};

/** An arXiv-phase checkpoint as buildRaw writes it, for the resume tests. */
const checkpoint = (window, categories, papers) =>
  JSON.stringify({ window, categories, papers });

/** An in-memory `readFile`/`writeFile` pair over one `files` object. */
const memoryFs = (files) => ({
  readFile: async (file) => {
    if (!(file in files)) throw new Error(`ENOENT: ${file}`);
    return files[file];
  },
  writeFile: async (file, data) => { files[file] = data; },
});

const NOW = new Date('2026-01-01T00:00:00Z');

/* ── percentiles ───────────────────────────────────────────────────────── */

test('percentiles: pct per category, ties share the mean rank, all in [0,1]', () => {
  /* Five papers across two categories, with one tie. By hand:
       quant-ph  cites 0,5,5  m=3  → 0  ⇒ (0 + 0.5×1)/3 = 1/6
                                     5  ⇒ (1 + 0.5×2)/3 = 2/3   (both, by the tie)
       cond-mat  cites 2,8    m=2  → 2  ⇒ (0 + 0.5)/2     = 0.25
                                     8  ⇒ (1 + 0.5)/2     = 0.75                  */
  const pct = percentiles([
    { id: 'q1', cat: 'quant-ph', cites: 0 },
    { id: 'q2', cat: 'quant-ph', cites: 5 },
    { id: 'q3', cat: 'quant-ph', cites: 5 },
    { id: 'm1', cat: 'cond-mat.mes-hall', cites: 2 },
    { id: 'm2', cat: 'cond-mat.mes-hall', cites: 8 },
  ]);

  assert.equal(pct.get('q1'), 1 / 6);
  assert.equal(pct.get('q2'), 2 / 3);
  assert.equal(pct.get('q3'), 2 / 3); // the tie: both get the mean of ranks 2 and 3
  assert.equal(pct.get('m1'), 0.25);
  assert.equal(pct.get('m2'), 0.75);
  for (const value of pct.values()) assert.ok(value >= 0 && value <= 1, String(value));
});

test('percentiles: a category of one paper is 0.5, the lone-candidate value', () => {
  const pct = percentiles([{ id: 'solo', cat: 'quant-ph', cites: 99 }]);
  assert.equal(pct.get('solo'), 0.5);
});

/* ── sliceWeeks ────────────────────────────────────────────────────────── */

test('sliceWeeks cuts the window into 7-day slices and clips the last', () => {
  assert.deepEqual(sliceWeeks('2025-09-01', '2025-09-20'), [
    { from: '2025-09-01', to: '2025-09-07' },
    { from: '2025-09-08', to: '2025-09-14' },
    { from: '2025-09-15', to: '2025-09-20' }, // 09-21 clipped back to the window's end
  ]);
});

test('sliceWeeks handles a single day, an empty range, and a month boundary', () => {
  assert.deepEqual(sliceWeeks('2025-09-01', '2025-09-01'),
    [{ from: '2025-09-01', to: '2025-09-01' }]);
  assert.deepEqual(sliceWeeks('2025-09-10', '2025-09-01'), []);
  // Nine days: a full week then a two-day tail, across the month edge.
  assert.deepEqual(sliceWeeks('2025-09-29', '2025-10-07'), [
    { from: '2025-09-29', to: '2025-10-05' },
    { from: '2025-10-06', to: '2025-10-07' },
  ]);
});

/* ── arxivIdFromUrl ────────────────────────────────────────────────────── */

test('arxivIdFromUrl reads every arXiv location spelling, version-free', () => {
  assert.equal(arxivIdFromUrl('http://arxiv.org/abs/2509.01234'), '2509.01234');
  assert.equal(arxivIdFromUrl('https://arxiv.org/pdf/2509.01234v2'), '2509.01234');
  assert.equal(arxivIdFromUrl('https://arxiv.org/pdf/2509.01234.pdf'), '2509.01234');
  assert.equal(arxivIdFromUrl('https://doi.org/10.48550/arxiv.2509.01234'), '2509.01234');
  assert.equal(arxivIdFromUrl('https://doi.org/10.48550/ARXIV.2509.01234v1'), '2509.01234');
  // A published paper's journal DOI is not an arXiv id, nor is an empty value.
  assert.equal(arxivIdFromUrl('https://doi.org/10.1002/aidi.202500214'), null);
  assert.equal(arxivIdFromUrl(''), null);
  assert.equal(arxivIdFromUrl(undefined), null);
});

/* ── buildRaw ──────────────────────────────────────────────────────────── */

/* One week, two categories → two arXiv pages (one each, both short so paging
   stops), then one OpenAlex page for all five DOIs. */
const PAGES = {
  'quant-ph': [
    entry({ id: '2509.00001' }), entry({ id: '2509.00002' }), entry({ id: '2509.00003' }),
  ],
  'cond-mat.mes-hall': [entry({ id: '2509.00004' }), entry({ id: '2509.00005' })],
};

/* 2509.00001 is deliberately absent: OpenAlex does not know it. */
const CITED = [
  citeRow('2509.00002', 10), citeRow('2509.00003', 10),
  citeRow('2509.00004', 4), citeRow('2509.00005', 8),
];

test('buildRaw: a fake arXiv page and a fake OpenAlex page give the exact object', async () => {
  const urls = [];
  const slept = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    if (url.includes('export.arxiv.org')) {
      const cat = decodeURIComponent(url).match(/cat:([^\s&]+)/)[1];
      return ok(atom(PAGES[cat]));
    }
    return ok({ results: CITED }, true);
  };

  const raw = await buildRaw({
    categories: ['quant-ph', 'cond-mat.mes-hall'],
    from: '2025-09-01', to: '2025-09-07',
    now: NOW, fetchImpl, env: {}, sleep: async (ms) => { slept.push(ms); },
  });

  assert.deepEqual(raw, {
    window: { from: '2025-09-01', to: '2025-09-07' },
    categories: ['quant-ph', 'cond-mat.mes-hall'],
    papers: [
      { id: '2509.00001', title: 'Paper 2509.00001', abstract: 'Abstract 2509.00001',
        cat: 'quant-ph', cites: 0, pct: 1 / 6 },
      { id: '2509.00002', title: 'Paper 2509.00002', abstract: 'Abstract 2509.00002',
        cat: 'quant-ph', cites: 10, pct: 2 / 3 },
      { id: '2509.00003', title: 'Paper 2509.00003', abstract: 'Abstract 2509.00003',
        cat: 'quant-ph', cites: 10, pct: 2 / 3 },
      { id: '2509.00004', title: 'Paper 2509.00004', abstract: 'Abstract 2509.00004',
        cat: 'cond-mat.mes-hall', cites: 4, pct: 0.25 },
      { id: '2509.00005', title: 'Paper 2509.00005', abstract: 'Abstract 2509.00005',
        cat: 'cond-mat.mes-hall', cites: 8, pct: 0.75 },
    ],
  });

  // Two arXiv calls (one per category) with a 3 s wait between, one OpenAlex call.
  const arxiv = urls.filter((u) => u.includes('export.arxiv.org'));
  assert.equal(arxiv.length, 2);
  assert.equal(urls.filter((u) => u.includes('api.openalex.org')).length, 1);
  assert.deepEqual(slept, [3000]);

  // The query is the submittedDate range for the slice, paged from the start.
  const q = new URL(arxiv[0]);
  assert.equal(q.searchParams.get('search_query'),
    'cat:quant-ph AND submittedDate:[202509010000 TO 202509072359]');
  assert.equal(q.searchParams.get('start'), '0');
  assert.equal(q.searchParams.get('max_results'), String(ARXIV_PAGE));

  // OpenAlex is asked for the arXiv DOIs, 50 at a time, selecting three fields.
  const oa = new URL(urls.find((u) => u.includes('api.openalex.org')));
  assert.equal(oa.searchParams.get('filter'),
    'doi:10.48550/arXiv.2509.00001|10.48550/arXiv.2509.00002|' +
    '10.48550/arXiv.2509.00003|10.48550/arXiv.2509.00004|' +
    '10.48550/arXiv.2509.00005');
  assert.equal(oa.searchParams.get('per-page'), '50');
  assert.equal(oa.searchParams.get('select'), 'doi,cited_by_count,locations');
  assert.equal(oa.searchParams.get('mailto'), null); // env did not set one
});

test('buildRaw matches a published preprint by its arXiv location, not its DOI', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('export.arxiv.org')) return ok(atom([entry({ id: '2509.01234' })]));
    return ok({ results: [PREPRINT_ROW] }, true);
  };

  const raw = await buildRaw({
    categories: ['quant-ph'], from: '2025-09-01', to: '2025-09-07',
    now: NOW, fetchImpl, env: {}, sleep: async () => {},
  });

  // The work's own DOI is the journal DOI, so a DOI match would lose it; only the
  // locations name arXiv 2509.01234, and cited_by_count 11 lands on that paper.
  assert.deepEqual(raw.papers, [{
    id: '2509.01234', title: 'Paper 2509.01234', abstract: 'Abstract 2509.01234',
    cat: 'quant-ph', cites: 11, pct: 0.5,
  }]);
});

test('buildRaw reads an arXiv id from each location spelling, version-free', async () => {
  const rows = [
    { doi: 'https://doi.org/10.1002/x.1', cited_by_count: 1,
      locations: [{ landing_page_url: 'http://arxiv.org/abs/2509.00011v3' }] },
    { doi: 'https://doi.org/10.1002/x.2', cited_by_count: 2,
      locations: [{ landing_page_url: 'https://doi.org/10.1002/x.2' },
                  { pdf_url: 'https://arxiv.org/pdf/2509.00012v1.pdf' }] },
    { doi: 'https://doi.org/10.48550/ARXIV.2509.00013', cited_by_count: 3, locations: [] },
  ];
  const fetchImpl = async (url) => {
    if (url.includes('export.arxiv.org')) {
      return ok(atom([
        entry({ id: '2509.00011' }), entry({ id: '2509.00012' }), entry({ id: '2509.00013' }),
      ]));
    }
    return ok({ results: rows }, true);
  };

  const raw = await buildRaw({
    categories: ['quant-ph'], from: '2025-09-01', to: '2025-09-07',
    now: NOW, fetchImpl, env: {}, sleep: async () => {},
  });
  const cites = Object.fromEntries(raw.papers.map((p) => [p.id, p.cites]));
  assert.deepEqual(cites, {
    '2509.00011': 1, // landing_page_url, version suffix stripped
    '2509.00012': 2, // pdf_url, .pdf and version stripped
    '2509.00013': 3, // no locations: the doi fallback, case-insensitive
  });
});

test('buildRaw pages past a full page and stops on the first short page', async () => {
  // A full first page (exactly ARXIV_PAGE) is not the last page; the short
  // second page ends the walk. Two arXiv calls, then start=2000 never happens.
  const full = Array.from({ length: ARXIV_PAGE }, (_, i) =>
    entry({ id: `2509.${String(i).padStart(5, '0')}` }));
  const tail = [entry({ id: '2509.99998' }), entry({ id: '2509.99999' })];
  const arxivUrls = [];
  const fetchImpl = async (url) => {
    if (url.includes('export.arxiv.org')) {
      arxivUrls.push(url);
      const start = Number(new URL(url).searchParams.get('start'));
      return ok(atom(start === 0 ? full : tail));
    }
    return ok({ results: [] }, true); // OpenAlex: nothing known
  };

  const raw = await buildRaw({
    categories: ['quant-ph'], from: '2025-09-01', to: '2025-09-07',
    now: NOW, fetchImpl, env: {}, sleep: async () => {},
  });

  assert.equal(arxivUrls.length, 2);
  assert.equal(new URL(arxivUrls[0]).searchParams.get('start'), '0');
  assert.equal(new URL(arxivUrls[1]).searchParams.get('start'), String(ARXIV_PAGE));
  assert.equal(raw.papers.length, ARXIV_PAGE + tail.length);
  // Nothing is known to OpenAlex, so every paper scores 0 citations.
  assert.ok(raw.papers.every((p) => p.cites === 0));
});

test('buildRaw retries a 429 and then takes the page', async () => {
  let arxiv = 0;
  const slept = [];
  const fetchImpl = async (url) => {
    if (url.includes('export.arxiv.org')) {
      arxiv += 1;
      return arxiv === 1 ? down(429) : ok(atom([entry({ id: '2509.00001' })]));
    }
    return ok({ results: [] }, true);
  };

  const raw = await buildRaw({
    categories: ['quant-ph'], from: '2025-09-01', to: '2025-09-07',
    now: NOW, fetchImpl, env: {}, sleep: async (ms) => { slept.push(ms); },
  });

  assert.equal(arxiv, 2);
  assert.deepEqual(slept, [3000]); // one retry wait, then success
  assert.equal(raw.papers.length, 1);
});

test('buildRaw gives up after the retry ladder when the service stays down', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return down(503); };
  await assert.rejects(
    buildRaw({
      categories: ['quant-ph'], from: '2025-09-01', to: '2025-09-07',
      now: NOW, fetchImpl, env: {}, sleep: async () => {},
    }),
    /arXiv HTTP 503/);
  // Three total tries — one attempt plus two retries, the ladder llm.mjs uses.
  assert.equal(calls, 3);
});

test('OpenAlex gets a mailto only when the environment sets one', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    if (url.includes('export.arxiv.org')) return ok(atom([entry({ id: '2509.00001' })]));
    return ok({ results: [] }, true);
  };
  const base = {
    categories: ['quant-ph'], from: '2025-09-01', to: '2025-09-07',
    now: NOW, fetchImpl, sleep: async () => {},
  };

  await buildRaw({ ...base, env: {} });
  await buildRaw({ ...base, env: { OPENALEX_MAILTO: 'me@example.com' } });

  const openalex = urls.filter((u) => u.includes('api.openalex.org'));
  assert.equal(openalex.length, 2);
  assert.equal(new URL(openalex[0]).searchParams.get('mailto'), null);
  assert.equal(new URL(openalex[1]).searchParams.get('mailto'), 'me@example.com');
});

test('the window is clipped to `now` so no future week is fetched', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    if (url.includes('export.arxiv.org')) { urls.push(url); return ok(atom([])); }
    return ok({ results: [] }, true);
  };
  // `to` reaches into December, but "now" is the 3rd — only the first week runs.
  const raw = await buildRaw({
    categories: ['quant-ph'], from: '2025-09-01', to: '2025-12-31',
    now: new Date('2025-09-03T00:00:00Z'), fetchImpl, env: {}, sleep: async () => {},
  });
  assert.equal(urls.length, 1);
  assert.deepEqual(raw.window, { from: '2025-09-01', to: '2025-09-03' });
});

/* ── the arXiv checkpoint ──────────────────────────────────────────────── */

test('buildRaw writes the arXiv crawl to `<out>.arxiv.json`', async () => {
  const files = {};
  const fetchImpl = async (url) => {
    if (url.includes('export.arxiv.org')) return ok(atom(PAGES['quant-ph']));
    return ok({ results: [] }, true); // OpenAlex: nothing known
  };

  await buildRaw({
    categories: ['quant-ph'], from: '2025-09-01', to: '2025-09-07',
    out: 'corpus-raw.json', now: NOW, fetchImpl, env: {}, sleep: async () => {},
    ...memoryFs(files),
  });

  // Only the checkpoint is written here; main writes corpus-raw.json itself.
  assert.deepEqual(Object.keys(files), ['corpus-raw.json.arxiv.json']);
  assert.deepEqual(JSON.parse(files['corpus-raw.json.arxiv.json']), {
    window: { from: '2025-09-01', to: '2025-09-07' },
    categories: ['quant-ph'],
    papers: [
      { id: '2509.00001', title: 'Paper 2509.00001', abstract: 'Abstract 2509.00001',
        cat: 'quant-ph' },
      { id: '2509.00002', title: 'Paper 2509.00002', abstract: 'Abstract 2509.00002',
        cat: 'quant-ph' },
      { id: '2509.00003', title: 'Paper 2509.00003', abstract: 'Abstract 2509.00003',
        cat: 'quant-ph' },
    ],
  });
});

test('buildRaw reuses a matching checkpoint and skips the arXiv phase', async () => {
  const papers = [
    { id: '2509.00007', title: 'Paper 2509.00007', abstract: 'Abstract 2509.00007',
      cat: 'quant-ph' },
  ];
  const files = {
    'corpus-raw.json.arxiv.json': checkpoint(
      { from: '2025-09-01', to: '2025-09-07' }, ['quant-ph'], papers),
  };
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return ok({ results: [] }, true); // only OpenAlex is expected
  };

  const raw = await buildRaw({
    categories: ['quant-ph'], from: '2025-09-01', to: '2025-09-07',
    out: 'corpus-raw.json', now: NOW, fetchImpl, env: {}, sleep: async () => {},
    ...memoryFs(files),
  });

  // arXiv is never touched, and the reused paper flows through the OpenAlex and
  // percentile passes like a freshly crawled one.
  assert.equal(urls.filter((u) => u.includes('export.arxiv.org')).length, 0);
  assert.deepEqual(raw, {
    window: { from: '2025-09-01', to: '2025-09-07' },
    categories: ['quant-ph'],
    papers: [{ ...papers[0], cites: 0, pct: 0.5 }],
  });
});

test('buildRaw ignores a checkpoint whose window or categories differ', async () => {
  const files = {
    'corpus-raw.json.arxiv.json': checkpoint(
      { from: '2025-09-01', to: '2025-09-07' }, ['cond-mat.mes-hall'],
      [{ id: '2509.00009', title: 'Paper 2509.00009', abstract: 'Abstract 2509.00009',
         cat: 'cond-mat.mes-hall' }]),
  };
  const arxivUrls = [];
  const fetchImpl = async (url) => {
    if (url.includes('export.arxiv.org')) {
      arxivUrls.push(url);
      return ok(atom([entry({ id: '2509.00001' })]));
    }
    return ok({ results: [] }, true);
  };

  const raw = await buildRaw({
    categories: ['quant-ph'], from: '2025-09-01', to: '2025-09-07',
    out: 'corpus-raw.json', now: NOW, fetchImpl, env: {}, sleep: async () => {},
    ...memoryFs(files),
  });

  assert.equal(arxivUrls.length, 1); // different categories → refetched
  assert.deepEqual(raw.papers.map((p) => p.id), ['2509.00001']);
});

test('buildRaw with fresh ignores the checkpoint and refetches arXiv', async () => {
  const files = {
    'corpus-raw.json.arxiv.json': checkpoint(
      { from: '2025-09-01', to: '2025-09-07' }, ['quant-ph'],
      [{ id: '2509.00007', title: 'Paper 2509.00007', abstract: 'Abstract 2509.00007',
         cat: 'quant-ph' }]),
  };
  let reads = 0;
  const fetchImpl = async (url) => {
    if (url.includes('export.arxiv.org')) return ok(atom([entry({ id: '2509.00001' })]));
    return ok({ results: [] }, true);
  };

  const raw = await buildRaw({
    categories: ['quant-ph'], from: '2025-09-01', to: '2025-09-07',
    out: 'corpus-raw.json', fresh: true,
    now: NOW, fetchImpl, env: {}, sleep: async () => {},
    readFile: async (file) => { reads += 1; return files[file]; },
    writeFile: async (file, data) => { files[file] = data; },
  });

  assert.equal(reads, 0); // --fresh never even looks at the checkpoint
  assert.deepEqual(raw.papers.map((p) => p.id), ['2509.00001']);
  // and the stale checkpoint is overwritten from the fresh crawl
  assert.deepEqual(JSON.parse(files['corpus-raw.json.arxiv.json']).papers.map((p) => p.id),
    ['2509.00001']);
});
