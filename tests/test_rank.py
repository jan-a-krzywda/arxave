from __future__ import annotations

from arxave import rank, store

WEIGHTS = {'llm': 0.6, 'centrality': 0.3, 'scites': 0.1}


def test_blend_with_all_signals():
    got = rank.blend({'llm': 1.0, 'centrality': 1.0, 'scites': 1.0}, WEIGHTS)
    assert got == 1.0


def test_blend_renormalizes_over_present_signals():
    """A missing signal must redistribute weight, not score as zero.

    Otherwise every freshly posted paper — which OpenAlex hasn't indexed yet —
    would be systematically buried, which is backwards for a daily scout.
    """
    both = rank.blend({'llm': 0.8, 'centrality': None, 'scites': None}, WEIGHTS)
    assert both == 0.8

    zeroed = rank.blend({'llm': 0.8, 'centrality': 0.0, 'scites': 0.0}, WEIGHTS)
    assert zeroed < both


def test_blend_of_nothing_is_zero_not_an_error():
    assert rank.blend({'llm': None, 'centrality': None}, WEIGHTS) == 0.0


def test_blend_ignores_zero_weighted_signals():
    weights = {'llm': 1.0, 'centrality': 0.0}
    assert rank.blend({'llm': 0.5, 'centrality': 1.0}, weights) == 0.5


def test_run_scores_and_advances_status(cfg):
    with store.connect(cfg.db_path) as conn:
        store.upsert_paper(conn, 'K1', arxiv_id='2401.1', status='filtered',
                           relevance_score=0.9, centrality=0.5)
        store.upsert_paper(conn, 'K2', arxiv_id='2401.2', status='filtered',
                           relevance_score=0.2, centrality=None)

        assert rank.run(cfg, conn) == 2
        rows = {r['cite_key']: r for r in conn.execute('SELECT * FROM papers')}

    assert rows['K1']['status'] == 'ranked'
    assert rows['K1']['importance'] > rows['K2']['importance']
    # Scirate is stubbed in M1 — the column must be NULL, never 0.
    assert rows['K1']['scites'] is None


def test_run_is_a_noop_without_filtered_papers(cfg):
    with store.connect(cfg.db_path) as conn:
        store.upsert_paper(conn, 'K1', status='new')
        assert rank.run(cfg, conn) == 0
