from __future__ import annotations

import pytest

from arxave import openalex


# These mirror the corpus repo's own selfcheck cases — the vendored client must
# normalize identically, or records produced here won't match works.json.
@pytest.mark.parametrize('raw,expected', [
    ('https://doi.org/10.1103/PhysRevB.86.045316', '10.1103/physrevb.86.045316'),
    ('http://dx.doi.org/10.1103/PhysRevB.86.045316', '10.1103/physrevb.86.045316'),
    ('DOI: 10.1145/258533.258579', '10.1145/258533.258579'),
    ('arXiv:1234', ''),
    ('', ''),
    (None, ''),
    ('not-a-doi', ''),
])
def test_normalize_doi(raw, expected):
    assert openalex.normalize_doi(raw) == expected


def test_arxiv_doi_lowercases_and_prefixes():
    """The DataCite form is 10.48550/arXiv.<id>, but OpenAlex stores it folded."""
    assert openalex.arxiv_doi('2401.12345') == '10.48550/arxiv.2401.12345'
    assert openalex.arxiv_doi('2401.12345v3') == '10.48550/arxiv.2401.12345'


def test_arxiv_doi_of_empty_is_empty():
    assert openalex.arxiv_doi('') == ''
    assert openalex.arxiv_doi(None) == ''


def test_raw_arxiv_id_would_not_survive_normalization():
    """Guards the trap: hand OpenAlex the bare ID and it silently drops out."""
    assert openalex.normalize_doi('2401.12345') == ''
    assert openalex.arxiv_doi('2401.12345') != ''


def test_overlap_maps_to_cite_keys_and_dedupes():
    corpus_ids = {'W1': 'Petta2005', 'W2': 'Loss1998'}
    refs = ['W1', 'W9', 'W2', 'W1']
    assert openalex.overlap(refs, corpus_ids) == ['Petta2005', 'Loss1998']


def test_overlap_of_nothing():
    assert openalex.overlap([], {'W1': 'K'}) == []
    assert openalex.overlap(None, {'W1': 'K'}) == []
    assert openalex.overlap(['W9'], {'W1': 'K'}) == []


def test_resolve_by_doi_batches_and_maps_back(monkeypatch):
    calls = []

    def fake_get(url, **kwargs):
        calls.append(url)
        return {'results': [{
            'id': 'https://openalex.org/W1',
            'doi': 'https://doi.org/10.48550/arxiv.2401.00001',
            'title': 'A paper',
            'publication_year': 2024,
            'referenced_works': ['https://openalex.org/W7'],
        }]}

    monkeypatch.setattr(openalex, '_get_json', fake_get)
    monkeypatch.setattr(openalex.time, 'sleep', lambda _: None)

    dois = {f'K{i}': f'10.48550/arxiv.2401.{i:05d}' for i in range(120)}
    resolved = openalex.resolve_by_doi(dois, mailto='t@example.com')

    assert len(calls) == 3  # 120 DOIs at 50/batch
    assert 't%40example.com' in calls[0] or 't@example.com' in calls[0]
    assert resolved['K1']['openalex_id'] == 'https://openalex.org/W1'
    assert resolved['K1']['doi'] == '10.48550/arxiv.2401.00001'
    assert resolved['K1']['referenced_works'] == ['https://openalex.org/W7']


def test_resolve_by_doi_skips_unresolvable_dois(monkeypatch):
    monkeypatch.setattr(openalex, '_get_json', lambda url, **kw: {'results': []})
    monkeypatch.setattr(openalex.time, 'sleep', lambda _: None)
    # An unindexed paper is simply absent — the normal case for fresh preprints.
    assert openalex.resolve_by_doi({'K1': '10.48550/arxiv.2401.1'},
                                   mailto='t@example.com') == {}


def test_resolve_by_doi_ignores_keys_without_a_doi(monkeypatch):
    called = []
    monkeypatch.setattr(openalex, '_get_json',
                        lambda url, **kw: called.append(url) or {'results': []})
    assert openalex.resolve_by_doi({'K1': ''}, mailto='t@example.com') == {}
    assert called == []  # no request at all
