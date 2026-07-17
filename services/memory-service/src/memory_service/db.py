"""Async engine/session factory for memory_db — this service's only database."""

from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker, create_async_engine


def make_engine(url: str, pool_size: int = 10, max_overflow: int = 20) -> AsyncEngine:
    return create_async_engine(url, pool_size=pool_size, max_overflow=max_overflow, pool_pre_ping=True)


def make_session_factory(engine: AsyncEngine) -> async_sessionmaker:
    return async_sessionmaker(engine, expire_on_commit=False)
