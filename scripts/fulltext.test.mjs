/**
 * `node --test scripts/fulltext.test.mjs` (after `npm install` in this dir).
 *
 * These pin the trim, because the trim is what makes reading whole papers
 * affordable, and every way it can go wrong is silent: too little removed and
 * the bill grows, too much and the model briefs a paper it was shown the middle
 * of. The fixtures are LaTeXML's real spellings, taken from
 * arxiv.org/html/2608.23460 on 2026-08-25.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BUDGET, clip, decodeEntities, dropBackMatter, extractArticle, fetchFullText,
  parseCodeLinks, parseFigures, standaloneSvg, stripMath, toText,
} from './fulltext.mjs';

const BASE = 'https://arxiv.org/html/2608.23460v1';

test('MathML collapses to the LaTeX the author wrote', () => {
  // The whole economy of this file in one assertion: ~200 bytes of markup for
  // one symbol becomes the handful of characters that symbol was written as.
  const el = '<math id="m5" class="ltx_Math" alttext="\\mathcal{S}_{0}" display="inline">' +
    '<semantics><msub><mi>𝒮</mi><mn>0</mn></msub>' +
    '<annotation encoding="application/x-tex">\\mathcal{S}_{0}</annotation></semantics></math>';
  assert.equal(stripMath(`a ${el} b`).replace(/\s+/g, ' ').trim(), 'a $\\mathcal{S}_{0}$ b');
  assert.ok(stripMath(el).length < el.length / 4);
});

test('math with no alttext is removed rather than left as MathML', () => {
  assert.equal(stripMath('a <math><mi>x</mi></math> b').replace(/\s+/g, ' '), 'a b');
});

test('entities decode, and &amp; decodes last', () => {
  // Decoding &amp; first would turn the encoded text "&amp;lt;" into a real
  // "<", which is how an escaped abstract becomes broken markup downstream.
  assert.equal(decodeEntities('&amp;lt;'), '&lt;');
  assert.equal(decodeEntities('&#8722;1 &#x3b1; &quot;q&quot;'), '−1 α "q"');
});

test('the site furniture is dropped, the paper is kept', () => {
  const html = '<div class="ltx_page_navbar">Report GitHub Issue Back to arXiv</div>' +
    '<article class="ltx_document"><section id="S1">Introduction</section></article>' +
    '<footer>arXiv</footer>';
  const got = toText(extractArticle(html));
  assert.match(got, /Introduction/);
  assert.doesNotMatch(got, /Report GitHub Issue/);
  assert.doesNotMatch(got, /^arXiv$/m);
});

test('a page with no article wrapper degrades to the whole page', () => {
  assert.equal(extractArticle('<div>no wrapper</div>'), '<div>no wrapper</div>');
});

test('bibliography and appendices go, body sections stay', () => {
  const html =
    '<section id="S1" class="ltx_section">body</section>' +
    '<section id="bib" class="ltx_bibliography">Smith et al.</section>' +
    '<section id="A1" class="ltx_appendix">proof</section>';
  const got = toText(dropBackMatter(html));
  assert.match(got, /body/);
  assert.doesNotMatch(got, /Smith et al/);
  assert.doesNotMatch(got, /proof/);
});

/* Figures. Two spellings and one nesting trap, all three of which silently cost
   figures rather than throwing — and a missing figure is invisible in a feed
   that renders it only when present. */

test('a raster figure is found, with an absolute url and its caption', () => {
  const [fig] = parseFigures(
    '<figure id="S2.F1" class="ltx_figure"><img src="2608.23460v1/overview.png">' +
    '<figcaption><span class="ltx_tag">Figure 1: </span>Overview of the framework.</figcaption>' +
    '</figure>', BASE);
  assert.equal(fig.id, 'S2.F1');
  assert.equal(fig.src, 'https://arxiv.org/html/2608.23460v1/overview.png');
  assert.equal(fig.caption, 'Figure 1: Overview of the framework.');
});

test('a vector figure is an <object data>, not an <img>, and still counts', () => {
  // LaTeXML emits SVG as <object type="image/svg+xml" data>. Matching only
  // <img src> dropped every plot in a plots-heavy paper and reported success.
  const [fig] = parseFigures(
    '<figure id="S7.F3"><object type="image/svg+xml" data="2608.23460v1/phase.svg"></object>' +
    '<figcaption>Figure 3: Phase transition.</figcaption></figure>', BASE);
  assert.equal(fig.src, 'https://arxiv.org/html/2608.23460v1/phase.svg');
});

test('a multi-panel figure yields the outer figure once, not its panels', () => {
  // The nesting trap: matched non-greedily, the outer figure ends inside its
  // first panel and its own </figure> is then read as opening the next one.
  const figs = parseFigures(
    '<figure id="S8.F5"><figure class="ltx_figure_panel"><img src="a.png"></figure>' +
    '<figure class="ltx_figure_panel"><img src="b.png"></figure>' +
    '<figcaption>Figure 5: Two panels.</figcaption></figure>' +
    '<figure id="S9.F6"><img src="c.png"><figcaption>Figure 6: After.</figcaption></figure>',
    BASE);
  assert.deepEqual(figs.map((f) => f.id), ['S8.F5', 'S9.F6']);
  assert.match(figs[0].src, /a\.png$/);
  assert.match(figs[1].src, /c\.png$/);
});

test('a figure with nothing to show is skipped rather than shipped empty', () => {
  assert.deepEqual(parseFigures('<figure id="S1.F1"><figcaption>c</figcaption></figure>', BASE), []);
});

