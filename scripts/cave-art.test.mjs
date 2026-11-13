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

    /* The flame group is what cave-tokens.css animates. */
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


/* ── the token sheet ───────────────────────────────────────────────────── */

const css = read('/assets/cave-tokens.css').replace(/\/\*[\s\S]*?\*\//g, '');

/* Every token the contract names. Nine of them, and each must exist in all
   three blocks: dark `:root`, the system-preference light block, and the
   explicit [data-theme="light"] override. */
const TOKENS = [
  '--cv-bg', '--cv-surface', '--cv-surface-2', '--cv-line',
  '--cv-text', '--cv-muted', '--cv-fire', '--cv-ember', '--cv-glow',
];

/* The values the contract fixes. Anything else (--cv-on-fire, the type scale)
   is this card's to choose; these are not. */
const DARK_FIXED = {
  '--cv-bg': '#14100d',
  '--cv-surface': '#1c1713',
  '--cv-surface-2': '#251e18',
  '--cv-line': '#3a2f26',
  '--cv-text': '#efe4d4',
  '--cv-muted': '#a8987f',
  '--cv-fire': '#ff9a3c',
  '--cv-ember': '#e2571e',
  '--cv-glow': 'rgba(255, 154, 60, 0.18)',
};

const LIGHT_FIXED = {
  '--cv-bg': '#f5ecdf',
  '--cv-surface': '#fffaf1',
  '--cv-text': '#2a2018',
  '--cv-fire': '#c2570a',
};

/* the block body a selector opens, found by brace matching */
function blockAfter(pattern) {
  const m = pattern.exec(css);
  assert.ok(m, `cave-tokens.css: no rule matching ${pattern}`);
  const open = css.indexOf('{', m.index + m[0].length - 1);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return { text: css.slice(open + 1, i), body: css.slice(m.index, i + 1) };
    }
  }
  throw new Error(`cave-tokens.css: unbalanced braces after ${pattern}`);
}

const tokensIn = (text) => new Map(
  [...text.matchAll(/(--cv-[\w-]+)\s*:\s*([^;}]+)/g)].map((m) => [m[1], m[2].trim()]),
);

const darkBlock = blockAfter(/:root\s*\{/);
const lightMedia = blockAfter(/@media\s*\(prefers-color-scheme:\s*light\)\s*\{/);
const lightAttr = blockAfter(/\[data-theme=["']light["']\]\s*\{/);

const dark = tokensIn(darkBlock.text);
const lightA = tokensIn(lightMedia.text);
const lightB = tokensIn(lightAttr.text);

test('every contract token is defined in the dark theme', () => {
  for (const name of TOKENS) assert.ok(dark.has(name), `dark: missing ${name}`);
  assert.deepEqual(Object.fromEntries(TOKENS.map((k) => [k, dark.get(k)])), DARK_FIXED);
});

test('every contract token is defined in both light-theme blocks', () => {
  for (const [label, theme] of [['prefers-color-scheme', lightA], ['[data-theme=light]', lightB]]) {
    for (const name of TOKENS) assert.ok(theme.has(name), `${label}: missing ${name}`);
    for (const [name, value] of Object.entries(LIGHT_FIXED)) {
      assert.equal(theme.get(name), value, `${label}: ${name}`);
    }
  }
  /* Two copies of one theme: any drift between them is a half-lit page. */
  for (const name of TOKENS) {
    assert.equal(lightA.get(name), lightB.get(name), `light: ${name} differs between blocks`);
  }
});

test('the light theme is a different theme, not a rename', () => {
  assert.notEqual(lightB.get('--cv-bg'), dark.get('--cv-bg'));
  assert.notEqual(lightB.get('--cv-text'), dark.get('--cv-text'));
});

/* ── contrast ──────────────────────────────────────────────────────────── */

const channel = (v) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

function luminance(hex, who) {
  assert.match(hex, /^#[0-9a-f]{6}$/i, `${who}: expected a 6-digit hex, got ${hex}`);
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a, 'fg'), luminance(b, 'bg')].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test('body text and muted text clear WCAG AA (4.5:1) in both themes', () => {
  for (const [label, theme] of [['dark', dark], ['light', lightB]]) {
    const pairs = [
      ['--cv-text on --cv-bg', theme.get('--cv-text'), theme.get('--cv-bg')],
      ['--cv-muted on --cv-surface', theme.get('--cv-muted'), theme.get('--cv-surface')],
      /* The primary button's ink on its fire fill is a text pair too. */
      ['--cv-on-fire on --cv-fire', theme.get('--cv-on-fire'), theme.get('--cv-fire')],
    ];
    for (const [name, fg, bg] of pairs) {
      const ratio = contrast(fg, bg);
      assert.ok(ratio >= 4.5, `${label}: ${name} is ${ratio.toFixed(2)}:1`);
    }
  }
});

test('no colour is hard-coded outside the token blocks', () => {
  /* Remove the three token blocks and nothing colour-shaped may survive: the
     primitives must read var(--cv-…), or a theme switch would half-work. */
  const rest = css
    .replace(darkBlock.text, '')
    .replace(lightMedia.text, '')
    .replace(lightAttr.text, '');
  assert.deepEqual(rest.match(/#[0-9a-f]{3,8}\b/gi) ?? [], [], 'hex colours outside the token blocks');
  assert.ok(!/\b(?:rgba?|hsla?)\(/i.test(rest), 'rgb()/hsl() outside the token blocks');
});

test('the primitives the contract names are all styled', () => {
  for (const selector of ['.cv-btn', '.cv-slider', '.cv-chip', '.cv-card', '.cv-sheet']) {
    assert.match(css, new RegExp(`\\${selector}\\s*[{,]`), `missing ${selector}`);
  }
});

test('the stylesheet is balanced, so no rule is swallowed by a typo', () => {
  assert.equal((css.match(/\{/g) ?? []).length, (css.match(/\}/g) ?? []).length);
  assert.equal((css.match(/@media/g) ?? []).length, 3, 'one light theme, one reduced-motion, one small-screen');
});

test('every var(--cv-…) reference resolves to a defined token', () => {
  const defined = new Set([...css.matchAll(/(--cv-[\w-]+)\s*:/g)].map((m) => m[1]));
  const used = new Set([...css.matchAll(/var\((--cv-[\w-]+)/g)].map((m) => m[1]));
  assert.ok(used.size > 10, 'the primitives should be reading tokens');
  for (const name of used) assert.ok(defined.has(name), `var(${name}) is never defined`);
});

test('the flame flickers in four steps, and holds still when asked', () => {
  const rule = /\.cv-flame\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, '.cv-flame rule');
  assert.match(rule[1], /animation:\s*cv-flame-flicker\s+0\.9s\s+steps\(4\)/);
  assert.match(css, /@keyframes\s+cv-flame-flicker\s*\{/);
  assert.match(
    css,
    /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\.cv-flame\s*\{\s*animation:\s*none;?\s*\}/,
    'reduced motion must switch the flicker off',
  );
});


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

