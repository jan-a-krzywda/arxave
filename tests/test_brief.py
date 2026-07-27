from __future__ import annotations

from datetime import date

from arxave import brief, store
from arxave.llm import Pitch

from conftest import FakeLLM

TODAY = date(2026, 7, 20)


def _seed(conn):
    store.upsert_paper(
        conn, 'Petta2024_2401.1', arxiv_id='2401.1', status='ranked',
        title='Coherent exchange in a triple dot', importance=0.9,
        summary='s', research_question='q', contribution='c',
        relevant=1, topics=['silicon spin qubits'],
        cited_in_corpus=['Petta2005 something', 'Loss1998 something'],
    )
    store.upsert_paper(
        conn, 'Loss2024_2401.2', arxiv_id='2401.2', status='ranked',
        title='A second paper', importance=0.5,
        summary='s2', research_question='q2', contribution='c2',
        relevant=1, topics=['charge noise'],
    )
    store.upsert_paper(
        conn, 'Off2024_2401.3', arxiv_id='2401.3', status='summarized',
        title='An off-topic paper', relevant=0,
        filter_reason='Concerns superconducting qubits, not spin qubits.',
    )


def test_pitch_writes_fields_and_marks_briefed(cfg):
    llm = FakeLLM([
        Pitch(claim='C1', stakes='S1', connection='X1', verdict='read'),
        Pitch(claim='C2', stakes='S2', connection='X2', verdict='SKIM'),
    ])
    with store.connect(cfg.db_path) as conn:
        _seed(conn)
        assert brief.pitch(cfg, conn, llm) == 2
        rows = {r['cite_key']: r for r in conn.execute('SELECT * FROM papers')}

    top = rows['Petta2024_2401.1']
    assert (top['claim'], top['stakes'], top['verdict']) == ('C1', 'S1', 'read')
    assert top['status'] == 'briefed'
    assert top['briefed_on']
    # Verdict is normalized to lowercase.
    assert rows['Loss2024_2401.2']['verdict'] == 'skim'


def test_pitch_normalizes_an_invalid_verdict(cfg):
    llm = FakeLLM([
        Pitch(claim='C', stakes='S', connection='X', verdict='definitely read this'),
        Pitch(claim='C2', stakes='S2', connection='X2', verdict='skip'),
    ])
    with store.connect(cfg.db_path) as conn:
        _seed(conn)
        brief.pitch(cfg, conn, llm)
        row = conn.execute(
            'SELECT verdict FROM papers WHERE cite_key="Petta2024_2401.1"'
        ).fetchone()
    assert row['verdict'] == 'skim'


def test_pitch_prompt_names_cited_corpus_papers(cfg):
    llm = FakeLLM([Pitch(claim='C', stakes='S', connection='X', verdict='read')] * 2)
    with store.connect(cfg.db_path) as conn:
        _seed(conn)
        brief.pitch(cfg, conn, llm)

    with_overlap = llm.calls[0]['user']
    assert 'Petta2005 something' in with_overlap
    assert 'Loss1998 something' in with_overlap

    # Without overlap the prompt must say so, and must not invite a claim of
    # connection the model has no evidence for.
    without_overlap = llm.calls[1]['user']
    assert 'No citation overlap' in without_overlap


def test_pitch_respects_top_n(cfg):
    """top_n is 2 in the fixture; a third ranked paper must not be pitched."""
    llm = FakeLLM([Pitch(claim='C', stakes='S', connection='X', verdict='read')] * 3)
    with store.connect(cfg.db_path) as conn:
        _seed(conn)
        store.upsert_paper(conn, 'Third_2401.4', arxiv_id='2401.4',
                           status='ranked', importance=0.1, title='Third')
        assert brief.pitch(cfg, conn, llm) == 2


def test_render_produces_slides_and_also_ran(cfg):
    with store.connect(cfg.db_path) as conn:
        _seed(conn)
        store.upsert_paper(
            conn, 'Petta2024_2401.1', claim='Exchange survives charge noise',
            stakes='Removes the main obstacle to two-qubit fidelity.',
            connection='Extends Petta2005.', verdict='read',
            briefed_on=TODAY.isoformat(), status='briefed',
        )
        path = brief.render(cfg, conn, TODAY)

    text = path.read_text()
    assert path.name == '2026-07-20.md'
    assert '# Morning brief — 2026-07-20' in text
    assert '## 1. Exchange survives charge noise' in text
    assert 'Removes the main obstacle' in text
    assert '**Verdict: read**' in text
    assert 'arxiv.org/abs/2401.1' in text
    # Everything evaluated but not pitched is still reported.
    assert 'Also evaluated' in text
    assert 'An off-topic paper' in text
    assert 'Concerns superconducting qubits' in text


def test_render_handles_an_empty_day(cfg):
    with store.connect(cfg.db_path) as conn:
        text = brief.render(cfg, conn, TODAY).read_text()
    assert 'Nothing cleared the bar today' in text


def test_render_is_reproducible_without_llm_calls(cfg):
    """The brief is a view over the store, so re-rendering is free and stable."""
    with store.connect(cfg.db_path) as conn:
        _seed(conn)
        store.upsert_paper(conn, 'Petta2024_2401.1', claim='C', stakes='S',
                           connection='X', verdict='read',
                           briefed_on=TODAY.isoformat(), status='briefed')
        first = brief.render(cfg, conn, TODAY).read_text()
        second = brief.render(cfg, conn, TODAY).read_text()
    assert first == second


def test_render_escapes_pipes_in_the_also_ran_table(cfg):
    with store.connect(cfg.db_path) as conn:
        store.upsert_paper(conn, 'K1', arxiv_id='2401.9', status='summarized',
                           title='A | B', relevant=0, filter_reason='x | y')
        text = brief.render(cfg, conn, TODAY).read_text()
    assert r'A \| B' in text
    assert r'x \| y' in text
