/**
 * demath — inline TeX math, rendered as text.
 *
 * arXiv titles and abstracts are TeX. Not a subset of TeX, not TeX-flavoured
 * markup: the author's own source, `$|\sqrt{\mathrm{T}}\rangle$` and all. The
 * announcement feed hands it over verbatim, and a card that prints it verbatim
 * prints backslashes at a reader.
 *
 * WHY NOT KATEX. A maths renderer is a CDN script and a stylesheet on a site
 * that has neither a build step nor a single browser dependency, and it would
 * fix exactly one of the two places this text is read: the other is a feed
 * reader, which runs no script at all and would still show the backslashes. The
 * text has to be right in the file, not fixed up after it arrives.
 *
 * SO THE MATH IS FLATTENED TO UNICODE, which handles the overwhelming majority
 * of what actually appears in these fields — kets, radicals, relations, Greek,
 * a superscript exponent — and degrades to something readable, never to
 * something wrong, on the rest. `\frac{a}{b}` becomes `a/b`. An exponent whose
 * characters have no superscript form keeps its caret: `10^-4` is `10⁻⁴`, but
 * `x^{n+1}` stays `x^(n+1)` rather than becoming a lie.
 *
 * NOT A CACHE KEY. `deLatex` in warm-dig.mjs is byte-identical to a copy in
 * filter.js because the two hash abstracts and must agree. This is display
 * only, runs after it, and is deliberately not part of that pair — but it
 * borrows that module's Greek table rather than keeping a third copy of it.
 */

import { GREEK, SPECIALS } from './warm-dig.mjs';

/* Relations, operators and delimiters, in the spelling TeX uses. Only symbols
   with an unambiguous single-character Unicode form are here — anything that
   would need layout to be honest is left alone below. */
export const SYMBOLS = {
  ...GREEK, ...SPECIALS,
  langle: '⟨', rangle: '⟩', lvert: '|', rvert: '|', lVert: '‖', rVert: '‖',
  vert: '|', Vert: '‖', mid: '|',
  times: '×', cdot: '·', div: '÷', pm: '±', mp: '∓', ast: '∗', star: '⋆',
  approx: '≈', simeq: '≃', sim: '∼', propto: '∝', equiv: '≡', neq: '≠',
  leq: '≤', le: '≤', geq: '≥', ge: '≥', ll: '≪', gg: '≫',
  to: '→', rightarrow: '→', leftarrow: '←', leftrightarrow: '↔',
  Rightarrow: '⇒', Leftarrow: '⇐', mapsto: '↦',
  uparrow: '↑', downarrow: '↓', updownarrow: '↕',
  infty: '∞', partial: '∂', nabla: '∇', hbar: 'ℏ', ell: 'ℓ',
  dagger: '†', ddagger: '‡', prime: '′', circ: '∘', bullet: '•',
  cup: '∪', cap: '∩', subset: '⊂', subseteq: '⊆', supset: '⊃', in: '∈',
  notin: '∉', forall: '∀', exists: '∃', neg: '¬', land: '∧', lor: '∨',
  sum: '∑', prod: '∏', int: '∫', otimes: '⊗', oplus: '⊕', sqrt: '√',
  perp: '⊥', parallel: '∥', angle: '∠', deg: '°',
  ldots: '…', dots: '…', cdots: '⋯', quad: ' ', qquad: '  ',
};

/* Wrappers that carry no meaning once the type is gone: the argument survives,
   the command does not. `\mathrm{T}` is a T. */
const TRANSPARENT = new Set([
  'mathrm', 'mathbf', 'mathit', 'mathsf', 'mathtt', 'mathcal', 'mathbb',
  'mathfrak', 'boldsymbol', 'bm', 'text', 'textrm', 'textbf', 'textit',
  'operatorname', 'rm', 'bf', 'it', 'left', 'right', 'displaystyle',
  'textstyle', 'scriptstyle', 'ensuremath', 'nonumber', 'label', 'penalty',
]);

/* Spacing commands, which exist to move things a hair on a printed page. */
const SPACING = /\\[,;:!> ]|\\quad|\\qquad|\\thinspace|\\penalty\s*-?\d*/g;

const SUPER = {
  0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸',
  9: '⁹', '+': '⁺', '-': '⁻', '−': '⁻', '=': '⁼', '(': '⁽', ')': '⁾',
  n: 'ⁿ', i: 'ⁱ',
};

