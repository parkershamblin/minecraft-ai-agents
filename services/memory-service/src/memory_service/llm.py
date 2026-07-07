"""Summarization LLM port for reflections — the same openai -> ollama chain as
agent-service's deliberation port (CIV-7), with one deliberate divergence: when
no real provider is available, or the daily budget trips, reflections STOP
instead of degrading to fake. Reflections are permanent narrative material
(memory_db is filming truth); scripted insights would pollute it. An explicit
LLM_PROVIDER=fake still opts in for tests and dev sandboxes.
"""

import json
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Protocol

import httpx

from memory_service.logging import logger
from memory_service.metrics import (
    llm_budget_tripped,
    llm_cost_dollars_total,
    llm_latency_seconds,
    llm_tokens_total,
)
from memory_service.settings import Settings

# USD per token (input, output). Unknown models cost 0 — the metric is an
# estimate for the Grafana wallet panel, not an invoice.
_PRICES_PER_TOKEN: dict[str, tuple[float, float]] = {
    "gpt-4o-mini": (0.15e-6, 0.60e-6),
    "gpt-4o": (2.50e-6, 10.00e-6),
}

# What the summarizer must emit. Every property is required and
# additionalProperties is false — OpenAI strict mode rejects optional
# properties (the M1-3 ruling); numeric/array bounds are fine by the same
# precedent (DECISION_SCHEMA ships them against both providers).
REFLECTION_SCHEMA: dict = {
    "type": "object",
    "properties": {
        "insights": {
            "type": "array",
            "minItems": 1,
            "maxItems": 3,
            "items": {
                "type": "object",
                "properties": {
                    "insight": {"type": "string", "minLength": 1},
                    "sourceIndices": {
                        "type": "array",
                        "items": {"type": "integer", "minimum": 1},
                        "minItems": 1,
                    },
                },
                "required": ["insight", "sourceIndices"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["insights"],
    "additionalProperties": False,
}


@dataclass(frozen=True)
class LLMResponse:
    text: str
    tokens_in: int
    tokens_out: int
    latency_seconds: float
    provider: str
    model: str


class SummarizerProvider(Protocol):
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


class FakeSummarizer:
    """Deterministic, offline, schema-valid. NOT part of the auto chain (see
    module docstring) — only an explicit LLM_PROVIDER=fake lands here."""

    name = "fake"
    model = "fake-reflection-1"

    _INSIGHT = {
        "insights": [
            {
                "insight": "Looking back, the same faces and the same chores keep filling my days.",
                "sourceIndices": [1],
            }
        ]
    }

    async def complete(self, system: str, user: str) -> LLMResponse:
        return _record(
            LLMResponse(
                text=json.dumps(self._INSIGHT),
                tokens_in=0,
                tokens_out=0,
                latency_seconds=0.0,
                provider=self.name,
                model=self.model,
            )
        )


class OpenAISummarizer:
    name = "openai"

    def __init__(self, api_key: str, model: str, temperature: float, client: httpx.AsyncClient):
        self.model = model
        self._api_key = api_key
        self._temperature = temperature
        self._client = client

    async def complete(self, system: str, user: str) -> LLMResponse:
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
                    "json_schema": {"name": "reflection", "schema": REFLECTION_SCHEMA, "strict": True},
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


class OllamaSummarizer:
    name = "ollama"

    def __init__(self, base_url: str, model: str, temperature: float, client: httpx.AsyncClient):
        self.model = model
        self._url = f"{base_url.rstrip('/')}/api/chat"
        self._temperature = temperature
        self._client = client

    async def complete(self, system: str, user: str) -> LLMResponse:
        started = time.perf_counter()
        response = await self._client.post(
            self._url,
            json={
                "model": self.model,
                "stream": False,
                "format": REFLECTION_SCHEMA,  # Ollama structured outputs
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


class BudgetExhausted(RuntimeError):
    """Raised while the daily reflection token budget breaker is open."""


class BudgetedSummarizer:
    """Daily token circuit breaker around the chosen summarizer.

    Diverges from agent-service's BudgetedProvider on purpose: deliberation
    flips to fake when the budget trips (the sim must never stall), but a
    tripped reflection budget RAISES until midnight UTC — see module docstring.
    In-process counter; a Redis counter replaces this the day it shards.
    """

    name = "budgeted"

    def __init__(
        self,
        primary: SummarizerProvider,
        daily_token_budget: int,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    ):
        self._primary = primary
        self._budget = daily_token_budget
        self._clock = clock
        self._day = clock().date()
        self._spent = 0
        self._tripped = False
        llm_budget_tripped.set(0)

    @property
    def model(self) -> str:
        return self._primary.model

    @property
    def tokens_spent_today(self) -> int:
        return self._spent

    def _roll_day(self) -> None:
        today = self._clock().date()
        if today != self._day:
            self._day = today
            self._spent = 0
            if self._tripped:
                self._tripped = False
                llm_budget_tripped.set(0)
                logger.info("reflection budget reset — circuit breaker closed", day=str(today))

    async def complete(self, system: str, user: str) -> LLMResponse:
        self._roll_day()
        if self._tripped:
            raise BudgetExhausted(
                f"reflection token budget exhausted ({self._spent}/{self._budget}); resets at midnight UTC"
            )
        response = await self._primary.complete(system, user)
        self._spent += response.tokens_in + response.tokens_out
        if not self._tripped and self._spent >= self._budget:
            self._tripped = True
            llm_budget_tripped.set(1)
            logger.warning(
                "REFLECTION TOKEN BUDGET EXHAUSTED — reflections paused until midnight UTC",
                spent=self._spent,
                budget=self._budget,
            )
        return response


async def build_summarizer_provider(settings: Settings, client: httpx.AsyncClient) -> SummarizerProvider | None:
    """Boot-time chain: explicit LLM_PROVIDER pins; 'auto' walks
    openai (key present) -> ollama (reachable + model pulled, warmed) -> None.
    None means reflections stay OFF — unlike deliberation there is no fake
    fallback, because fake insights would be stored as narrative truth."""
    choice = settings.llm_provider.lower()

    if choice == "fake":
        logger.info("reflection llm: fake (explicit opt-in — memories will be scripted)")
        return FakeSummarizer()

    if choice in ("auto", "openai") and settings.openai_api_key:
        logger.info("reflection llm: openai", model=settings.llm_model_openai)
        return OpenAISummarizer(settings.openai_api_key, settings.llm_model_openai, settings.llm_temperature, client)
    if choice == "openai":
        logger.warning("LLM_PROVIDER=openai but OPENAI_API_KEY is blank — walking the chain instead")

    try:
        response = await client.get(f"{settings.ollama_base_url.rstrip('/')}/api/tags", timeout=5.0)
        response.raise_for_status()
        models = [m["name"] for m in response.json().get("models", [])]
        wanted = settings.llm_model_ollama
        if any(m == wanted or m.split(":")[0] == wanted.split(":")[0] for m in models):
            provider = OllamaSummarizer(settings.ollama_base_url, wanted, settings.llm_temperature, client)
            await provider.warmup()
            logger.info("reflection llm: ollama (warmed)", model=wanted)
            return provider
        logger.warning(
            "ollama reachable but LLM model not pulled — reflections DISABLED (no fake fallback)",
            wanted=wanted,
            available=models,
        )
    except httpx.HTTPError as exc:
        logger.warning("ollama unreachable — reflections DISABLED (no fake fallback)", error=str(exc))

    return None
