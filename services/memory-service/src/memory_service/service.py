"""MemoryService — the module's public surface, shaped exactly like the future
REST contract (store / search / reflect) so the M1 extraction is mechanical."""

import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import async_sessionmaker
from uuid6 import uuid7

from memory_service.logging import logger
from memory_service.embeddings import EmbeddingProvider
from memory_service.envelope import TOPIC_AGENT, build_envelope
from memory_service.kafka import EventPublisher
from memory_service.llm import BudgetExhausted, SummarizerProvider
from memory_service.models import Memory
from memory_service.reflection import (
    REFLECTION_SYSTEM_PROMPT,
    HourlyCap,
    ReflectionUnavailable,
    build_reflection_prompt,
    parse_insights,
)
from memory_service.scoring import (
    recency_score,
    retrieval_score,
    score_importance,
    score_sentiment,
)
from memory_service.metrics import memories_stored_total, memory_retrieval_seconds, reflections_total
from memory_service.settings import Settings


@dataclass(frozen=True)
class MemoryRecord:
    id: uuid.UUID
    villager_id: uuid.UUID
    memory_type: str
    content: str
    importance: float
    sentiment: float
    occurred_at: datetime
    embedding_model: str


@dataclass(frozen=True)
class RetrievedMemory:
    record: MemoryRecord
    relevance: float
    recency: float
    score: float


@dataclass(frozen=True)
class RetrievalWeights:
    recency: float = 1.0
    importance: float = 1.0
    relevance: float = 1.0


