"""Integration proof against REAL pgvector (same image compose uses):
store -> HNSW search -> full-formula re-rank -> access metadata touched;
schema constraints enforced; retrieval latency observed.
"""

import os
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy.exc import IntegrityError

from agent_service.db import make_engine, make_session_factory
from agent_service.memory.service import MemoryService, RetrievalWeights
from agent_service.metrics import memory_retrieval_seconds
from agent_service.settings import Settings
from testcontainers.postgres import PostgresContainer

ELARA = uuid.UUID("019f8e2a-0000-7000-8000-0000000e1a2a")


class StubEmbeddings:
    """Known vectors per topic so ranking assertions are deterministic."""

    name = "stub"
    dim = 768

    _topics = {"oak": 0, "fish": 1, "election": 2}

    async def embed(self, text: str) -> list[float]:
        vector = [0.0] * 768
        for topic, axis in self._topics.items():
            if topic in text.lower():
                vector[axis] = 1.0
        if not any(vector):
            vector[3] = 1.0
        norm = sum(v * v for v in vector) ** 0.5
        return [v / norm for v in vector]


@pytest.fixture(scope="session")
def database():
    with PostgresContainer(
        image="pgvector/pgvector:0.8.0-pg16",
        username="test",
        password="test",
        dbname="memory_db",
    ) as container:
        host = container.get_container_host_ip()
        port = container.get_exposed_port(5432)
        os.environ.update(
            POSTGRES_HOST=host,
            POSTGRES_PORT=str(port),
            MEMORY_DB_USER="test",
            MEMORY_DB_PASSWORD="test",
        )
        command.upgrade(Config("alembic.ini"), "head")
        yield Settings()


@pytest.fixture()
async def service(database: Settings):
    engine = make_engine(database.memory_db_url)
    yield MemoryService(make_session_factory(engine), StubEmbeddings(), database)
    await engine.dispose()


async def test_full_memory_lifecycle(service: MemoryService):
    # -- store three memories with distinct topics and profiles --------------
    old_oak = await service.store(
        ELARA,
        "I chopped the great oak by the pond.",
        occurred_at=datetime.now(UTC) - timedelta(days=3),
    )
    await service.store(ELARA, "I caught a fish in the river.")
    dramatic = await service.store(ELARA, "Bram betrayed me during the election count!")

    assert old_oak.embedding_model == "stub"
    assert dramatic.importance >= 8.0  # heuristic saw the drama

    # -- relevance dominates: an oak query finds the oak memory first --------
    results = await service.search(ELARA, "the oak tree", k=2)
    assert results[0].record.id == old_oak.id
    assert results[0].relevance > 0.9

    # -- weights change the verdict: importance-led ranking surfaces drama ---
    importance_led = await service.search(
        ELARA, "the oak tree", k=1, weights=RetrievalWeights(recency=0.0, importance=5.0, relevance=0.1)
    )
    assert importance_led[0].record.id == dramatic.id

    # -- access metadata touched on winners only ------------------------------
    twice = await service.search(ELARA, "the oak tree", k=1)
    assert twice[0].record.id == old_oak.id
    # (access_count is internal; verified via a raw query)
    async with service._sessions() as session:  # noqa: SLF001 — test peeks at storage
        from sqlalchemy import select

        from agent_service.memory.models import Memory

        row = (await session.execute(select(Memory).where(Memory.id == old_oak.id))).scalar_one()
        assert row.access_count >= 2

    # -- another villager's stream is invisible ------------------------------
    stranger = uuid.uuid4()
    assert await service.search(stranger, "oak", k=5) == []

    # -- p95 metric observed ---------------------------------------------------
    collected = memory_retrieval_seconds.collect()[0]
    count = next(s.value for s in collected.samples if s.name.endswith("_count"))
    assert count >= 3


async def test_reflection_provenance_enforced_by_schema(service: MemoryService):
    # a reflection without source memories violates the CHECK constraint
    with pytest.raises(IntegrityError):
        await service.store(ELARA, "I reflect on nothing.", memory_type="reflection")

    # and a valid reflection with provenance is accepted
    source = await service.store(ELARA, "Bram shared his bread with me.")
    reflection = await service.store(
        ELARA,
        "Bram is a generous friend.",
        memory_type="reflection",
        source_memory_ids=[source.id],
    )
    assert reflection.importance >= 7.0
