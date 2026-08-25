/**
 * fulltext — the paper itself, trimmed to what a briefing can actually use.
 *
 * The enricher used to see abstracts only, and the two fields that most decide
 * whether a paper is worth an evening — what the number really is, and what it
 * was measured under — are the two an abstract is written to soften. So for the
 * papers that clear the top band, this fetches arXiv's own HTML rendering and
 * hands back a trimmed transcript plus the figures.
 *
 * WHY arXiv HTML AND NOT THE PDF OR THE SOURCE TARBALL. `arxiv.org/html/<id>`
 * is LaTeXML's rendering, served for anything submitted as LaTeX since late
 * 2023, and it needs no PDF layer and no tar extraction — a plain fetch and
 * some regex. It is also the same document the figures live in, so `<img src>`
 * resolves against it and a figure costs nothing beyond the URL. The Python
 * side already pulls e-print tarballs for bibliographies (src/arxave/
 * arxiv_bib.py); this deliberately does not reach for that, because a second
 * consumer of the tarball is a second thing to keep working.
 *
 * NOT EVERY PAPER HAS ONE. Word submissions, PDF-only submissions and anything
 * whose LaTeX failed to convert return 404. That is not an error here — it is
 * the abstract tier, which is what every paper got before this file existed.
 *
 * THE TRIM IS THE WHOLE POINT. A rendered paper is ~600 KB, and the great
 * majority of that is MathML: every symbol expands to a couple of hundred bytes
 * of <semantics><msub>… wrapping one character. Sending it raw would turn a
 * few-cents-a-day job into a real bill for no added signal, because the LaTeX
 * source of each symbol is already sitting in the `alttext` attribute. So:
 * bibliography and appendices go, MathML collapses to its alttext, tags go, and
 * what is left is clipped head-and-tail — the introduction and the conclusion,
 * which is where the question and the limits are stated, rather than the middle
 * where the derivations are. Measured on 2608.23460: 602 KB → ~21 KB.
 */

const HTML_BASE = 'https://arxiv.org/html/';
const TIMEOUT_MS = 30_000;
const UA = 'arxave-feed/0.1 (+https://github.com/jan-a-krzywda/arxave)';

/* The budget, in characters of trimmed prose. ~24k is about 6k tokens, which at
   a handful of top-band papers a day is small change, and it comfortably holds
   an introduction and a conclusion for every paper measured. */
export const BUDGET = 24_000;
/* Split head-heavy: the introduction states the question and the prior work,
   which is two of the six fields, where the conclusion mostly restates. */
const HEAD_SHARE = 0.6;
const ELLIPSIS = '\n\n[… middle of the paper omitted …]\n\n';

/** Where a repository link is worth believing. Anything else is a citation. */
const CODE_HOSTS = /https?:\/\/(?:www\.)?(?:github\.com|gitlab\.com|zenodo\.org|codeberg\.org|bitbucket\.org)\/[^\s"'<>)\]]+/gi;

/**
 * MathML → the LaTeX the author wrote.
 *
 * `alttext` is on the outer <math>, so this replaces the whole element with it
 * rather than descending. Falls back to empty rather than to the MathML when
 * there is no alttext, because the MathML is the thing being removed.
 */
export function stripMath(html) {
  return html.replace(/<math\b[^>]*?>[\s\S]*?<\/math>/gi, (el) => {
    const alt = el.match(/\balttext="([^"]*)"/i);
    return alt ? ` $${decodeEntities(alt[1])}$ ` : ' ';
  });
}

/** The handful of entities LaTeXML emits. Not a general HTML decoder. */
export function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&');       // last, so &amp;lt; does not become <
}

