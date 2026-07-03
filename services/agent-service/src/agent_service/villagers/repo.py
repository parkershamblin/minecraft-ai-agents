import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import async_sessionmaker

from agent_service.villagers.models import Villager


class VillagerRepo:
    def __init__(self, session_factory: async_sessionmaker):
        self._sessions = session_factory

    async def insert_if_absent(
        self,
        villager_id: uuid.UUID,
        name: str,
        minecraft_username: str,
        personality: dict[str, Any],
        backstory: str,
    ) -> bool:
        """True if the row was created; False if the villager already existed
        (idempotent seed)."""
        now = datetime.now(UTC)
        async with self._sessions() as session:
            result = await session.execute(
                insert(Villager)
                .values(
                    id=villager_id,
                    name=name,
                    minecraft_username=minecraft_username,
                    personality=personality,
                    backstory=backstory,
                    status="alive",
                    created_at=now,
                    updated_at=now,
                )
                .on_conflict_do_nothing(index_elements=["id"])
            )
            await session.commit()
            return result.rowcount == 1

    async def list_alive(self, limit: int) -> list[Villager]:
        async with self._sessions() as session:
            rows = await session.execute(
                select(Villager).where(Villager.status == "alive").order_by(Villager.created_at).limit(limit)
            )
            return list(rows.scalars())
