/**
 * cave-launch-run — what a launch DOES, split from what it IS.
 *
 * `cave-launch.mjs` is the table and the two URL forms, and it is loaded alone
 * by `404.html`, so it must stay a plain data module with no imports at all.
 * Seeding and the run's freshness rule need the modules that own the storage
 * keys — Dig's, the field's, Priorities' — so they live here instead. That
 * keeps the cycle out of the 404 page: only the pages that actually run the
 * night (Cave, its map, its Priorities) ever load this file.
 *
 * THE KEYS ARE THE STAGES', IMPORTED. Seeding writes Dig's form, Dig's one-shot
 * autorun flag and the Priorities store, so those names come from the modules
 * that own them instead of being retyped here: a renamed key would otherwise
 * leave a launch silently half-seeded (it would open, and do nothing). The
 * Priorities and map stages import `runningLaunch` back, so those two edges
 * form a cycle; every binding is read inside a function, at call time, so it
 * resolves whichever module the page loads first.
 */
import { LAUNCH_FRESH_MS, LAUNCH_KEY, launchById } from './cave-launch.mjs';
import { FIELD_KEY, alignCategories, fieldById, fieldKey } from './cave-fields.mjs';
import { AUTODIG_KEY, FORM_KEY } from './cave-stage-dig.mjs';
import { STORE_KEY } from './cave-stage-priorities.mjs';
import { readStore, writeStore } from './sieve-ui.mjs';

/**
 * The launch this page is still inside, or null.
 *
 * One rule, three askers: `cave.js` seeds only when no launch of this id is
 * running, the map passes its own card, and the Priorities stage runs the
 * phrase. A record older than `LAUNCH_FRESH_MS` is a visit, not a run — the
 * reader came back later and is browsing, so nothing may move on its own.
 *
 * ponytail: the window is counted from the seed and is sized for a cold,
 * uncached category (about a minute before the embed); a night that outlives
 * even that stops the run at the map, where the reader's own Continue finishes
 * it. Re-stamp the record when the night lands if that ever bites.
 */
export function runningLaunch(storage, now = Date.now()) {
  const record = readStore(storage, LAUNCH_KEY, null);
  if (!record || !(now - Number(record.at) < LAUNCH_FRESH_MS)) return null;
  return launchById(record.id);
}

/**
 * Write what a launch asks for into the places the stages already read, so the
 * night runs itself: Dig's form becomes the launch's field and categories one
 * day back, Dig's autorun flag asks for the press a link cannot make, and the
 * Priorities store is emptied so the sliders come back at their defaults — a
 * launch is a stranger's ranking, and the reader's old sliders are not part of
 * it. The one thing taken from the row is the topic leaf, written as `prefer`
 * so the tree agrees with the phrase beside it.
 *
 * The record goes in last and is the page's proof that this is a launch rather
 * than a visit: `runningLaunch` reads it back in each stage, and the
 * Priorities stage clears it once the run has ranked.
 *
 * Called before `chooseField`, because Dig's categories are what pick the pack:
 * seeding after the field was chosen would dig one field's codes out of the
 * other field's corpus.
 */
export function seedLaunch({ storage, launch, now = Date.now() } = {}) {
  if (!storage || !launch) return;

  const field = fieldById(launch.field);
  writeStore(storage, FIELD_KEY, launch.field);

  /* `{ ...form }` keeps the reader's max results: a launch says nothing about
     how many papers are enough, and 200 is a sensible answer for everyone.
     The categories go through `alignCategories` like any other list that
     arrives with a field, so the pack's own codes lead it. */
  const form = readStore(storage, FORM_KEY, null) || {};
  writeStore(storage, FORM_KEY, {
    ...form,
    categories: alignCategories(launch.categories, field).join(', '),
    lookback: 1,
  });

  writeStore(storage, AUTODIG_KEY, now);
  writeStore(storage, LAUNCH_KEY, { id: launch.id, at: now });

  const prefsKey = fieldKey(STORE_KEY, field);
  try {
    storage.removeItem(prefsKey);
  } catch (_) {
    /* nothing stored, or a storage that will not forget: writeStore below
       still writes the nudge, and the defaults are what parsePrefs reads */
  }
  /* Only the topic part of the prefs: `parsePrefs` fills the sliders in at
     their defaults, so this is the smallest set of words that means "this
     leaf, preferred, everything else untouched". An id this field's tree does
     not know is dropped there, which is the right answer too. */
  if (launch.nudge) writeStore(storage, prefsKey, { q: 'topics=' + launch.nudge + ':prefer' });
}
