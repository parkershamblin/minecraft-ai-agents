"""agent-service — the villager mind, assembled.

Boot: the agent_db engine, the memory-service HTTP client (extracted in
Sprint 2 — same interface, network boundary), the boot-probed LLM chain in
its budget breaker, the Kafka publisher, the perception consumer, and the
staggered tick scheduler.
"""

import uuid
from contextlib import asynccontextmanager
from typing import Literal

import httpx
import redis.asyncio as aioredis
from fastapi import FastAPI, HTTPException, Response
from pydantic import BaseModel, Field, model_validator
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest

from agent_service.brain.awareness import ActionAwareness
from agent_service.brain.civics import CivicState
from agent_service.brain.race import RaceState
from agent_service.brain.race_rehydrate import rehydrate_race
from agent_service.brain.graph import TickDeps, VillagerBrief, build_tick_graph
from agent_service.brain.scheduler import TickScheduler
from agent_service.db import make_engine, make_session_factory
from agent_service.kafka.percepts import PerceptConsumer
from agent_service.kafka.producer import EventPublisher
from agent_service.llm.budget import BudgetedProvider
from agent_service.llm.providers import TeamRouter, build_llm_provider, build_team_providers
from agent_service.logging import configure_logging, logger
from agent_service.memory_client import MemoryClient
from agent_service.settings import Settings
from agent_service.villagers.relationships import RelationshipRepo
from agent_service.villagers.repo import VillagerRepo
from uuid6 import uuid7

from agent_service.events.envelope import TOPIC_COMMANDS, build_envelope
from agent_service.villagers.seed import clamp_seed_count, load_seed_personas, seed_villagers
from agent_service.world.gateway import WorldGateway

settings = Settings()
configure_logging(settings.log_level)

# Tick every alive seeded villager, not only VILLAGER_COUNT — dashboard "add
# next" grows the fleet without a compose recreate. Env count remains the
# default target for POST /internal/seed with an empty body.
_ROSTER_TICK_LIMIT = 100


class SeedRequest(BaseModel):
    """Optional override for how many personas from villagers.json to embody."""

    count: int | None = Field(
        default=None,
        ge=1,
        le=20,
        description="Seed/spawn the first N personas (default: VILLAGER_COUNT).",
    )


class DespawnRequest(BaseModel):
    """Trim the fleet: either named villagers, or keep the first N seed-roster
    personas (same ordering as seed / despawn-fleet.mjs)."""

    names: list[str] | None = None
    keep: int | None = Field(default=None, ge=0, le=20)

    @model_validator(mode="after")
    def _one_mode(self) -> "DespawnRequest":
        if (self.names is None) == (self.keep is None):
            raise ValueError("provide exactly one of names or keep")
        return self


