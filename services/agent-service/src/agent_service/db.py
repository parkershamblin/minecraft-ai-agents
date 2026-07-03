"""Async engine/session factories. One factory per logical database —
memory_db now, agent_db at CIV-8 — honoring database-per-service even
in-process: the Memory module never touches another context's tables."""

from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker, create_async_engine


def make_engine(url: str) -> AsyncEngine:
    return create_async_engine(url, pool_size=5, pool_pre_ping=True)


def make_session_factory(engine: AsyncEngine) -> async_sessionmaker:
    return async_sessionmaker(engine, expire_on_commit=False)
