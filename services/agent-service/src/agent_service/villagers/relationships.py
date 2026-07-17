"""Directed relationship edges — the drama primitive, finally written to.

apply_updates upserts (villager -> target) edges with clamping to the schema
bounds — one session/transaction for a whole tick's batch — and returns
previous+new values so the caller can emit truthful RelationshipChanged
events. Self-edges and unknown targets are validated up front (a mid-batch
FK/CHECK rejection would poison the shared transaction) and skipped with a
warning; the single-edge apply_update wrapper turns a skip into ValueError."""

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import async_sessionmaker
from uuid6 import uuid7

from agent_service.logging import logger
from agent_service.villagers.models import Relationship, Villager

# An edge at or below this is a grudge. Ambient positive drift heals it at half
# speed (M2-5 — measured M1: the ±3 hearer-sentiment heuristic mean-reverts any
# grudge to zero under ordinary plaza chatter), and the prompt tells the
# villager the grudge legitimately constrains tone and choices.
GRUDGE_AFFINITY_THRESHOLD = -20


@dataclass(frozen=True)
class RelationshipUpdate:
    """One decided delta, batched: a tick hands apply_updates its whole list.
    `ambient=True` marks background drift (the hearer-sentiment heuristic) as
    opposed to a delta the LLM deliberately chose: ambient goodwill onto a
    grudge edge is halved, a deliberate one lands whole — a real apology
    still works."""

    target_id: uuid.UUID
    affinity_delta: float
    trust_delta: float
    reason: str | None = None
    ambient: bool = False


@dataclass(frozen=True)
class RelationshipChange:
    villager_id: uuid.UUID
    target_id: uuid.UUID
    previous_affinity: int
    new_affinity: int
    previous_trust: int
    new_trust: int


@dataclass(frozen=True)
class RelationshipEdge:
    """A read-side view of one directed edge — detached from any session, so
    it survives the request/tick that produced it. `last_reason` is the drama:
    the most recent cause that moved this edge."""

    target_id: uuid.UUID
    affinity: int
    trust: int
    interaction_count: int
    last_reason: str | None
    last_reason_at: datetime | None
    last_interaction_at: datetime | None
    updated_at: datetime

    @classmethod
    def of(cls, row: Relationship) -> "RelationshipEdge":
        return cls(
            target_id=row.target_villager_id,
            affinity=row.affinity,
            trust=row.trust,
            interaction_count=row.interaction_count,
            last_reason=row.last_reason,
            last_reason_at=row.last_reason_at,
            last_interaction_at=row.last_interaction_at,
            updated_at=row.updated_at,
        )


