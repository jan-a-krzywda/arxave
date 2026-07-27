"""The database adapter and the per-user tables, exercised on SQLite.

The Postgres path can't run in CI without a server; these pin the behaviour the
Postgres path must match — placeholder round-trips, RETURNING ids, the
baseline-vs-override split, and prune cascade to the per-user tables.
"""
from __future__ import annotations

from arxave import db, store


def test_dialect_detection():
    assert db.dialect_of('postgres://u@h/db') == db.POSTGRES
    assert db.dialect_of('postgresql://u@h/db') == db.POSTGRES
    assert db.dialect_of('/tmp/papers.db') == db.SQLITE
    assert db.dialect_of(None) == db.SQLITE


def test_pg_placeholder_translation():
    conn = db._PgConn(raw=None)
    assert conn._translate('SELECT * FROM t WHERE a=? AND b=?') == \
        'SELECT * FROM t WHERE a=%s AND b=%s'
    # literal % is escaped so psycopg doesn't read it as a format spec
    assert conn._translate("x LIKE 'a%'") == "x LIKE 'a%%'"


def test_schema_created_on_connect(tmp_path):
    with store.connect(tmp_path / 'p.db') as conn:
        tables = {r['name'] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        )}
    assert {'papers', 'refs', 'embeddings', 'summaries', 'user_filters', 'runs'} <= tables


def test_start_run_returns_id_without_lastrowid(tmp_path):
    with store.connect(tmp_path / 'p.db') as conn:
        rid = store.start_run(conn, ['topic'])
        assert isinstance(rid, int) and rid >= 1
        store.finish_run(conn, rid, n_scraped=3)
        row = conn.execute('SELECT * FROM runs WHERE run_id=?', (rid,)).fetchone()
    assert row['n_scraped'] == 3


def test_baseline_and_user_summaries_coexist(tmp_path):
    with store.connect(tmp_path / 'p.db') as conn:
        store.upsert_paper(conn, 'K1', arxiv_id='1', status='summarized')
        # shared baseline (batch, user_id='')
        store.upsert_summary(conn, 'K1', 'gemma', summary='baseline')
        # a user's stronger-LLM override for the same paper
        store.upsert_summary(conn, 'K1', 'opus', user_id='u42', summary='sharper')

        base = store.summary_for(conn, 'K1')
        mine = store.summary_for(conn, 'K1', user_id='u42')
        assert base['summary'] == 'baseline'
        assert base['user_id'] == ''
        assert mine['summary'] == 'sharper'
        # both rows exist independently
        n = conn.execute('SELECT COUNT(*) AS n FROM summaries').fetchone()['n']
        assert n == 2


def test_summary_upsert_updates_in_place(tmp_path):
    with store.connect(tmp_path / 'p.db') as conn:
        store.upsert_paper(conn, 'K1', arxiv_id='1', status='summarized')
        store.upsert_summary(conn, 'K1', 'gemma', summary='v1')
        store.upsert_summary(conn, 'K1', 'gemma', summary='v2', claim='c')
        row = store.summary_for(conn, 'K1', llm_model='gemma')
        n = conn.execute('SELECT COUNT(*) AS n FROM summaries').fetchone()['n']
    assert n == 1  # same (paper,user,model) key -> updated, not duplicated
    assert row['summary'] == 'v2' and row['claim'] == 'c'


def test_user_filters_are_private_per_user(tmp_path):
    with store.connect(tmp_path / 'p.db') as conn:
        store.upsert_paper(conn, 'K1', arxiv_id='1', status='summarized')
        store.upsert_user_filter(conn, 'K1', 'alice',
                                 relevant=1, topics=['qec'], relevance_score=0.9)
        store.upsert_user_filter(conn, 'K1', 'bob', relevant=0)

        alice = store.user_filter_for(conn, 'K1', 'alice')
        bob = store.user_filter_for(conn, 'K1', 'bob')
        assert alice['relevant'] == 1
        assert store.json_list(alice['topics']) == ['qec']
        assert bob['relevant'] == 0
        assert store.user_filter_for(conn, 'K1', 'carol') is None


def test_prune_cascades_to_per_user_tables(tmp_path):
    with store.connect(tmp_path / 'p.db') as conn:
        store.upsert_paper(conn, 'Old', arxiv_id='1',
                           published='2020-01-01', status='briefed')
        store.upsert_summary(conn, 'Old', 'gemma', summary='s')
        store.upsert_user_filter(conn, 'Old', 'u1', relevant=1)

        counts = store.prune_old(conn, before='2026-01-01')
        assert counts['papers'] == 1
        assert counts['summaries'] == 1
        assert counts['user_filters'] == 1
        assert conn.execute('SELECT COUNT(*) AS n FROM summaries').fetchone()['n'] == 0
