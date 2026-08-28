/**
 * `node --test scripts/mathml.test.mjs` (after `npm install` in this dir).
 *
 * What these pin is not temml — that has its own tests — but the two decisions
 * around it: which `$…$` spans are maths at all, and that a field which does not
 * render comes back null rather than half-rendered. A card that shows a formula
 * where a price was meant, or an error where a formula was, is worse than the
 * flat text this replaces.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { escapeHtml, mathHtml, texToMathML } from './mathml.mjs';

test('a subscript survives as a subscript', () => {
  // The complaint this file was written for: `C_min` in a brief, printed as
  // typed, underscore and all.
  const out = mathHtml('Requires $C_{\\min}(K,S,\\epsilon)$ gates.');
  assert.match(out, /^Requires <math/);
  assert.match(out, /<msub><mi>C<\/mi>/);
  assert.match(out, / gates\.$/);
});

test('no raw TeX is left anywhere in the markup', () => {
  // temml offers to keep the source in an <annotation>. It must not: a reader
  // that flattens markup to text would print the backslashes this whole path
  // exists to remove — which is what preset-feed's own feed test asserts.
  const out = texToMathML('p_{\\rm CNOT}=5*10^{-4}');
  assert.doesNotMatch(out, /\\rm|annotation/);
  assert.match(out, /<msub><mi>p<\/mi>/);
});

test('a price is not maths', () => {
  // demath's rule, and this has to make the same call on the same span or a
  // card and its feed would disagree about the same sentence.
  assert.equal(mathHtml('costs $5 and $10 in prose'), null);
  assert.equal(mathHtml('from $100 to $200 a month'), null);
});

test('a field with no maths in it renders nothing', () => {
  // Null, not a copy: a record must not grow a second field saying the same
  // thing as the first.
  assert.equal(mathHtml('no math at all, just prose'), null);
  assert.equal(mathHtml(''), null);
  assert.equal(mathHtml(null), null);
});

test('TeX that will not convert falls back rather than showing an error', () => {
  // temml's default is to print the failed source in red. A card must never do
  // that, so a refusal is a null and the caller keeps the flat text.
  assert.equal(texToMathML('\\notacommand{x}'), null);
  assert.equal(mathHtml('a $\\notacommand{x}$ b'), null);
});

test('display maths is rendered as display, and only once', () => {
  // `$…$` would otherwise match the empty middle of a `$$…$$` span.
  const out = mathHtml('Bound: $$K=\\Theta(\\log(S/\\epsilon))$$ here.');
  assert.equal((out.match(/<math/g) || []).length, 1);
  assert.match(out, /display="block"/);
});

test('the prose around a formula is flattened and escaped', () => {
  // Two different jobs on the same string: the TeX between the dollars is
  // typeset, the TeX outside them is flattened the way it always was, and the
  // angle bracket someone wrote in a brief is text, not a tag.
  const out = mathHtml('$T_2$ of 100 ms, \\mu s before <2024',
    { flatten: (t) => t.replace(/\\mu/g, 'μ') });
  assert.match(out, /<msub><mi>T<\/mi><mn>2<\/mn><\/msub>/);
  assert.match(out, / of 100 ms, μ s before &lt;2024$/);
});

test('escaping takes the ampersand first', () => {
  // Or the escapes escape each other and `&lt;` arrives as a real `<`.
  assert.equal(escapeHtml('a & <b> "c"'), 'a &amp; &lt;b&gt; &quot;c&quot;');
});
