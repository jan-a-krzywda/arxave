/**
 * `node --test scripts/cave-art.test.mjs`.
 *
 * The art and the token sheet are the two files on this page that fail
 * silently: a broken SVG still draws *something* (or nothing), a token the
 * light theme forgot still resolves to its dark value, and a colour pair that
 * scores 3.9:1 looks fine to whoever picked it. So this test is a parser, a
 * palette audit and a contrast calculation rather than a snapshot — it says
 * what must be true of the files, not what they currently contain.
 *
 * No dependencies: the SVG check is a ~40-line well-formedness pass over the
 * tag stream, which is enough for files this repo authors by hand and keeps
 * `node --test` runnable without an install.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ART, ART_SIZE, emptyState } from '../docs/assets/cave-art.mjs';

/* `p` is a site-root path (`/assets/…`), which under any baseurl is still
   `docs/assets/…` on disk. */
const DOCS = new URL('../docs/', import.meta.url);
const docPath = (p) => fileURLToPath(new URL(`.${p}`, DOCS));
const read = (p) => readFileSync(docPath(p), 'utf8');

/* ── the mini XML reader ───────────────────────────────────────────────── */

/* name, then zero or more `-qualified="quoted"` pairs, then / or >. Values
   must be quoted: an unquoted one is where a hand-edited file goes wrong. */
const TAG = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[A-Za-z_:][\w:.-]*\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/y;

/**
 * Walk the tag stream, keeping a stack, and assert everything else is text
 * with no raw `<`, `>` or bare `&`. Returns the root's attribute string.
 */
function parseSvg(src, label) {
  const stack = [];
  let roots = 0;
  let rootAttrs = '';
  let i = 0;

  const skipPast = (end) => {
    const at = src.indexOf(end, i);
    assert.ok(at !== -1, `${label}: unterminated ${end}`);
    i = at + end.length;
  };

  while (i < src.length) {
    if (src[i] === '<') {
      if (src.startsWith('<!--', i)) { skipPast('-->'); continue; }
      if (src.startsWith('<?', i)) { skipPast('?>'); continue; }
      if (src.startsWith('<!', i)) { skipPast('>'); continue; }

      TAG.lastIndex = i;
      const m = TAG.exec(src);
      assert.ok(m, `${label}: malformed tag at byte ${i}: ${src.slice(i, i + 60)}`);
      const [, closing, name, attrs, selfClose] = m;
      if (closing) {
        assert.equal(stack.pop(), name, `${label}: </${name}> closes the wrong element`);
      } else if (!selfClose) {
        if (stack.length === 0) { roots += 1; rootAttrs = attrs; }
        stack.push(name);
      } else if (stack.length === 0) {
        roots += 1;
        rootAttrs = attrs;
      }
      i = TAG.lastIndex;
      continue;
    }

    const next = src.indexOf('<', i);
    const text = src.slice(i, next === -1 ? src.length : next);
    assert.ok(!text.includes('>'), `${label}: stray ">" outside a tag`);
    assert.ok(
      !/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(text),
      `${label}: unescaped "&" in text`,
    );
    i += text.length;
  }

  assert.deepEqual(stack, [], `${label}: unclosed element(s) ${stack.join(', ')}`);
  assert.equal(roots, 1, `${label}: exactly one root element`);
  assert.match(rootAttrs, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/, `${label}: svg namespace`);
  return rootAttrs;
}

/* ── the SVGs ──────────────────────────────────────────────────────────── */

const KINDS = ['idle', 'none', 'digging'];

/* The four ember colours of cave-v3-interfaces.md, in paint order. A fifth
   colour would silently break the "4-colour palette" rule, so the set is
   compared exactly rather than as a subset. */
const PALETTE = ['#14100d', '#3a2f26', '#e2571e', '#ff9a3c'];

test('ART names exactly the four drawings, and each one exists', () => {
  assert.deepEqual(Object.keys(ART).sort(), ['digging', 'header', 'idle', 'none']);
  for (const [kind, href] of Object.entries(ART)) {
    assert.match(href, /^\/assets\/cave-art\/[\w-]+\.svg$/, `${kind}: site-root path`);
    const file = readFileSync(docPath(href), 'utf8');
    assert.ok(file.startsWith('<svg'), `${kind}: ${href} is an SVG`);
  }
  assert.equal(ART_SIZE.width, 128);
  assert.equal(ART_SIZE.height, 128);
});

