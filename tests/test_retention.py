"""The rolling-window prune: drop old papers and their children, keep recent
ones, and never prune a paper whose publication date is unknown.
"""
from __future__ import annotations

from arxave import store


def _seed(conn):
    # published far in the past -> should be pruned
    store.upsert_paper(conn, 'Old2020', arxiv_id='2001.1',
                       published='2020-01-01', status='briefed')
    store.replace_refs(conn, 'Old2020', [
        {'raw': 'r', 'ref_doi': '10.1/x', 'ref_arxiv': None,
         'ref_title': None, 'matched_key': None, 'source': 'eprint'},
    ])
    conn.execute("INSERT INTO embeddings (cite_key, dim, vector) VALUES ('Old2020', 1, X'00')")
    # published recently -> should survive
    store.upsert_paper(conn, 'New2026', arxiv_id='2607.1',
                       published='2026-07-25', status='briefed')
    store.replace_refs(conn, 'New2026', [
        {'raw': 'r', 'ref_doi': '10.2/y', 'ref_arxiv': None,
         'ref_title': None, 'matched_key': None, 'source': 'eprint'},
    ])
    # unknown publication date -> must never be pruned
    store.upsert_paper(conn, 'NoDate', arxiv_id='9999.9',
                       published='', status='new')


def test_prune_drops_old_and_cascades(tmp_path):
    with store.connect(tmp_path / 'p.db') as conn:
        _seed(conn)
        counts = store.prune_old(conn, before='2026-07-20')

        assert counts['papers'] == 1
        assert counts['refs'] == 1
        assert counts['embeddings'] == 1
        keys = {r['cite_key'] for r in conn.execute('SELECT cite_key FROM papers')}
        assert keys == {'New2026', 'NoDate'}
        # the pruned paper's children are gone...
        assert store.refs_for(conn, 'Old2020') == []
        assert conn.execute(
            "SELECT COUNT(*) FROM embeddings WHERE cite_key='Old2020'"
        ).fetchone()[0] == 0
        # ...but the survivor's are intact
        assert len(store.refs_for(conn, 'New2026')) == 1


def test_prune_keeps_empty_published(tmp_path):
    with store.connect(tmp_path / 'p.db') as conn:
        _seed(conn)
        # a cutoff after everything: only the empty-published row is protected
        store.prune_old(conn, before='2099-01-01')
        keys = {r['cite_key'] for r in conn.execute('SELECT cite_key FROM papers')}
        assert keys == {'NoDate'}


def test_prune_noop_returns_zero(tmp_path):
    with store.connect(tmp_path / 'p.db') as conn:
        _seed(conn)
        assert store.prune_old(conn, before='2000-01-01') == {
            'papers': 0, 'refs': 0, 'embeddings': 0,
            'summaries': 0, 'user_filters': 0,
        }
