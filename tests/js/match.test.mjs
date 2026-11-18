/*
 * Match verdict: does tonight answer the reader's words? Run with
 * `node --test tests/js/match.test.mjs`.
 *
 * A launch link promises "papers like this phrase"; on an off night the honest
 * answer is "nothing close", not a list of the least-unrelated papers served as
 * if it were the answer. The verdict is judged on how close the best papers
 * are — the mean of the three largest dot products between tonight's vectors
 * and the reader's touchstones — and never on a count of papers over a z bar: a
 * truly matching title's z sits inside the range a normal night's non-matching
 * papers reach by noise, so a count cannot tell "no real match" from "a few".
 * Closeness is easy to pin down here because the touchstone is a unit axis, so
 * a paper's dot with it is its first component.
 *
 * The two states with no banner at all are the ones that would lie: no
 * touchstones (nothing was asked) and a close night (the answer is the list
 * itself). Both are pinned here because neither is visible on screen.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MIN_NIGHT,
  NONE_COS,
  WEAK_COS,
  matchBannerHtml,
  matchVerdict,
} from '../../docs/assets/cave-match.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The reader's words as one unit vector: a paper's closeness is its x. */
const WORDS = { touchstones: [[1, 0, 0]] };

/** A ranked row whose vector sits `cos` away from the touchstone. */
const row = (cos) => ({ vec: [cos, 0.1, 0] });

/**
 * A normal night: the papers named, then zero-closeness papers until it is long
 * enough to be judged — a thin night is what `MIN_NIGHT` refuses to read.
 */
const night = (...cosines) => {
  const list = cosines.map((cos) => row(cos));
  while (list.length < MIN_NIGHT) list.push(row(0));
  return list;
};

/** The mean of the three largest cosines, worked out without the module. */
const meanTop3 = (cosines) => cosines.slice().sort((a, b) => b - a).slice(0, 3)
  .reduce((sum, cos) => sum + cos, 0) / 3;

test('no touchstones means no verdict: the banner stays off, even on an empty night', () => {
  for (const list of [[], [row(0.9)], night(0.9)]) {
    const verdict = matchVerdict(list, { touchstones: [] });
    assert.equal(verdict.state, 'off', JSON.stringify(verdict));
    assert.equal(verdict.top3, null, 'a night nobody asked about has a closeness');
    assert.equal(matchBannerHtml(verdict), '', 'a reader who typed nothing is told nothing');
  }
  assert.equal(matchVerdict([row(0.9)]).state, 'off', 'a missing option is not "no words"');
});

test('touchstones and no papers is an empty day, not a weak match', () => {
  const verdict = matchVerdict([], WORDS);
  assert.deepEqual(verdict, { state: 'empty', top3: null, count: 0 });
  const html = matchBannerHtml(verdict);
  assert.match(html, /announced nothing/, html);
  assert.doesNotMatch(html, /Nothing close tonight/, 'an empty day is blamed on the reader');
});

test('a night too short to judge says nothing, even when its papers are close', () => {
  const short = Array.from({ length: MIN_NIGHT - 1 }, () => row(0.9));
  const verdict = matchVerdict(short, WORDS);
  assert.equal(verdict.state, 'off', 'top3 of a short night was compared');
  assert.equal(verdict.top3, null);
  assert.equal(matchBannerHtml(verdict), '');
  assert.equal(matchVerdict(night(0.9, 0.9, 0.9), WORDS).state, 'ok', 'MIN_NIGHT is enough');
});

/*
 * A night with nothing close is the loud one: a lone cart in the wind, above
 * the nearest papers, so the verdict arrives before the list does. The panel
 * carries the closeness the same way the old one-liner did — two decimals, no
 * parenthesis — and the cart and streaks are decoration, so the words alone
 * would still be the message.
 */
test('nothing over NONE_COS: a lone cart says so above the closest papers', () => {
  const verdict = matchVerdict(night(0.6, 0.6, 0.6), WORDS);
  assert.equal(verdict.state, 'none');
  assert.equal(verdict.count, MIN_NIGHT);
  assert.ok(Math.abs(verdict.top3 - 0.6) < 1e-9, 'top3 is not the mean of the best three');
  const html = matchBannerHtml(verdict);
  assert.match(html, /^<div class="cave-match-panel is-none" role="status">/, html);
  assert.match(html, /class="cave-match-head">No match today</, html);
  assert.match(html,
    /Nothing on tonight&#39;s arXiv is close to your words, so here are the closest ones\./,
    'the copy line is missing, or its apostrophe is not escaped: ' + html);
  assert.equal((html.match(/class="cave-match-wind"/g) || []).length, 3,
    'the scene does not blow three streaks past the cart: ' + html);
  assert.match(html, /class="cave-match-cart"/, 'the scene has no cart: ' + html);
  assert.match(html, /<p class="cave-match-close">closeness 0\.60<\/p>/,
    'the closeness is not given to two decimals: ' + html);
  assert.doesNotMatch(html, /0\.600/, 'the closeness is printed at full precision: ' + html);
});

test('between the thresholds the matches are weak, and the banner says so', () => {
  const verdict = matchVerdict(night(0.72, 0.72, 0.72), WORDS);
  assert.equal(verdict.state, 'weak');
  const html = matchBannerHtml(verdict);
  assert.match(html, /Only weak matches tonight/, html);
  assert.match(html, /0\.72/, 'the closeness is missing: ' + html);
  assert.doesNotMatch(html, /Nothing close tonight/, 'a weak night is called a dead one');
});

