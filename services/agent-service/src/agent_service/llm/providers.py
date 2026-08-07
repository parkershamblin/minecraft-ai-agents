"""LLM providers. Each returns the raw response text plus usage; parsing and
contract validation live in decide.py — providers stay transport-only."""

import asyncio
import json
import time
from dataclasses import dataclass
from typing import Protocol

import httpx

from agent_service.llm.contract import DECISION_SCHEMA, decision_tool_schema
from agent_service.logging import logger
from agent_service.metrics import llm_cost_dollars_total, llm_latency_seconds, llm_tokens_total
from agent_service.settings import Settings

# USD per token (input, output). Unknown models cost 0 — the metric is an
# estimate for the Grafana wallet panel, not an invoice.
_PRICES_PER_TOKEN: dict[str, tuple[float, float]] = {
    "gpt-4o-mini": (0.15e-6, 0.60e-6),
    "gpt-4o": (2.50e-6, 10.00e-6),
    "claude-sonnet-5": (3.00e-6, 15.00e-6),
    "claude-opus-5": (5.00e-6, 25.00e-6),
    "claude-haiku-4-5": (1.00e-6, 5.00e-6),
}

# The single forced tool on the frontier providers (owner decision
# 2026-07-27): the decision channel IS a function call there — one 'decide'
# invocation per tick, strict schema, no open-ended loop. The description is
# model-facing documentation; the verbs themselves are documented in the
# system prompt, which stays the source of truth for behavior.
_DECIDE_TOOL_DESCRIPTION = (
    "Commit the villager's decision for this tick. Reason briefly first, then "
    "pick exactly one action with params matching that action's shape. Call "
    "this tool exactly once."
)


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
            "importance": 2,
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
            "importance": 2,
            "sentiment": 0.0,
            "relationshipUpdates": None,
            "governanceAction": None,
        },
        {
            "action": "idle",
            "params": {},
            "reasoning": "A moment of rest to watch the clouds.",
            "importance": 1,
            "sentiment": 0.25,
            "relationshipUpdates": None,
            "governanceAction": None,
        },
        # RB-1 rows: the fake script exercises the T1 enums (contract-commit
        # house rule) so CI walks the new surface through the brain seam.
        {
            "action": "gather",
            "params": {"resource": "iron_ore", "count": 2},
            "reasoning": "The seam by the ridge showed iron; the pick in my pack is stone.",
            "importance": 3,
            "sentiment": 0.25,
            "relationshipUpdates": None,
            "governanceAction": None,
        },
        {
            "action": "craft",
            "params": {"item": "iron_pickaxe"},
            "reasoning": "Raw iron in the pack and a furnace's worth of patience.",
            "importance": 4,
            "sentiment": 0.5,
            "relationshipUpdates": None,
            "governanceAction": None,
        },
        {
            "action": "craft",
            "params": {"item": "iron_sword"},
            "reasoning": "A guard without a blade is a scarecrow; the same furnace owes me a sword.",
            "importance": 4,
            "sentiment": 0.5,
            "relationshipUpdates": None,
            "governanceAction": None,
        },
        # Unit-10 rows: same house rule as RB-1 above — every verb the contract
        # offers is walked through the brain seam by CI, so a verb can never
        # ship with a params shape nothing ever validated.
        {
            "action": "place",
            "params": {"item": "chest", "position": None},
            "reasoning": "My pack overflows and the stores are a walk away; a chest here serves everyone.",
            "importance": 3,
            "sentiment": 0.25,
            "relationshipUpdates": None,
            "governanceAction": None,
        },
        {
            "action": "store",
            "params": {"item": "stone", "count": 16},
            "reasoning": "Cobble is heavy and I am carrying more than I can use today.",
            "importance": 2,
            "sentiment": 0.0,
            "relationshipUpdates": None,
            "governanceAction": None,
        },
        {
            "action": "retrieve",
            "params": {"item": "food", "count": 4},
            "reasoning": "Hunger comes before nightfall and the stores are still stocked.",
            "importance": 4,
            "sentiment": 0.25,
            "relationshipUpdates": None,
            "governanceAction": None,
        },
        # Coverage-closing rows (2026-08-07): hunt and follow were the two
        # DELIBERATE_ACTIONS with no scripted row — the house rule above was
        # aspirational until test_script_covers_every_deliberate_action
        # started asserting it.
        {
            "action": "hunt",
            "params": {"animal": "cow", "maxDistance": 24},
            "reasoning": "The smokehouse is empty and the meadow herd wanders close.",
            "importance": 3,
            "sentiment": 0.0,
            "relationshipUpdates": None,
            "governanceAction": None,
        },
        {
            "action": "follow",
            "params": {"targetVillagerId": "019f8e2a-0000-7000-8000-0000000b2a44", "range": 2},
            "reasoning": "A neighbour knows the way to the ridge; better to walk together.",
            "importance": 2,
            "sentiment": 0.25,
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
                # Native FORCED strict function calling (2026-07-27, replacing
                # response_format json_schema — same constrained-decoding
                # machinery per OpenAI's own docs, but the tools surface is the
                # standardized channel). tool_choice pins the call; the model
                # cannot answer in prose or pick another function.
                "tools": [
                    {
                        "type": "function",
                        "function": {
                            "name": "decide",
                            "description": _DECIDE_TOOL_DESCRIPTION,
                            "parameters": decision_tool_schema(),
                            "strict": True,
                        },
                    }
                ],
                "tool_choice": {"type": "function", "function": {"name": "decide"}},
                "parallel_tool_calls": False,
            },
            timeout=60.0,
        )
        response.raise_for_status()
        body = response.json()
        message = body["choices"][0]["message"]
        tool_calls = message.get("tool_calls") or []
        if tool_calls:
            text = tool_calls[0]["function"]["arguments"]
        else:
            # Near-impossible under forced tool_choice; degrade to whatever
            # came back so validate_decision produces the idle fallback with
            # a real error message instead of this seam crashing the tick.
            text = message.get("content") or ""
        usage = body.get("usage", {})
        return _record(
            LLMResponse(
                text=text,
                tokens_in=usage.get("prompt_tokens", 0),
                tokens_out=usage.get("completion_tokens", 0),
                latency_seconds=time.perf_counter() - started,
                provider=self.name,
                model=self.model,
            )
        )


