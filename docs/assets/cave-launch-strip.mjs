/**
 * cave-launch-strip — the train a launch link rides.
 *
 * A reader who followed `/ai/llms` did not ask for six cards; they asked for
 * one ranking. While that run is doing itself the page owes them one thing:
 * which of a launch's three steps is in hand — dig tonight, embed the phrase,
 * rank — and where the run has got to when a step is slow. The Cave already
 * draws a night as a train (the haul strip, filter.css), so the answer is the
 * same shape: three wagons and an engine that moves along them.
 *
 * THE MARKUP IS A STRING, like `stageRailHtml`, so the states can be held to
 * without a document. CSS OWNS THE SLIDE: `--launch-step` is the one value
 * that changes between renders, the engine's translateX follows it, and
 * `prefers-reduced-motion` drops that transition so the engine arrives at
 * once instead of travelling. No colour is written here or in the rules that
 * draw it — they are all theme tokens, so dark mode needs no second rule.
 */
import { escapeHtml } from './sieve-ui.mjs';

/** The three things a launch does, in order — and the strip's three wagons. */
export const STRIP_STEPS = Object.freeze(['dig', 'embed', 'rank']);

/** The words on the wagons, as a reader reads them. */
const STRIP_NAMES = Object.freeze({ dig: 'Dig', embed: 'Embed', rank: 'Rank' });

/**
 * Where the train stands, from the one word the page knows.
 *
 * `done` has all three wagons behind it and no current one: the ranking is on
 * the page. `error` is an embed that failed — the run goes on with the old
 * order, so the engine stays on Embed and the error line marks the wagon that
 * did not do its job. Anything else parks the engine on that wagon, with the
 * wagons before it done.
 *
 * Derived once and exported because `cave.js` repaints the strip in place:
 * replacing the element would hand the engine no previous position and it
 * would jump. One source for the state means the wagon markers, the engine's
 * parking spot and `aria-current` cannot disagree.
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
    wagons: STRIP_STEPS.map((id, i) => ({
      id,
      name: STRIP_NAMES[id],
      isDone: done || i < at,
      current: !done && i === at,
    })),
  };
}

/**
 * The strip, as markup: the launch's own words, then the three wagons.
 *
 * `label` is the row's label ("Spin qubits") and is escaped here rather than
 * at the caller, so no page can forget to.
 */
export function stripHtml(step, label) {
  const state = stripState(step);
  return '<div class="cave-launch-strip' +
      (state.error ? ' is-error' : '') + (state.done ? ' is-done' : '') +
      '" style="--launch-step: ' + state.at + '">' +
    '<p class="cave-launch-label">' + escapeHtml(label) + '</p>' +
    '<div class="cave-launch-track">' +
      '<span class="cave-launch-loco" aria-hidden="true"></span>' +
      '<ol class="cave-launch-wagons">' +
        state.wagons.map((wagon) =>
          '<li class="cave-launch-wagon' + (wagon.isDone ? ' is-done' : '') + '"' +
            (wagon.current ? ' aria-current="step"' : '') + '>' +
            '<span class="cave-launch-name">' + escapeHtml(wagon.name) + '</span>' +
          '</li>').join('') +
      '</ol>' +
    '</div>' +
  '</div>';
}