@dataclass(frozen=True)
class LeaderboardRow:
    """One villager as the village sees them: the sum of everyone's incoming
    affinity. Sum, not average — being loved by five neighbors should outrank
    being loved intensely by one."""

    villager_id: uuid.UUID
    name: str
    score: int
    edge_count: int


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
        reason: str | None = None,
        *,
        ambient: bool = False,
    ) -> RelationshipChange:
        """Single-edge convenience over apply_updates; an invalid edge
        (self-edge, hallucinated target) surfaces as ValueError."""
        applied = await self.apply_updates(
            villager_id,
            [
                RelationshipUpdate(
                    target_id=target_id,
                    affinity_delta=affinity_delta,
                    trust_delta=trust_delta,
                    reason=reason,
                    ambient=ambient,
                )
            ],
        )
        if not applied:
            raise ValueError(f"invalid relationship edge {villager_id} -> {target_id}")
        return applied[0][1]

    async def apply_updates(
        self, villager_id: uuid.UUID, updates: list[RelationshipUpdate]
    ) -> list[tuple[RelationshipUpdate, RelationshipChange]]:
        """A whole tick's deltas in ONE session/transaction (each edge used to
        pay its own SELECT…FOR UPDATE + commit). Per-edge semantics are those
        of the old apply_update — same clamp, grudge damping, interaction and
        reason merge — applied in list order, so duplicate targets compound
        exactly as sequential calls did. Self-edges and unknown targets are
        skipped with a warning rather than raised: the CHECK/FK rejection
        would abort every edge sharing the transaction."""
        if not updates:
            return []
        now = datetime.now(UTC)
        applied: list[tuple[RelationshipUpdate, RelationshipChange]] = []
        try:
            async with self._sessions() as session:
                # Validate targets up front — a hallucinated villagerId must
                # cost only its own edge, not the batch.
                known = set(
                    (
                        await session.execute(
                            select(Villager.id).where(Villager.id.in_({u.target_id for u in updates}))
                        )
                    ).scalars()
                )
                rows = (
                    await session.execute(
                        select(Relationship)
                        .where(Relationship.villager_id == villager_id)
                        .where(Relationship.target_villager_id.in_(known))
                        .with_for_update()
                    )
                ).scalars()
                by_target = {row.target_villager_id: row for row in rows}

                for update in updates:
                    if update.target_id == villager_id or update.target_id not in known:
                        logger.warning(
                            "relationship update rejected",
                            villager=str(villager_id),
                            target=str(update.target_id),
                            error="self-edge or unknown target",
                        )
                        continue
                    row = by_target.get(update.target_id)
                    # (0, 50) = schema defaults for a first meeting
                    previous_affinity, previous_trust = (
                        (row.affinity, row.trust) if row is not None else (0, 50)
                    )
                    affinity_delta, trust_delta = update.affinity_delta, update.trust_delta
                    if update.ambient and affinity_delta > 0 and previous_affinity <= GRUDGE_AFFINITY_THRESHOLD:
                        affinity_delta /= 2
                        trust_delta /= 2

                    if row is None:
                        row = Relationship(
                            id=uuid7(),
                            villager_id=villager_id,
                            target_villager_id=update.target_id,
                            affinity=_clamp(previous_affinity + affinity_delta, -100, 100),
                            trust=_clamp(previous_trust + trust_delta, 0, 100),
                            interaction_count=1,
                            last_interaction_at=now,
                            last_reason=update.reason,
                            last_reason_at=now if update.reason else None,
                            created_at=now,
                            updated_at=now,
                        )
                        session.add(row)
                        by_target[update.target_id] = row
                    else:
                        row.affinity = _clamp(previous_affinity + affinity_delta, -100, 100)
                        row.trust = _clamp(previous_trust + trust_delta, 0, 100)
                        row.interaction_count += 1
                        row.last_interaction_at = now
                        if update.reason:  # keep the last *explained* cause; empty reason doesn't erase it
                            row.last_reason = update.reason
                            row.last_reason_at = now
                    applied.append(
                        (
                            update,
                            RelationshipChange(
                                villager_id=villager_id,
                                target_id=update.target_id,
                                previous_affinity=previous_affinity,
                                new_affinity=row.affinity,
                                previous_trust=previous_trust,
                                new_trust=row.trust,
                            ),
                        )
                    )
                await session.commit()
        except IntegrityError as exc:
            # A target vanished between validation and commit — the whole
            # transaction is gone with it; the caller logs and moves on.
            raise ValueError(f"invalid relationship batch for {villager_id}: {exc.orig}") from exc

        return applied

    async def edges_for(
        self, villager_id: uuid.UUID, target_ids: list[uuid.UUID]
    ) -> list[RelationshipEdge]:
        """The subset of villager_id's outgoing edges that point at target_ids
        — the prompt read seam. Missing edges are simply absent (the caller
        renders those neutral); order is unspecified."""
        if not target_ids:
            return []
        async with self._sessions() as session:
            rows = await session.execute(
                select(Relationship)
                .where(Relationship.villager_id == villager_id)
                .where(Relationship.target_villager_id.in_(target_ids))
            )
            return [RelationshipEdge.of(r) for r in rows.scalars()]

    async def list_edges(self, villager_id: uuid.UUID) -> list[RelationshipEdge]:
        """All of villager_id's outgoing edges, strongest affinity first — the
        GET /villagers/{id}/relationships read path."""
        async with self._sessions() as session:
            rows = await session.execute(
                select(Relationship)
                .where(Relationship.villager_id == villager_id)
                .order_by(Relationship.affinity.desc())
            )
            return [RelationshipEdge.of(r) for r in rows.scalars()]

    async def leaderboard(
        self, metric: Literal["popular", "hated"], limit: int = 10
    ) -> list[LeaderboardRow]:
        """The interim M1 leaderboard: one SQL aggregate over incoming edges
        (idx_relationships_target serves it). Villagers nobody has an edge
        toward don't chart — you can't be popular or hated unseen.
        analytics-service takes this job over in M2."""
        score = func.sum(Relationship.affinity)
        async with self._sessions() as session:
            rows = await session.execute(
                select(
                    Relationship.target_villager_id,
                    Villager.name,
                    score.label("score"),
                    func.count().label("edge_count"),
                )
                .join(Villager, Villager.id == Relationship.target_villager_id)
                .group_by(Relationship.target_villager_id, Villager.name)
                .order_by(score.desc() if metric == "popular" else score.asc())
                .limit(limit)
            )
            return [
                LeaderboardRow(
                    villager_id=row.target_villager_id,
                    name=row.name,
                    score=int(row.score),
                    edge_count=int(row.edge_count),
                )
                for row in rows
            ]
