"""Shared testcontainers Postgres for the integration suites (relationships,
seed): one real database per session — the same pgvector image compose uses —
migrated to head before any test touches it. Offline tests never request it,
so they stay Docker-free."""

import os

import pytest
from alembic import command
from alembic.config import Config
from testcontainers.postgres import PostgresContainer

from agent_service.settings import Settings


@pytest.fixture(scope="session")
def database():
    with PostgresContainer(
        image="pgvector/pgvector:0.8.0-pg16",
        username="test",
        password="test",
        dbname="agent_db",
    ) as container:
        os.environ.update(
            POSTGRES_HOST=container.get_container_host_ip(),
            POSTGRES_PORT=str(container.get_exposed_port(5432)),
            AGENT_DB_USER="test",
            AGENT_DB_PASSWORD="test",
            AGENT_DB_NAME="agent_db",
        )
        command.upgrade(Config("alembic.ini"), "head")
        yield Settings()
