"""LLM providers. Each returns the raw response text plus usage; parsing and
contract validation live in decide.py — providers stay transport-only."""

import asyncio
import json
import time
from dataclasses import dataclass
from typing import Protocol

import httpx

from agent_service.llm.contract import DECISION_SCHEMA
from agent_service.logging import logger
from agent_service.metrics import llm_cost_dollars_total, llm_latency_seconds, llm_tokens_total
from agent_service.settings import Settings

# USD per token (input, output). Unknown models cost 0 — the metric is an
# estimate for the Grafana wallet panel, not an invoice.
_PRICES_PER_TOKEN: dict[str, tuple[float, float]] = {
    "gpt-4o-mini": (0.15e-6, 0.60e-6),
    "gpt-4o": (2.50e-6, 10.00e-6),
}


@dataclass(frozen=True)
class LLMResponse:
    text: str
    tokens_in: int
    tokens_out: int
    latency_seconds: float
    provider: str
    model: str


class LLMProvider(Protocol):
    name: str
    model: str

    async def complete(self, system: str, user: str) -> LLMResponse: ...


def _record(response: LLMResponse) -> LLMResponse:
    llm_tokens_total.labels(provider=response.provider, direction="input").inc(response.tokens_in)
    llm_tokens_total.labels(provider=response.provider, direction="output").inc(response.tokens_out)
    prices = _PRICES_PER_TOKEN.get(response.model, (0.0, 0.0))
    llm_cost_dollars_total.labels(provider=response.provider).inc(
        response.tokens_in * prices[0] + response.tokens_out * prices[1]
    )
    llm_latency_seconds.labels(provider=response.provider).observe(response.latency_seconds)
    return response


class FakeProvider:
    """Deterministic, offline, always-valid decisions. Tests and CI never
    spend a token; the budget breaker and boot-probe both land here."""

    name = "fake"
    model = "fake-scripted-1"

    _SCRIPT = [
        {
            "action": "chat",
            "params": {"message": "Good day! The weather holds and the work is honest."},
            "reasoning": "Someone is nearby; a greeting builds goodwill.",
            "importance": 2.5,
            "sentiment": 0.5,
            "relationshipUpdates": [
                {
                    "villagerId": "019f8e2a-0000-7000-8000-0000000b2a44",
                    "affinityDelta": 3,
                    "trustDelta": 1,
                    "reason": "A pleasant exchange in the morning sun.",
                }
            ],
            "governanceAction": None,
        },
        {
            "action": "move",
            "params": {"to": {"x": 8, "y": 64, "z": 8}, "range": 2},
            "reasoning": "I should stretch my legs and see the village.",
            "importance": 1.5,
            "sentiment": 0.1,
            "relationshipUpdates": None,
            "governanceAction": None,
        },
        {
            "action": "idle",
            "params": {},
            "reasoning": "A moment of rest to watch the clouds.",
            "importance": 1.0,
            "sentiment": 0.2,
            "relationshipUpdates": None,
            "governanceAction": None,
        },
        # RB-1 rows: the fake script exercises the T1 enums (contract-commit
        # house rule) so CI walks the new surface through the brain seam.
        {
            "action": "gather",
            "params": {"resource": "iron_ore", "count": 2},
            "reasoning": "The seam by the ridge showed iron; the pick in my pack is stone.",
            "importance": 3.0,
            "sentiment": 0.3,
            "relationshipUpdates": None,
            "governanceAction": None,
        },
        {
            "action": "craft",
            "params": {"item": "iron_pickaxe"},
            "reasoning": "Raw iron in the pack and a furnace's worth of patience.",
            "importance": 4.0,
            "sentiment": 0.4,
            "relationshipUpdates": None,
            "governanceAction": None,
        },
        {
            "action": "craft",
            "params": {"item": "iron_sword"},
            "reasoning": "A guard without a blade is a scarecrow; the same furnace owes me a sword.",
            "importance": 4.0,
            "sentiment": 0.4,
            "relationshipUpdates": None,
            "governanceAction": None,
        },
    ]

    def __init__(self) -> None:
        self._calls = 0

    async def complete(self, system: str, user: str) -> LLMResponse:
        decision = self._SCRIPT[self._calls % len(self._SCRIPT)]
        self._calls += 1
        return _record(
            LLMResponse(
                text=json.dumps(decision),
                tokens_in=0,
                tokens_out=0,
                latency_seconds=0.0,
                provider=self.name,
                model=self.model,
            )
        )


