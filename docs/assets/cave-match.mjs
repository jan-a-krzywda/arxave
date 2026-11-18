/**
 * cave-match — does tonight answer the reader's words?
 *
 * A launch link (`/ai/llms`) promises papers like its phrase. Most nights that
 * is true and the list speaks for itself; some nights nothing on arXiv comes
 * near the phrase, and a ranked list then reads as an answer when it is only
 * the nearest thing available. This module is the one place that decides, so
 * the ranking stage draws a verdict rather than inventing one.
 *
 * JUDGED ON THE Z-SCORE, NEVER THE PERCENTILE. `fit` is `caveScore`'s
 * corpus-normalised z-score — how many corpus standard deviations closer this
 * paper is to the words than the field's average — and `fitPct` is that same
 * number through the normal CDF. A percentile saturates: over ~200 papers some
 * paper is always above the 99th percentile of the field, so `fitPct` would
 * call a busy off-topic night a match. The threshold is therefore on the raw z,
 * where "3" means the same thing on a quiet Monday and a 400-paper Tuesday.
 *
 * THE VERDICT IS PURE, AND THE MARKUP IS A STRING, like `stripHtml`: the states
 * are held to by `tests/js/match.test.mjs` with no document. Nothing here
 * colours or places the banner — that is `cave-ranking.css`, on theme tokens.
 */
import { escapeHtml } from './sieve-ui.mjs';

/**
 * A paper counts as close at or above this `fit` z-score. Tuned against the
 * shipped corpora now that launch phrases have stored vectors (the follow-up
 * plan's Task 5); until then it is the plan's starting guess.
 */
export const CLOSE_Z = 3;

/** Fewer close papers than this reads as "only a few", not as a good night. */
export const FEW_CLOSE = 3;

/**
 * Tonight's verdict from the ranked list and whether the reader typed anything.
 *
 * `off` is "no words": the night was never asked a question, so nothing is
 * claimed about it — and that must beat `empty`, or a reader with an empty box
 * on a holiday is told arXiv announced nothing for their words.
 * `close` counts papers at or above `CLOSE_Z`; `best` is the largest finite
 * `fit` on offer (null when the scorer placed none), which the banner quotes so
 * "nothing close" comes with evidence rather than a shrug. A non-finite fit is
 * neither counted nor compared: a paper the scorer could not place is not a
 * match and must not win a maximum.
 */
export function matchVerdict(ranked, options = {}) {
  const list = Array.isArray(ranked) ? ranked : [];
  const fits = list.map((item) => Number(item && item.fit)).filter(Number.isFinite);
  const close = fits.filter((z) => z >= CLOSE_Z).length;
  const best = fits.reduce((max, z) => Math.max(max, z), -Infinity);
  const state = !options.hasWords ? 'off'
    : list.length === 0 ? 'empty'
      : close === 0 ? 'none'
        : close < FEW_CLOSE ? 'few' : 'ok';
  return { state, close, best: Number.isFinite(best) ? best : null };
}

/**
 * The banner for a verdict, or '' for the two states that need none: `off` (no
 * words) and `ok` (the list is the answer). One `<p role="status">` line, so a
 * reader with a screen reader hears the verdict once, where the list begins.
 *
 * Copy is written for the second person and never blames the night for an empty
 * day — those are different facts and the reader acts differently on each.
 */
export function matchBannerHtml(verdict) {
  const { state, close, best } = verdict || {};
  let text = '';
  if (state === 'none') {
    // With no finite fit there is no z to quote, so the sentence skips the
    // parenthesis instead of printing "z null".
    text = 'Nothing close tonight. ' +
      (Number.isFinite(best)
        ? 'Your closest paper is only a weak match (z ' + best.toFixed(1) + '). '
        : '') +
      'The list below is the nearest, not a match.';
  } else if (state === 'few') {
    text = 'Only ' + close + (close === 1 ? ' paper tonight is' : ' papers tonight are') +
      ' close to your words.';
  } else if (state === 'empty') {
    text = 'arXiv announced nothing for this day. Pick another day in Dig.';
  }
  if (!text) return '';
  return '<p class="cave-match-banner is-' + state + '" role="status">' +
    escapeHtml(text) + '</p>';
}
