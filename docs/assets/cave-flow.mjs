/**
 * cave-flow — one night in the cave, as eight stages and a bit of state.
 *
 * The page is a single column of cards top to bottom; each card unlocks when
 * the one before it is done, folds to its one-line summary when done, and
 * reopens on click. That is a small, boring state machine, which is exactly why
 * it lives here instead of in the page: `cave.js` then only maps state to
 * markup, and this file can be tested without a DOM, a clock or a fetch.
 *
 * WHAT "OPEN" MEANS. A stage is open when every earlier stage is done and it
 * is not done itself. Done wins over open (a stage can be done while an earlier
 * one is not — `invalidateFrom` clears from a point onward, so the reverse
 * never happens through this API), and anything else is locked.
 *
 * FOLD IS UI STATE, KEPT IN THE SAME SNAPSHOT. The default is derived — the
 * open stage expanded, done stages collapsed — but a reader can click a done
 * card open and it must stay open while they read. So `expanded` is an explicit
 * set that `complete` and `invalidateFrom` nudge back to the default, and
 * `toggle` overrides.
 *
 * PERSISTENCE IS BEST-EFFORT, BOTH WAYS. `localStorage` throws in private modes
 * and when the quota is full, and the stored value is whatever an older build
 * of this page left there. Neither may break a night: load failures start
 * fresh, save failures are swallowed, and anything that is not a snapshot
 * naming only stages this machine knows is ignored.
 */

export const STAGES = ['dig', 'train', 'map', 'fire', 'priorities', 'ranking', 'act', 'story'];

const oneLine = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

/**
 * Does a stage fold to its one-line summary once it is done?
 *
 * Every stage does but the story: the narrative the night produced is what the
 * reader came for, so `complete('story')` leaves the card expanded instead of
 * putting it away behind its own summary. Pure, so the shell and the test can
 * ask the rule without a page.
 */
export function foldOnComplete(id) {
  return id !== 'story';
}

/**
 * Create the machine for one page.
 *
 * `storage` is anything with `getItem`/`setItem` (localStorage, a fake in a
 * test); `key` names its entry; `stages` is the fixed order and exists so a
 * test — or a later three-stage page — does not have to know all eight.
 */
export function createFlow({ storage = null, key = 'arxave-cave-v4-flow', stages = STAGES } = {}) {
  if (!Array.isArray(stages) || stages.length === 0) {
    throw new TypeError('cave-flow: stages must be a non-empty array');
  }

  const order = [...stages];
  const known = new Set(order);

  /** @type {Map<string, string>} stage id -> its one-line summary */
  const done = new Map();
  /** @type {Set<string>} ids the reader (or the default) has folded open */
  const open = new Set();
  /** @type {Set<(snapshot: object) => void>} */
  const listeners = new Set();

  const at = (id) => {
    const index = order.indexOf(id);
    if (index === -1) throw new TypeError(`cave-flow: unknown stage "${id}"`);
    return index;
  };

  /** First stage that is not done, or null once the whole night is. */
  function current() {
    return order.find((id) => !done.has(id)) ?? null;
  }

  function status(id) {
    const index = at(id);
    if (done.has(id)) return 'done';
    for (let i = 0; i < index; i += 1) if (!done.has(order[i])) return 'locked';
    return 'open';
  }

  function summary(id) {
    at(id);
    return done.has(id) ? done.get(id) : null;
  }

  function expanded(id) {
    at(id);
    return open.has(id);
  }

  function snapshot() {
    const doneOut = {};
    for (const id of order) if (done.has(id)) doneOut[id] = done.get(id);
    return { done: doneOut, expanded: order.filter((id) => open.has(id)) };
  }

  /* Writing then telling are one step: a listener that re-renders must never
     see state the disk has not seen, and a throwing listener must not stop the
     others. */
  function commit() {
    if (storage) {
      try {
        storage.setItem(key, JSON.stringify(snapshot()));
      } catch {
        /* private mode, quota, a storage that is not one — the night goes on */
      }
    }
    const snap = snapshot();
    for (const fn of listeners) {
      try {
        fn(snap);
      } catch {
        /* one broken renderer may not take the page down with it */
      }
    }
  }

  function complete(id, value) {
    if (status(id) === 'locked') {
      throw new Error(`cave-flow: "${id}" is locked until "${order[at(id) - 1]}" is done`);
    }
    done.set(id, oneLine(value));
    if (foldOnComplete(id)) open.delete(id);
    else open.add(id);
    const next = current();
    if (next) open.add(next);
    commit();
  }

  function invalidateFrom(id) {
    const from = at(id);
    for (let i = from; i < order.length; i += 1) {
      done.delete(order[i]);
      open.delete(order[i]);
    }
    open.add(id);
    commit();
  }

  function toggle(id) {
    at(id);
    if (open.has(id)) open.delete(id);
    else open.add(id);
    commit();
  }

  function onChange(fn) {
    if (typeof fn !== 'function') throw new TypeError('cave-flow: onChange wants a function');
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  /* Restore, or start the night fresh. Every branch below that returns without
     touching state is a deliberate fresh start: a half-read key is worse than
     no key, because it would leave `current()` pointing at a stage nobody is
     at. */
  function restore() {
    if (!storage) return;
    let raw;
    try {
      raw = storage.getItem(key);
    } catch {
      return;
    }
    if (raw == null) return;

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;

    const stored = parsed.done;
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return;
    for (const [id, value] of Object.entries(stored)) {
      if (!known.has(id) || typeof value !== 'string') return;
    }
    if (parsed.expanded != null && !Array.isArray(parsed.expanded)) return;

    open.clear();
    for (const [id, value] of Object.entries(stored)) done.set(id, value);
    if (Array.isArray(parsed.expanded)) {
      for (const id of parsed.expanded) if (known.has(id)) open.add(id);
    } else {
      const next = current();
      if (next) open.add(next);
    }
    return true;
  }

  /* A missing key and an unreadable one both start the night fresh; a stored
     key keeps the reader's own folds, even the empty one. */
  if (!restore()) {
    const next = current();
    if (next) open.add(next);
  }

  return {
    status,
    complete,
    summary,
    current,
    invalidateFrom,
    expanded,
    toggle,
    onChange,
    snapshot,
  };
}
