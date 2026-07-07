"""Directed relationship edges — the drama primitive, finally written to.

apply_update upserts the (villager -> target) edge with clamping to the schema
bounds and returns previous+new values so the caller can emit a truthful
RelationshipChanged. Self-edges and unknown targets are rejected by the
database (CHECK + FK) and surface as ValueError."""

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import async_sessionmaker
from uuid6 import uuid7

from agent_service.villagers.models import Relationship


@dataclass(frozen=True)
class RelationshipChange:
    villager_id: uuid.UUID
    target_id: uuid.UUID
    previous_affinity: int
    new_affinity: int
    previous_trust: int
    new_trust: int


def _clamp(value: float, low: int, high: int) -> int:
    return int(max(low, min(high, round(value))))


class RelationshipRepo:
    def __init__(self, session_factory: async_sessionmaker):
        self._sessions = session_factory

    async def apply_update(
        self,
        villager_id: uuid.UUID,
        target_id: uuid.UUID,
        affinity_delta: float,
        trust_delta: float,
    ) -> RelationshipChange:
        now = datetime.now(UTC)
        try:
            async with self._sessions() as session:
                row = (
                    await session.execute(
                        select(Relationship)
                        .where(Relationship.villager_id == villager_id)
                        .where(Relationship.target_villager_id == target_id)
                        .with_for_update()
                    )
                ).scalar_one_or_none()

                if row is None:
                    previous_affinity, previous_trust = 0, 50  # schema defaults
                    row = Relationship(
                        id=uuid7(),
                        villager_id=villager_id,
                        target_villager_id=target_id,
                        affinity=_clamp(previous_affinity + affinity_delta, -100, 100),
                        trust=_clamp(previous_trust + trust_delta, 0, 100),
                        interaction_count=1,
                        last_interaction_at=now,
                        created_at=now,
                        updated_at=now,
                    )
                    session.add(row)
                else:
                    previous_affinity, previous_trust = row.affinity, row.trust
                    row.affinity = _clamp(previous_affinity + affinity_delta, -100, 100)
                    row.trust = _clamp(previous_trust + trust_delta, 0, 100)
                    row.interaction_count += 1
                    row.last_interaction_at = now
                new_affinity, new_trust = row.affinity, row.trust
                await session.commit()
        except IntegrityError as exc:
            # self-edge CHECK or unknown-target FK — a hallucinated villagerId
            raise ValueError(f"invalid relationship edge {villager_id} -> {target_id}: {exc.orig}") from exc

        return RelationshipChange(
            villager_id=villager_id,
            target_id=target_id,
            previous_affinity=previous_affinity,
            new_affinity=new_affinity,
            previous_trust=previous_trust,
            new_trust=new_trust,
        )