def _brief(villager) -> VillagerBrief:
    return VillagerBrief(
        id=villager.id, name=villager.name, personality=villager.personality, backstory=villager.backstory
    )


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info(
        "agent-service starting",
        kafka=settings.kafka_brokers,
        tick_interval_s=settings.tick_interval_seconds,
        villager_count=settings.villager_count,
    )
    http_client = httpx.AsyncClient()
    redis = aioredis.from_url(settings.redis_url, decode_responses=True)

    agent_engine = make_engine(settings.agent_db_url)
    agent_sessions = make_session_factory(agent_engine)
    repo = VillagerRepo(agent_sessions)
    relationships = RelationshipRepo(agent_sessions)
    # Sprint 2 extraction: same interface, now across the network boundary
    memory = MemoryClient(settings.memory_service_url, http_client)
    llm = BudgetedProvider(await build_llm_provider(settings, http_client), settings.llm_daily_token_budget)

    publisher = EventPublisher(settings.kafka_brokers)
    await publisher.start()
    civics = CivicState()
    race = RaceState()
    # Per-team brains (RB filming): each race team on its own warmed Ollama
    # model, routed per tick via the race roster. Every team provider gets its
    # OWN budget breaker — sized like the main one, so a runaway team flips to
    # fake alone instead of dragging the rival down with it.
    team_providers = await build_team_providers(settings, http_client)
    llm_for = None
    if team_providers:
        budgeted_teams = {
            team: BudgetedProvider(provider, settings.llm_daily_token_budget)
            for team, provider in team_providers.items()
        }
        llm_for = TeamRouter(llm, budgeted_teams, race.team_of)
        logger.info(
            "per-team llm routing ON",
            teams={team: provider.model for team, provider in team_providers.items()},
        )
    percepts = PerceptConsumer(settings.kafka_brokers, redis)
    percepts.civics = civics  # institutions -> working memory (M2-8)
    percepts.race = race  # the attempt scoreboard -> working memory (RB-2)

    graph = build_tick_graph(
        TickDeps(
            world=WorldGateway(redis),
            memory=memory,
            llm=llm,
            llm_for=llm_for,
            publish=publisher.publish,
            flush=publisher.flush,
            relationships=relationships,
            awareness=ActionAwareness(),
            civics=civics,
            race=race,
            community_goal=settings.community_goal or None,
            percepts_max=settings.percepts_max_per_tick,
            memories_k=settings.memories_per_tick,
        )
    )
    scheduler = TickScheduler(
        graph,
        settings.tick_interval_seconds,
        reactive_cooldown_s=settings.reactive_cooldown_seconds,
        max_reactive_per_5min=settings.max_reactive_per_5min,
        imminent_s=settings.reactive_imminent_seconds,
    )
    roster = await repo.list_alive(_ROSTER_TICK_LIMIT)
    scheduler.ensure([_brief(v) for v in roster])
    percepts.on_chat_percept = scheduler.request_reactive  # ears -> mind (M1-2)
    if settings.outcome_wake_enabled:
        percepts.on_outcome_percept = scheduler.request_reactive  # outcome -> mind (D1)
    # Election news broadcasts to every alive villager; the same map resolves
    # candidate/mayor names for percepts (refreshed on seed).
    percepts.roster = {str(v.id): v.name for v in roster}
    # A restart mid-attempt used to forget the race (in-memory state, committed
    # offsets) — ask the ledger before consuming, so live news lands on a
    # rehydrated scoreboard. Then start the consumer AFTER the hooks above are
    # wired: the old order let early percepts arrive with no reactive-tick hook
    # and an empty roster.
    if settings.event_service_url:
        await rehydrate_race(http_client, settings.event_service_url, race, percepts._name)
    await percepts.start()

    app.state.repo = repo
    app.state.relationships = relationships
    app.state.publisher = publisher
    app.state.scheduler = scheduler
    app.state.percepts = percepts
    app.state.http = http_client
    logger.info("agent-service ready")
    yield

    await scheduler.stop()
    await percepts.stop()
    await publisher.stop()
    await redis.aclose()
    await http_client.aclose()
    await agent_engine.dispose()


app = FastAPI(title="agent-service", lifespan=lifespan)


@app.get("/healthz")
async def healthz() -> dict:
    return {"status": "UP"}


@app.get("/metrics")
async def metrics() -> Response:
    return Response(content=generate_latest(), media_type=CONTENT_TYPE_LATEST)


@app.get("/villagers")
async def list_villagers() -> list[dict]:
    villagers = await app.state.repo.list_alive(limit=100)
    return [
        {
            "id": str(v.id),
            "name": v.name,
            "minecraftUsername": v.minecraft_username,
            "status": v.status,
            "personality": v.personality,
            "backstory": v.backstory,
        }
        for v in villagers
    ]


