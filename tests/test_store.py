from __future__ import annotations

import pytest

from arxave import store


# --------------------------------------------------------------------------
# cite keys — the join key across every layer, so collisions matter
# --------------------------------------------------------------------------

def test_cite_key_shape():
    key = store.make_cite_key(['John M. Petta'], '2024-01-15', '2401.12345')
    assert key == 'Petta2024_2401.12345'


def test_cite_key_folds_non_ascii():
    assert store.make_cite_key(['Ana Muñoz'], '2024-01-15', '2401.1').startswith('Munoz2024')
    assert store.make_cite_key(['Łukasz Cywiński'], '2023-05-01', '2305.1').startswith(
        'Cywinski2023'
    )


def test_cite_key_uses_last_token_of_first_author():
    key = store.make_cite_key(
        ['Lieven M. K. Vandersypen', 'Someone Else'], '2022-03-03', '2203.1'
    )
    assert key.startswith('Vandersypen2022')


@pytest.mark.parametrize('authors', [None, [], ['']])
def test_cite_key_survives_missing_author(authors):
    assert store.make_cite_key(authors, '2024-01-01', '2401.9') == 'Anon2024_2401.9'


def test_cite_key_omits_unparseable_year():
    assert store.make_cite_key(['A Smith'], '', '2401.9') == 'Smith_2401.9'


def test_cite_key_unique_for_same_author_and_year():
    """Uniqueness must come from the arXiv ID, not the readable prefix."""
    a = store.make_cite_key(['John Petta'], '2024-01-15', '2401.11111')
    b = store.make_cite_key(['John Petta'], '2024-06-02', '2406.22222')
    c = store.make_cite_key(['John Petta'], '2024-02-02', '2402.33333')
    assert len({a, b, c}) == 3


@pytest.mark.parametrize('raw,expected', [
    ('http://arxiv.org/abs/2401.12345v2', '2401.12345'),
    ('https://arxiv.org/abs/2401.12345', '2401.12345'),
    ('arXiv:2401.12345v1', '2401.12345'),
    ('2401.12345', '2401.12345'),
    ('cond-mat/0512345v3', 'cond-mat/0512345'),
])
def test_bare_arxiv_id(raw, expected):
    assert store.bare_arxiv_id(raw) == expected


# --------------------------------------------------------------------------
# upserts and status
# --------------------------------------------------------------------------

def test_upsert_is_idempotent(cfg):
    with store.connect(cfg.db_path) as conn:
        for _ in range(3):
            store.upsert_paper(conn, 'K1', title='A paper', status='new')
        rows = list(conn.execute('SELECT * FROM papers'))
    assert len(rows) == 1
    assert rows[0]['title'] == 'A paper'


def test_upsert_enriches_without_clobbering(cfg):
    """A later stage must not erase an earlier stage's columns."""
    with store.connect(cfg.db_path) as conn:
        store.upsert_paper(conn, 'K1', title='A paper', abstract='abs', status='new')
        store.upsert_paper(conn, 'K1', summary='sum', status='summarized')
        row = conn.execute('SELECT * FROM papers WHERE cite_key="K1"').fetchone()
    assert row['title'] == 'A paper'
    assert row['abstract'] == 'abs'
    assert row['summary'] == 'sum'
    assert row['status'] == 'summarized'


def test_upsert_rejects_unknown_column(cfg):
    with store.connect(cfg.db_path) as conn:
        with pytest.raises(ValueError, match='unknown column'):
            store.upsert_paper(conn, 'K1', titel='typo')


def test_list_columns_round_trip_as_json(cfg):
    with store.connect(cfg.db_path) as conn:
        store.upsert_paper(conn, 'K1', authors=['A', 'B'], topics=['t1'], status='new')
        row = conn.execute('SELECT * FROM papers WHERE cite_key="K1"').fetchone()
    assert store.json_list(row['authors']) == ['A', 'B']
    assert store.json_list(row['topics']) == ['t1']


def test_json_list_tolerates_null_and_garbage():
    assert store.json_list(None) == []
    assert store.json_list('') == []
    assert store.json_list('not json') == ['not json']


def test_set_status_rejects_unknown(cfg):
    with store.connect(cfg.db_path) as conn:
        store.upsert_paper(conn, 'K1', status='new')
        with pytest.raises(ValueError, match='unknown status'):
            store.set_status(conn, 'K1', 'nonsense')


def test_papers_with_status_filters(cfg):
    with store.connect(cfg.db_path) as conn:
        store.upsert_paper(conn, 'K1', status='new', published='2024-01-01')
        store.upsert_paper(conn, 'K2', status='summarized', published='2024-01-02')
        assert [r['cite_key'] for r in store.papers_with_status(conn, 'new')] == ['K1']


def test_top_ranked_orders_by_importance_and_skips_briefed(cfg):
    with store.connect(cfg.db_path) as conn:
        store.upsert_paper(conn, 'lo', status='ranked', importance=0.1)
        store.upsert_paper(conn, 'hi', status='ranked', importance=0.9)
        store.upsert_paper(conn, 'null', status='ranked', importance=None)
        store.upsert_paper(conn, 'done', status='ranked', importance=1.0,
                           briefed_on='2024-01-01')
        keys = [r['cite_key'] for r in store.top_ranked(conn, 10)]
    assert keys[:2] == ['hi', 'lo']
    assert 'done' not in keys
    assert keys[-1] == 'null'  # NULL importance sorts last, not first


def test_run_bookkeeping(cfg):
    with store.connect(cfg.db_path) as conn:
        run_id = store.start_run(conn, ['t'])
        store.finish_run(conn, run_id, n_scraped=10, n_relevant=3, n_briefed=2)
        row = conn.execute('SELECT * FROM runs WHERE run_id=?', (run_id,)).fetchone()
    assert (row['n_scraped'], row['n_relevant'], row['n_briefed']) == (10, 3, 2)
