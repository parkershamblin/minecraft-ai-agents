import json

import httpx
import pytest

from agent_service.llm.contract import validate_decision
from agent_service.llm.providers import (
    FakeProvider,
    OllamaProvider,
    OpenAIProvider,
    build_llm_provider,
)
from agent_service.settings import Settings


def _client(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


class TestFakeProvider:
    async def test_every_scripted_decision_is_contract_valid(self):
        provider = FakeProvider()
        for _ in range(len(FakeProvider._SCRIPT) + 1):  # full rotation + wrap
            response = await provider.complete("system", "user")
            validate_decision(response.text)  # raises on violation
            assert response.tokens_in == 0


class TestOpenAIProvider:
    async def test_sends_strict_schema_and_parses_usage(self):
        captured = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured.update(json.loads(request.content))
            assert request.headers["authorization"] == "Bearer sk-test"
            return httpx.Response(
                200,
                json={
                    "choices": [{"message": {"content": '{"a":1}'}}],
                    "usage": {"prompt_tokens": 120, "completion_tokens": 30},
                },
            )

        provider = OpenAIProvider("sk-test", "gpt-4o-mini", 0.7, _client(handler))
        response = await provider.complete("sys", "usr")

        assert captured["response_format"]["json_schema"]["strict"] is True
        assert captured["response_format"]["json_schema"]["schema"]["required"]
        assert response.tokens_in == 120
        assert response.tokens_out == 30
        assert response.text == '{"a":1}'


class TestOllamaProvider:
    async def test_sends_format_schema_and_parses_counts(self):
        captured = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured.update(json.loads(request.content))
            return httpx.Response(
                200,
                json={"message": {"content": '{"b":2}'}, "prompt_eval_count": 200, "eval_count": 50},
            )

        provider = OllamaProvider("http://ollama:11434", "llama3.1:8b", 0.7, _client(handler))
        response = await provider.complete("sys", "usr")

        assert captured["format"]["properties"]["action"]["enum"]
        assert captured["stream"] is False
        assert response.tokens_in == 200
        assert response.tokens_out == 50


class TestChain:
    async def test_explicit_fake_pins(self):
        settings = Settings(llm_provider="fake", openai_api_key="sk-would-win-otherwise")
        provider = await build_llm_provider(settings, _client(lambda r: httpx.Response(500)))
        assert isinstance(provider, FakeProvider)

    async def test_key_selects_openai(self):
        settings = Settings(llm_provider="auto", openai_api_key="sk-test")
        provider = await build_llm_provider(settings, _client(lambda r: httpx.Response(500)))
        assert isinstance(provider, OpenAIProvider)

    async def test_no_key_falls_to_ollama_with_warmup(self):
        calls = []

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(request.url.path)
            if request.url.path == "/api/tags":
                return httpx.Response(200, json={"models": [{"name": "llama3.1:8b"}]})
            if request.url.path == "/api/chat":  # warmup
                return httpx.Response(200, json={"message": {"content": "ok"}})
            raise AssertionError(request.url.path)

        settings = Settings(llm_provider="auto", openai_api_key="")
        provider = await build_llm_provider(settings, _client(handler))
        assert isinstance(provider, OllamaProvider)
        assert "/api/chat" in calls  # warmed at boot

    async def test_nothing_available_falls_to_fake(self):
        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("refused")

        settings = Settings(llm_provider="auto", openai_api_key="")
        provider = await build_llm_provider(settings, _client(handler))
        assert isinstance(provider, FakeProvider)


@pytest.fixture(autouse=True)
def _no_env_leakage(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("LLM_PROVIDER", raising=False)
    monkeypatch.delenv("OLLAMA_BASE_URL", raising=False)
