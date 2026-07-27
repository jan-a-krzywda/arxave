"""Minimal OpenAlex client — DOI batch resolution with references.

Origin note: the request shapes, the `select` field list, the 50-DOI batch
size, and the emitted record schema deliberately match SpinLib's
`scripts/oa_fetch.py`, so records produced here stay interchangeable with the
corpus's `works.json`. This is a re-implementation, not an import: arxave does
not depend on SpinLib at runtime. If OpenAlex changes its API shape, that file
is the other place worth looking.

Not carried over from oa_fetch.py: BibTeX parsing, the title-search fallback,
and its `main()`. Arxave derives DOIs from arXiv IDs directly, so it needs
neither — and `main()` carries a resume guard that skips newly added entries
once its cache is populated.
"""
from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Iterable

API = 'https://api.openalex.org/works'
SELECT = 'id,doi,title,publication_year,referenced_works'
DOI_BATCH = 50
BATCH_PAUSE_S = 0.15


class OpenAlexError(Exception):
    """Network or API failure. Callers treat this as non-fatal."""


def normalize_doi(raw: str | None) -> str:
    """Strip URL/scheme wrappers, return a bare lowercased '10.x/...' or ''.

    Note the lowercasing: an arXiv DOI built as '10.48550/arXiv.2401.12345'
    comes back as '10.48550/arxiv.2401.12345'. That is the form OpenAlex
    stores, so pass the normalized value to the filter.
    """
    if not raw:
        return ''
    s = raw.strip().lower()
    s = re.sub(r'^https?://(dx\.)?doi\.org/', '', s)
    s = re.sub(r'^doi:\s*', '', s).strip()
    return s if s.startswith('10.') else ''


def arxiv_doi(arxiv_id: str) -> str:
    """arXiv ID -> its DataCite DOI, normalized.

    arXiv preprints carry a DOI of the form 10.48550/arXiv.<id>, which
    OpenAlex indexes — so a preprint resolves through the same DOI path as a
    journal article. Passing the raw arXiv ID instead would not: it fails the
    '10.' prefix check in normalize_doi and yields ''.
    """
    bare = re.sub(r'v\d+$', '', (arxiv_id or '').strip())
    if not bare:
        return ''
    return normalize_doi(f'10.48550/arXiv.{bare}')


def _get_json(url: str, *, tries: int = 5, timeout: int = 60) -> dict:
    """GET with exponential backoff on 429 and 5xx."""
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'arxave'})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode())
        except urllib.error.HTTPError as exc:
            if exc.code in (429, 500, 502, 503, 504) and attempt < tries - 1:
                time.sleep(2 ** attempt)
                continue
            raise OpenAlexError(f'{exc.code} from OpenAlex: {url}') from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            if attempt < tries - 1:
                time.sleep(2 ** attempt)
                continue
            raise OpenAlexError(f'could not reach OpenAlex: {exc}') from exc
    raise OpenAlexError(f'giving up on {url}')


def _record(work: dict) -> dict[str, Any]:
    """One OpenAlex work -> a works.json-shaped record."""
    return {
        'openalex_id': work['id'],
        'doi': normalize_doi(work.get('doi')),
        'title': work.get('title') or '',
        'year': work.get('publication_year'),
        'referenced_works': work.get('referenced_works', []),
    }


def resolve_by_doi(
    dois_by_key: dict[str, str],
    *,
    mailto: str,
    batch_size: int = DOI_BATCH,
) -> dict[str, dict[str, Any]]:
    """Batch-resolve {cite_key: doi} -> {cite_key: record}.

    Keys whose DOI has no OpenAlex record are simply absent from the result.
    That is the expected outcome for papers posted in the last few days:
    DataCite registration and OpenAlex indexing both lag arXiv posting, so a
    same-day preprint usually is not there yet. Callers must treat a missing
    key as ordinary, not as failure.
    """
    doi_to_keys: dict[str, list[str]] = {}
    for key, doi in dois_by_key.items():
        clean = normalize_doi(doi)
        if clean:
            doi_to_keys.setdefault(clean, []).append(key)

    resolved: dict[str, dict[str, Any]] = {}
    dois = list(doi_to_keys)
    for i in range(0, len(dois), batch_size):
        batch = dois[i:i + batch_size]
        params = {
            'filter': 'doi:' + '|'.join(batch),
            'per-page': batch_size,
            'mailto': mailto,
            'select': SELECT,
        }
        data = _get_json(f'{API}?{urllib.parse.urlencode(params)}')
        for work in data.get('results', []):
            wd = normalize_doi(work.get('doi'))
            for key in doi_to_keys.get(wd, []):
                resolved[key] = _record(work)
        time.sleep(BATCH_PAUSE_S)

    return resolved


def overlap(referenced_works: Iterable[str], corpus_ids: dict[str, str]) -> list[str]:
    """Corpus cite-keys cited by this paper.

    `corpus_ids` maps OpenAlex ID -> corpus cite_key. This is the whole
    mechanism behind the brief's "Connection" line, and it is the same
    reference-overlap that wires a new node into the citation graph.
    """
    seen: list[str] = []
    for ref in referenced_works or ():
        key = corpus_ids.get(ref)
        if key is not None and key not in seen:
            seen.append(key)
    return seen
