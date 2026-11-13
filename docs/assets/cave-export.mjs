/**
 * cave-export — take tonight's picked stones out of the cave.
 *
 * Stage 7 is the exit: a pick is only worth making if it lands somewhere the
 * reader can work from tomorrow. So this module turns `night.stones` into the
 * three formats that need no account: RIS (Zotero imports it in one click),
 * BibTeX (for LaTeX users and a plain-text paste), and a Markdown reading list
 * (for Obsidian / Notion / a repo). The diamond, when it has been mined, rides
 * along: its summary becomes RIS `N1` and the Markdown bullets.
 *
 * Everything except `downloadText` is a pure string builder, so the tests feed
 * hand-written papers in and compare text out. `downloadText` is the only DOM
 * code and returns false in Node rather than reaching for a `document` that
 * is not there.
 *
 * Paper input (a `night.stones` entry, optionally with a diamond):
 *   { id, title, abstract, authors: string[] | string, cat,
 *     diamond?: { summary, takeaways[], questions[], readIf } }
 */

const RIS_TYPE = 'RPRT';       // safe everywhere; Zotero files it as a Report
const RIS_GENRE = 'Preprint';
const RIS_PUBLISHER = 'arXiv';

/** The id without its version: DOIs and URLs point at the paper, not a draft. */
function baseId(id) {
  return String(id == null ? '' : id).trim().replace(/v\d+$/i, '');
}

/**
 * arXiv id → publication year.
 *
 * New-style ids start with yymm ("2511.01234" → 2025). Old-style ids carry the
 * same yymm after the slash ("quant-ph/0101001" → 2001), but their two-digit
 * years run 91–07, so 99 means 1999, not 2099.
 */
function yearOf(id) {
  const base = baseId(id);
  const part = base.slice(base.lastIndexOf('/') + 1);
  const m = /^(\d{2})/.exec(part);
  if (!m) return '';
  const yy = Number(m[1]);
  const oldStyle = base.includes('/');
  return String(oldStyle && yy > 7 ? 1900 + yy : 2000 + yy);
}

/** `authors` is a list in `night.stones`; accept a bare string too. */
function authorList(authors) {
  if (Array.isArray(authors)) {
    return authors.map((a) => String(a == null ? '' : a).trim()).filter(Boolean);
  }
  if (typeof authors === 'string') {
    // Semicolons or a written "and" separate names; a comma is kept, because
    // in "Last, First" it belongs to the name.
    return authors.split(/\s*;\s*|\s+and\s+/i).map((a) => a.trim()).filter(Boolean);
  }
  return [];
}

/**
 * RIS wants "Last, First". A single-word name has no split to make, and a
 * name that already carries a comma is left alone rather than reordered.
 */
function risAuthor(name) {
  if (name.includes(',') || !/\s/.test(name)) return name;
  const parts = name.split(/\s+/);
  const last = parts.pop();
  return last + ', ' + parts.join(' ');
}

function risField(tag, value) {
  // One line per field: an abstract with a wrapped line would otherwise split
  // the record and a Zotero import would stop reading there.
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return text ? tag + '  - ' + text : '';
}

/** One RIS record, CRLF-terminated, ready to append to a Zotero import. */
function risRecord(p) {
  const id = baseId(p && p.id);
  const year = yearOf(id);
  const lines = [
    risField('TY', RIS_TYPE),
    risField('M3', RIS_GENRE),
    risField('PB', RIS_PUBLISHER),
    risField('TI', p && p.title),
    ...authorList(p && p.authors).map((a) => risField('AU', risAuthor(a))),
    risField('PY', year),
    risField('AB', p && p.abstract),
    risField('UR', id ? 'https://arxiv.org/abs/' + id : ''),
    risField('DO', id ? '10.48550/arXiv.' + id : ''),
    risField('N1', p && p.diamond && p.diamond.summary),
    'ER  - ',
  ].filter(Boolean);
  return lines.join('\r\n') + '\r\n';
}

/** Papers → one RIS document. Blank line between records, as importers expect. */
export function toRis(papers) {
  return (papers || []).map(risRecord).join('\r\n');
}

