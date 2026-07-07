"""Integration proof against REAL Postgres (same image compose uses): the
relationship read path M1-4 adds — reason persistence on upsert, edges_for /
list_edges — exercised through the actual DDL (migration 0002 included).

Kept out of the offline suite by its testcontainers dependency, like
memory-service's integration test; CI's runner ships a Docker daemon.
The session-scoped `database` fixture lives in conftest.py (shared with the
seed suite).
"""

import uuid

import pytest
from sqlalchemy import text

from agent_service.db import make_engine, make_session_factory
from agent_service.settings import Settings
from agent_service.villagers.relationships import RelationshipRepo
from agent_service.villagers.repo import VillagerRepo

ELARA = uuid.UUID("019f8e2a-0000-7000-8000-0000000e1a2a")
BRAM = uuid.UUID("019f8e2a-0000-7000-8000-0000000b2a44")
WREN = uuid.UUID("019f8e2a-0000-7000-8000-0000000c3e55")


@pytest.fixture()
async def repos(database: Settings):
    engine = make_engine(database.agent_db_url)
    sessions = make_session_factory(engine)
    villagers = VillagerRepo(sessions)
    # FK targets must exist before any edge can be written.
    for vid, name in ((ELARA, "Elara"), (BRAM, "Bram"), (WREN, "Wren")):
        await villagers.insert_if_absent(vid, name, name.lower(), {"traits": []}, "")
    # Each test starts from a clean edge set — no cross-test ordering coupling.
    async with sessions() as session:
        await session.execute(text("DELETE FROM relationships"))
        await session.commit()
    yield RelationshipRepo(sessions)
    await engine.dispose()


async def test_apply_update_persists_reason(repos: RelationshipRepo):
    await repos.apply_update(ELARA, BRAM, 11, 6, reason="He shared bread when I was hungry.")

    [edge] = await repos.edges_for(ELARA, [BRAM])
    assert edge.target_id == BRAM
    assert edge.affinity == 11 and edge.trust == 56  # 0+11, 50+6
    assert edge.last_reason == "He shared bread when I was hungry."
    assert edge.last_reason_at is not None


async def test_upsert_updates_reason_but_none_does_not_erase(repos: RelationshipRepo):
    await repos.apply_update(ELARA, WREN, 5, 0, reason="first impression")
    await repos.apply_update(ELARA, WREN, 5, 0, reason="she returned my tools")
    [edge] = await repos.edges_for(ELARA, [WREN])
    assert edge.affinity == 10 and edge.interaction_count == 2
    assert edge.last_reason == "she returned my tools"

    # a reasonless nudge (heuristic can pass one) must not wipe the last cause
    await repos.apply_update(ELARA, WREN, 3, 0, reason=None)
    [edge] = await repos.edges_for(ELARA, [WREN])
    assert edge.affinity == 13
    assert edge.last_reason == "she returned my tools"


async def test_edges_for_filters_to_requested_targets(repos: RelationshipRepo):
    await repos.apply_update(BRAM, ELARA, 4, 0, reason="x")
    await repos.apply_update(BRAM, WREN, 9, 0, reason="y")

    only_wren = await repos.edges_for(BRAM, [WREN])
    assert [e.target_id for e in only_wren] == [WREN]
    # a target with no edge simply doesn't appear; empty request -> empty
    assert await repos.edges_for(ELARA, [BRAM]) == []  # ELARA has no edges in this test
    assert await repos.edges_for(BRAM, []) == []


async def test_list_edges_orders_by_affinity_desc(repos: RelationshipRepo):
    await repos.apply_update(WREN, ELARA, -20, 0, reason="grudge")
    await repos.apply_update(WREN, BRAM, 30, 0, reason="ally")

    edges = await repos.list_edges(WREN)
    assert [e.target_id for e in edges] == [BRAM, ELARA]  # +30 before -20


async def test_affinity_clamps_at_bounds(repos: RelationshipRepo):
    await repos.apply_update(ELARA, WREN, 200, 0, reason="overflow")
    [edge] = await repos.edges_for(ELARA, [WREN])
    assert edge.affinity == 100  # clamped from 0+200


async def test_leaderboard_sums_incoming_affinity(repos: RelationshipRepo):
    # Bram: loved twice (+30, +20 = 50). Elara: divisive (-40, +10 = -30).
    # Wren: nobody has an edge toward her -> charts nowhere.
    await repos.apply_update(ELARA, BRAM, 30, 0, reason="he helped")
    await repos.apply_update(WREN, BRAM, 20, 0, reason="good stories")
    await repos.apply_update(BRAM, ELARA, -40, 0, reason="she lied")
    await repos.apply_update(WREN, ELARA, 10, 0, reason="kind enough")

    popular = await repos.leaderboard("popular")
    assert [(r.name, r.score, r.edge_count) for r in popular] == [("Bram", 50, 2), ("Elara", -30, 2)]

    hated = await repos.leaderboard("hated")
    assert [(r.name, r.score) for r in hated] == [("Elara", -30), ("Bram", 50)]

    assert "Wren" not in {r.name for r in popular}


async def test_leaderboard_empty_when_no_edges(repos: RelationshipRepo):
    assert await repos.leaderboard("popular") == []
