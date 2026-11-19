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
 * THE SAME ANSWER ALSO CARRIES THE H-INDEX, for the senior-author bonus: the
 * same search asks for `summary_stats`, and `explainHIndex` reads it off the
 * same candidate under the same ambiguity rule, saying why when there is none.
 * `authorSignal` turns an h into the 0..1 signal the order key wants.
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

/** The letters NFD cannot decompose (`ł`, `ø`, `ß`…), as ASCII. */
const LETTERS = { ß: 'ss', æ: 'ae', œ: 'oe', þ: 'th', ø: 'o', đ: 'd', ð: 'd', ł: 'l', ı: 'i' };

/**
 * Lower case, no accents, no punctuation, single spaces.
 *
 * arXiv writes author lines in LaTeX — `Szyma\'nski`, `B{\o}ggild` — and a
 * backslash left to the punctuation cut becomes a space, so the surname never
 * matches the one OpenAlex indexes. Every accent form is unwrapped to its base
 * letter first; grouping braces are dropped rather than spaced, or `{\'n}`
 * would split the name in two. A trailing generational suffix (`Smith Jr.`) is
 * not a surname either.
 */
function plain(text) {
  return String(text || '')
    /* `\ss`, `\o`, `\l`, `\ae`, `\i`: whole-letter commands, not accents. The
       brace still counts as a boundary, so `{\o}stergaard` keeps its o. */
    .replace(/\\(ss|ae|AE|o|O|l|L|i)(?![A-Za-z])/g, (_, cmd) => cmd.toLowerCase())
    /* `\'n`, `\"o`, `\v{s}`, `\c{c}`, `\c c`, `\H{o}`, `\u{g}`, `\r{a}` … */
    .replace(/\\(?:v|c|H|u|r|['"^`~.=])\s*\{?\s*([A-Za-z])\}?/g, '$1')
    /* Grouping braces are dropped, not spaced, or `{\'n}` would split a name. */
    .replace(/[{}]/g, '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[ßæœþøđðłı]/g, (ch) => LETTERS[ch])
    .replace(/[^a-z\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s+(?:iii|ii|jr|sr)$/, '');
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
    '&select=display_name,works_count,last_known_institutions,summary_stats';
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
 * The top same-name hit in `payload` for `name`, or null, with the reason when
 * it is null: no same-name hit at all, or a rival namesake (see RIVAL_SHARE).
 * The candidate set and the rival rule are shared by `pickAffiliation` and
 * `explainHIndex` so the two never disagree about who the last author is.
 */
function topNamesake(payload, name) {
  const want = nameKey(name);
  const results = payload && Array.isArray(payload.results) ? payload.results : [];
  if (!want) return { top: null, why: 'no-match' };
  const same = results.filter((author) => author && sameName(String(author.display_name || ''), want));
  if (!same.length) return { top: null, why: 'no-match' };
  const top = same[0];
  const inst = firstInst(top);
  const floor = RIVAL_SHARE * (Number(top.works_count) || 0);
  const rival = same.slice(1).some((author) =>
    (Number(author.works_count) || 0) >= floor && firstInst(author) && firstInst(author) !== inst);
  return rival ? { top: null, why: 'ambiguous' } : { top, why: null };
}

/**
 * The short affiliation OpenAlex's answer gives for `name`, or '' when it gives
 * none or the name is ambiguous (see RIVAL_SHARE).
 */
export function pickAffiliation(payload, name) {
  const top = topNamesake(payload, name).top;
  if (!top) return '';
  const inst = firstInst(top);
  return inst ? shortAffil(inst) : '';
}

/**
 * The h-index OpenAlex's answer gives for `name`, and the reason when it gives
 * none: 'no-match' (nobody of that surname and first initial), 'ambiguous' (a
 * rival namesake, see RIVAL_SHARE), or 'no-hindex' (the hit carries no number).
 * `why` is null exactly when `h` is a number. An affiliation is not needed for
 * an h-index, so a top hit with no known institution still answers.
 */
export function explainHIndex(payload, name) {
  const { top, why } = topNamesake(payload, name);
  if (!top) return { h: null, why };
  const h = top.summary_stats ? top.summary_stats.h_index : null;
  return typeof h === 'number' && Number.isFinite(h) ? { h, why: null } : { h: null, why: 'no-hindex' };
}

/** The h-index alone, or null — `explainHIndex`'s `h`. */
export function pickHIndex(payload, name) {
  return explainHIndex(payload, name).h;
}

/**
 * An h-index as the order key's bonus scale: 0..1, saturating at
 * `hSaturation` (60 by default). null (or junk) is "unknown" — a missing
 * lookup never penalises.
 */
export function authorSignal(h, hSaturation = 60) {
  if (h === null || h === undefined) return null;
  const value = Number(h);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.min(Math.log1p(value) / Math.log1p(hSaturation), 1);
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
