"""agent-service — the villager mind, assembled.

Boot: the agent_db engine, the memory-service HTTP client (extracted in
Sprint 2 — same interface, network boundary), the boot-probed LLM chain in
its budget breaker, the Kafka publisher, the perception consumer, and the
staggered tick scheduler.
"""

import uuid
from contextlib import asynccontextmanager

import httpx
import redis.asyncio as aioredis
from fastapi import FastAPI, Response
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest

from agent_service.brain.graph import TickDeps, VillagerBrief, build_tick_graph
from agent_service.brain.scheduler import TickScheduler
from agent_service.db import make_engine, make_session_factory
from agent_service.kafka.percepts import PerceptConsumer
from agent_service.kafka.producer import EventPublisher
from agent_service.llm.budget import BudgetedProvider
from agent_service.llm.providers import build_llm_provider
from agent_service.logging import configure_logging, logger
from agent_service.memory_client import MemoryClient
from agent_service.settings import Settings
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
    repo = VillagerRepo(make_session_factory(agent_engine))
    # Sprint 2 extraction: same interface, now across the network boundary
    memory = MemoryClient(settings.memory_service_url, http_client)
    llm = BudgetedProvider(await build_llm_provider(settings, http_client), settings.llm_daily_token_budget)

    publisher = EventPublisher(settings.kafka_brokers)
    await publisher.start()
    percepts = PerceptConsumer(settings.kafka_brokers, redis)
    await percepts.start()

    graph = build_tick_graph(
        TickDeps(
            world=WorldGateway(redis),
            memory=memory,
            llm=llm,
            publish=publisher.publish,
            percepts_max=settings.percepts_max_per_tick,
            memories_k=settings.memories_per_tick,
        )
    )
    scheduler = TickScheduler(graph, settings.tick_interval_seconds)
    scheduler.ensure([_brief(v) for v in await repo.list_alive(settings.villager_count)])

    app.state.repo = repo
    app.state.publisher = publisher
    app.state.scheduler = scheduler
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


@app.post("/internal/seed")
async def seed() -> dict:
    """Provision villagers.json (first VILLAGER_COUNT), emit VillagerCreated,
    publish spawn commands, and start their tick loops."""
    result = await seed_villagers(app.state.repo, app.state.publisher, settings.villager_count)
    app.state.scheduler.ensure(
        [_brief(v) for v in await app.state.repo.list_alive(settings.villager_count)]
    )
    return result