test('math in a caption becomes LaTeX, not MathML', () => {
  const [fig] = parseFigures(
    '<figure id="S1.F1"><img src="a.png"><figcaption>Figure 1: ' +
    '<math alttext="[\\![n,k,3]\\!]"><mi>n</mi></math> codes.</figcaption></figure>', BASE);
  assert.equal(fig.caption, 'Figure 1: $[\\![n,k,3]\\!]$ codes.');
});

test('repository links are picked out, deduped, and stripped of trailing punctuation', () => {
  const links = parseCodeLinks(
    'Code at https://github.com/x/y. See also https://github.com/x/y and ' +
    'https://zenodo.org/records/123, but not https://arxiv.org/abs/1 ' +
    'or https://doi.org/10.1/2');
  assert.deepEqual(links, ['https://github.com/x/y', 'https://zenodo.org/records/123']);
});

test('the clip keeps the head and the tail, and drops the middle', () => {
  // The introduction states the question and the prior work; the conclusion
  // states the limits. The derivations in between are what the budget buys.
  const text = 'HEAD' + 'x'.repeat(500) + 'TAIL';
  const got = clip(text, 100);
  assert.ok(got.startsWith('HEAD'));
  assert.ok(got.endsWith('TAIL'));
  assert.ok(got.includes('omitted'));
  assert.ok(got.length < text.length);
});

test('a short paper is not clipped at all', () => {
  assert.equal(clip('short', 100), 'short');
});

/* One live call. Skipped without ARXAVE_NET=1, because a unit suite that needs
   arxiv.org is a suite that fails on a plane — but the shapes above are all
   copied from the real document, and this is what says they still match it. */
test('the real thing, when asked for it', { skip: !process.env.ARXAVE_NET }, async () => {
  const got = await fetchFullText('2608.23460');
  assert.ok(got, 'this paper has an HTML rendering');
  assert.ok(got.text.length <= BUDGET);
  assert.ok(got.text.startsWith('Satisfying Quantum Codes'), 'starts at the title');
  assert.ok(got.figures.length >= 5, 'finds the SVG figures too');
  assert.ok(got.figures.every((f) => f.src.startsWith('https://arxiv.org/html/')));
});

test('a paper with no HTML rendering is null, not a throw', async () => {
  const notFound = async () => ({ status: 404, ok: false });
  assert.equal(await fetchFullText('1234.5678', { fetchImpl: notFound }), null);
});

test('a conversion-failure stub is treated as absent, not briefed as the paper', async () => {
  // LaTeXML serves a page of apology with a 200. Briefed, it would be summarized
  // as if it were the paper's content.
  const stub = async () => ({
    status: 200, ok: true, url: BASE,
    text: async () => '<html><body><p>HTML is not available for this paper.</p></body></html>',
  });
  assert.equal(await fetchFullText('1234.5678', { fetchImpl: stub }), null);
});

test('a network failure is null, not a thrown feed', async () => {
  const boom = async () => { throw new Error('ETIMEDOUT'); };
  assert.equal(await fetchFullText('1234.5678', { fetchImpl: boom }), null);
});

test('a TikZ picture drawn into the page is a figure, not a miss', () => {
  // 2608.26272's only figure, in LaTeXML's third spelling: no <img> and no
  // <object>, just the drawing, inline. Reading only the first two is why
  // every diagram in a theory paper went missing.
  const html = '<figure id="S0.F1" class="ltx_figure">' +
    '<svg id="S0.F1.pic1" class="ltx_picture" viewBox="0 0 182 202">' +
    '<g><path d="M 0 0 L 158 0"></path></g></svg>' +
    '<figcaption>Figure 1: The overhead, against $K$.</figcaption></figure>';
  const [fig] = parseFigures(html, BASE);
  assert.equal(fig.id, 'S0.F1');
  assert.equal(fig.src, '');
  assert.ok(fig.svg.startsWith('<svg') && fig.svg.endsWith('</svg>'));
  assert.equal(fig.caption, 'Figure 1: The overhead, against $K$.');
});

test('a hotlinkable figure is never mirrored', () => {
  // Both spellings in one block: the file wins, because a URL costs nothing to
  // carry and a copy costs a file in the repository.
  const html = '<figure id="S2.F1"><img src="x1.png"/><svg><g/></svg></figure>';
  const [fig] = parseFigures(html, BASE);
  assert.equal(fig.src, 'https://arxiv.org/html/x1.png');
  assert.equal(fig.svg, '');
});

test('a nested picture is taken whole', () => {
  // The same trap the figure scan has: a non-greedy match to the first </svg>
  // hands back markup that no longer closes.
  const block = '<figure id="S1.F1"><svg id="a"><svg id="b"><g/></svg><g/></svg></figure>';
  const [fig] = parseFigures(block, BASE);
  assert.equal(fig.svg, '<svg id="a"><svg id="b"><g/></svg><g/></svg>');
});

test('a mirrored picture declares the three namespaces it needs', () => {
  // In a .svg file every one of these is parsed as XML: an element with no
  // namespace is not SVG, not XHTML and not MathML, and the file renders as an
  // empty box.
  const svg = '<svg viewBox="0 0 10 10"><foreignObject><span class="ltx_p">' +
    '<math><mi>K</mi></math></span></foreignObject></svg>';
  const out = standaloneSvg(svg);
  assert.match(out, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(out, /<span xmlns="http:\/\/www\.w3\.org\/1999\/xhtml" class="ltx_p">/);
  assert.match(out, /<math xmlns="http:\/\/www\.w3\.org\/1998\/Math\/MathML">/);
});

test('namespaces a converter already wrote are not doubled', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><math xmlns="http://www.w3.org/1998/Math/MathML"/></svg>';
  const out = standaloneSvg(svg);
  assert.equal((out.match(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g) || []).length, 1);
  assert.equal((out.match(/xmlns="http:\/\/www\.w3\.org\/1998\/Math\/MathML"/g) || []).length, 1);
});
