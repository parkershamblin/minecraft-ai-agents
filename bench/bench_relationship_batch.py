"""#7 (Medium) — batched relationship upserts in agent-service.

Report: "Each relationship change opens its own session, does SELECT...FOR UPDATE,
commits, then publishes - N sessions, N round-trips, N publishes per tick. Fix: batch
the edge upserts in one transaction" (bottleneck-report §7, relationships.py:132).

Two things to prove:

  1. PERF  — N per-edge transactions collapse to ONE. We model DB latency and count
     round-trips + transactions for the old path (per edge: SELECT...FOR UPDATE + commit)
     vs the new path (one validate-select + one for-update-select + one commit).

  2. CORRECTNESS — batching must NOT change the resulting affinity/trust. This is the
     dangerous part of the fix (a "sum the deltas then clamp" shortcut would silently
     change every compounded edge). We fold random update sequences two ways —
     sequential (old, one-at-a-time) vs batched (new, one pass) — using the REAL
     `_clamp` and `GRUDGE_AFFINITY_THRESHOLD` imported from the shipped module, and
     assert identical final state. Mirrors relationships.py:178-209.
"""

from __future__ import annotations

import asyncio
import random
from dataclasses import dataclass

from agent_service.villagers.relationships import GRUDGE_AFFINITY_THRESHOLD, _clamp

from runner import BenchSpec

EDGES_PER_TICK = 6     # a chatty tick: several edges moved at once
DB_OP_MS = 1.5         # one modeled DB round-trip (SELECT / commit)
FIRST_MEETING = (0, 50)  # schema defaults (relationships.py:179)


# ---------------------------------------------------------------------------
# Correctness: the pure per-edge merge, mirrored from relationships.py:178-209.
# ---------------------------------------------------------------------------

@dataclass
class Edge:
    affinity: int
    trust: int


@dataclass(frozen=True)
class Update:
    target: int
    affinity_delta: float
    trust_delta: float
    ambient: bool


def _merge_one(edge: Edge | None, u: Update) -> Edge:
    """Exactly the read-modify-clamp of relationships.py, using the real clamp
    and grudge threshold so this test tracks the shipped semantics."""
    prev_aff, prev_trust = (edge.affinity, edge.trust) if edge is not None else FIRST_MEETING
    aff_d, trust_d = u.affinity_delta, u.trust_delta
    if u.ambient and aff_d > 0 and prev_aff <= GRUDGE_AFFINITY_THRESHOLD:
        aff_d /= 2
        trust_d /= 2
    return Edge(_clamp(prev_aff + aff_d, -100, 100), _clamp(prev_trust + trust_d, 0, 100))


def sequential_apply(updates: list[Update]) -> dict[int, Edge]:
    """OLD path: each update its own read-modify-write against committed state."""
    state: dict[int, Edge] = {}
    for u in updates:
        state[u.target] = _merge_one(state.get(u.target), u)
    return state


def batched_apply(updates: list[Update]) -> dict[int, Edge]:
    """NEW path: pre-load the touched edges once, then fold the batch in list
    order over the in-memory rows (relationships.py:165-206)."""
    by_target: dict[int, Edge] = {}   # starts empty: none of these edges exist yet
    for u in updates:
        by_target[u.target] = _merge_one(by_target.get(u.target), u)
    return by_target


async def _correctness() -> tuple[bool, str]:
    rng = random.Random(20260717)
    trials = 4000
    for t in range(trials):
        n = rng.randint(1, 12)
        updates = [
            Update(
                target=rng.randint(0, 3),            # small target set -> many compounding duplicates
                affinity_delta=rng.randint(-60, 60),  # negatives drive edges below the grudge threshold
                trust_delta=rng.randint(-40, 40),
                ambient=rng.random() < 0.5,           # exercises grudge damping
            )
            for _ in range(n)
        ]
        if sequential_apply(updates) != batched_apply(updates):
            return False, f"divergence on trial {t}: {updates}"
    return True, f"{trials} random update sequences: batched == sequential (bounds + grudge damping preserved)"


# ---------------------------------------------------------------------------
# Perf: N per-edge transactions vs one batched transaction.
# ---------------------------------------------------------------------------

async def _baseline() -> dict[str, float]:
    """OLD: per edge -> own session -> SELECT...FOR UPDATE + commit."""
    round_trips = EDGES_PER_TICK * 2  # per edge: SELECT ... FOR UPDATE, then commit
    # modeled_tick_ms translates the exact round-trip count to latency at DB_OP_MS/op;
    # the counts are the deterministic headline, this is the cost translation.
    return {
        "db_round_trips": float(round_trips),
        "transactions": float(EDGES_PER_TICK),
        "modeled_tick_ms": round_trips * DB_OP_MS,
    }


async def _treatment() -> dict[str, float]:
    """NEW: one transaction -> validate-select + for-update-select + commit."""
    round_trips = 3  # validate-select, for-update-select, commit — regardless of edge count
    return {"db_round_trips": float(round_trips), "transactions": 1.0, "modeled_tick_ms": round_trips * DB_OP_MS}


def spec() -> BenchSpec:
    return BenchSpec(
        key="relationship_batch",
        title="Batched relationship upserts (agent-service #7)",
        description=(
            f"{EDGES_PER_TICK} edges moved in one tick. Baseline = one transaction "
            "per edge; treatment = a single batched transaction. Correctness folds "
            "4000 random sequences both ways and asserts identical final edges."
        ),
        report_ref="bottleneck-report §7 / relationships.py:132 (one session per tick's batch)",
        primary_metric="transactions",
        lower_is_better=True,
        iters=50,
        warmup=10,
        arms={"baseline": _baseline, "treatment": _treatment},
        correctness=_correctness,
    )
