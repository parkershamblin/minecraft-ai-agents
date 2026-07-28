import json

import httpx
import pytest

from agent_service.llm.contract import validate_decision
from agent_service.llm.providers import (
    AnthropicProvider,
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
    async def test_sends_forced_strict_tool_and_parses_arguments(self):
        captured = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured.update(json.loads(request.content))
            assert request.headers["authorization"] == "Bearer sk-test"
            return httpx.Response(
                200,
                json={
                    "choices": [
                        {
                            "message": {
                                "content": None,
                                "tool_calls": [
                                    {
                                        "id": "call_1",
                                        "type": "function",
                                        "function": {"name": "decide", "arguments": '{"a":1}'},
                                    }
                                ],
                            }
                        }
                    ],
                    "usage": {"prompt_tokens": 120, "completion_tokens": 30},
                },
            )

        provider = OpenAIProvider("sk-test", "gpt-4o-mini", 0.7, _client(handler))
        response = await provider.complete("sys", "usr")

        assert "response_format" not in captured  # the old channel is gone
        tool = captured["tools"][0]["function"]
        assert tool["name"] == "decide"
        assert tool["strict"] is True
        assert tool["parameters"]["required"]
        assert captured["tool_choice"] == {"type": "function", "function": {"name": "decide"}}
        assert captured["parallel_tool_calls"] is False
        assert response.tokens_in == 120
        assert response.tokens_out == 30
        assert response.text == '{"a":1}'

    async def test_missing_tool_call_degrades_to_content(self):
        # Near-impossible under forced tool_choice, but the seam must hand
        # SOMETHING to validate_decision (which then produces the idle
        # fallback) instead of KeyError-ing the tick.
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                json={"choices": [{"message": {"content": "I cannot decide."}}], "usage": {}},
            )

        provider = OpenAIProvider("sk-test", "gpt-4o-mini", 0.7, _client(handler))
        response = await provider.complete("sys", "usr")
        assert response.text == "I cannot decide."


