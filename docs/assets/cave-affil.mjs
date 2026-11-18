/**
 * cave-affil — the last author's short affiliation, for the ranking row.
 *
 * NO FEED CARRIES IT. The announcement RSS and the search API both give names
 * only, and OpenAlex indexes arXiv about six days late, so a lookup by paper
 * finds nothing for tonight. The last author is usually the group's PI, with
 * years of indexed work, so this asks OpenAlex for the PERSON instead: author
 * search, Physics & Astronomy only, last known institution.
 *
 * A COMMON NAME IS LEFT BLANK. "Wei Zhang" is a dozen physicists; when a second
 * author of the same surname and first initial has a real body of work
 * (`RIVAL_SHARE` of the top hit's) at another institution, the row shows
 * nothing rather than a confident wrong answer.
 *
 * Answers are cached per name in `ctx.storage` for `TTL_DAYS`, so a reader's
 * second visit asks about new names only. The pure half — the URL, the pick,
 * the shortening, the cache — is here; the fetch lives in the ranking stage.
 */

/** OpenAlex's author search. */
export const OPENALEX_AUTHORS = 'https://api.openalex.org/authors';

/** Where one name's answer is kept, in `ctx.storage`. */
export const AFFIL_PREFIX = 'arxave-cave-affil:';

/** How long a cached answer (or a cached "don't know") stands. */
export const TTL_DAYS = 30;

/** A namesake with this share of the top hit's works makes the name ambiguous. */
export const RIVAL_SHARE = 0.3;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Lower case, no accents, no punctuation, single spaces. */
function plain(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** `{ surname, initial }` of a name, or null for an empty one. */
export function nameKey(name) {
  const words = plain(name).split(' ').filter(Boolean);
  if (!words.length) return null;
  return { surname: words[words.length - 1], initial: words[0][0] };
}

/** True when two names share the surname and the first initial. */
export function sameName(a, b) {
  const x = typeof a === 'string' ? nameKey(a) : a;
  const y = typeof b === 'string' ? nameKey(b) : b;
  return !!(x && y && x.surname === y.surname && x.initial === y.initial);
}

/** The last name in an author list (an array, or one comma-separated string). */
export function lastAuthor(authors) {
  const list = (Array.isArray(authors) ? authors : String(authors || '').split(/,| and /))
    .map((name) => String(name || '').trim())
    .filter(Boolean);
  return list.length ? list[list.length - 1] : '';
}

/** The search for one name, Physics & Astronomy (OpenAlex field 31) only. */
export function authorQueryUrl(name, base = OPENALEX_AUTHORS) {
  return base + '?search=' + encodeURIComponent(String(name || '').trim()) +
    '&filter=topics.field.id:31&per-page=5' +
    '&select=display_name,works_count,last_known_institutions';
}

/** An institution's name as a row can hold it: no "(United States)", no "The". */
export function shortAffil(name) {
  return String(name || '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .replace(/^the\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const firstInst = (author) => {
  const list = author && Array.isArray(author.last_known_institutions)
    ? author.last_known_institutions : [];
  return list.length && list[0] ? String(list[0].display_name || '') : '';
};

/**
 * The short affiliation OpenAlex's answer gives for `name`, or '' when it gives
 * none or the name is ambiguous (see RIVAL_SHARE).
 */
export function pickAffiliation(payload, name) {
  const want = nameKey(name);
  const results = payload && Array.isArray(payload.results) ? payload.results : [];
  if (!want) return '';
  const same = results.filter((author) => author && sameName(String(author.display_name || ''), want));
  if (!same.length) return '';
  const top = same[0];
  const inst = firstInst(top);
  if (!inst) return '';
  const floor = RIVAL_SHARE * (Number(top.works_count) || 0);
  const rival = same.slice(1).some((author) =>
    (Number(author.works_count) || 0) >= floor && firstInst(author) && firstInst(author) !== inst);
  return rival ? '' : shortAffil(inst);
}

/* ── the cache ──────────────────────────────────────────────────────────── */

/** The storage key for one name: the same person however the feed spells them. */
export function affilKey(name) {
  return AFFIL_PREFIX + plain(name);
}

/**
 * The cached answer for `name`: a string ('' is a cached "don't know"), or null
 * when never asked, expired, or the storage is missing or holds junk.
 */
export function readCachedAffil(storage, name, now = Date.now()) {
  if (!storage || typeof storage.getItem !== 'function') return null;
  try {
    const raw = storage.getItem(affilKey(name));
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed.v !== 'string' || !Number.isFinite(parsed.t)) return null;
    return now - parsed.t > TTL_DAYS * DAY_MS ? null : parsed.v;
  } catch (_) {
    return null;
  }
}

/** Write an answer back; a full quota or a private-mode storage is not fatal. */
export function writeCachedAffil(storage, name, value, now = Date.now()) {
  if (!storage || typeof storage.setItem !== 'function') return;
  try {
    storage.setItem(affilKey(name), JSON.stringify({ v: String(value || ''), t: now }));
  } catch (_) {
    /* the row still shows what was just found */
  }
}