test('a close night needs no banner', () => {
  const verdict = matchVerdict(night(0.8, 0.8, 0.8), WORDS);
  assert.equal(verdict.state, 'ok');
  assert.ok(Math.abs(verdict.top3 - 0.8) < 1e-9, 'top3 is not the best three, meaned');
  assert.equal(matchBannerHtml(verdict), '', 'the list is the answer, and it came with a caption');
});

test('the thresholds are what decide, not tonight\'s luck', () => {
  const under = NONE_COS - 0.01;
  const over = NONE_COS + 0.01;
  assert.equal(matchVerdict(night(under, under, under), WORDS).state, 'none',
    'a night just under NONE_COS reads as a match');
  assert.equal(matchVerdict(night(over, over, over), WORDS).state, 'weak',
    'a night just over NONE_COS reads as dead');
});

test('top3 is the mean of the three largest, wherever they sit in the list', () => {
  const cosines = [0.5, 0.9, 0.2, 0.8, 0.75];
  const verdict = matchVerdict(night(...cosines), WORDS);
  assert.ok(Math.abs(verdict.top3 - meanTop3(cosines)) < 1e-9,
    'top3 is not the mean of the three largest: ' + verdict.top3);
  assert.equal(verdict.state, 'ok');
});

test('a paper with no placeable vector is ignored, and a night of none is not judged', () => {
  const list = night(0.6, 0.6, 0.6);
  list.push({}, { vec: [] }, { vec: [1, 0] }, { vec: [NaN, 0.1, 0] }, { vec: [Infinity, 0.1, 0] });
  const verdict = matchVerdict(list, WORDS);
  assert.ok(Math.abs(verdict.top3 - 0.6) < 1e-9,
    'a paper the numbers cannot place won the top three: ' + verdict.top3);
  assert.equal(verdict.state, 'none');
  assert.equal(verdict.count, list.length, 'count is the papers on the night');

  const unplaceable = Array.from({ length: MIN_NIGHT }, () => ({ vec: [NaN, 0, 0] }));
  assert.equal(matchVerdict(unplaceable, WORDS).state, 'off',
    'a night with nothing placeable was judged');
});

test('two touchstones: a paper takes whichever it is closer to', () => {
  const words = { touchstones: [[1, 0, 0], [0, 1, 0]] };
  const across = Array.from({ length: MIN_NIGHT }, () => ({ vec: [0.3, 0.8, 0] }));
  assert.ok(Math.abs(matchVerdict(across, words).top3 - 0.8) < 1e-9,
    'the smaller dot won instead of the larger');
  const along = Array.from({ length: MIN_NIGHT }, () => ({ vec: [0.95, 0.1, 0] }));
  assert.ok(Math.abs(matchVerdict(along, words).top3 - 0.95) < 1e-9,
    'the first touchstone is not read');
});

test('one weak banner, one empty banner, and the panel for none', () => {
  assert.match(matchBannerHtml(matchVerdict(night(0.2, 0.2, 0.2), WORDS)),
    /^<div class="cave-match-panel is-none" role="status">/);
  assert.match(matchBannerHtml(matchVerdict(night(0.72, 0.72, 0.72), WORDS)),
    /^<p class="cave-match-banner is-weak" role="status">/);
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
 * the import, the list it judges, and the reader's own vectors are three silent
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
  assert.match(js, /touchstones:[^\n]*ctx\.prefs\.touchstones/,
    'the verdict is not given the reader\'s own vectors');
  assert.doesNotMatch(js, /hasWords/, 'the z-score count rule is still wired in');
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

/*
 * The lone cart's scene is a stylesheet fact, so it is read as text too: three
 * streaks run one slow keyframe past a cart whose wheels do not turn (it is
 * standing, not travelling), and a reader who asked for reduced motion gets
 * the panel without the wind. Colours stay on the tokens, as everywhere here.
 */
test('the wind blows in CSS, and stops for reduced motion', () => {
  const css = fs.readFileSync(path.join(ROOT, 'docs/assets/cave-ranking.css'), 'utf8');
  assert.match(css, /@keyframes cave-match-wind\b/, 'the wind has no keyframes');
  assert.match(css, /\.cave-match-wind[^{]*\{[^}]*animation:[^;]*cave-match-wind/,
    'the streaks do not run the wind keyframes');
  assert.doesNotMatch(css, /\.cave-match-wheel[^{]*\{[^}]*animation:/,
    'the lone cart\'s wheels turn, so it reads as travelling');
  const panel = /\.cave-match-panel\s*\{([^}]*)\}/.exec(css);
  assert.ok(panel, 'no panel rule in cave-ranking.css');
  assert.match(panel[1], /var\(--/, 'the panel takes no colour from the theme');
  assert.doesNotMatch(panel[1], /#[0-9a-f]{3,6}\b/i, 'the panel hardcodes a colour');
  // The rule lives in the file's last reduced-motion block, so the tail from
  // that media query is the reachable scope to check it sits in.
  const reduce = css.slice(css.lastIndexOf('prefers-reduced-motion'));
  assert.match(reduce, /\.cave-match-wind[^{]*\{[^}]*(animation:\s*none|display:\s*none)/,
    'reduced motion keeps the wind blowing');
});
