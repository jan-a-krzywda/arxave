"""Provider-agnostic LLM access, split into two configurable roles.

`light` does the per-paper work (summarize, filter) and runs once per scouted
paper, so it dominates cost. `heavy` writes the brief and runs only for the
top N. Each role is configured independently — provider, model, base URL, and
API-key env var — so they can point at different providers entirely.

Every call requests schema-constrained JSON, so parsing is deterministic and a
malformed response is a validation error rather than a downstream surprise.
"""
from __future__ import annotations

from typing import Protocol, TypeVar

from pydantic import BaseModel, Field

from .config import LLMRoleConfig

T = TypeVar('T', bound=BaseModel)

# Non-streaming ceiling. These are short structured payloads; the cap exists
# to avoid a truncated JSON body, not to bound cost.
MAX_TOKENS = 4096


class LLMError(Exception):
    """A call failed or returned something that did not validate."""


# --------------------------------------------------------------------------
# response schemas (spec §8)
# --------------------------------------------------------------------------

class Summary(BaseModel):
    summary: str = Field(description='One structured paragraph: topic, approach, result.')
    research_question: str = Field(description='The question the paper sets out to answer.')
    contribution: str = Field(description="What is new here that wasn't known before.")


class Relevance(BaseModel):
    relevant: bool = Field(description='True only if it matches at least one topic.')
    relevance_score: float = Field(ge=0.0, le=1.0, description='0..1 confidence.')
    matched_topics: list[str] = Field(
        default_factory=list,
        description='Verbatim copies of the matched topic strings; empty if none.',
    )
    reason: str = Field(description='One sentence justifying the verdict.')


class Pitch(BaseModel):
    claim: str = Field(description='The finding as a headline, not the paper title.')
    stakes: str = Field(description='One line on why it matters. Lead with this.')
    connection: str = Field(description='How it relates to the library, or why it stands alone.')
    verdict: str = Field(description="Exactly one of: 'read', 'skim', 'skip'.")


# --------------------------------------------------------------------------
# interface
# --------------------------------------------------------------------------

class LLM(Protocol):
    def complete_json(self, system: str, user: str, schema: type[T]) -> T: ...


class AnthropicLLM:
    """Anthropic implementation using schema-constrained structured output.

    The system prompt is cached: it carries the topic list and is byte-identical
    across every paper in a run, so a per-paper stage pays for it once. Note
    that Haiku's minimum cacheable prefix is 4096 tokens — below that the cache
    silently does nothing, which is fine, just not a saving.
    """

    def __init__(self, cfg: LLMRoleConfig):
        try:
            import anthropic
        except ImportError as exc:  # pragma: no cover - install-time failure
            raise LLMError(
                'the `anthropic` package is required for provider "anthropic"'
            ) from exc

        kwargs = {'api_key': cfg.api_key}
        if cfg.base_url:
            kwargs['base_url'] = cfg.base_url
        self._client = anthropic.Anthropic(**kwargs)
        self._model = cfg.model
        self._role = cfg.role

    @property
    def model(self) -> str:
        return self._model

    def complete_json(self, system: str, user: str, schema: type[T]) -> T:
        try:
            response = self._client.messages.parse(
                model=self._model,
                max_tokens=MAX_TOKENS,
                system=[{
                    'type': 'text',
                    'text': system,
                    'cache_control': {'type': 'ephemeral'},
                }],
                messages=[{'role': 'user', 'content': user}],
                output_config={'format': schema},
            )
        except Exception as exc:
            raise LLMError(f'llm.{self._role} ({self._model}) call failed: {exc}') from exc

        parsed = getattr(response, 'parsed_output', None)
        if parsed is None:
            raise LLMError(
                f'llm.{self._role} ({self._model}) returned no parseable '
                f'{schema.__name__}; stop_reason={getattr(response, "stop_reason", "?")}'
            )
        return parsed


_PROVIDERS = {'anthropic': AnthropicLLM}


def get_llm(cfg: LLMRoleConfig) -> LLM:
    try:
        factory = _PROVIDERS[cfg.provider]
    except KeyError:
        raise LLMError(
            f'llm.{cfg.role}: unknown provider {cfg.provider!r}. '
            f'Available: {", ".join(sorted(_PROVIDERS))}.'
        ) from None
    return factory(cfg)
