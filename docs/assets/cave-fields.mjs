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
 * mounts and every stage holds on to it, so a switch is a reload rather than a
 * hot swap that would leave half the stages on the old corpus. Precedence: the
 * URL (a shared link means what it says), then Dig's FIRST category that a
 * field claims (cs.AI first → AI, quant-ph first → quantum), then the reader's
 * last choice, then quantum. A switch therefore reorders Dig's categories, so
 * the list and the field never disagree.
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
 * The field that claims the first claimed category in the list, or null when
 * no field claims any of them. Order is the reader's: ['cs.AI', 'quant-ph'] is
 * AI, ['quant-ph', 'cs.AI'] is quantum.
 */
export function fieldForCategories(categories) {
  for (const code of Array.isArray(categories) ? categories : []) {
    const field = FIELDS.find((f) => f.categories.includes(code));
    if (field) return field;
  }
  return null;
}

/** Every field the list touches, in the order its categories first appear. */
export function fieldsInCategories(categories) {
  const found = [];
  for (const code of Array.isArray(categories) ? categories : []) {
    const field = FIELDS.find((f) => f.categories.includes(code));
    if (field && !found.includes(field)) found.push(field);
  }
  return found;
}

/**
 * The list reordered so `field` leads it: the field's own codes move to the
 * front (in the reader's order), the rest keep theirs. A list that has none
 * of the field's codes becomes the field's defaults.
 */
export function alignCategories(categories, field) {
  const list = Array.isArray(categories) ? categories : [];
  if (!field) return [...list];
  const own = list.filter((code) => field.categories.includes(code));
  if (!own.length) return [...field.categories];
  return [...own, ...list.filter((code) => !field.categories.includes(code))];
}

/**
 * Tonight's field: `?field=` → Dig's first claimed category → the stored
 * choice → quantum. `search` is `location.search`; `stored` the FIELD_KEY
 * value; `digCategories` the list Dig remembers.
 */
export function chooseField({ search = '', stored = null, digCategories = [] } = {}) {
  return fieldFromUrl(search)
    ?? fieldForCategories(digCategories)
    ?? fieldById(stored)
    ?? DEFAULT_FIELD;
}

/** The field a `?field=` names, or null. */
export function fieldFromUrl(search) {
  try {
    return fieldById(new URLSearchParams(search).get('field'));
  } catch (_) {
    return null; /* a search string URLSearchParams will not read is no field */
  }
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

/**
 * `href` without `?field=`. A switch reloads on this: Dig's reordered
 * categories carry the choice, and a param left in the bar would outrank the
 * reader's next reorder.
 */
export function withoutField(href) {
  const url = new URL(href);
  url.searchParams.delete('field');
  return url.toString();
}
