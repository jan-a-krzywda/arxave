/*
 * Match verdict: does tonight answer the reader's words? Run with
 * `node --test tests/js/match.test.mjs`.
 *
 * A launch link promises "papers like this phrase"; on an off night the honest
 * answer is "nothing close", not a list of the least-unrelated papers served as
 * if it were the answer. The verdict is judged on `fit` — the corpus-normalised
 * z-score `caveScore` returns — and never on `fitPct`: a percentile saturates,
 * so over ~200 papers some paper is always above the 99th percentile of the
 * field and "nothing close" would never fire on a busy night.
 *
 * The two states with no banner at all are the ones that would lie: no words
 * typed (nothing was asked) and three or more close papers (the answer is the
 * list itself). Both are pinned here because neither is visible on screen.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CLOSE_Z,
  FEW_CLOSE,
  matchBannerHtml,
  matchVerdict,
} from '../../docs/assets/cave-match.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORDS = { hasWords: true };
const SILENT = { hasWords: false };

/** A ranked row, as the ranking stage passes it; only `fit` is read here. */
const row = (fit) => ({ fit });

test('no words means no verdict: the banner stays off, even on an empty night', () => {
  for (const list of [[], [row(9)], [row(0)]]) {
    const verdict = matchVerdict(list, SILENT);
    assert.equal(verdict.state, 'off', JSON.stringify(verdict));
    assert.equal(matchBannerHtml(verdict), '', 'a reader who typed nothing is told nothing');
  }
});

test('words and no papers is an empty day, not a weak match', () => {
  const verdict = matchVerdict([], WORDS);
  assert.deepEqual(verdict, { state: 'empty', close: 0, best: null });
  const html = matchBannerHtml(verdict);
  assert.match(html, /announced nothing/, html);
  assert.doesNotMatch(html, /Nothing close tonight/, 'an empty day is blamed on the reader');
});

test('everything below CLOSE_Z says nothing is close, with how close the best came', () => {
  const verdict = matchVerdict([row(1.44), row(-2), row(0.5)], WORDS);
  assert.equal(verdict.state, 'none');
  assert.equal(verdict.close, 0);
  const html = matchBannerHtml(verdict);
  assert.match(html, /Nothing close tonight/, html);
  assert.match(html, /z 1\.4\)/, 'the best z is not given to one decimal: ' + html);
  assert.doesNotMatch(html, /z 1\.44/, 'the z is printed at full precision: ' + html);
});

test('one or two close papers reads as few, and says how many', () => {
  const one = matchVerdict([row(CLOSE_Z), row(1)], WORDS);
  assert.equal(one.state, 'few');
  assert.equal(one.close, 1);
  assert.match(matchBannerHtml(one), /Only 1 paper\b/, 'the count is wrong or unreadable');

  const two = matchVerdict([row(CLOSE_Z + 1), row(0), row(CLOSE_Z)], WORDS);
  assert.equal(two.state, 'few');
  assert.equal(two.close, 2);
  assert.match(matchBannerHtml(two), /Only 2/, 'the count is wrong or missing');
});


test('three or more close papers need no banner', () => {
  const list = [row(CLOSE_Z - 1), row(CLOSE_Z), row(CLOSE_Z + 2), row(CLOSE_Z + 0.5)];
  const verdict = matchVerdict(list, WORDS);
  assert.equal(verdict.state, 'ok');
  assert.equal(verdict.close, 3);
  assert.equal(matchBannerHtml(verdict), '', 'the list is the answer, and it came with a caption');
});

test('the thresholds are what decide "close" and "few", not tonight\'s luck', () => {
  const close = Array.from({ length: FEW_CLOSE }, () => row(CLOSE_Z));
  assert.equal(matchVerdict(close, WORDS).state, 'ok', 'FEW_CLOSE papers do not read as enough');
  assert.equal(matchVerdict(close.slice(1), WORDS).state, 'few', 'one short of FEW_CLOSE is not few');
});

test('best is the largest fit, whatever the order', () => {
  assert.equal(matchVerdict([row(1), row(4.5), row(2)], WORDS).best, 4.5);
  assert.equal(matchVerdict([row(-3)], WORDS).best, -3, 'a negative z is still the best on offer');
});

