"""Smoke-test the store against whatever SUPABASE_DB_URL points at.

Usage:
    pip install -e ".[postgres]"
    python scripts/db_smoke.py

Connects, ensures the schema (CREATE TABLE IF NOT EXISTS on both engines),
writes a shared baseline summary + a per-user override, reads them back, then
cleans up. Prints which engine it hit. No LLM, no config file needed.
"""
from __future__ import annotations

import os

from dotenv import find_dotenv, load_dotenv

from arxave import db, store

# find_dotenv walks up from the cwd, so this works whether run from the repo
# root or from scripts/.
load_dotenv(find_dotenv(usecwd=True))

target = os.environ.get('SUPABASE_DB_URL') or '.local/arxave/smoke.db'
if not os.environ.get('SUPABASE_DB_URL'):
    print('WARNING: SUPABASE_DB_URL not set — falling back to local SQLite.')
    print('         Add it to .env at the repo root to test against Postgres.\n')
print(f'engine: {db.dialect_of(target)}  ->  {target.split("@")[-1] if "@" in target else target}')

with store.connect(target) as conn:
    store.upsert_paper(conn, 'Smoke2026', arxiv_id='2607.99999',
                       title='smoke test', published='2026-07-27', status='new')
    store.upsert_summary(conn, 'Smoke2026', 'gemma', summary='baseline summary')
    store.upsert_summary(conn, 'Smoke2026', 'opus', user_id='u-smoke',
                         summary='sharper override')

    paper = conn.execute(
        'SELECT title FROM papers WHERE cite_key=?', ('Smoke2026',)
    ).fetchone()
    base = store.summary_for(conn, 'Smoke2026')
    mine = store.summary_for(conn, 'Smoke2026', user_id='u-smoke')

    print('paper roundtrip :', paper['title'])
    print('baseline summary:', base['summary'], '(user_id=%r)' % base['user_id'])
    print('user override   :', mine['summary'])

    # clean up so the smoke row doesn't linger in a shared DB
    for t in ('summaries', 'papers'):
        conn.execute(f'DELETE FROM {t} WHERE cite_key=?', ('Smoke2026',))
    print('cleaned up. OK.')