class AnthropicProvider:
    """Claude via the Messages API with a FORCED strict tool call — the
    native function-calling shape Anthropic documents for this exact case
    (their guidance for many related actions: "group them into a single tool
    with an action parameter"). Raw httpx by house convention: every provider
    is transport-only behind one shared AsyncClient, semaphore and metrics
    seam.

    Deliberate divergences from the local-model conventions:
    - No temperature: sampling params are REMOVED on current Claude models
      (Opus 4.7+/Sonnet 5) — sending one 400s. Decisions on this provider are
      not greedy-reproducible; the race harness must not assume they are.
    - thinking explicitly disabled: a per-tick decision needs no extended
      thinking, and disabled keeps max_tokens accounting flat (thinking
      shares the max_tokens budget when enabled). NOTE: claude-fable-5
      rejects disabled thinking — configure Sonnet/Opus-tier models here.
    """

    name = "anthropic"

    def __init__(
        self,
        api_key: str,
        model: str,
        client: httpx.AsyncClient,
        max_concurrent: int = 4,
    ):
        self.model = model
        self._api_key = api_key
        self._client = client
        self._gate = asyncio.Semaphore(max_concurrent)

    async def complete(self, system: str, user: str) -> LLMResponse:
        async with self._gate:
            return await self._complete(system, user)

    async def _complete(self, system: str, user: str) -> LLMResponse:
        started = time.perf_counter()
        response = await self._client.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": self._api_key,
                "anthropic-version": "2023-06-01",
            },
            json={
                "model": self.model,
                # Decision JSON runs ~300 tokens; thinking is disabled so
                # nothing hidden shares this budget.
                "max_tokens": 2048,
                "thinking": {"type": "disabled"},
                "system": system,
                "messages": [{"role": "user", "content": user}],
                "tools": [
                    {
                        "name": "decide",
                        "description": _DECIDE_TOOL_DESCRIPTION,
                        "input_schema": decision_tool_schema(),
                        # strict tool use is GA, no beta header: tool input is
                        # grammar-guaranteed to match input_schema.
                        "strict": True,
                    }
                ],
                "tool_choice": {
                    "type": "tool",
                    "name": "decide",
                    "disable_parallel_tool_use": True,
                },
            },
            timeout=60.0,
        )
        response.raise_for_status()
        body = response.json()
        tool_input = next(
            (
                block.get("input")
                for block in body.get("content", [])
                if block.get("type") == "tool_use"
            ),
            None,
        )
        if tool_input is not None:
            text = json.dumps(tool_input)
        else:
            # Refusal or classifier stop: no tool_use block arrives. Hand a
            # non-JSON marker downstream — decide_safely maps it to idle with
            # the stop_reason in the log, never a crash.
            text = f"(no tool_use block; stop_reason={body.get('stop_reason')})"
        usage = body.get("usage", {})
        return _record(
            LLMResponse(
                text=text,
                tokens_in=usage.get("input_tokens", 0),
                tokens_out=usage.get("output_tokens", 0),
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
        self._show_url = f"{base_url.rstrip('/')}/api/show"
        self._temperature = temperature
        self._num_ctx = num_ctx
        self._client = client
        # None = not yet probed; see _thinking_capable().
        self._thinking_capable_cache: bool | None = None
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

    async def _thinking_capable(self) -> bool:
        """Thinking-capable models (qwen3.5, deepseek-r1 family) default to
        reasoning mode, burn the entire num_ctx window on chain-of-thought and
        return an EMPTY content channel under structured outputs — the Phase 2
        qwen3.5:4b 0/5 row (bench/results/RACE_REPORT.md). Those models get
        `think: false` on every call. Plain models must NOT get the flag —
        Ollama rejects `think` on models without the capability. One /api/show
        probe per process, cached; probe failure = assume plain (never block
        the deliberation path on an introspection call)."""
        if self._thinking_capable_cache is None:
            try:
                response = await self._client.post(
                    self._show_url, json={"model": self.model}, timeout=30.0
                )
                response.raise_for_status()
                capabilities = response.json().get("capabilities", [])
                self._thinking_capable_cache = "thinking" in capabilities
            except Exception:
                self._thinking_capable_cache = False
        return self._thinking_capable_cache

    async def _payload(self, messages: list[dict]) -> dict:
        payload: dict = {
            "model": self.model,
            "stream": False,
            "options": self._options(),
            "messages": messages,
        }
        if await self._thinking_capable():
            payload["think"] = False
        return payload

    async def complete(self, system: str, user: str) -> LLMResponse:
        async with self._gate:
            return await self._complete(system, user)

    async def _complete(self, system: str, user: str) -> LLMResponse:
        started = time.perf_counter()
        payload = await self._payload([
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ])
        payload["format"] = DECISION_SCHEMA  # Ollama structured outputs
        response = await self._client.post(
            self._url,
            json=payload,
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
            json=await self._payload([{"role": "user", "content": "ok"}]),
            timeout=300.0,
        )


def _model_pulled(wanted: str, available: list[str]) -> bool:
    return any(m == wanted or m.split(":")[0] == wanted.split(":")[0] for m in available)


async def build_llm_provider(settings: Settings, client: httpx.AsyncClient) -> LLMProvider:
    """Boot-time chain: explicit LLM_PROVIDER pins; 'auto' walks
    openai (key present) -> anthropic (key present) -> ollama (reachable +
    model pulled, warmed) -> fake.
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

    if choice in ("auto", "anthropic") and settings.anthropic_api_key:
        logger.info("llm provider: anthropic", model=settings.llm_model_anthropic)
        return AnthropicProvider(
            settings.anthropic_api_key,
            settings.llm_model_anthropic,
            client,
            settings.llm_max_concurrent_requests,
        )
    if choice == "anthropic":
        logger.warning(
            "LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is blank — walking the chain instead"
        )

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