@app.get("/leaderboard")
async def leaderboard(metric: Literal["popular", "hated"] = "popular") -> list[dict]:
    """Interim M1 leaderboard (one SQL aggregate over incoming affinity);
    analytics-service takes this over in M2. score = sum of incoming affinity."""
    rows = await app.state.relationships.leaderboard(metric)
    return [
        {
            "villagerId": str(row.villager_id),
            "name": row.name,
            "score": row.score,
            "edgeCount": row.edge_count,
        }
        for row in rows
    ]


@app.get("/villagers/{villager_id}/relationships")
async def villager_relationships(villager_id: uuid.UUID) -> list[dict]:
    """This villager's outgoing edges, strongest affinity first — the read path
    the relationship graph bootstraps from (M1-5); live deltas ride the SSE
    RelationshipChanged stream."""
    edges = await app.state.relationships.list_edges(villager_id)
    return [
        {
            "villagerId": str(villager_id),
            "targetId": str(e.target_id),
            "affinity": e.affinity,
            "trust": e.trust,
            "interactionCount": e.interaction_count,
            "lastReason": e.last_reason,
            "lastReasonAt": e.last_reason_at.isoformat() if e.last_reason_at else None,
            "lastInteractionAt": e.last_interaction_at.isoformat() if e.last_interaction_at else None,
            "updatedAt": e.updated_at.isoformat(),
        }
        for e in edges
    ]


async def _fetch_embodied() -> list[dict]:
    """Live bot bodies from minecraft-service (may outlive DB 'alive' status)."""
    url = f"{settings.minecraft_service_url.rstrip('/')}/internal/positions"
    try:
        client: httpx.AsyncClient = app.state.http
        response = await client.get(url, timeout=3.0)
        response.raise_for_status()
        return list(response.json().get("positions") or [])
    except Exception as err:  # noqa: BLE001 — probe must never fail the status API
        logger.warning("embodied probe failed", url=url, error=str(err))
        return []


def _persona_indexes() -> tuple[dict[str, dict], dict[str, dict]]:
    personas = load_seed_personas()
    by_name = {p["name"]: p for p in personas}
    by_username = {p["minecraftUsername"]: p for p in personas}
    return by_name, by_username


@app.get("/internal/seed/status")
async def seed_status() -> dict:
    """Roster progress for the dashboard fleet controls.

    `alive` = tickable DB rows. `embodied` = bot bodies still on the MC server
    (from minecraft-service). Orphans = embodied but not alive — the desync
    Remove/Keep must clear.
    """
    personas = load_seed_personas()
    by_username = {p["minecraftUsername"]: p["name"] for p in personas}
    alive = await app.state.repo.list_alive(_ROSTER_TICK_LIMIT)
    alive_names = {v.name for v in alive}
    embodied_names: list[str] = []
    for entry in await _fetch_embodied():
        username = entry.get("username")
        if not username:
            continue
        embodied_names.append(by_username.get(username, username))
    embodied_unique = list(dict.fromkeys(embodied_names))
    orphans = [n for n in embodied_unique if n not in alive_names]
    next_persona = next((p["name"] for p in personas if p["name"] not in alive_names), None)
    return {
        "aliveCount": len(alive),
        "alive": [v.name for v in alive],
        "embodiedCount": len(embodied_unique),
        "embodied": embodied_unique,
        "orphanBodies": orphans,
        "rosterSize": len(personas),
        "roster": [p["name"] for p in personas],
        "next": next_persona,
        "defaultCount": settings.villager_count,
    }


@app.post("/internal/seed")
async def seed(body: SeedRequest = SeedRequest()) -> dict:
    """Provision villagers.json, emit VillagerCreated, publish spawn commands,
    and start tick loops. Optional JSON `{"count": N}` seeds the first N
    personas (clamped to the roster); omit for VILLAGER_COUNT."""
    target = clamp_seed_count(body.count if body.count is not None else settings.villager_count)
    result = await seed_villagers(app.state.repo, app.state.publisher, target)
    roster = await app.state.repo.list_alive(_ROSTER_TICK_LIMIT)
    app.state.scheduler.ensure([_brief(v) for v in roster])
    app.state.percepts.roster = {str(v.id): v.name for v in roster}
    return {**result, "count": target, "aliveCount": len(roster)}


