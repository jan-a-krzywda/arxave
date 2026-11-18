/**
 * cave-launch-strip — the mine cart a launch link rides.
 *
 * A reader who followed `/ai/llms` did not ask for six cards; they asked for
 * one ranking. While that run is doing itself the page owes them one thing:
 * which of a launch's three steps is in hand — dig tonight, embed the phrase,
 * rank — and where the run has got to when a step is slow. The Cave already
 * draws a night as a haul through a mine (filter.css), so the answer is the
 * same shape: three step markers, and a cart that stands still while the
 * rails run under it. Motion says "working"; a cart that travelled would say
 * how far a step had got, which nobody knows, and would jump whenever the
 * page repainted it.
 *
 * THE MARKUP IS A STRING, like `stageRailHtml`, so the states can be held to
 * without a document. CSS OWNS THE MOTION: the rails animate their own
 * background-position, the wheels spin and the lamp flickers, all on
 * `prefers-reduced-motion` rules that stop them — the words in the say line
 * and the wagon markers carry the same information when they are stopped. No
 * colour is written here or in the rules that draw it: they are all theme
 * tokens, so dark mode needs no second rule.
 */
import { escapeHtml } from './sieve-ui.mjs';

/** The three things a launch does, in order — and the strip's three markers. */
export const STRIP_STEPS = Object.freeze(['dig', 'embed', 'rank']);

/** The words on the markers, as a reader reads them. */
const STRIP_NAMES = Object.freeze({ dig: 'Dig', embed: 'Embed', rank: 'Rank' });

/**
 * What the strip says under the rails, one line per state.
 *
 * The error line names the order on purpose: the run goes on after a failed
 * embed (cave-stage-priorities.mjs), so "ranking" alone would leave the reader
 * thinking their words were used.
 */
const STRIP_SAY = Object.freeze({
  dig: 'Digging tonight\'s papers…',
  embed: 'Embedding your words…',
  rank: 'Ranking…',
  done: 'Done.',
  error: 'Your words were not embedded. Ranking the old order.',
});

/**
 * Where the run stands, from the one word the page knows.
 *
 * `done` has all three markers behind it and no current one: the ranking is on
 * the page. `error` is an embed that failed — the run goes on with the old
 * order, so the cart waits on Embed, the rails stop, and the say line names
 * the order the reader is about to get. Anything else marks that step current,
 * with the steps before it done.
 *
 * Derived once and exported because `cave.js` repaints the strip in place:
 * replacing the element would restart the rails and the lamp from the top of
 * their loops, which reads as a hitch. One source for the state means the
 * markers, the say line and the error stop cannot disagree.
 */
export function stripState(step) {
  const done = step === 'done';
  const at = done
    ? STRIP_STEPS.length - 1
    : Math.max(0, STRIP_STEPS.indexOf(step === 'error' ? 'embed' : step));
  return {
    at,
    error: step === 'error',
    done,
    say: STRIP_SAY[step] || STRIP_SAY.dig,
    wagons: STRIP_STEPS.map((id, i) => ({
      id,
      name: STRIP_NAMES[id],
      isDone: done || i < at,
      current: !done && i === at,
    })),
  };
}

/**
 * The cart, drawn once.
 *
 * It is a constant string because `cave.js` may repaint the strip at any step
 * and must not rebuild the cart: a fresh element starts its wheel spin and bob
 * from zero, and the cart visibly jumps. The path is a mine cart's open hopper
 * and the wheels are spoked so a rotate is visible at all. They are inside one
 * `aria-hidden` span — the wagon markers and the say line are the information.
 */
const CART = '<span class="cave-launch-cart" aria-hidden="true">' +
    '<span class="cave-launch-lamp"></span>' +
    '<svg class="cave-launch-cart-shape" viewBox="0 0 48 24" focusable="false">' +
      '<path class="cave-launch-body" d="M4 3h40l-5 12H9z"/>' +
      '<g class="cave-launch-wheel cave-launch-wheel-rear">' +
        '<circle cx="15" cy="18" r="4"/><path d="M15 14v8M11 18h8"/>' +
      '</g>' +
      '<g class="cave-launch-wheel cave-launch-wheel-front">' +
        '<circle cx="33" cy="18" r="4"/><path d="M33 14v8M29 18h8"/>' +
      '</g>' +
    '</svg>' +
  '</span>';

/**
 * The strip, as markup: the launch's own words, the step markers, the scene
 * and the one say line.
 *
 * `label` is the row's label ("Spin qubits") and is escaped here rather than
 * at the caller, so no page can forget to.
 */
export function stripHtml(step, label) {
  const state = stripState(step);
  return '<div class="cave-launch-strip' +
      (state.error ? ' is-error' : '') + (state.done ? ' is-done' : '') + '">' +
    '<p class="cave-launch-label">' + escapeHtml(label) + '</p>' +
    '<ol class="cave-launch-wagons">' +
      state.wagons.map((wagon) =>
        '<li class="cave-launch-wagon' + (wagon.isDone ? ' is-done' : '') + '"' +
          (wagon.current ? ' aria-current="step"' : '') + '>' +
          '<span class="cave-launch-name">' + escapeHtml(wagon.name) + '</span>' +
        '</li>').join('') +
    '</ol>' +
    '<div class="cave-launch-track">' +
      CART +
      '<span class="cave-launch-rails" aria-hidden="true"></span>' +
    '</div>' +
    '<p class="cave-launch-say">' + escapeHtml(state.say) + '</p>' +
  '</div>';
}