class TestAnthropicProvider:
    async def test_sends_forced_strict_tool_and_parses_input(self):
        captured = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured.update(json.loads(request.content))
            assert request.headers["x-api-key"] == "sk-ant-test"
            assert request.headers["anthropic-version"] == "2023-06-01"
            return httpx.Response(
                200,
                json={
                    "content": [
                        {"type": "text", "text": "picking a task"},
                        {"type": "tool_use", "id": "toolu_1", "name": "decide", "input": {"a": 1}},
                    ],
                    "stop_reason": "tool_use",
                    "usage": {"input_tokens": 200, "output_tokens": 40},
                },
            )

        provider = AnthropicProvider("sk-ant-test", "claude-sonnet-5", _client(handler))
        response = await provider.complete("sys", "usr")

        # Sampling params are REMOVED on current Claude models — sending
        # temperature 400s. The greedy convention deliberately does not apply.
        assert "temperature" not in captured
        assert captured["thinking"] == {"type": "disabled"}
        assert captured["system"] == "sys"
        tool = captured["tools"][0]
        assert tool["name"] == "decide"
        assert tool["strict"] is True
        assert tool["input_schema"]["required"]
        assert captured["tool_choice"] == {
            "type": "tool",
            "name": "decide",
            "disable_parallel_tool_use": True,
        }
        assert response.tokens_in == 200
        assert response.tokens_out == 40
        assert json.loads(response.text) == {"a": 1}

    async def test_refusal_without_tool_use_degrades_to_marker(self):
        # A classifier stop returns no tool_use block; the marker is non-JSON
        # so decide_safely maps it to idle with the stop_reason in the log.
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                json={
                    "content": [{"type": "text", "text": "declined"}],
                    "stop_reason": "refusal",
                    "usage": {"input_tokens": 10, "output_tokens": 2},
                },
            )

        provider = AnthropicProvider("sk-ant-test", "claude-sonnet-5", _client(handler))
        response = await provider.complete("sys", "usr")
        assert "stop_reason=refusal" in response.text


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
            if request.url.path == "/api/show":
                return httpx.Response(200, json={"capabilities": ["completion"]})
            options_seen.append(json.loads(request.content).get("options"))
            return httpx.Response(200, json={"message": {"content": "{}"}})

        provider = OllamaProvider(
            "http://ollama:11434", "llama3.1:8b", 0.7, _client(handler), num_ctx=8192
        )
        await provider.warmup()
        await provider.complete("sys", "usr")

        assert [o.get("num_ctx") for o in options_seen] == [8192, 8192]

    async def test_thinking_model_gets_think_false_everywhere(self):
        # qwen3.5-family lesson (Phase 2 sweep, 0/5): a thinking-capable model
        # burns the whole num_ctx window on chain-of-thought and returns empty
        # content under structured outputs. think:false must ride every call,
        # warmup included, and the /api/show probe must run exactly once.
        chat_bodies, show_calls = [], []

        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/api/show":
                show_calls.append(json.loads(request.content))
                return httpx.Response(200, json={"capabilities": ["completion", "thinking"]})
            chat_bodies.append(json.loads(request.content))
            return httpx.Response(200, json={"message": {"content": "{}"}})

        provider = OllamaProvider("http://ollama:11434", "qwen3.5:4b", 0.0, _client(handler))
        await provider.warmup()
        await provider.complete("sys", "usr")

        assert [b["think"] for b in chat_bodies] == [False, False]
        assert show_calls == [{"model": "qwen3.5:4b"}]  # probed once, cached

    async def test_plain_model_never_gets_think_flag(self):
        # Ollama rejects `think` on models without the capability — the flag
        # must be absent, not think:true, for the whole non-reasoning fleet.
        chat_bodies = []

        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/api/show":
                return httpx.Response(200, json={"capabilities": ["completion"]})
            chat_bodies.append(json.loads(request.content))
            return httpx.Response(200, json={"message": {"content": "{}"}})

        provider = OllamaProvider("http://ollama:11434", "llama3.1:8b", 0.7, _client(handler))
        await provider.complete("sys", "usr")
        assert "think" not in chat_bodies[0]

    async def test_show_probe_failure_degrades_to_plain(self):
        # Introspection must never block deliberation: a dead /api/show means
        # "assume plain" and the completion still goes out (without think).
        chat_bodies = []

        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/api/show":
                return httpx.Response(500)
            chat_bodies.append(json.loads(request.content))
            return httpx.Response(200, json={"message": {"content": "{}"}})

        provider = OllamaProvider("http://ollama:11434", "mystery:7b", 0.7, _client(handler))
        await provider.complete("sys", "usr")
        assert "think" not in chat_bodies[0]

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

    async def test_anthropic_key_selects_anthropic_under_auto(self):
        settings = Settings(llm_provider="auto", openai_api_key="", anthropic_api_key="sk-ant-x")
        provider = await build_llm_provider(settings, _client(lambda r: httpx.Response(500)))
        assert isinstance(provider, AnthropicProvider)

    async def test_auto_prefers_openai_over_anthropic(self):
        # Existing precedence preserved: openai wins under auto when both
        # keys are present; LLM_PROVIDER=anthropic pins explicitly.
        settings = Settings(llm_provider="auto", openai_api_key="sk-test", anthropic_api_key="sk-ant-x")
        provider = await build_llm_provider(settings, _client(lambda r: httpx.Response(500)))
        assert isinstance(provider, OpenAIProvider)

    async def test_explicit_anthropic_pins(self):
        settings = Settings(
            llm_provider="anthropic", openai_api_key="sk-would-win-under-auto", anthropic_api_key="sk-ant-x"
        )
        provider = await build_llm_provider(settings, _client(lambda r: httpx.Response(500)))
        assert isinstance(provider, AnthropicProvider)

    async def test_no_key_falls_to_ollama_with_warmup(self):
        calls = []

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(request.url.path)
            if request.url.path == "/api/tags":
                return httpx.Response(200, json={"models": [{"name": "llama3.1:8b"}]})
            if request.url.path == "/api/show":  # thinking-capability probe
                return httpx.Response(200, json={"capabilities": ["completion"]})
            if request.url.path == "/api/chat":  # warmup
                return httpx.Response(200, json={"message": {"content": "ok"}})
            raise AssertionError(request.url.path)

        # llm_model_ollama pinned explicitly: without it Settings reads the
        # machine's .env and the test goes red whenever that pins a model the
        # mock /api/tags doesn't list (the HANDOFF local-only flake).
        settings = Settings(llm_provider="auto", openai_api_key="", llm_model_ollama="llama3.1:8b")
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
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("LLM_PROVIDER", raising=False)
    monkeypatch.delenv("OLLAMA_BASE_URL", raising=False)
    monkeypatch.delenv("LLM_TEAM_MODELS", raising=False)
    monkeypatch.delenv("OLLAMA_NUM_CTX", raising=False)