const SUB = {
  0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈',
  9: '₉', '+': '₊', '-': '₋', '−': '₋', '=': '₌', '(': '₍', ')': '₎',
};

/**
 * The brace group starting at `open`, and where it ends. Depth-counted rather
 * than matched by regex, because `{a{b}c}` is common and a regex cannot.
 */
function group(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') {
      depth--;
      if (!depth) return { body: s.slice(open + 1, i).trim(), end: i + 1 };
    }
  }
  return { body: s.slice(open + 1).trim(), end: s.length };
}

/** `\cmd{a}{b}` → the arguments, as strings, and where the last one ends. */
function args(s, from, n) {
  const out = [];
  let i = from;
  for (let k = 0; k < n; k++) {
    while (s[i] === ' ') i++;
    if (s[i] !== '{') return null;
    const g = group(s, i);
    out.push(g.body);
    i = g.end;
  }
  return { out, end: i };
}

/** A run of characters raised or lowered, or null when one of them cannot be. */
function shift(text, table) {
  let out = '';
  for (const ch of text) {
    if (!Object.prototype.hasOwnProperty.call(table, ch)) return null;
    out += table[ch];
  }
  return out;
}

/**
 * One pass over the string, expanding commands as they are met.
 *
 * Recursive on arguments rather than iterative to a fixed point: `\sqrt{\pi}`
 * needs its argument expanded before it can be wrapped, and a fixed-point loop
 * over the whole string re-scans everything for every nested command.
 */
function expand(s) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const ch = s[i];

    /* An exponent or an index. Both take either a brace group or the single
       character after them, which is what `10^-4` and `p_{\rm CNOT}` are. */
    if (ch === '^' || ch === '_') {
      const table = ch === '^' ? SUPER : SUB;
      let body;
      let end;
      if (s[i + 1] === '{') {
        const g = group(s, i + 1);
        body = expand(g.body);
        end = g.end;
      } else if (s[i + 1] === '\\') {
        const m = /^\\[A-Za-z]+/.exec(s.slice(i + 1));
        body = expand(s.slice(i + 1, i + 1 + (m ? m[0].length : 1)));
        end = i + 1 + (m ? m[0].length : 1);
      } else {
        body = s[i + 1] ?? '';
        end = i + 2;
      }
      const lifted = shift(body, table);
      /* Unmappable: keep the operator so the reader can still see what is an
         exponent. A bare word needs no bracket — `p_CNOT` is how the paper
         writes it anyway — but anything with an operator in it does, or
         `x^n+1` reads as `x^(n+1)`. */
      const bare = /^\w+$/.test(body);
      out += lifted !== null ? lifted
        : `${ch}${bare || body.length <= 1 ? body : `(${body})`}`;
      i = end;
      continue;
    }

    if (ch !== '\\') {
      /* Braces that survived their command are grouping, not content. */
      if (ch !== '{' && ch !== '}') out += ch;
      i++;
      continue;
    }

    const m = /^\\([A-Za-z]+)/.exec(s.slice(i));
    if (!m) {
      /* `\{`, `\%`, `\&`: an escaped literal. */
      out += s[i + 1] ?? '';
      i += 2;
      continue;
    }
    const cmd = m[1];
    let j = i + m[0].length;

    if (cmd === 'frac' || cmd === 'tfrac' || cmd === 'dfrac') {
      const a = args(s, j, 2);
      if (a) {
        const [num, den] = a.out.map(expand);
        /* Parenthesised only when it would otherwise re-associate: `1/2` reads,
           `(a+b)/(c+d)` has to. */
        const wrap = (t) => (/^[\w.]+$/.test(t) ? t : `(${t})`);
        out += `${wrap(num)}/${wrap(den)}`;
        i = a.end;
        continue;
      }
    }

    if (cmd === 'sqrt') {
      const a = args(s, j, 1);
      if (a) {
        out += `√${expand(a.out[0])}`;
        i = a.end;
        continue;
      }
    }

    /* `\ket{\psi}` → `|ψ⟩`, which is the notation this feed is full of. */
    if (cmd === 'ket' || cmd === 'bra') {
      const a = args(s, j, 1);
      if (a) {
        const body = expand(a.out[0]);
        out += cmd === 'ket' ? `|${body}⟩` : `⟨${body}|`;
        i = a.end;
        continue;
      }
    }
    if (cmd === 'braket' || cmd === 'ip') {
      const a = args(s, j, 2);
      if (a) {
        out += `⟨${expand(a.out[0])}|${expand(a.out[1])}⟩`;
        i = a.end;
        continue;
      }
    }
    if (cmd === 'absolutevalue' || cmd === 'abs') {
      const a = args(s, j, 1);
      if (a) {
        out += `|${expand(a.out[0])}|`;
        i = a.end;
        continue;
      }
    }

    if (TRANSPARENT.has(cmd)) {
      const a = args(s, j, 1);
      if (a) {
        out += expand(a.out[0]);
        i = a.end;
        continue;
      }
      /* `\left(` and friends take a delimiter, not a group. */
      i = j;
      /* One space after a command name is the name's terminator, not a space. */
      if (s[i] === ' ') i++;
      continue;
    }

    if (Object.prototype.hasOwnProperty.call(SYMBOLS, cmd)) {
      out += SYMBOLS[cmd];
      i = j;
      if (s[i] === ' ') i++;
      continue;
    }

    /* An unknown command. The name is very often the thing being talked about
       — `\Bperp`, `\Tgate` — so the backslash goes and the word stays. */
    out += cmd;
    i = j;
    if (s[i] === ' ') i++;
  }
  return out;
}

