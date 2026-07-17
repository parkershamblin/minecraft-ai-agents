"""Async engine/session factories. One factory per logical database —
memory_db now, agent_db at CIV-8 — honoring database-per-service even
in-process: the Memory module never touches another context's tables."""

from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker, create_async_engine


def make_engine(url: str) -> AsyncEngine:
    # Sized for 20 villagers ticking concurrently (each tick reads edges and
    # commits one relationship batch) — the old 5/10 default queued ticks.
    return create_async_engine(url, pool_size=10, max_overflow=20, pool_pre_ping=True)


def make_session_factory(engine: AsyncEngine) -> async_sessionmaker:
    return async_sessionmaker(engine, expire_on_commit=False)
