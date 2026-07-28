from __future__ import annotations

import pytest

from arxave.config import (
    Config, ConnectConfig, CorpusConfig, LLMRoleConfig, RankingConfig, ScoutConfig,
)


@pytest.fixture
def cfg(tmp_path) -> Config:
    """A config rooted in tmp_path — no network, no real corpus, no keys."""
    role = lambda name, model: LLMRoleConfig(  # noqa: E731
        role=name, provider='anthropic', model=model, api_key_env='TEST_KEY'
    )
    return Config(
        root=tmp_path,
        topics=['silicon spin qubits', 'charge noise'],
        scout=ScoutConfig(categories=['cond-mat.mes-hall'], lookback_days=1),
        corpus=CorpusConfig(source=None, stale_after_days=30),
        ranking=RankingConfig(
            weights={'llm': 0.6, 'centrality': 0.3, 'scites': 0.1}, top_n=2
        ),
        connect=ConnectConfig(enabled=True, openalex_mailto='test@example.com'),
        llm={'light': role('light', 'test-light'), 'heavy': role('heavy', 'test-heavy')},
    )


class FakeLLM:
    """Returns queued responses; records the prompts it was given."""

    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def complete_json(self, system, user, schema):
        self.calls.append({'system': system, 'user': user, 'schema': schema})
        if not self.responses:
            raise AssertionError('FakeLLM ran out of queued responses')
        return self.responses.pop(0)
