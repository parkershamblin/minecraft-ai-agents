import json

import httpx
import pytest

from agent_service.llm.contract import validate_decision
from agent_service.llm.providers import (
    FakeProvider,
    OllamaProvider,
    OpenAIProvider,
    TeamRouter,
    build_llm_provider,
    build_team_providers,
    parse_team_models,
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
        assert "num_ctx" not in captured["options"]  # unset -> server default rules
        assert response.tokens_in == 200
        assert response.tokens_out == 50

    async def test_num_ctx_rides_every_call_including_warmup(self):
        # Warmup MUST send the same options as completions: Ollama spins up a
        # new runner per num_ctx, so a bare warmup would cold-load the model
        # twice (once at server-default ctx, again on the first real tick).
        options_seen = []

        def handler(request: httpx.Request) -> httpx.Response:
            options_seen.append(json.loads(request.content).get("options"))
            return httpx.Response(200, json={"message": {"content": "{}"}})

        provider = OllamaProvider(
            "http://ollama:11434", "llama3.1:8b", 0.7, _client(handler), num_ctx=8192
        )
        await provider.warmup()
        await provider.complete("sys", "usr")

        assert [o.get("num_ctx") for o in options_seen] == [8192, 8192]

    async def test_instance_name_labels_metrics_per_team(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"message": {"content": "{}"}})

        provider = OllamaProvider(
            "http://ollama:11434", "gemma3:12b", 0.7, _client(handler), name="ollama/blue"
        )
        response = await provider.complete("sys", "usr")

        assert provider.name == "ollama/blue"
        assert response.provider == "ollama/blue"
        assert OllamaProvider.name == "ollama"  # single-brain path keeps the class label


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


class TestParseTeamModels:
    def test_happy_path_with_spaces(self):
        assert parse_team_models(" red = llama3.1:8b , blue = gemma3:12b ") == {
            "red": "llama3.1:8b",
            "blue": "gemma3:12b",
        }

    def test_blank_means_off(self):
        assert parse_team_models("") == {}
        assert parse_team_models(" , ") == {}

    @pytest.mark.parametrize("spec", ["red", "red=", "=llama3.1:8b", "red=a,red=b"])
    def test_malformed_or_duplicate_refuses_boot(self, spec):
        with pytest.raises(ValueError):
            parse_team_models(spec)


class TestBuildTeamProviders:
    def _settings(self, spec: str) -> Settings:
        return Settings(llm_team_models=spec, ollama_num_ctx=8192)

    async def test_blank_spec_is_off_and_never_calls_ollama(self):
        def handler(request: httpx.Request) -> httpx.Response:
            raise AssertionError("feature off must not touch the network")

        assert await build_team_providers(self._settings(""), _client(handler)) == {}

    async def test_builds_one_warmed_provider_per_team(self):
        warmed = []

        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/api/tags":
                return httpx.Response(
                    200, json={"models": [{"name": "llama3.1:8b"}, {"name": "gemma3:12b"}]}
                )
            if request.url.path == "/api/chat":  # warmup
                warmed.append(json.loads(request.content)["model"])
                return httpx.Response(200, json={"message": {"content": "ok"}})
            raise AssertionError(request.url.path)

        providers = await build_team_providers(
            self._settings("red=llama3.1:8b,blue=gemma3:12b"), _client(handler)
        )

        assert set(providers) == {"red", "blue"}
        assert providers["red"].model == "llama3.1:8b"
        assert providers["blue"].model == "gemma3:12b"
        assert providers["red"].name == "ollama/red"
        assert providers["blue"].name == "ollama/blue"
        assert sorted(warmed) == ["gemma3:12b", "llama3.1:8b"]  # both resident pre-race

    async def test_unpulled_model_refuses_boot(self):
        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/api/tags":
                return httpx.Response(200, json={"models": [{"name": "llama3.1:8b"}]})
            raise AssertionError(request.url.path)

        with pytest.raises(RuntimeError, match="ollama pull gemma3:12b"):
            await build_team_providers(
                self._settings("red=llama3.1:8b,blue=gemma3:12b"), _client(handler)
            )

    async def test_unreachable_ollama_refuses_boot(self):
        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("refused")

        with pytest.raises(httpx.HTTPError):
            await build_team_providers(self._settings("red=llama3.1:8b"), _client(handler))


class TestTeamRouter:
    def test_routes_by_team_and_defaults_otherwise(self):
        default, red, blue = FakeProvider(), FakeProvider(), FakeProvider()
        roster = {"v-red": "red", "v-blue": "blue", "v-ghost": "green"}  # green has no provider
        router = TeamRouter(default, {"red": red, "blue": blue}, roster.get)

        assert router("v-red") is red
        assert router("v-blue") is blue
        assert router("v-ghost") is default  # team without a model -> default brain
        assert router("v-none") is default  # pre-race / not racing -> default brain


@pytest.fixture(autouse=True)
def _no_env_leakage(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("LLM_PROVIDER", raising=False)
    monkeypatch.delenv("OLLAMA_BASE_URL", raising=False)
    monkeypatch.delenv("LLM_TEAM_MODELS", raising=False)
    monkeypatch.delenv("OLLAMA_NUM_CTX", raising=False)
