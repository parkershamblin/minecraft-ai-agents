"""memory-service — the Memory bounded context as its own deployable.

Extracted from agent-service in Sprint 2: the REST contract below is the same
shape the in-process module always had, so the only thing that moved is the
network boundary (the design's staged-extraction ruling, landed).
"""

import uuid
from contextlib import asynccontextmanager
from datetime import datetime

import httpx
from fastapi import FastAPI, HTTPException, Response
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest
from pydantic import BaseModel, Field
from sqlalchemy import select

from memory_service.db import make_engine, make_session_factory
from memory_service.embeddings import build_embedding_provider
from memory_service.kafka import EventPublisher
from memory_service.llm import BudgetedSummarizer, build_summarizer_provider
from memory_service.logging import configure_logging, logger
from memory_service.models import Memory
from memory_service.reflection import ReflectionJob, ReflectionUnavailable
from memory_service.service import MemoryService, RetrievalWeights
from memory_service.settings import Settings

settings = Settings()
configure_logging(settings.log_level)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("memory-service starting", db=settings.memory_db_name)
    http_client = httpx.AsyncClient()
    engine = make_engine(settings.memory_db_url)
    sessions = make_session_factory(engine)
    embeddings = await build_embedding_provider(settings, http_client)

    # Reflections (M1-9): armed only when a real summarizer exists — the chain
    # has no fake fallback (scripted insights would pollute narrative truth).
    # Kafka starts with it: the publisher's only client is reflection emission.
    summarizer = publisher = job = None
    if settings.reflection_enabled:
        base_summarizer = await build_summarizer_provider(settings, http_client)
        if base_summarizer is not None:
            summarizer = BudgetedSummarizer(base_summarizer, settings.reflection_daily_token_budget)
            publisher = EventPublisher(settings.kafka_brokers)
            await publisher.start()

    service = MemoryService(sessions, embeddings, settings, summarizer=summarizer, publisher=publisher)
    app.state.sessions = sessions
    app.state.service = service

    if summarizer is not None:
        job = ReflectionJob(service, sessions, settings)
        job.start()

    logger.info(
        "memory-service ready",
        embeddings=embeddings.name,
        reflections="on" if summarizer is not None else "off",
    )
    yield
    if job is not None:
        await job.stop()
    if publisher is not None:
        await publisher.stop()
    await http_client.aclose()
    await engine.dispose()


app = FastAPI(title="memory-service", lifespan=lifespan)


# ---------- wire shapes (camelCase, matching the platform's JSON style) ------


class StoreRequest(BaseModel):
    villagerId: uuid.UUID
    content: str = Field(min_length=1)
    memoryType: str = "observation"
    occurredAt: datetime | None = None
    importance: float | None = Field(default=None, ge=0, le=10)
    sentiment: float | None = Field(default=None, ge=-1, le=1)
    sourceEventId: uuid.UUID | None = None
    sourceMemoryIds: list[uuid.UUID] | None = None


class MemoryRecordDto(BaseModel):
    id: uuid.UUID
    villagerId: uuid.UUID
    memoryType: str
    content: str
    importance: float
    sentiment: float
    occurredAt: datetime
    embeddingModel: str


class SearchRequest(BaseModel):
    query: str = Field(min_length=1)
    k: int = Field(default=10, ge=1, le=50)
    weights: dict[str, float] | None = None  # {recency, importance, relevance}


class RetrievedDto(BaseModel):
    record: MemoryRecordDto
    relevance: float
    recency: float
    score: float


def _record_dto(record) -> MemoryRecordDto:
    return MemoryRecordDto(
        id=record.id,
        villagerId=record.villager_id,
        memoryType=record.memory_type,
        content=record.content,
        importance=record.importance,
        sentiment=record.sentiment,
        occurredAt=record.occurred_at,
        embeddingModel=record.embedding_model,
    )


# ---------- endpoints ---------------------------------------------------------


@app.get("/healthz")
async def healthz() -> dict:
    return {"status": "UP"}


@app.get("/metrics")
async def metrics() -> Response:
    return Response(content=generate_latest(), media_type=CONTENT_TYPE_LATEST)


@app.post("/memories", status_code=201)
async def store(body: StoreRequest) -> MemoryRecordDto:
    try:
        record = await app.state.service.store(
            villager_id=body.villagerId,
            content=body.content,
            memory_type=body.memoryType,
            occurred_at=body.occurredAt,
            importance=body.importance,
            sentiment=body.sentiment,
            source_event_id=body.sourceEventId,
            source_memory_ids=body.sourceMemoryIds,
        )
    except Exception as exc:
        # schema CHECKs (memory_type enum, reflection provenance) surface here
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return _record_dto(record)


@app.post("/villagers/{villager_id}/memories/search")
async def search(villager_id: uuid.UUID, body: SearchRequest) -> dict:
    weights = RetrievalWeights(**body.weights) if body.weights else None
    results = await app.state.service.search(villager_id, body.query, k=body.k, weights=weights)
    return {
        "results": [
            RetrievedDto(record=_record_dto(m.record), relevance=m.relevance, recency=m.recency, score=m.score)
            for m in results
        ]
    }


@app.get("/villagers/{villager_id}/memories")
async def stream(
    villager_id: uuid.UUID,
    since: datetime | None = None,
    min_importance: float | None = None,
    limit: int = 50,
) -> dict:
    async with app.state.sessions() as session:
        query = select(Memory).where(Memory.villager_id == villager_id)
        if since is not None:
            query = query.where(Memory.occurred_at >= since)
        if min_importance is not None:
            query = query.where(Memory.importance_score >= min_importance)
        rows = (await session.execute(query.order_by(Memory.occurred_at.desc()).limit(min(limit, 200)))).scalars()
        return {"data": [_record_dto_from_row(row).model_dump(mode="json") for row in rows]}


def _record_dto_from_row(row: Memory) -> MemoryRecordDto:
    return MemoryRecordDto(
        id=row.id,
        villagerId=row.villager_id,
        memoryType=row.memory_type,
        content=row.content,
        importance=row.importance_score,
        sentiment=row.sentiment_score,
        occurredAt=row.occurred_at,
        embeddingModel=row.embedding_model,
    )


@app.post("/villagers/{villager_id}/reflections")
async def reflect(villager_id: uuid.UUID) -> dict:
    """Force one reflection pass now (the background job fires these on
    importance pressure; this is the dev/demo lever). The budget breaker and
    hourly cap still apply — an empty list means nothing to reflect on, a
    capped run, or unusable LLM output."""
    try:
        records = await app.state.service.reflect(villager_id)
    except ReflectionUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {"data": [_record_dto(r).model_dump(mode="json") for r in records]}