async def _despawn_one(villager_id: uuid.UUID, name: str) -> None:
    """Stop ticks, mark despawned, publish body despawn (reconnect-proof).

    Always publishes despawn — even when status was already despawned — so
    orphan bot sessions left on the server are torn down.
    """
    app.state.scheduler.release(str(villager_id))
    await app.state.repo.set_status(villager_id, "despawned")
    command_id = uuid7()
    await app.state.publisher.publish(
        TOPIC_COMMANDS,
        build_envelope(
            "ActionRequested",
            villager_id,
            {
                "commandId": str(command_id),
                "villagerId": str(villager_id),
                "action": "despawn",
                "params": {},
                "timeoutMs": 30_000,
            },
            correlation_id=uuid7(),
            event_id=command_id,
        ),
    )
    logger.info("despawn published", villager=name, villager_id=str(villager_id))


async def _resolve_despawn_targets(body: DespawnRequest) -> list[tuple[uuid.UUID, str]]:
    """Names to remove: DB rows (any status) + live embodied bodies, not only
    status=alive. keep=N uses seed-roster order like despawn-fleet.mjs."""
    by_name, by_username = _persona_indexes()
    personas = load_seed_personas()
    keep_names: set[str] = set()
    selected: set[str] | None = None

    if body.names is not None:
        selected = set(body.names)
        unknown = [n for n in body.names if n not in by_name]
        if unknown:
            raise HTTPException(status_code=404, detail=f"unknown personas: {', '.join(unknown)}")
    else:
        assert body.keep is not None
        keep_names = {p["name"] for p in personas[: body.keep]}

    targets: dict[uuid.UUID, str] = {}

    for villager in await app.state.repo.list_all(_ROSTER_TICK_LIMIT):
        if selected is not None:
            if villager.name not in selected:
                continue
        elif villager.name in keep_names:
            continue
        targets[villager.id] = villager.name

    for entry in await _fetch_embodied():
        username = entry.get("username")
        persona = by_username.get(username) if username else None
        if persona is None:
            # Prefer villagerId from the positions payload when present.
            raw_id = entry.get("villagerId")
            if not raw_id or selected is not None:
                continue
            try:
                vid = uuid.UUID(str(raw_id))
            except ValueError:
                continue
            targets.setdefault(vid, str(username))
            continue
        name = persona["name"]
        if selected is not None:
            if name not in selected:
                continue
        elif name in keep_names:
            continue
        targets[uuid.UUID(persona["id"])] = name

    if body.names is not None and not targets:
        # Named remove with nothing embodied and no DB row — still 404 so the
        # UI does not silently succeed.
        raise HTTPException(status_code=404, detail=f"not found / not embodied: {', '.join(body.names)}")

    return [(vid, name) for vid, name in targets.items()]


@app.post("/internal/despawn")
async def despawn(body: DespawnRequest) -> dict:
    """Remove villagers from the live fleet (stop ticks + despawn bodies).

    Clears orphan bodies whose DB status is already despawned but the bot
    session is still online — that desync is what Keep 0 / Remove must fix.
    """
    resolved = await _resolve_despawn_targets(body)
    despawned: list[str] = []
    for villager_id, name in resolved:
        await _despawn_one(villager_id, name)
        despawned.append(name)

    roster = await app.state.repo.list_alive(_ROSTER_TICK_LIMIT)
    app.state.percepts.roster = {str(v.id): v.name for v in roster}
    embodied = [e.get("username") for e in await _fetch_embodied()]
    logger.info("despawn complete", despawned=despawned, alive=[v.name for v in roster], embodied=embodied)
    return {
        "despawned": despawned,
        "aliveCount": len(roster),
        "alive": [v.name for v in roster],
        "embodied": embodied,
    }
