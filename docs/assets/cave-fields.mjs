/**
 * cave-fields — which field's pack the page reads tonight: quantum or AI.
 *
 * A FIELD IS A PACK, NOT A TOPIC LIST. Match, Impact and Surprise are read
 * against a background corpus, the tree's centroids live in that corpus'
 * space, and the axes (Theory ↔ Experiment, ML for quantum) are fitted on it.
 * Swapping the tree alone would grade an AI paper against quantum papers, so a
 * field swaps all four files at once: `corpus.json`, `corpus.vec.bin`,
 * `topics.json` and `axes.json`, from its own folder under the corpus base.
 * A pack without `axes.json` simply has no sliders for them — the page
 * already hides an axis that does not ship.
 *
 * THE FIELD IS CHOSEN ONCE, AT LOAD. The world is loaded before any stage
 * mounts and every stage holds on to it, so a switch is a reload with
 * `?field=` rather than a hot swap that would leave half the stages on the old
 * corpus. Precedence: the URL (a shared link means what it says), then the
 * reader's last choice, then the categories Dig last scouted, then quantum.
 *
 * Pure: no DOM. `cave.js` and the Priorities stage do the reading and writing.
 */

/** The packs. `dir` is relative to the corpus base; '' is the original pack. */
export const FIELDS = Object.freeze([
  Object.freeze({
    id: 'quantum',
    label: 'Quantum',
    dir: '',
    categories: Object.freeze(['cond-mat.mes-hall', 'quant-ph']),
  }),
  Object.freeze({
    id: 'ai',
    label: 'AI',
    dir: 'ai/',
    categories: Object.freeze(['cs.AI', 'cs.LG']),
  }),
]);

/** Where the reader's last explicit choice is remembered. */
export const FIELD_KEY = 'arxave-cave-field';

/** The default field, and the one an unknown id falls back to. */
export const DEFAULT_FIELD = FIELDS[0];

/** A field by id, or null. */
export function fieldById(id) {
  return FIELDS.find((field) => field.id === id) ?? null;
}

/**
 * The field whose categories the list overlaps most, or null when it touches
 * none. Ties go to the earlier field, so quantum wins an even split.
 */
export function fieldForCategories(categories) {
  const list = Array.isArray(categories) ? categories : [];
  let best = null;
  let bestHits = 0;
  for (const field of FIELDS) {
    const hits = list.filter((code) => field.categories.includes(code)).length;
    if (hits > bestHits) {
      best = field;
      bestHits = hits;
    }
  }
  return best;
}

/**
 * Tonight's field: `?field=` → the stored choice → Dig's last categories →
 * quantum. `search` is `location.search`; `stored` the FIELD_KEY value;
 * `digCategories` the list Dig remembers.
 */
export function chooseField({ search = '', stored = null, digCategories = [] } = {}) {
  let fromUrl = null;
  try {
    fromUrl = new URLSearchParams(search).get('field');
  } catch (_) { /* a search string URLSearchParams will not read is no field */ }
  return fieldById(fromUrl)
    ?? fieldById(stored)
    ?? fieldForCategories(digCategories)
    ?? DEFAULT_FIELD;
}

/** The pack's folder under the corpus base, with exactly one slash between. */
export function fieldBase(base, field) {
  const root = String(base || '/assets/corpus/');
  const dir = field?.dir ?? '';
  return (root.endsWith('/') ? root : root + '/') + dir;
}

/**
 * A storage key per field. Quantum keeps the key it always had, so a reader's
 * saved weights survive this change; any other field gets its own key, so
 * weighing AI topics never overwrites the quantum tree's settings.
 */
export function fieldKey(key, field) {
  return !field || field.id === DEFAULT_FIELD.id ? key : key + '-' + field.id;
}

/** `href` with `?field=` set to `id`; the hash and other params are kept. */
export function fieldHref(href, id) {
  const url = new URL(href);
  url.searchParams.set('field', id);
  return url.toString();
}
