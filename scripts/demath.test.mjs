import test from 'node:test';
import assert from 'node:assert/strict';

import { deMath } from './demath.mjs';

/* Every case below is real text off a 2026-08 arXiv announcement or an arXiv
   HTML caption, which is why some of them are malformed: the source is the
   author's TeX, not a sanitised feed. */

test('a ket comes out as a ket', () => {
  assert.equal(
    deMath('Fault-tolerant $|\\sqrt{ \\mathrm{T} }\\rangle$ state preparation'),
    'Fault-tolerant |√T⟩ state preparation');
  assert.equal(deMath('$\\ket{v_0, \\downarrow}$ state'), '|v₀, ↓⟩ state');
  assert.equal(deMath('$\\absolutevalue{C}$'), '|C|');
});

test('exponents and indices are lifted when they can be', () => {
  assert.equal(deMath('$5*10^{-4}$'), '5*10⁻⁴');
  assert.equal(deMath('$T_{2}^{*}$'), 'T₂^*');
  assert.equal(deMath('$x^{n+1}$'), 'xⁿ⁺¹');
});

test('an unliftable script keeps its operator rather than lying', () => {
  // `p_CNOT` is how the paper writes it; what must not happen is the subscript
  // silently disappearing and leaving `pCNOT`.
  assert.equal(deMath('$p_{\\rm CNOT}$'), 'p_CNOT');
  assert.equal(deMath('$B_{\\perp}^{\\rm opt}$'), 'B_⊥^opt');
  // Bracketed when it would otherwise re-associate.
  assert.equal(deMath('$x^{a+b}c$'), 'x^(a+b)c');
});

test('a fraction becomes a division, parenthesised only when it must be', () => {
  assert.equal(deMath('$\\frac{1}{2}$'), '1/2');
  assert.equal(deMath('$\\frac{a+b}{c}$'), '(a+b)/c');
});

test('Greek and accents survive, from the table the warmer already has', () => {
  assert.equal(deMath('$\\Omega$ and $\\mu$s'), 'Ω and μs');
  assert.equal(deMath('$\\alpha^2$'), 'α²');
});

test('a dollar sign in prose is money, not a delimiter', () => {
  // The failure this guards is silent and reads as plausible English:
  // "costs 5 and 10 in prose".
  assert.equal(deMath('costs $5 and $10 in prose'), 'costs $5 and $10 in prose');
  assert.equal(deMath('no math at all, just prose'), 'no math at all, just prose');
});

test('a quantity between dollars is still math', () => {
  assert.equal(deMath('$T_2$ of 100$-$200 ns'), 'T₂ of 100-200 ns');
});

test('unpaired dollars out of arXiv HTML do not leave TeX on the page', () => {
  // Verbatim from a 2026-08-25 caption: LaTeXML closes the span and then keeps
  // writing TeX after it.
  assert.equal(
    deMath('$B_{\\rm ext}=$187\\text{\\,}\\mathrm{mT}$$'),
    'B_ext=187,mT');
});

test('a command nobody mapped keeps its name, which is usually the subject', () => {
  // `\Bperp`, `\Tgate`: an author's own macro. The name is the thing being
  // talked about, so it stays; only the backslash goes.
  assert.equal(deMath('$\\Bperp$ sweep'), 'Bperp sweep');
});

test('text-mode escapes are handled too', () => {
  assert.equal(deMath('a 50\\% gain and 1{\\deg} tilt'), 'a 50% gain and 1° tilt');
});
