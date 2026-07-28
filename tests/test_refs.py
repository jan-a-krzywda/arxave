"""The refs stage: fetch a bibliography, match it, store it — and the
connect stage preferring those matches over OpenAlex.
"""
from __future__ import annotations

from arxave import connect, corpus, refs, store

# A corpus with one paper, reachable by DOI, by arXiv id, and by title.
SNAP = corpus.Snapshot(
    ids={'https://openalex.org/W1': 'Petta2005'},
    titles={'Petta2005': 'Coherent Manipulation of Coupled Electron Spins'},
    dois={'10.1126/science.1116955': 'Petta2005'},
    title_index={
        corpus.norm_title('Coherent Manipulation of Coupled Electron Spins'): 'Petta2005'
    },
    synced_at='2026-07-20',
)


def test_snapshot_match_ref_by_each_route():
    assert SNAP.match_ref('10.1126/science.1116955', None, None) == 'Petta2005'
    assert SNAP.match_ref(None, None,
                          'coherent manipulation of coupled electron spins') == 'Petta2005'
    assert SNAP.match_ref('10.9/nope', None, 'unrelated title') is None


def test_refs_stage_stores_matched_bibliography(cfg, monkeypatch):
    parsed = [
        {'raw': 'a', 'ref_doi': '10.1126/science.1116955',
         'ref_arxiv': None, 'ref_title': None},
        {'raw': 'b', 'ref_doi': None, 'ref_arxiv': None, 'ref_title': 'unrelated'},
    ]
    monkeypatch.setattr(refs.arxiv_bib, 'references', lambda aid: parsed)

    with store.connect(cfg.db_path) as conn:
        store.upsert_paper(conn, 'K1', arxiv_id='2401.1', status='filtered')
        assert refs.run(cfg, conn, SNAP) == 1
        stored = store.refs_for(conn, 'K1')

    assert len(stored) == 2
    matched = [r['matched_key'] for r in stored]
    assert 'Petta2005' in matched
    assert matched.count(None) == 1  # the unrelated ref matched nothing


def test_refs_stage_is_idempotent(cfg, monkeypatch):
    calls = []
    monkeypatch.setattr(refs.arxiv_bib, 'references',
                        lambda aid: calls.append(aid) or [
                            {'raw': 'a', 'ref_doi': '10.1126/science.1116955',
                             'ref_arxiv': None, 'ref_title': None}])
    with store.connect(cfg.db_path) as conn:
        store.upsert_paper(conn, 'K1', arxiv_id='2401.1', status='filtered')
        refs.run(cfg, conn, SNAP)
        refs.run(cfg, conn, SNAP)  # second run must not re-fetch
    assert calls == ['2401.1']


def test_connect_prefers_bib_over_openalex(cfg, monkeypatch):
    """When the bibliography already connects a paper, connect must not spend an
    OpenAlex call on it."""
    parsed = [{'raw': 'a', 'ref_doi': '10.1126/science.1116955',
               'ref_arxiv': None, 'ref_title': None}]
    monkeypatch.setattr(refs.arxiv_bib, 'references', lambda aid: parsed)

    def _boom(*a, **k):
        raise AssertionError('OpenAlex must not be called when bib connected')
    monkeypatch.setattr(connect.openalex, 'resolve_by_doi', _boom)

    with store.connect(cfg.db_path) as conn:
        store.upsert_paper(conn, 'K1', arxiv_id='2401.1', status='filtered')
        refs.run(cfg, conn, SNAP)
        assert connect.run(cfg, conn, SNAP) == 1
        row = conn.execute('SELECT * FROM papers WHERE cite_key="K1"').fetchone()

    assert row['centrality'] > 0
    assert store.json_list(row['cited_in_corpus']) == [
        'Coherent Manipulation of Coupled Electron Spins'
    ]


def test_connect_falls_back_to_openalex_when_bib_misses(cfg, monkeypatch):
    """A paper whose bibliography matched nothing still gets the OpenAlex route."""
    monkeypatch.setattr(refs.arxiv_bib, 'references',
                        lambda aid: [{'raw': 'x', 'ref_doi': None,
                                      'ref_arxiv': None, 'ref_title': 'unrelated'}])
    monkeypatch.setattr(connect.openalex, 'resolve_by_doi', lambda dois, **kw: {
        'K1': {'openalex_id': 'https://openalex.org/W50', 'doi': '10.48550/arxiv.2401.1',
               'title': 'p', 'year': 2026,
               'referenced_works': ['https://openalex.org/W1']}})

    with store.connect(cfg.db_path) as conn:
        store.upsert_paper(conn, 'K1', arxiv_id='2401.1', status='filtered')
        refs.run(cfg, conn, SNAP)
        assert connect.run(cfg, conn, SNAP) == 1
        row = conn.execute('SELECT * FROM papers WHERE cite_key="K1"').fetchone()

    assert row['openalex_id'] == 'https://openalex.org/W50'
    assert row['centrality'] > 0
