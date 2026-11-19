/**
 * cave-launch-ride — what a launch link says while the night is doing itself.
 *
 * A reader who followed `/ai/llms` did not ask for six cards; they asked for
 * one ranking. Digging tonight, embedding the phrase and ranking can take
 * several seconds, and a page that looks finished during them reads as broken.
 * So the Cave does the one thing its own drawing already does: the lift in the
 * rail rides down to the Ranking floor (`cave.js` sets `--lift-floor`, cave.css
 * slows the descent for the ride), and this box parks beside the cards saying
 * why nothing is here yet. The cart strip said the same in three small markers,
 * which nobody read; the run's steps are the lift's own business.
 *
 * THE MARKUP IS A STRING, like `stageRailHtml`, so the copy can be held to
 * without a document (`tests/js/launch.test.mjs`). CSS owns the placement, the
 * fade and whether the cage is allowed to travel at all — this file is the
 * words, and the one import it needs is the escape helper. `cave-launch.mjs`
 * stays import-free, which is a test of its own.
 */
import { escapeHtml } from './sieve-ui.mjs';

/**
 * How long the cage takes to reach the Ranking floor while someone else's run
 * is loading. The rail's ordinary move is 700ms (cave.css), which is right for
 * a click the reader made and far too quick for a descent nobody asked for: at
 * fourteen seconds it reads as travel rather than a jump, and it is still over
 * before a run that works is done. CSS cannot read this constant, so its
 * `--ride-ms` carries the same number and `tests/js/launch.test.mjs` holds the
 * two together.
 */
export const RIDE_MS = 14000;

/**
 * The box, as markup: one heading, one line, and the launch's own label.
 *
 * `label` is the row's label ("Spin qubits") and is escaped here rather than at
 * the caller, so no page can forget to. One `role="status"` around the whole
 * aside, so a reader with a screen reader hears it once, as one thing.
 */
export function rideHtml(label) {
  return '<aside class="cave-ride" role="status">' +
    '<p class="cave-ride-head">On our way…</p>' +
    '<p class="cave-ride-copy">Your ranking should be here in a few seconds.</p>' +
    '<p class="cave-ride-label">' + escapeHtml(label) + '</p>' +
  '</aside>';
}
