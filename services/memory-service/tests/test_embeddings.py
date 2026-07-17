import math

import httpx
import pytest

from memory_service.embeddings import (
    FakeEmbeddingProvider,
    OllamaEmbeddingProvider,
    QueryEmbeddingCache,
    build_embedding_provider,
)
from memory_service.settings import Settings


class CountingProvider:
    """Deterministic per-text vectors, counting embed calls."""

    name = "counting"
    dim = 3

    def __init__(self):
        self.calls = 0

    async def embed(self, text: str) -> list[float]:
        self.calls += 1
        return [float(len(text)), 0.0, 0.0]


class TestFakeProvider:
    async def test_deterministic_and_unit_norm(self):
        provider = FakeEmbeddingProvider()
        a1 = await provider.embed("the oak tree by the pond")
        a2 = await provider.embed("the oak tree by the pond")
        b = await provider.embed("an election in the village")
        assert a1 == a2
        assert a1 != b
        assert len(a1) == 768
        assert math.isclose(math.sqrt(sum(v * v for v in a1)), 1.0, rel_tol=1e-9)


class TestQueryEmbeddingCache:
    async def test_hit_skips_provider_and_delegates_identity(self):
        inner = CountingProvider()
        cache = QueryEmbeddingCache(inner, capacity=8)
        first = await cache.embed("the oak tree")
        second = await cache.embed("the oak tree")
        assert first == second == [12.0, 0.0, 0.0]
        assert inner.calls == 1
        assert (cache.name, cache.dim) == ("counting", 3)

    async def test_lru_evicts_least_recently_used(self):
        inner = CountingProvider()
        cache = QueryEmbeddingCache(inner, capacity=2)
        await cache.embed("a")
        await cache.embed("b")
        await cache.embed("a")  # refresh "a" — "b" is now LRU
        await cache.embed("c")  # evicts "b"
        assert inner.calls == 3
        await cache.embed("a")  # still cached
        assert inner.calls == 3
        await cache.embed("b")  # was evicted — re-embeds
        assert inner.calls == 4

    async def test_zero_capacity_disables_caching(self):
        inner = CountingProvider()
        cache = QueryEmbeddingCache(inner, capacity=0)
        await cache.embed("a")
        await cache.embed("a")
        assert inner.calls == 2


def _client(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


class TestProviderChain:
    async def test_openai_key_wins(self):
        settings = Settings(openai_api_key="sk-test", ollama_base_url="http://nowhere:1")
        provider = await build_embedding_provider(settings, _client(lambda r: httpx.Response(500)))
        assert provider.name == "text-embedding-3-small@768"

    async def test_falls_to_ollama_when_model_pulled(self):
        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/api/tags":
                return httpx.Response(200, json={"models": [{"name": "nomic-embed-text:latest"}]})
            if request.url.path == "/api/embed":  # boot-time warmup
                return httpx.Response(200, json={"embeddings": [[0.0] * 768]})
            raise AssertionError(f"unexpected call: {request.url.path}")

        settings = Settings(openai_api_key="")
        provider = await build_embedding_provider(settings, _client(handler))
        assert isinstance(provider, OllamaEmbeddingProvider)
        assert provider.name == "nomic-embed-text"

    async def test_falls_to_fake_when_model_missing(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"models": [{"name": "llama3.1:8b"}]})

        settings = Settings(openai_api_key="")
        provider = await build_embedding_provider(settings, _client(handler))
        assert isinstance(provider, FakeEmbeddingProvider)

    async def test_falls_to_fake_when_ollama_unreachable(self):
        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("refused")

        settings = Settings(openai_api_key="")
        provider = await build_embedding_provider(settings, _client(handler))
        assert isinstance(provider, FakeEmbeddingProvider)


class TestOllamaProvider:
    async def test_calls_api_embed_and_unwraps(self):
        def handler(request: httpx.Request) -> httpx.Response:
            assert request.url.path == "/api/embed"
            return httpx.Response(200, json={"embeddings": [[0.1, 0.2, 0.3]]})

        provider = OllamaEmbeddingProvider("http://ollama:11434", "nomic-embed-text", 3, _client(handler))
        assert await provider.embed("hello") == [0.1, 0.2, 0.3]


@pytest.fixture(autouse=True)
def _no_env_leakage(monkeypatch):
    # A real OPENAI_API_KEY in the developer's env must not flip chain tests.
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("OLLAMA_BASE_URL", raising=False)
