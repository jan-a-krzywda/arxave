/**
 * cave-match — does tonight answer the reader's words?
 *
 * A launch link (`/ai/llms`) promises papers like its phrase. Most nights that
 * is true and the list speaks for itself; some nights nothing on arXiv comes
 * near the phrase, and a ranked list then reads as an answer when it is only
 * the nearest thing available. This module is the one place that decides, so
 * the ranking stage draws a verdict rather than inventing one.
 *
 * JUDGED ON HOW CLOSE THE BEST PAPERS ARE, NOT ON HOW MANY CLEAR A BAR. An
 * earlier rule counted papers whose `fit` z-score reached 3, and it could not
 * tell "no real match" from "a few real matches": measured on the shipped
 * corpora (5000 papers per field, twelve launch phrases with their stored
 * vectors, six off-topic ones), titles that truly match a phrase sit at a
 * median z of only 0.7 to 2.8 — for "llms" none of 1176 matching titles reach 3
 * — while a non-matching paper still reaches z 1.5 on 2 to 8 percent of nights,
 * so a normal night manufactures "close" papers out of noise. Absolute
 * closeness separates them: cos(paper) is the largest dot product of the
 * paper's `vec` (already centred and unit length, in the touchstones' space)
 * with any touchstone, and `top3` is the mean of the three largest cos on the
 * night.
 *
 * THE VERDICT IS PURE, AND THE MARKUP IS A STRING, like `stripHtml`: the states
 * are held to by `tests/js/match.test.mjs` with no document. Nothing here
 * colours or places the banner — that is `cave-ranking.css`, on theme tokens.
 */
import { escapeHtml } from './sieve-ui.mjs';

/**
 * Below this `top3` nothing on the night is close. The numbers come from the
 * shipped corpora: simulated nights of 200 random papers put the 5th percentile
 * of top3 at 0.719 (spin qubits) up to 0.832, for every one of the twelve
 * launch phrases, with typical medians of 0.75 to 0.85; six off-topic phrases
 * (bread, poetry, protein folding, QCD, Roman trade, solar-cell quantum dots)
 * put the 95th percentile at 0.623 to 0.758, all but one below 0.73. A night at
 * 0.70 has no real match on it; the two thresholds sit in that gap.
 */
export const NONE_COS = 0.7;

/** Below this `top3` the matches are real but weak, and the banner says so. */
export const WEAK_COS = 0.73;

/**
 * Fewer papers than this cannot be judged: `top3` of a short night is lower
 * than a normal night's, so a thin night would read "nothing close" for the
 * same best paper a busy Tuesday calls a match. It gets `off`, along with any
 * night the numbers cannot place.
 */
export const MIN_NIGHT = 30;

/**
 * The largest dot product between one paper's vector and any touchstone, or
 * null when the paper cannot be placed: no vector, a vector of another length,
 * or a dot product that is not finite. A NaN or an Infinity anywhere in the
 * pair makes the sum non-finite, and a paper the numbers could not place is not
 * a match and must not win the maximum.
 */
function closeness(vec, touchstones, dim) {
  if (!vec || vec.length !== dim) return null;
  let best = -Infinity;
  for (const stone of touchstones) {
    if (!stone || stone.length !== dim) continue;
    let dot = 0;
    for (let k = 0; k < dim; k += 1) dot += Number(vec[k]) * Number(stone[k]);
    if (dot > best) best = dot;
  }
  return Number.isFinite(best) ? best : null;
}

/**
 * Tonight's verdict from the ranked list and the reader's touchstones.
 *
 * `off` is "no words" — no touchstones means the night was never asked a
 * question, so nothing is claimed about it — and that must beat `empty`, or a
 * reader with an empty box on a holiday is told arXiv announced nothing for
 * their words. A night under `MIN_NIGHT` papers is `off` too: not enough to
 * judge. `top3` is the mean of the three largest cos on the night (of fewer
 * when the night has fewer placeable papers), quoted by the banner so "nothing
 * close" arrives with evidence rather than a shrug. `count` is the papers on
 * the night, placeable or not.
 */
export function matchVerdict(ranked, options = {}) {
  const list = Array.isArray(ranked) ? ranked : [];
  const stones = (options && Array.isArray(options.touchstones) ? options.touchstones : [])
    .filter((stone) => stone && typeof stone.length === 'number' && stone.length > 0);
  const dim = stones.length ? stones[0].length : 0;
  const cosines = stones.length
    ? list.map((item) => closeness(item && item.vec, stones, dim)).filter((cos) => cos !== null)
    : [];
  const top = cosines.sort((a, b) => b - a).slice(0, 3);
  const top3 = top.length ? top.reduce((sum, cos) => sum + cos, 0) / top.length : null;
  const state = stones.length === 0 ? 'off'
    : list.length === 0 ? 'empty'
      : list.length < MIN_NIGHT || top3 === null ? 'off'
        : top3 < NONE_COS ? 'none'
          : top3 < WEAK_COS ? 'weak' : 'ok';
  return { state, top3: state === 'off' || state === 'empty' ? null : top3, count: list.length };
}

/**
 * The banner for a verdict, or '' for the two states that need none: `off` (no
 * words, or too few papers to say) and `ok` (the list is the answer). One
 * `<p role="status">` line, so a reader with a screen reader hears the verdict
 * once, where the list begins.
 *
 * Copy is written for the second person and never blames the night for an empty
 * day — those are different facts and the reader acts differently on each.
 */
export function matchBannerHtml(verdict) {
  const { state, top3 } = verdict || {};
  // With no finite top3 there is no closeness to quote, so the sentence skips
  // the parenthesis instead of printing "closeness NaN".
  const howClose = Number.isFinite(top3) ? ' (closeness ' + top3.toFixed(2) + ')' : '';
  let text = '';
  if (state === 'none') {
    text = 'Nothing close tonight. Even the closest papers are only a weak match' +
      howClose + '. The list below is the nearest, not a match.';
  } else if (state === 'weak') {
    text = 'Only weak matches tonight. The closest papers are not very close to your words' +
      howClose + '.';
  } else if (state === 'empty') {
    text = 'arXiv announced nothing for this day. Pick another day in Dig.';
  }
  if (!text) return '';
  return '<p class="cave-match-banner is-' + state + '" role="status">' +
    escapeHtml(text) + '</p>';
}
