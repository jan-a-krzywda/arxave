"""Pull a paper's own bibliography from its arXiv e-print source.

Why this exists: the citation route in `connect.py` reads OpenAlex, and OpenAlex
carries no reference list for fresh preprints (measured — see that module's
docstring). But the paper *ships* its bibliography inside its LaTeX source: the
compiled `.bbl`, or a `.bib`, is in the e-print tarball at posting time, with
zero indexing lag. Reading it directly is the only citation source that works on
the day-one firehose sqout prioritizes.

The tarball is messy: it may be gzipped tar (multi-file source), a single
gzipped `.tex`, plain text, or a bare PDF (withdrawn / PDF-only — no source to
read). Parsing compiled `.bbl` LaTeX is inherently lossy, so this module is
best-effort by design: it extracts arXiv IDs, DOIs, and titles where it can and
records the raw entry always. A miss is ordinary, never an error — the caller
falls back to OpenAlex.

Structured as three pure-ish layers so the parser is unit-testable offline:
`fetch_eprint` (network) -> `extract_source` (archive) -> `parse_bibliography`.
"""
from __future__ import annotations

import gzip
import io
import re
import tarfile
import urllib.error
import urllib.request

EPRINT_URL = 'https://arxiv.org/e-print/{}'

# Source files worth reading, best first. The compiled .bbl is the cleanest
# citation list; a .bib is structured; .tex is the last resort (inline
# \bibitem or \bibliography that never got a separate .bbl).
_SOURCE_EXTS = ('.bbl', '.bib', '.tex')

# arXiv identifiers, new (2401.12345) and old (cond-mat/0512345) style.
_ARXIV_NEW = re.compile(r'(?:arxiv[:\s]|abs/|/pdf/)\s*(\d{4}\.\d{4,5})', re.I)
_ARXIV_OLD = re.compile(r'\b([a-z][a-z\-]+(?:\.[A-Z]{2})?/\d{7})\b')
# DOIs. Trailing brace/quote/punctuation is stripped by the caller.
_DOI = re.compile(r'\b(10\.\d{4,9}/[^\s{}"\'<>,]+)', re.I)
# .bib title field: title = {...} or title = "...". Non-greedy, tolerates newlines.
_BIB_TITLE = re.compile(r'title\s*=\s*[{"](.+?)[}"]\s*,', re.I | re.S)


class BibError(Exception):
    """Network failure fetching the e-print. Callers treat this as non-fatal."""


def fetch_eprint(arxiv_id: str, *, timeout: int = 30) -> bytes:
    """Download the raw e-print archive for a bare arXiv id."""
    url = EPRINT_URL.format(arxiv_id)
    req = urllib.request.Request(url, headers={'User-Agent': 'sqout'})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read()
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise BibError(f'could not fetch e-print for {arxiv_id}: {exc}') from exc


def extract_source(archive: bytes) -> str:
    """Return the concatenated bibliography-bearing source text, or ''.

    Handles the shapes arXiv actually serves: gzipped tar, single gzipped file,
    uncompressed tar, plain text, or a PDF (no source -> '')."""
    if archive[:5] == b'%PDF-':
        return ''  # PDF-only submission — no LaTeX source to read.

    blob = archive
    if archive[:2] == b'\x1f\x8b':  # gzip magic
        try:
            blob = gzip.decompress(archive)
        except (OSError, EOFError):
            return ''

    # Multi-file tar? Read every source file, best extension first.
    try:
        tar = tarfile.open(fileobj=io.BytesIO(blob))
    except tarfile.TarError:
        tar = None

    if tar is not None:
        chosen: list[str] = []
        with tar:
            members = [m for m in tar.getmembers() if m.isfile()]
            for ext in _SOURCE_EXTS:
                for m in members:
                    if m.name.lower().endswith(ext):
                        f = tar.extractfile(m)
                        if f is not None:
                            chosen.append(f.read().decode('utf-8', 'ignore'))
                if chosen and ext != '.tex':
                    # Prefer .bbl/.bib alone; only fall through to .tex if none.
                    break
        return '\n'.join(chosen)

    # Not a tar — a single decompressed source file (or plain text).
    return blob.decode('utf-8', 'ignore')


def _clean_doi(raw: str) -> str:
    return raw.rstrip('.,;)}]"\'').lower()


def _first(pattern: re.Pattern[str], text: str) -> str | None:
    m = pattern.search(text)
    return m.group(1) if m else None


def _split_entries(text: str) -> list[str]:
    """Break source text into one chunk per cited work.

    `.bbl` uses `\\bibitem`; `.bib` uses `@type{`. Falling back to the whole
    text as a single entry still lets the id/doi scanners find references, just
    without per-entry granularity."""
    if '\\bibitem' in text:
        parts = re.split(r'\\bibitem', text)
        return [p for p in parts[1:] if p.strip()]
    if re.search(r'@\w+\s*\{', text):
        parts = re.split(r'(?=@\w+\s*\{)', text)
        return [p for p in parts if p.strip() and p.lstrip().startswith('@')]
    return [text] if text.strip() else []


def parse_bibliography(text: str) -> list[dict]:
    """Parse source text into reference records.

    Each record is {raw, ref_doi, ref_arxiv, ref_title} with None for anything
    not found. Best-effort: an entry with no id/doi/title is still returned so
    the raw bibliography survives for a human or a later pass."""
    entries = _split_entries(text)
    out: list[dict] = []
    for chunk in entries:
        doi = _first(_DOI, chunk)
        arxiv = _first(_ARXIV_NEW, chunk) or _first(_ARXIV_OLD, chunk)
        title = _first(_BIB_TITLE, chunk)
        out.append({
            'raw': chunk.strip()[:2000],
            'ref_doi': _clean_doi(doi) if doi else None,
            'ref_arxiv': arxiv,
            'ref_title': ' '.join(title.split()) if title else None,
        })
    return out


def references(arxiv_id: str) -> list[dict]:
    """End-to-end: fetch, extract, parse. Raises BibError only on network fail."""
    return parse_bibliography(extract_source(fetch_eprint(arxiv_id)))