/** Tags out, whitespace collapsed the way every other text field here is. */
export function toText(html) {
  return decodeEntities(
    html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<\/(p|div|section|h[1-6]|li|figcaption)>/gi, '\n')
        .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

/**
 * The figures, in document order, with absolute image URLs.
 *
 * The id is LaTeXML's — "S2.F1" for the first figure of section 2 — and it is
 * what the model is asked to name when it picks one, so ids and captions travel
 * together. Figures with no <img> (a table dressed as a figure, a TikZ picture
 * that failed to convert) are dropped: there is nothing to show.
 */
export function parseFigures(html, base) {
  const out = [];
  const tags = [...html.matchAll(/<(\/?)figure\b([^>]*)>/gi)];
  for (let i = 0; i < tags.length; i++) {
    if (tags[i][1]) continue;                       // a close tag
    const id = tags[i][2].match(/\bid="([^"]+)"/i);
    if (!id) continue;
    /* Multi-panel figures nest: one outer <figure id="S7.F3"> holding a
       <figure> per panel. A non-greedy match to the first </figure> would end
       inside the first panel and, worse, leave the outer figure's own close tag
       to be read as the start of the next one — which is how three of this
       paper's five figures went missing before the depth count below. */
    let depth = 1;
    let j = i + 1;
    for (; j < tags.length && depth > 0; j++) depth += tags[j][1] ? -1 : 1;
    const end = depth === 0 ? tags[j - 1].index + tags[j - 1][0].length : html.length;
    const block = html.slice(tags[i].index, end);
    /* LaTeXML emits a raster figure as <img src> and a vector one as
       <object type="image/svg+xml" data>. Missing the second spelling silently
       dropped every SVG figure — which in a plots-heavy paper is most of
       them. */
    const src = block.match(/<img\b[^>]*\bsrc="([^"]+)"/i)
      || block.match(/<object\b[^>]*\bdata="([^"]+\.svgz?)"/i);
    if (src) {
      const cap = block.match(/<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/i);
      out.push({
        id: id[1],
        src: new URL(decodeEntities(src[1]), base).href,
        caption: cap ? toText(stripMath(cap[1])).replace(/\s+/g, ' ').trim() : '',
      });
    }
    i = j - 2 >= i ? j - 2 : i;                     // skip the panels just consumed
  }
  return out;
}

/** Every repository link the paper offers, deduped, first one first. */
export function parseCodeLinks(text) {
  const seen = new Set();
  for (const raw of text.match(CODE_HOSTS) || []) {
    const url = raw.replace(/[.,;)]+$/, '');
    if (!seen.has(url)) seen.add(url);
  }
  return [...seen];
}

/**
 * The paper, without arXiv's furniture around it.
 *
 * LaTeXML wraps the document in <article class="ltx_document">; everything
 * before it is the site header, the "Report GitHub Issue" dialog and the table
 * of contents. None of that is the paper, and left in it eats the head of the
 * budget — which is the half the introduction lives in. Falls back to the whole
 * page when the wrapper is missing, so a layout change degrades rather than
 * blanks.
 */
export function extractArticle(html) {
  const open = html.search(/<article\b[^>]*class="[^"]*ltx_document/i);
  if (open < 0) return html;
  const close = html.lastIndexOf('</article>');
  return close > open ? html.slice(open, close) : html.slice(open);
}

/**
 * Bibliography and appendices out — they are half the file and none of the
 * briefing. Both are marked by LaTeXML with a class, not only by a heading, so
 * this does not depend on what the authors called their sections.
 */
export function dropBackMatter(html) {
  return html
    .replace(/<section\b[^>]*class="[^"]*ltx_bibliography[^"]*"[\s\S]*?<\/section>/gi, ' ')
    .replace(/<section\b[^>]*class="[^"]*ltx_appendix[^"]*"[\s\S]*?<\/section>/gi, ' ')
    .replace(/<div\b[^>]*class="[^"]*ltx_bibliography[^"]*"[\s\S]*?<\/div>/gi, ' ');
}

/** Head and tail of the paper, with the derivations in between dropped. */
export function clip(text, budget = BUDGET) {
  if (text.length <= budget) return text;
  /* The marker comes out of the budget rather than being added to it: `budget`
     is what gets sent, and a cap that is quietly exceeded by a constant is not
     a cap. */
  const room = Math.max(0, budget - ELLIPSIS.length);
  const head = Math.floor(room * HEAD_SHARE);
  return text.slice(0, head) + ELLIPSIS + text.slice(text.length - (room - head));
}

/**
 * One paper's HTML → { text, figures, code } — or null when there is none.
 *
 * Null is the ordinary case for a PDF-only submission, not a failure worth
 * reporting: every caller falls back to the abstract tier. A network error is
 * logged, because a run where *every* paper is suddenly abstract-only means
 * arXiv changed something, and that should not be silent.
 */
export async function fetchFullText(arxivId, { budget = BUDGET, fetchImpl = fetch } = {}) {
  const url = HTML_BASE + encodeURIComponent(arxivId);
  let resp;
  try {
    resp = await fetchImpl(url, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    console.warn(`fulltext: ${arxivId} — ${err.message}`);
    return null;
  }
  if (resp.status === 404) return null;          // no HTML rendering; expected
  if (!resp.ok) {
    console.warn(`fulltext: ${arxivId} — HTTP ${resp.status}`);
    return null;
  }
  const html = await resp.text();
  /* LaTeXML sometimes serves a stub page saying conversion failed. It parses
     as HTML and yields a page of apology, which would be briefed as if it were
     the paper — so a document with no sections at all is treated as absent. */
  if (!/<section\b/i.test(html)) return null;

  const body = dropBackMatter(extractArticle(html));
  const figures = parseFigures(body, resp.url || url);
  const text = clip(toText(stripMath(body)), budget);
  return { text, figures, code: parseCodeLinks(text) };
}
