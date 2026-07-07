"""Shared integration fixtures: one real pgvector container per session
(migrated to head) and deterministic stub embeddings — shared by the memory
and reflection integration suites. Offline suites never request these."""

import os

import pytest
from alembic import command
from alembic.config import Config
from testcontainers.postgres import PostgresContainer

from memory_service.db import make_engine, make_session_factory
from memory_service.service import MemoryService
from memory_service.settings import Settings


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
def embeddings():
    return StubEmbeddings()


@pytest.fixture()
async def service(database: Settings, embeddings):
    engine = make_engine(database.memory_db_url)
    yield MemoryService(make_session_factory(engine), embeddings, database)
    await engine.dispose()
