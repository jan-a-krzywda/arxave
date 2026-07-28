from __future__ import annotations

from arxave import filter as filter_stage
from arxave import store, summarize
from arxave.llm import LLMError, Relevance, Summary

from conftest import FakeLLM


class BrokenLLM:
    def complete_json(self, system, user, schema):
        raise LLMError('boom')


def test_summarize_advances_status(cfg):
    llm = FakeLLM([Summary(summary='s', research_question='q', contribution='c')])
    with store.connect(cfg.db_path) as conn:
        store.upsert_paper(conn, 'K1', title='T', abstract='A',
                           primary_category='cond-mat.mes-hall', status='new')
        assert summarize.run(cfg, conn, llm) == 1
        row = conn.execute('SELECT * FROM papers WHERE cite_key="K1"').fetchone()

    assert (row['summary'], row['research_question'], row['contribution']) == ('s', 'q', 'c')
    assert row['status'] == 'summarized'
    assert row['llm_model'] == 'test-light'


def test_summarize_leaves_a_failed_paper_retryable(cfg):
    """A failed call must not advance status, or the paper is silently lost."""
    with store.connect(cfg.db_path) as conn:
        store.upsert_paper(conn, 'K1', title='T', abstract='A', status='new')
        assert summarize.run(cfg, conn, BrokenLLM()) == 0
        row = conn.execute('SELECT * FROM papers WHERE cite_key="K1"').fetchone()
    assert row['status'] == 'new'


def test_filter_records_every_paper_but_advances_only_the_relevant(cfg):
    """The rejected papers are the point of the memory layer — they must persist."""
    llm = FakeLLM([
        Relevance(relevant=True, relevance_score=0.9,
                  matched_topics=['silicon spin qubits'], reason='direct hit'),
        Relevance(relevant=False, relevance_score=0.1,
                  matched_topics=[], reason='superconducting, not spin'),
    ])
    with store.connect(cfg.db_path) as conn:
        store.upsert_paper(conn, 'K1', title='T1', summary='s1', status='summarized')
        store.upsert_paper(conn, 'K2', title='T2', summary='s2', status='summarized')
        assert filter_stage.run(cfg, conn, llm) == 1
        rows = {r['cite_key']: r for r in conn.execute('SELECT * FROM papers')}

    assert rows['K1']['status'] == 'filtered'
    assert rows['K1']['relevant'] == 1

    assert rows['K2']['status'] == 'summarized'   # does not advance
    assert rows['K2']['relevant'] == 0            # but is recorded
    assert rows['K2']['filter_reason'] == 'superconducting, not spin'


def test_filter_drops_topics_the_model_invented(cfg):
    """Only verbatim topics survive — a hallucinated one would skew the brief."""
    llm = FakeLLM([Relevance(
        relevant=True, relevance_score=0.9,
        matched_topics=['silicon spin qubits', 'a topic nobody configured'],
        reason='ok',
    )])
    with store.connect(cfg.db_path) as conn:
        store.upsert_paper(conn, 'K1', summary='s', status='summarized')
        filter_stage.run(cfg, conn, llm)
        row = conn.execute('SELECT topics FROM papers WHERE cite_key="K1"').fetchone()
    assert store.json_list(row['topics']) == ['silicon spin qubits']


def test_filter_system_prompt_carries_the_topics(cfg):
    llm = FakeLLM([Relevance(relevant=False, relevance_score=0.0,
                             matched_topics=[], reason='n/a')])
    with store.connect(cfg.db_path) as conn:
        store.upsert_paper(conn, 'K1', summary='s', status='summarized')
        filter_stage.run(cfg, conn, llm)

    system = llm.calls[0]['system']
    assert 'silicon spin qubits' in system
    assert 'charge noise' in system


def test_stages_are_noops_on_an_empty_db(cfg):
    with store.connect(cfg.db_path) as conn:
        assert summarize.run(cfg, conn, FakeLLM([])) == 0
        assert filter_stage.run(cfg, conn, FakeLLM([])) == 0