test('a paper with no finite fit is ignored: not close, and never the best', () => {
  const verdict = matchVerdict([row(NaN), row(Infinity), row(undefined), row(1)], WORDS);
  assert.equal(verdict.close, 0, 'a non-finite fit counted as close');
  assert.equal(verdict.best, 1, 'a non-finite fit won the comparison');
  assert.equal(verdict.state, 'none');
});

test('a night with no finite fit at all still says nothing close, and quotes no z', () => {
  // A paper the scorer could not place has no z; the sentence must not print
  // "z null" or "z NaN" at a reader.
  const verdict = matchVerdict([row(NaN)], WORDS);
  assert.equal(verdict.state, 'none');
  assert.equal(verdict.best, null);
  const html = matchBannerHtml(verdict);
  assert.match(html, /Nothing close tonight/, html);
  assert.doesNotMatch(html, /\(z /, 'a missing z is quoted: ' + html);
});

test('the banner is one status line, classed by its state', () => {
  assert.match(matchBannerHtml(matchVerdict([row(0)], WORDS)),
    /^<p class="cave-match-banner is-none" role="status">/);
  assert.match(matchBannerHtml(matchVerdict([row(CLOSE_Z)], WORDS)),
    /^<p class="cave-match-banner is-few" role="status">/);
  assert.match(matchBannerHtml(matchVerdict([], WORDS)),
    /^<p class="cave-match-banner is-empty" role="status">/);
});

/*
 * The module is pure arithmetic plus markup, like `cave-launch-strip.mjs`; the
 * one import it needs is the escape helper. Checking it as text is the cheap
 * guard against the ranking stage dragging the rest of the Cave into a paint.
 */
test('cave-match.mjs imports nothing but the escape helper', () => {
  const js = fs.readFileSync(path.join(ROOT, 'docs/assets/cave-match.mjs'), 'utf8');
  const imports = js.split('\n').filter((line) => /^\s*import\b/.test(line));
  for (const line of imports) {
    assert.match(line, /from '\.\/sieve-ui\.mjs'/, 'unexpected import: ' + line);
  }
});

/*
 * The ranking stage's wiring, as text. A verdict nobody draws is no verdict:
 * the import, the list it judges, and the reader's own words are three silent
 * ways for the banner to disappear, and nothing on screen would show it — an
 * absent banner looks exactly like a good night.
 */
test('the ranking stage asks the match module about the list it painted', () => {
  const js = fs.readFileSync(path.join(ROOT, 'docs/assets/cave-stage-ranking.mjs'), 'utf8');
  assert.match(js, /from '\.\/cave-match\.mjs'/, 'the ranking stage never imports the verdict');
  assert.match(js, /matchVerdict\(state\.ranked/, 'the verdict is not judged on the ranked list');
  assert.match(js, /matchBannerHtml\(/, 'the banner markup is never drawn');
  // A page waiting on a dig has an empty list too, and its empty list is "not
  // yet", not "arXiv announced nothing": the verdict waits for a finished pass.
  assert.match(js, /state\.answered\s*\n?\s*\?/,
    'the verdict is drawn before a scoring pass has answered');
  assert.match(js, /hasWords:[^\n]*ctx\.prefs\.touchstones\.length > 0/,
    'hasWords does not come from the reader\'s own words');
});

/*
 * The banner's colours and the dimmed list are stylesheet facts, so they are
 * read as text: no hex, because dark mode gets its colours from the tokens.
 * `is-weak` must dim, never move: a list that reflows when the verdict changes
 * makes a slider drag jump the page.
 */
test('the banner and a weak list are styled on theme tokens', () => {
  const css = fs.readFileSync(path.join(ROOT, 'docs/assets/cave-ranking.css'), 'utf8');
  const banner = /\.cave-match-banner\s*\{([^}]*)\}/.exec(css);
  assert.ok(banner, 'no banner rule in cave-ranking.css');
  assert.match(banner[1], /var\(--/, 'the banner takes no colour from the theme');
  assert.doesNotMatch(banner[1], /#[0-9a-f]{3,6}\b/i, 'the banner hardcodes a colour');
  const weak = /\.is-weak[^{]*\{([^}]*)\}/.exec(css);
  assert.ok(weak, 'a weak list is not styled');
  assert.match(weak[1], /opacity:/, 'a weak list moves instead of dimming');
});