/** ASCII, lowercased, combining marks stripped — BibTeX keys and files alike. */
function ascii(s) {
  return String(s == null ? '' : s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function lastNameOf(name) {
  const clean = String(name == null ? '' : name).trim();
  if (!clean) return '';
  const comma = clean.indexOf(',');
  if (comma > 0) return clean.slice(0, comma);
  const parts = clean.split(/\s+/);
  return parts[parts.length - 1];
}

/** First readable word of the title, so `$\alpha$-stable` reads as "alpha". */
function firstWordOf(title) {
  const words = ascii(title).replace(/[^a-z0-9]+/g, ' ').trim();
  return words.split(' ')[0] || 'untitled';
}

function keyBase(p) {
  const year = yearOf(p && p.id) || 'nd';
  const who = ascii(lastNameOf(authorList(p && p.authors)[0])).replace(/[^a-z0-9]/g, '');
  return (who || 'anon') + year + firstWordOf(p && p.title);
}

/** "key", "keya", "keyb", … for papers that would otherwise collide. */
function uniqueKey(base, used) {
  let key = base;
  let i = 0;
  while (used.has(key)) {
    key = base + String.fromCharCode(97 + (i % 26));
    if (i >= 26) key += String(Math.floor(i / 26));
    i += 1;
  }
  used.add(key);
  return key;
}

/** `{ } % & # _` are the characters that break a BibTeX value. */
function bibEscape(value) {
  return String(value == null ? '' : value).replace(/[{}%&#_]/g, (ch) => '\\' + ch);
}

/** Braces go around the title so a capitalised word survives BibTeX's casing. */
function bibField(name, value) {
  const text = String(value == null ? '' : value);
  return text ? '  ' + name + ' = {' + text + '},' : '';
}

function bibEntry(p, key) {
  const id = baseId(p && p.id);
  const year = yearOf(id);
  const authors = authorList(p && p.authors);
  const fields = [
    bibField('title', bibEscape(p && p.title)),
    bibField('author', authors.map(bibEscape).join(' and ')),
    bibField('year', year),
    bibField('eprint', id),
    bibField('archivePrefix', 'arXiv'),
    bibField('primaryClass', p && p.cat),
    bibField('doi', id ? '10.48550/arXiv.' + id : ''),
    bibField('url', id ? 'https://arxiv.org/abs/' + id : ''),
    bibField('abstract', bibEscape(p && p.abstract)),
  ].filter(Boolean);
  // A trailing comma is legal BibTeX and keeps every entry uniform.
  return '@misc{' + key + ',\n' + fields.join('\n') + '\n}';
}

/** Papers → a `.bib` document with collision-free keys. */
export function toBibtex(papers) {
  if (!papers || !papers.length) return '';
  const used = new Set();
  return papers
    .map((p) => bibEntry(p, uniqueKey(keyBase(p), used)))
    .join('\n\n') + '\n';
}

function bulletList(items) {
  if (!Array.isArray(items) || !items.length) return '';
  return items.map((item) => '- ' + String(item).trim()).join('\n');
}

function markdownPaper(p) {
  const id = baseId(p && p.id);
  const title = String((p && p.title) || 'Untitled');
  const url = id ? 'https://arxiv.org/abs/' + id : '';
  const out = ['### ' + (url ? '[' + title + '](' + url + ')' : title), ''];

  const authors = authorList(p && p.authors);
  if (authors.length) out.push('Authors: ' + authors.join(', '), '');

  const d = p && p.diamond;
  if (d) {
    if (d.summary) out.push(String(d.summary).trim(), '');
    const takeaways = bulletList(d.takeaways);
    if (takeaways) out.push('**Takeaways**', '', takeaways, '');
    const questions = bulletList(d.questions);
    if (questions) out.push('**Open questions**', '', questions, '');
  }
  return out.join('\n');
}

/** Papers → a reading list in Markdown, diamonds included when mined. */
export function toMarkdown(papers, { title = 'Reading list' } = {}) {
  const head = '# ' + title;
  const body = (papers || []).map(markdownPaper).join('\n\n');
  return body ? head + '\n\n' + body + '\n' : head + '\n';
}

/**
 * Browser-only: hand the text to the browser as a file download.
 *
 * Returns false where there is no `document` (Node, a worker), so callers can
 * fall back to the clipboard or just keep the string.
 */
export function downloadText(filename, text, mime = 'text/plain') {
  if (typeof document === 'undefined') return false;
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return true;
}