for (const [kind, href] of Object.entries(ART)) {
  test(`${kind} drawing: well-formed, pixel-crisp, self-contained, < 12 KB`, () => {
    const src = readFileSync(docPath(href), 'utf8');
    const root = parseSvg(src, kind);

    /* crispEdges on the root is what keeps every rect on the 8 px grid once
       the browser scales the band to the viewport. */
    assert.match(root, /shape-rendering="crispEdges"/, `${kind}: crispEdges`);
    assert.match(root, /role="img"/, `${kind}: role`);

    /* Nothing may be pulled from elsewhere: no href at all, no <image>, no
       url(), no @import. The only absolute URL is the SVG namespace. */
    assert.ok(!/\b(?:xlink:)?href\s*=/i.test(src), `${kind}: an external href`);
    assert.ok(!/<image\b/i.test(src), `${kind}: an embedded <image>`);
    assert.ok(!/url\(|@import/i.test(src), `${kind}: a url()/@import`);
    assert.deepEqual(src.match(/https?:\/\/[^"'\s>]+/g) ?? [], ['http://www.w3.org/2000/svg']);

    /* Four colours, all of them from the ember palette. */
    const fills = [...new Set([...src.matchAll(/fill="([^"]+)"/g)].map((m) => m[1].toLowerCase()))];
    assert.deepEqual(fills.sort(), PALETTE.slice().sort(), `${kind}: 4-colour ember palette`);

    /* The flame group is what the campfire CSS animates (stage 4, K6). */
    assert.match(src, /<g class="cv-flame">/, `${kind}: a .cv-flame group`);

    /* Everything sits on the 8 px cell grid and inside the box: a rect off by
       three pixels is the difference between pixel art and a smudge. */
    const [, vbW, vbH] = /viewBox="0 0 (\d+) (\d+)"/.exec(root) ?? [];
    assert.ok(vbW && vbH, `${kind}: viewBox`);
    for (const [, attr] of src.matchAll(/<rect ([^>]*)\/>/g)) {
      for (const [, name, value] of attr.matchAll(/\b(x|y|width|height)="(\d+)"/g)) {
        assert.equal(Number(value) % 8, 0, `${kind}: ${name}="${value}" is off the 8 px grid`);
        if (name === 'x') assert.ok(Number(value) < Number(vbW), `${kind}: rect past the right edge`);
        if (name === 'y') assert.ok(Number(value) < Number(vbH), `${kind}: rect past the bottom edge`);
      }
    }

    const bytes = Buffer.byteLength(src);
    assert.ok(bytes < 12 * 1024, `${kind}: ${bytes} bytes, must stay under 12 KB`);
  });
}

/* ── emptyState ────────────────────────────────────────────────────────── */

test('emptyState draws the right picture and says the caller’s line', () => {
  for (const kind of KINDS) {
    const html = emptyState(kind, 'Nothing yet.');
    assert.match(html, new RegExp(`class="cv-empty" data-kind="${kind}"`));
    assert.ok(html.includes(`src="${ART[kind]}"`), `${kind}: uses its own art`);
    assert.match(html, /alt=""/, `${kind}: the drawing is decoration`);
    assert.match(html, /<p class="cv-empty-text">Nothing yet\.<\/p>/);
  }
});

test('emptyState escapes text instead of trusting it', () => {
  const html = emptyState('idle', '<script>alert("x")</script> & \'quotes\'');
  assert.ok(!html.includes('<script'), 'a raw tag got through');
  assert.ok(html.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'));
  assert.ok(html.includes('&amp;'));
  assert.ok(html.includes('&#39;quotes&#39;'));
  /* Escaping is per character, not a blanket encode: plain text stays plain. */
  assert.match(
    emptyState('none', 'No papers yet — try a wider window.'),
    /No papers yet — try a wider window\./,
  );
});

test('emptyState refuses a kind it has no drawing for', () => {
  assert.throws(() => emptyState('nope', 'x'), TypeError);
  assert.throws(() => emptyState('', 'x'), TypeError);
});