/**
 * Does a `$…$` span hold maths, or a price?
 *
 * Exported because the MathML pass has to make the same call on the same spans:
 * one renders `$C_{\\min}$` and the other flattens it, and if they disagreed
 * about which spans are maths a card would show a rendered formula where its
 * feed showed a dollar sign, for the same text.
 */
export function isMath(body) {
  return /[\\^_{}]/.test(body) || !/\s/.test(body) || settings(body);
}

/* A span with spaces in it is still maths when it is all relations and short
   names — `$d=2, n=3$` is a pair of settings, not a sentence. Both halves of
   the test have to hold: a relation sign somewhere, and no English word
   anywhere, so `$100 to $200` stays a price range. */
function settings(body) {
  return /[=<>]/.test(body)
    && body.trim().split(/\s+/).every((t) => !/[A-Za-z]{3,}/.test(t));
}

/**
 * Inline math, flattened. Text outside `$…$` is returned untouched, so a stray
 * dollar sign in prose cannot swallow the rest of a sentence.
 */
export function deMath(text) {
  const s = String(text ?? '');
  if (!s.includes('$') && !s.includes('\\')) return s;
  /* A dollar sign in prose is money far more often than it is a delimiter, and
     "costs $5 and $10" must not come out as "costs 5 and 10". So a span is
     math only when it looks like math: a command, a script, a brace group, or
     a run with no space in it — `$200$` is a quantity, `$5 and $` is a price
     and the word after it. Everything else is left exactly as written. */
  const flatten = (m, body) => (isMath(body) ? expand(body.replace(SPACING, ' ')) : m);
  /* `$$…$$` first: display math in an abstract is rare but it exists, and the
     single-dollar pattern would otherwise match its empty middle. */
  let out = s.replace(/\$\$([\s\S]+?)\$\$/g, flatten);
  out = out.replace(/\$([^$]+)\$/g, flatten);
  /* Commands outside math mode too. Partly because `1{\deg}` and `\%` are
     written that way, and partly because arXiv's own HTML rendering emits
     captions whose dollar signs do not pair up — `=$187\text{\,}\mathrm{mT}$$`
     is a real one — and the tail of such a caption is TeX sitting in the open.
     Only command-shaped runs are touched; prose is not re-parsed. */
  out = out.replace(/\\[A-Za-z]+(?:\s*\{[^{}]*\})*/g, (m) => expand(m));
  out = out.replace(SPACING, ' ');
  out = out.replace(/\\([%&#_{}$])/g, '$1');
  /* Braces left behind by a command that has already been expanded — `1{\deg}`
     comes out as `1{°}`. Braces are TeX grouping in these fields, never prose. */
  out = out.replace(/[{}]/g, '');
  /* A doubled dollar left over from that unpaired case is punctuation nobody
     meant. A single one might be money, and is left alone. */
  out = out.replace(/\${2,}/g, '');
  return out.replace(/[ \t]{2,}/g, ' ');
}
