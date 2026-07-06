"""Embedding providers — the same openai -> ollama -> fake chain as the LLM
port (CIV-7), probed at boot so a missing key degrades instead of crashing.

One model per deployment, recorded per-row in embedding_model: vectors from
different models never share a space; switching means an offline re-embed.
"""

import hashlib
import math
import struct
import time
from typing import Protocol

import httpx

from memory_service.logging import logger
from memory_service.metrics import embedding_seconds
from memory_service.settings import Settings


class EmbeddingProvider(Protocol):
    name: str
    dim: int

    async def embed(self, text: str) -> list[float]: ...


class FakeEmbeddingProvider:
    """Deterministic, unit-norm, offline. Tests and CI never spend a token."""

    def __init__(self, dim: int = 768):
        self.name = "fake"
        self.dim = dim

    async def embed(self, text: str) -> list[float]:
        raw = b""
        counter = 0
        while len(raw) < self.dim * 4:
            raw += hashlib.sha256(f"{text}:{counter}".encode()).digest()
            counter += 1
        values = [struct.unpack_from("<i", raw, i * 4)[0] for i in range(self.dim)]
        norm = math.sqrt(sum(v * v for v in values)) or 1.0
        return [v / norm for v in values]


class OllamaEmbeddingProvider:
    def __init__(self, base_url: str, model: str, dim: int, client: httpx.AsyncClient):
        self.name = model
        self.dim = dim
        self._url = f"{base_url.rstrip('/')}/api/embed"
        self._model = model
        self._client = client

    async def embed(self, text: str) -> list[float]:
        started = time.perf_counter()
        response = await self._client.post(self._url, json={"model": self._model, "input": text}, timeout=60.0)
        response.raise_for_status()
        embedding_seconds.labels(provider="ollama").observe(time.perf_counter() - started)
        return response.json()["embeddings"][0]

    async def warmup(self) -> None:
        """First call after boot loads the model into VRAM — pay that cost at
        startup (generously timed), not on a villager's first memory."""
        await self._client.post(self._url, json={"model": self._model, "input": "warmup"}, timeout=120.0)


class OpenAIEmbeddingProvider:
    def __init__(self, api_key: str, model: str, dim: int, client: httpx.AsyncClient):
        # Matryoshka truncation: text-embedding-3-small at dimensions=768
        self.name = f"{model}@{dim}"
        self.dim = dim
        self._model = model
        self._api_key = api_key
        self._client = client

    async def embed(self, text: str) -> list[float]:
        started = time.perf_counter()
        response = await self._client.post(
            "https://api.openai.com/v1/embeddings",
            headers={"Authorization": f"Bearer {self._api_key}"},
            json={"model": self._model, "input": text, "dimensions": self.dim},
            timeout=30.0,
        )
        response.raise_for_status()
        embedding_seconds.labels(provider="openai").observe(time.perf_counter() - started)
        return response.json()["data"][0]["embedding"]


async def build_embedding_provider(settings: Settings, client: httpx.AsyncClient) -> EmbeddingProvider:
    """Boot-time chain: openai (key present) -> ollama (reachable AND has the
    model pulled) -> fake with a loud warning. The demo degrades, never dies."""
    if settings.openai_api_key:
        logger.info("embedding provider: openai", model=settings.embedding_model_openai, dim=settings.embedding_dim)
        return OpenAIEmbeddingProvider(
            settings.openai_api_key, settings.embedding_model_openai, settings.embedding_dim, client
        )

    try:
        response = await client.get(f"{settings.ollama_base_url.rstrip('/')}/api/tags", timeout=5.0)
        response.raise_for_status()
        models = [m["name"] for m in response.json().get("models", [])]
        if any(m.split(":")[0] == settings.embedding_model_ollama.split(":")[0] for m in models):
            provider = OllamaEmbeddingProvider(
                settings.ollama_base_url, settings.embedding_model_ollama, settings.embedding_dim, client
            )
            await provider.warmup()
            logger.info("embedding provider: ollama (warmed)", model=settings.embedding_model_ollama)
            return provider
        logger.warning(
            "ollama reachable but embedding model not pulled — falling back to FAKE embeddings",
            wanted=settings.embedding_model_ollama,
            available=models,
        )
    except httpx.HTTPError as exc:
        logger.warning("ollama unreachable — falling back to FAKE embeddings", error=str(exc))

    return FakeEmbeddingProvider(settings.embedding_dim)
