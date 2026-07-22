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
        name: str | None = None,
        num_ctx: int | None = None,
    ):
        self.model = model
        if name is not None:
            # Per-team instances label metrics "ollama/<team>" so the Grafana
            # wallet/latency panels split by team; the single-brain path keeps
            # the class default and existing dashboards keep matching.
            self.name = name
        self._url = f"{base_url.rstrip('/')}/api/chat"
        self._temperature = temperature
        self._num_ctx = num_ctx
        self._client = client
        # Shared across all ticks (one provider instance per process). A single
        # local GPU thrashes under 20 parallel completions; queued ticks wait
        # here on purpose — the wait counts toward the deliberate node's
        # latency budget as backpressure, not as a bug.
        self._gate = asyncio.Semaphore(max_concurrent)

    def _options(self) -> dict:
        # num_ctx caps the KV-cache the server allocates per request. Without
        # it the host default rules (observed drifted to 65536 = 13 GB VRAM
        # for an 8B model); with it two team models fit resident on one GPU.
        options: dict = {"temperature": self._temperature}
        if self._num_ctx is not None:
            options["num_ctx"] = self._num_ctx
        return options

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
                "options": self._options(),
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
        """First call cold-loads the model into VRAM — pay it at boot.

        Must send the SAME options as real completions: Ollama spins up a new
        runner when num_ctx changes, so a bare warmup would cold-load twice
        (once at server-default ctx, again at ours on the first real tick).
        """
        await self._client.post(
            self._url,
            json={
                "model": self.model,
                "stream": False,
                "options": self._options(),
                "messages": [{"role": "user", "content": "ok"}],
            },
            timeout=300.0,
        )


def _model_pulled(wanted: str, available: list[str]) -> bool:
    return any(m == wanted or m.split(":")[0] == wanted.split(":")[0] for m in available)


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
        if _model_pulled(wanted, models):
            provider = OllamaProvider(
                settings.ollama_base_url,
                wanted,
                settings.llm_temperature,
                client,
                settings.llm_max_concurrent_requests,
                num_ctx=settings.ollama_num_ctx,
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


def parse_team_models(spec: str) -> dict[str, str]:
    """"red=llama3.1:8b,blue=gemma3:12b" -> {"red": "llama3.1:8b", ...}.

    Malformed entries raise ValueError: LLM_TEAM_MODELS is opt-in filming
    config, and a typo silently degrading one team to the default brain would
    poison a filmed race (asymmetric without anyone noticing). Fail the boot,
    not the take."""
    teams: dict[str, str] = {}
    for entry in filter(None, (part.strip() for part in spec.split(","))):
        team, sep, model = entry.partition("=")
        team, model = team.strip(), model.strip()
        if not sep or not team or not model:
            raise ValueError(f"LLM_TEAM_MODELS entry {entry!r} is not '<team>=<model>'")
        if team in teams:
            raise ValueError(f"LLM_TEAM_MODELS names team {team!r} twice")
        teams[team] = model
    return teams


async def build_team_providers(settings: Settings, client: httpx.AsyncClient) -> dict[str, OllamaProvider]:
    """One warmed OllamaProvider per race team (RB filming: rival teams on
    different local models). {} when LLM_TEAM_MODELS is blank — feature off.

    Strict by design, unlike the degrade-gracefully chain above: if the spec
    is set, every named model must be pulled and Ollama must be reachable, or
    boot fails loudly."""
    teams = parse_team_models(settings.llm_team_models)
    if not teams:
        return {}

    response = await client.get(f"{settings.ollama_base_url.rstrip('/')}/api/tags", timeout=5.0)
    response.raise_for_status()
    available = [m["name"] for m in response.json().get("models", [])]

    # Validate the WHOLE roster before warming anything — one missing model
    # must not leave the other team's brain half-loaded in VRAM.
    missing = {team: model for team, model in teams.items() if not _model_pulled(model, available)}
    if missing:
        pulls = "; ".join(f"`ollama pull {model}`" for model in missing.values())
        raise RuntimeError(
            f"LLM_TEAM_MODELS wants {missing} but Ollama only has {available} — {pulls} first"
        )

    providers: dict[str, OllamaProvider] = {}
    for team, model in teams.items():
        provider = OllamaProvider(
            settings.ollama_base_url,
            model,
            settings.llm_temperature,
            client,
            settings.llm_max_concurrent_requests,
            name=f"ollama/{team}",
            num_ctx=settings.ollama_num_ctx,
        )
        await provider.warmup()  # both models resident BEFORE the race starts
        providers[team] = provider
        logger.info("team llm warmed", team=team, model=model)
    return providers


class TeamRouter:
    """villager_id -> provider, via the race roster. Villagers outside a team
    (or before RaceStarted lands) deliberate on the default brain; during the
    race each team locks to its own model."""

    def __init__(self, default: LLMProvider, by_team: dict[str, LLMProvider], team_of):
        self._default = default
        self._by_team = by_team
        self._team_of = team_of

    def __call__(self, villager_id: str) -> LLMProvider:
        team = self._team_of(str(villager_id))
        if team is None:
            return self._default
        return self._by_team.get(team, self._default)
