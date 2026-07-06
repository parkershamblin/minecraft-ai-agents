import asyncio

from alembic import context
from sqlalchemy.ext.asyncio import create_async_engine

from memory_service.settings import Settings

config = context.config
target_metadata = None  # migrations are raw SQL — the DDL is the source of truth


def run_migrations_offline() -> None:
    context.configure(url=Settings().memory_db_url, literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()


def do_run_migrations(connection) -> None:
    context.configure(connection=connection)
    with context.begin_transaction():
        context.run_migrations()


async def run_migrations_online() -> None:
    engine = create_async_engine(Settings().memory_db_url)
    async with engine.connect() as connection:
        await connection.run_sync(do_run_migrations)
    await engine.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    asyncio.run(run_migrations_online())
