from __future__ import annotations

from datetime import date

import pytest

from arxave import scout, store

# 2026-07-20 is a Monday; 2026-07-17 the Friday before it.
MONDAY = date(2026, 7, 20)
FRIDAY = date(2026, 7, 17)
WEDNESDAY = date(2026, 7, 22)


def test_monday_reaches_back_to_friday():
    """arXiv doesn't announce on weekends. A calendar-day window would make
    every Monday brief empty."""
    assert scout.cutoff_date(MONDAY, 1) == FRIDAY


def test_midweek_is_the_previous_day():
    assert scout.cutoff_date(WEDNESDAY, 1) == date(2026, 7, 21)


def test_longer_lookback_counts_publishing_days():
    assert scout.cutoff_date(MONDAY, 3) == date(2026, 7, 15)  # Wed


def test_a_weekend_run_still_reaches_friday():
    assert scout.cutoff_date(date(2026, 7, 19), 1) == FRIDAY  # Sunday
    assert scout.cutoff_date(date(2026, 7, 18), 1) == FRIDAY  # Saturday


def test_zero_lookback_is_treated_as_one():
    assert scout.cutoff_date(WEDNESDAY, 0) == date(2026, 7, 21)


def test_run_inserts_at_status_new(cfg, monkeypatch):
    monkeypatch.setattr(scout, 'fetch', lambda c, d=None: [{
        'cite_key': 'Petta2026_2607.1',
        'arxiv_id': '2607.1',
        'title': 'A paper',
        'authors': ['John Petta'],
        'published': '2026-07-17',
        'primary_category': 'cond-mat.mes-hall',
        'abstract': 'abs',
    }])
    with store.connect(cfg.db_path) as conn:
        assert scout.run(cfg, conn, MONDAY) == 1
        row = conn.execute('SELECT * FROM papers').fetchone()
    assert row['status'] == 'new'
    assert row['arxiv_id'] == '2607.1'
    assert store.json_list(row['authors']) == ['John Petta']


def test_rerun_does_not_reset_progress(cfg, monkeypatch):
    """Overlapping lookback windows must not drag an advanced paper back to 'new'."""
    paper = {
        'cite_key': 'Petta2026_2607.1', 'arxiv_id': '2607.1', 'title': 'A paper',
        'authors': ['John Petta'], 'published': '2026-07-17',
        'primary_category': 'cond-mat.mes-hall', 'abstract': 'abs',
    }
    monkeypatch.setattr(scout, 'fetch', lambda c, d=None: [dict(paper)])

    with store.connect(cfg.db_path) as conn:
        scout.run(cfg, conn, MONDAY)
        store.set_status(conn, 'Petta2026_2607.1', 'briefed')
        scout.run(cfg, conn, MONDAY)
        rows = list(conn.execute('SELECT * FROM papers'))

    assert len(rows) == 1
    assert rows[0]['status'] == 'briefed'


def test_query_joins_categories():
    assert scout._query(['a', 'b']) == 'cat:a OR cat:b'
