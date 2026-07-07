"""Offline tests for the reflection LLM port: provider transports over
MockTransport, the boot chain (including its no-fake-fallback divergence),
and the daily token budget breaker."""

import json
from datetime import UTC, datetime, timedelta

import httpx
import jsonschema
import pytest

from memory_service.llm import (
    REFLECTION_SCHEMA,
    BudgetedSummarizer,
    BudgetExhausted,
    FakeSummarizer,
    LLMResponse,
    OllamaSummarizer,
    OpenAISummarizer,
    build_summarizer_provider,
)
from memory_service.settings import Settings


def _client(handler):
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


@pytest.fixture(autouse=True)
def _no_env_leakage(monkeypatch):
    """pydantic-settings reads real process env — scrub it so a dev's key or
    provider pin can't flip the chain tests."""
    for var in ("OPENAI_API_KEY", "LLM_PROVIDER", "OLLAMA_BASE_URL"):
        monkeypatch.delenv(var, raising=False)


class TestFakeSummarizer:
    async def test_output_is_schema_valid_and_free(self):
        response = await FakeSummarizer().complete("sys", "user")
        jsonschema.validate(json.loads(response.text), REFLECTION_SCHEMA)
        assert response.tokens_in == 0 and response.tokens_out == 0


class TestOpenAISummarizer:
    async def test_sends_strict_schema_and_parses_usage(self):
        seen = {}

        def handler(request):
            seen["body"] = json.loads(request.content)
            seen["auth"] = request.headers["Authorization"]
            return httpx.Response(
                200,
                json={
                    "choices": [
                        {"message": {"content": json.dumps({"insights": [{"insight": "x", "sourceIndices": [1]}]})}}
                    ],
                    "usage": {"prompt_tokens": 111, "completion_tokens": 22},
                },
            )

        provider = OpenAISummarizer("sk-test", "gpt-4o-mini", 0.7, _client(handler))
        response = await provider.complete("sys", "user")
        assert seen["auth"] == "Bearer sk-test"
        assert seen["body"]["response_format"]["json_schema"]["strict"] is True
        assert seen["body"]["response_format"]["json_schema"]["schema"] == REFLECTION_SCHEMA
        assert response.tokens_in == 111 and response.tokens_out == 22


class TestOllamaSummarizer:
    async def test_sends_format_schema_and_parses_counts(self):
        seen = {}

        def handler(request):
            seen["body"] = json.loads(request.content)
            return httpx.Response(
                200,
                json={"message": {"content": "{}"}, "prompt_eval_count": 55, "eval_count": 8},
            )

        provider = OllamaSummarizer("http://localhost:11434", "llama3.1:8b", 0.7, _client(handler))
        response = await provider.complete("sys", "user")
        assert seen["body"]["format"] == REFLECTION_SCHEMA
        assert seen["body"]["stream"] is False
        assert response.tokens_in == 55 and response.tokens_out == 8


class TestChain:
    async def test_explicit_fake_pins(self):
        provider = await build_summarizer_provider(
            Settings(llm_provider="fake"), _client(lambda r: httpx.Response(500))
        )
        assert isinstance(provider, FakeSummarizer)

    async def test_key_selects_openai(self):
        provider = await build_summarizer_provider(
            Settings(llm_provider="auto", openai_api_key="sk-test"), _client(lambda r: httpx.Response(500))
        )
        assert isinstance(provider, OpenAISummarizer)

    async def test_no_key_falls_to_ollama_with_warmup(self):
        calls = []

        def handler(request):
            calls.append(request.url.path)
            if request.url.path == "/api/tags":
                return httpx.Response(200, json={"models": [{"name": "llama3.1:8b"}]})
            return httpx.Response(200, json={"message": {"content": "ok"}})

        provider = await build_summarizer_provider(Settings(llm_provider="auto"), _client(handler))
        assert isinstance(provider, OllamaSummarizer)
        assert "/api/chat" in calls  # boot warmup happened

    async def test_nothing_available_disables_reflections(self):
        # THE divergence from deliberation: no fake fallback — None, not FakeSummarizer
        def handler(request):
            raise httpx.ConnectError("nope")

        provider = await build_summarizer_provider(Settings(llm_provider="auto"), _client(handler))
        assert provider is None

    async def test_model_not_pulled_disables_reflections(self):
        def handler(request):
            return httpx.Response(200, json={"models": [{"name": "nomic-embed-text"}]})

        provider = await build_summarizer_provider(Settings(llm_provider="auto"), _client(handler))
        assert provider is None


class CountingSummarizer:
    """600 tokens per call, so budget arithmetic is deterministic."""

    name = "counting"
    model = "counting-1"

    def __init__(self):
        self.calls = 0

    async def complete(self, system, user):
        self.calls += 1
        return LLMResponse(
            text="{}", tokens_in=500, tokens_out=100, latency_seconds=0.0, provider=self.name, model=self.model
        )


class Clock:
    def __init__(self):
        self.now = datetime(2026, 7, 7, 12, 0, tzinfo=UTC)

    def __call__(self):
        return self.now


class TestBudgetedSummarizer:
    async def test_trips_at_budget_then_raises(self):
        primary = CountingSummarizer()
        budgeted = BudgetedSummarizer(primary, daily_token_budget=1000, clock=Clock())
        await budgeted.complete("s", "u")  # 600
        await budgeted.complete("s", "u")  # 1200 — the crossing call still succeeds
        assert primary.calls == 2
        with pytest.raises(BudgetExhausted):
            await budgeted.complete("s", "u")
        assert primary.calls == 2  # the primary is never reached while open
        assert budgeted.tokens_spent_today == 1200

    async def test_midnight_utc_closes_the_breaker(self):
        clock = Clock()
        primary = CountingSummarizer()
        budgeted = BudgetedSummarizer(primary, daily_token_budget=600, clock=clock)
        await budgeted.complete("s", "u")
        with pytest.raises(BudgetExhausted):
            await budgeted.complete("s", "u")
        clock.now += timedelta(days=1)
        response = await budgeted.complete("s", "u")
        assert response.tokens_in == 500
        assert budgeted.tokens_spent_today == 600  # counter reset, then one call

    async def test_never_trips_under_budget(self):
        budgeted = BudgetedSummarizer(CountingSummarizer(), daily_token_budget=10_000, clock=Clock())
        for _ in range(5):
            await budgeted.complete("s", "u")
        assert budgeted.tokens_spent_today == 3000
