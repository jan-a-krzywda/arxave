/**
 * mathml — the same `$…$` spans demath flattens, kept as maths where markup is
 * allowed to survive.
 *
 * WHY THIS EXISTS ALONGSIDE demath.mjs, WHICH ARGUES AGAINST IT. That file's
 * case is against KaTeX: a CDN script and a stylesheet, on a site with no build
 * step, fixing only the browser and leaving a feed reader — which runs no
 * script — showing backslashes. Every word of that still holds. It is an
 * argument against rendering maths *in the reader*, and this renders it in the
 * builder: `C_{\min}` becomes MathML, once, in the file that ships. MathML is
 * markup, not a program — a browser lays it out with no stylesheet and no
 * script, and so does a feed reader built on one.
 *
 * SO THE FLAT TEXT IS STILL THE FLOOR, never the fallback nobody maintains.
 * Every field is flattened as before and that is what the archive JSON, the
 * feed's <title> and every plain-text path carry; the MathML is a second
 * rendering of the same field, offered only where a reader can use markup, and
 * a consumer that ignores it loses nothing it had yesterday.
 *
 * THE INPUT HAS TO BE TeX FOR ANY OF THIS TO MATTER. A brief that says
 * `C_min(K,S,ε)` in prose is not maths a renderer can find — see the maths line
 * in enrich.mjs's system prompt, which is the other half of this change.
 */

import temml from 'temml';

import { deMath, isMath } from './demath.mjs';

/** HTML text nodes. Ampersand first, or the escapes escape each other. */
export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * One TeX span → MathML, or null when it will not render.
 *
 * `throwOnError` rather than temml's default, which is to emit the failed
 * source in red: a card must never show an error message where a formula was
 * meant to be. Null sends the caller back to the flattened text, which is what
 * the card showed before this file existed.
 *
 * NO `annotate`. temml can keep the source TeX in an <annotation> inside the
 * MathML, which is handy for copying a formula back out — and it is exactly the
 * backslashes this project spent demath.mjs removing, put back where a reader
 * that flattens markup to text prints them. preset-feed's own test caught it:
 * the feed must carry no raw TeX anywhere, visible or not.
 */
export function texToMathML(tex, { display = false } = {}) {
  try {
    const out = temml.renderToString(String(tex), {
      displayMode: display,
      throwOnError: true,
      xml: true,
    });
    return out.includes('<merror') ? null : out;
  } catch (_) {
    return null;
  }
}

/**
 * A field of prose-with-maths → HTML: text escaped, `$…$` rendered.
 *
 * Returns null when nothing rendered — no maths in the field, or none of it
 * would convert — so a caller can keep using the plain escaped string and no
 * record grows a second copy of a field that says the same thing twice.
 *
 * `flatten` is how the prose between the formulas is made readable: preset-feed
 * passes its `readable`, which is the accent pass over the maths pass. It is a
 * parameter rather than an import because that function lives downstream of
 * this one, and a cycle between the two would be a worse bug than a callback.
 */
export function mathHtml(text, { flatten = deMath } = {}) {
  const s = String(text ?? '');
  if (!s.includes('$')) return null;
  let rendered = 0;
  let out = '';
  let last = 0;
  /* `$$…$$` before `$…$`, for the reason deMath takes them in that order: the
     single-dollar pattern would otherwise match the empty middle of a display
     span. One scan handles both, so a display span cannot be re-entered. */
  const spans = /\$\$([\s\S]+?)\$\$|\$([^$]+)\$/g;
  for (const m of s.matchAll(spans)) {
    const display = m[1] !== undefined;
    const body = display ? m[1] : m[2];
    const mathml = isMath(body) ? texToMathML(body, { display }) : null;
    if (!mathml) continue;                       // a price, or TeX temml refused
    out += escapeHtml(flatten(s.slice(last, m.index)));
    out += mathml;
    last = m.index + m[0].length;
    rendered++;
  }
  if (!rendered) return null;
  return out + escapeHtml(flatten(s.slice(last)));
}