class MemoryService:
    def __init__(
        self,
        session_factory: async_sessionmaker,
        embeddings: EmbeddingProvider,
        settings: Settings,
        summarizer: SummarizerProvider | None = None,
        publisher: EventPublisher | None = None,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    ):
        self._sessions = session_factory
        self._embeddings = embeddings
        self._settings = settings
        self._summarizer = summarizer
        self._publisher = publisher
        self._hourly_cap = HourlyCap(settings.reflections_per_hour_cap, clock)

    async def store(
        self,
        villager_id: uuid.UUID,
        content: str,
        memory_type: str = "observation",
        occurred_at: datetime | None = None,
        importance: float | None = None,
        sentiment: float | None = None,
        source_event_id: uuid.UUID | None = None,
        source_memory_ids: list[uuid.UUID] | None = None,
    ) -> MemoryRecord:
        """Persist one memory. importance/sentiment may arrive from the
        deliberation output (CIV-8); the heuristics are the fallback — never a
        separate LLM scoring call."""
        now = datetime.now(UTC)
        occurred_at = occurred_at or now
        importance = importance if importance is not None else score_importance(content, memory_type)
        sentiment = sentiment if sentiment is not None else score_sentiment(content)

        row = Memory(
            id=uuid7(),
            villager_id=villager_id,
            memory_type=memory_type,
            content=content,
            importance_score=importance,
            sentiment_score=sentiment,
            embedding=await self._embeddings.embed(content),
            embedding_model=self._embeddings.name,
            source_event_id=source_event_id,
            source_memory_ids=source_memory_ids,
            occurred_at=occurred_at,
            created_at=now,
            last_accessed_at=now,
            access_count=0,
        )
        async with self._sessions() as session:
            session.add(row)
            await session.commit()

        memories_stored_total.labels(memory_type=memory_type).inc()
        logger.debug("memory stored", villager_id=str(villager_id), memory_id=str(row.id), importance=importance)
        return _to_record(row)

    async def search(
        self,
        villager_id: uuid.UUID,
        query: str,
        k: int = 10,
        weights: RetrievalWeights | None = None,
    ) -> list[RetrievedMemory]:
        """Top-k by recency x importance x relevance. ANN (cosine) narrows to
        candidates; the full formula re-ranks in process. Access metadata on
        the winners is touched (the recency term of future retrievals)."""
        weights = weights or RetrievalWeights(
            recency=self._settings.retrieval_w_recency,
            importance=self._settings.retrieval_w_importance,
            relevance=self._settings.retrieval_w_relevance,
        )
        started = time.perf_counter()
        query_vector = await self._embeddings.embed(query)
        now = datetime.now(UTC)

        async with self._sessions() as session:
            distance = Memory.embedding.cosine_distance(query_vector)
            rows = (
                await session.execute(
                    select(Memory, distance.label("distance"))
                    .where(Memory.villager_id == villager_id)
                    .order_by(distance)
                    .limit(max(k * self._settings.retrieval_candidate_factor, k))
                )
            ).all()

            scored = []
            for memory, dist in rows:
                relevance = 1.0 - float(dist)
                recency = recency_score(
                    memory.last_accessed_at, now, self._settings.recency_decay_per_hour
                )
                score = retrieval_score(
                    recency,
                    memory.importance_score,
                    relevance,
                    weights.recency,
                    weights.importance,
                    weights.relevance,
                )
                scored.append(RetrievedMemory(_to_record(memory), round(relevance, 4), round(recency, 4), round(score, 4)))
            scored.sort(key=lambda m: m.score, reverse=True)
            winners = scored[:k]

            if winners:
                await session.execute(
                    update(Memory)
                    .where(Memory.id.in_([m.record.id for m in winners]))
                    .values(last_accessed_at=now, access_count=Memory.access_count + 1)
                )
                await session.commit()

        memory_retrieval_seconds.observe(time.perf_counter() - started)
        return winners

    async def reflect(self, villager_id: uuid.UUID) -> list[MemoryRecord]:
        """Distill unreflected recent memories into 1-3 higher-level insight
        memories (provenance-linked; the schema CHECK enforces it) and emit a
        ReflectionCreated per insight. Returns [] when there is nothing to
        reflect on, the hourly cap is hit, the budget breaker is open, or the
        LLM output was unusable — the caller never has to care which."""
        if self._summarizer is None:
            raise ReflectionUnavailable("reflections are disabled: no real LLM provider is armed")

        async with self._sessions() as session:
            last_at = (
                await session.execute(
                    select(func.max(Memory.created_at))
                    .where(Memory.villager_id == villager_id)
                    .where(Memory.memory_type == "reflection")
                )
            ).scalar()
            query = (
                select(Memory)
                .where(Memory.villager_id == villager_id)
                .where(Memory.memory_type != "reflection")
            )
            if last_at is not None:
                query = query.where(Memory.created_at > last_at)
            rows = list(
                (
                    await session.execute(
                        query.order_by(Memory.occurred_at.desc()).limit(self._settings.reflection_recent_limit)
                    )
                ).scalars()
            )
        rows.reverse()  # chronological for the prompt

        if not rows:
            reflections_total.labels(outcome="empty").inc()
            return []
        if not self._hourly_cap.try_acquire():
            reflections_total.labels(outcome="skipped_cap").inc()
            logger.info("reflection skipped — hourly cap", villager_id=str(villager_id))
            return []

        correlation = uuid7()
        try:
            response = await self._summarizer.complete(
                REFLECTION_SYSTEM_PROMPT, build_reflection_prompt([r.content for r in rows])
            )
        except BudgetExhausted as exc:
            reflections_total.labels(outcome="skipped_budget").inc()
            logger.warning("reflection skipped — budget breaker open", villager_id=str(villager_id), error=str(exc))
            return []

        insights = parse_insights(response.text, [r.id for r in rows])
        if not insights:
            reflections_total.labels(outcome="malformed").inc()
            logger.warning(
                "reflection discarded — unusable LLM output",
                villager_id=str(villager_id),
                provider=response.provider,
            )
            return []

        records: list[MemoryRecord] = []
        for content, source_ids in insights:
            record = await self.store(
                villager_id, content, memory_type="reflection", source_memory_ids=source_ids
            )
            records.append(record)
            reflections_total.labels(outcome="created").inc()
            if self._publisher is not None:
                envelope = build_envelope(
                    "ReflectionCreated",
                    villager_id,
                    {
                        "villagerId": str(villager_id),
                        "reflectionId": str(record.id),
                        "summary": content,
                        "sourceMemoryIds": [str(i) for i in source_ids],
                    },
                    correlation_id=correlation,
                )
                try:
                    await self._publisher.publish(TOPIC_AGENT, envelope)
                except Exception as exc:  # the row is truth; a ledger gap is logged, not fatal
                    logger.error(
                        "ReflectionCreated publish failed", villager_id=str(villager_id), error=str(exc)
                    )
        logger.info(
            "reflection complete",
            villager_id=str(villager_id),
            insights=len(records),
            provider=response.provider,
            correlationId=str(correlation),
        )
        return records


def _to_record(row: Memory) -> MemoryRecord:
    return MemoryRecord(
        id=row.id,
        villager_id=row.villager_id,
        memory_type=row.memory_type,
        content=row.content,
        importance=row.importance_score,
        sentiment=row.sentiment_score,
        occurred_at=row.occurred_at,
        embedding_model=row.embedding_model,
    )
