"""The measured OpenAlex behaviour that shaped connect.py.

A resolved preprint whose record carries no reference list is the common case,
not an edge case — see the module docstring in connect.py for the measurement.
These tests pin the distinction between "never found it" and "found it but it
told us nothing", because the two need different follow-up.
"""
from __future__ import annotations

from arxave import connect, corpus, store

SNAP = corpus.Snapshot(
    ids={'https://openalex.org/W1': 'Petta2005'},
    titles={'Petta2005': 'Coherent manipulation'},
    synced_at='2026-07-20',
)


def _resolved(refs):
    return lambda dois, **kw: {'K1': {
        'openalex_id': 'https://openalex.org/W50',
        'doi': '10.48550/arxiv.2401.1',
        'title': 'A preprint',
        'year': 2026,
        'referenced_works': refs,
    }}


def test_a_stub_record_still_stores_its_openalex_id(cfg, monkeypatch):
    """Resolved-but-no-references must keep the ID: a later re-run, once the
    published version lands, needs it — and it proves we did find the paper."""
    monkeypatch.setattr(connect.openalex, 'resolve_by_doi', _resolved([]))
    with store.connect(cfg.db_path) as conn:
        store.upsert_paper(conn, 'K1', arxiv_id='2401.1', status='filtered')
        assert connect.run(cfg, conn, SNAP) == 0
        row = conn.execute('SELECT * FROM papers WHERE cite_key="K1"').fetchone()

    assert row['openalex_id'] == 'https://openalex.org/W50'
    assert row['doi'] == '10.48550/arxiv.2401.1'
    # Distinguishes a stub from a real zero-overlap result.
    assert row['centrality'] is None
    assert row['cited_in_corpus'] is None


def test_references_that_miss_the_corpus_score_zero_not_null(cfg, monkeypatch):
    """A real reference list with no overlap is genuine information: this paper
    cites nothing in the library. That is a 0.0, not an absent signal."""
    monkeypatch.setattr(
        connect.openalex, 'resolve_by_doi', _resolved(['https://openalex.org/W999'])
    )
    with store.connect(cfg.db_path) as conn:
        store.upsert_paper(conn, 'K1', arxiv_id='2401.1', status='filtered')
        assert connect.run(cfg, conn, SNAP) == 0
        row = conn.execute('SELECT * FROM papers WHERE cite_key="K1"').fetchone()

    assert row['centrality'] == 0.0
    assert store.json_list(row['cited_in_corpus']) == []


def test_a_real_overlap_scores_and_names_the_papers(cfg, monkeypatch):
    monkeypatch.setattr(
        connect.openalex, 'resolve_by_doi',
        _resolved(['https://openalex.org/W1', 'https://openalex.org/W999']),
    )
    with store.connect(cfg.db_path) as conn:
        store.upsert_paper(conn, 'K1', arxiv_id='2401.1', status='filtered')
        assert connect.run(cfg, conn, SNAP) == 1
        row = conn.execute('SELECT * FROM papers WHERE cite_key="K1"').fetchone()

    assert row['centrality'] > 0
    assert store.json_list(row['cited_in_corpus']) == ['Coherent manipulation']


def test_brief_prompt_does_not_invite_a_disconnection_claim(cfg):
    """Without overlap the model must not assert the paper is unrelated —
    absence of a reference list is an artifact of the index, not a fact about
    the paper."""
    import sqlite3

    with store.connect(cfg.db_path) as conn:
        store.upsert_paper(conn, 'K1', arxiv_id='2401.1', title='T', summary='s',
                           research_question='q', contribution='c',
                           topics=['charge noise'], status='ranked')
        row: sqlite3.Row = conn.execute(
            'SELECT * FROM papers WHERE cite_key="K1"'
        ).fetchone()

    from arxave import brief
    prompt = brief._prompt(row)
    assert 'carries NO information' in prompt
    assert 'Do not say the paper is' in prompt