class OpenAIProvider:
    name = "openai"

    def __init__(
        self,
        api_key: str,
        model: str,
        temperature: float,
        client: httpx.AsyncClient,
        max_concurrent: int = 4,
    ):
        self.model = model
        self._api_key = api_key
        self._temperature = temperature
        self._client = client
        # One provider instance per process, so this gate is shared by every
        # caller (all villager ticks). Queuing here is intentional backpressure:
        # the wait counts toward the deliberate node's latency budget instead
        # of thrashing the backend with N parallel requests.
        self._gate = asyncio.Semaphore(max_concurrent)

    async def complete(self, system: str, user: str) -> LLMResponse:
        async with self._gate:
            return await self._complete(system, user)

    async def _complete(self, system: str, user: str) -> LLMResponse:
        started = time.perf_counter()
        response = await self._client.post(
            "https://api.openai.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {self._api_key}"},
            json={
                "model": self.model,
                "temperature": self._temperature,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
                # strict structured outputs: the model CANNOT emit off-schema JSON
                "response_format": {
                    "type": "json_schema",
                    "json_schema": {"name": "decision", "schema": DECISION_SCHEMA, "strict": True},
                },
            },
            timeout=60.0,
        )
        response.raise_for_status()
        body = response.json()
        usage = body.get("usage", {})
        return _record(
            LLMResponse(
                text=body["choices"][0]["message"]["content"],
                tokens_in=usage.get("prompt_tokens", 0),
                tokens_out=usage.get("completion_tokens", 0),
                latency_seconds=time.perf_counter() - started,
                provider=self.name,
                model=self.model,
            )
        )


class OllamaProvider:
    name = "ollama"

    def __init__(
        self,
        base_url: str,
        model: str,
        temperature: float,
        client: httpx.AsyncClient,
        max_concurrent: int = 4,
    ):
        self.model = model
        self._url = f"{base_url.rstrip('/')}/api/chat"
        self._temperature = temperature
        self._client = client
        # Shared across all ticks (one provider instance per process). A single
        # local GPU thrashes under 20 parallel completions; queued ticks wait
        # here on purpose — the wait counts toward the deliberate node's
        # latency budget as backpressure, not as a bug.
        self._gate = asyncio.Semaphore(max_concurrent)

    async def complete(self, system: str, user: str) -> LLMResponse:
        async with self._gate:
            return await self._complete(system, user)

    async def _complete(self, system: str, user: str) -> LLMResponse:
        started = time.perf_counter()
        response = await self._client.post(
            self._url,
            json={
                "model": self.model,
                "stream": False,
                "format": DECISION_SCHEMA,  # Ollama structured outputs
                "options": {"temperature": self._temperature},
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
            },
            timeout=120.0,  # local model latency varies with GPU load
        )
        response.raise_for_status()
        body = response.json()
        return _record(
            LLMResponse(
                text=body["message"]["content"],
                tokens_in=body.get("prompt_eval_count", 0),
                tokens_out=body.get("eval_count", 0),
                latency_seconds=time.perf_counter() - started,
                provider=self.name,
                model=self.model,
            )
        )

    async def warmup(self) -> None:
        """First call cold-loads the model into VRAM — pay it at boot."""
        await self._client.post(
            self._url,
            json={"model": self.model, "stream": False, "messages": [{"role": "user", "content": "ok"}]},
            timeout=300.0,
        )


async def build_llm_provider(settings: Settings, client: httpx.AsyncClient) -> LLMProvider:
    """Boot-time chain: explicit LLM_PROVIDER pins; 'auto' walks
    openai (key present) -> ollama (reachable + model pulled, warmed) -> fake.
    Degrades with a structured warning — the demo never crashes on credentials."""
    choice = settings.llm_provider.lower()

    if choice == "fake":
        logger.info("llm provider: fake (explicit)")
        return FakeProvider()

    if choice in ("auto", "openai") and settings.openai_api_key:
        logger.info("llm provider: openai", model=settings.llm_model_openai)
        return OpenAIProvider(
            settings.openai_api_key,
            settings.llm_model_openai,
            settings.llm_temperature,
            client,
            settings.llm_max_concurrent_requests,
        )
    if choice == "openai":
        logger.warning("LLM_PROVIDER=openai but OPENAI_API_KEY is blank — walking the chain instead")

    try:
        response = await client.get(f"{settings.ollama_base_url.rstrip('/')}/api/tags", timeout=5.0)
        response.raise_for_status()
        models = [m["name"] for m in response.json().get("models", [])]
        wanted = settings.llm_model_ollama
        if any(m == wanted or m.split(":")[0] == wanted.split(":")[0] for m in models):
            provider = OllamaProvider(
                settings.ollama_base_url,
                wanted,
                settings.llm_temperature,
                client,
                settings.llm_max_concurrent_requests,
            )
            await provider.warmup()
            logger.info("llm provider: ollama (warmed)", model=wanted)
            return provider
        logger.warning(
            "ollama reachable but LLM model not pulled — falling back to FAKE deliberation",
            wanted=wanted,
            available=models,
        )
    except httpx.HTTPError as exc:
        logger.warning("ollama unreachable — falling back to FAKE deliberation", error=str(exc))

    return FakeProvider()
