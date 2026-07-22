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
from fastapi import FastAPI, Response
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest

from agent_service.brain.awareness import ActionAwareness
from agent_service.brain.civics import CivicState
from agent_service.brain.race import RaceState
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
from agent_service.villagers.seed import seed_villagers
from agent_service.world.gateway import WorldGateway

settings = Settings()
configure_logging(settings.log_level)


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
    await percepts.start()

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
    roster = await repo.list_alive(settings.villager_count)
    scheduler.ensure([_brief(v) for v in roster])
    percepts.on_chat_percept = scheduler.request_reactive  # ears -> mind (M1-2)
    # Election news broadcasts to every alive villager; the same map resolves
    # candidate/mayor names for percepts (refreshed on seed).
    percepts.roster = {str(v.id): v.name for v in roster}

    app.state.repo = repo
    app.state.relationships = relationships
    app.state.publisher = publisher
    app.state.scheduler = scheduler
    app.state.percepts = percepts
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


@app.post("/internal/seed")
async def seed() -> dict:
    """Provision villagers.json (first VILLAGER_COUNT), emit VillagerCreated,
    publish spawn commands, and start their tick loops."""
    result = await seed_villagers(app.state.repo, app.state.publisher, settings.villager_count)
    roster = await app.state.repo.list_alive(settings.villager_count)
    app.state.scheduler.ensure([_brief(v) for v in roster])
    app.state.percepts.roster = {str(v.id): v.name for v in roster}
    return result
