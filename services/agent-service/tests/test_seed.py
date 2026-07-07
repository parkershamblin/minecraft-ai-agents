"""M1-7: the full 20-persona cast. Shape checks keep the seed file honest
(20 fully-voiced villagers, stable lead UUIDs, ordering that VILLAGER_COUNT
slicing depends on, legal Minecraft usernames); the testcontainers test proves
the seed flow is idempotent at 20 — a second run creates no rows and re-emits
no VillagerCreated facts, only spawn commands (the executor treats an active
bot as a no-op)."""

import json
import re
import uuid

from sqlalchemy import text

from agent_service.db import make_engine, make_session_factory
from agent_service.settings import Settings
from agent_service.villagers.repo import VillagerRepo
from agent_service.villagers.seed import find_seed_file, seed_villagers

PERSONAS = json.loads(find_seed_file().read_text(encoding="utf-8"))

# The founding three keep their ids forever — fixtures, docs, and the ledger's
# history all reference them.
ELARA = "019f8e2a-0000-7000-8000-0000000e1a2a"
BRAM = "019f8e2a-0000-7000-8000-0000000b2a44"
WREN = "019f8e2a-0000-7000-8000-0000000c3e55"


def test_cast_is_exactly_twenty():
    assert len(PERSONAS) == 20


def test_founding_three_lead_the_file_with_stable_ids():
    # seed_villagers slices [:count] — VILLAGER_COUNT=2 must still mean
    # Elara + Bram, so file order is part of the contract.
    assert [p["id"] for p in PERSONAS[:3]] == [ELARA, BRAM, WREN]


def test_ids_are_unique_valid_uuids():
    ids = [p["id"] for p in PERSONAS]
    assert len(set(ids)) == 20
    for candidate in ids:
        uuid.UUID(candidate)


def test_names_and_usernames_are_unique_and_minecraft_legal():
    assert len({p["name"] for p in PERSONAS}) == 20
    usernames = [p["minecraftUsername"] for p in PERSONAS]
    assert len(set(usernames)) == 20
    for username in usernames:
        assert re.fullmatch(r"[A-Za-z0-9_]{3,16}", username), username


def test_every_persona_is_fully_voiced():
    for p in PERSONAS:
        personality = p["personality"]
        assert len(personality["traits"]) >= 3, p["name"]
        assert len(personality["values"]) >= 3, p["name"]
        assert len(personality["quirks"]) >= 2, p["name"]
        assert personality["speechStyle"].strip(), p["name"]
        assert p["backstory"].strip(), p["name"]


def test_no_two_villagers_share_a_voice():
    styles = [p["personality"]["speechStyle"] for p in PERSONAS]
    assert len(set(styles)) == 20


class FakePublisher:
    def __init__(self):
        self.envelopes: list[tuple[str, dict]] = []

    async def publish(self, topic: str, envelope: dict) -> None:
        self.envelopes.append((topic, envelope))

    def of_type(self, event_type: str) -> list[dict]:
        return [e for _, e in self.envelopes if e["eventType"] == event_type]


async def test_seed_is_idempotent_at_twenty(database: Settings):
    engine = make_engine(database.agent_db_url)
    sessions = make_session_factory(engine)
    async with sessions() as session:
        # relationships first — it holds FKs to villagers
        await session.execute(text("DELETE FROM relationships"))
        await session.execute(text("DELETE FROM villagers"))
        await session.commit()

    publisher = FakePublisher()
    first = await seed_villagers(VillagerRepo(sessions), publisher, count=20)
    assert len(first["seeded"]) == 20 and first["existing"] == []

    second = await seed_villagers(VillagerRepo(sessions), publisher, count=20)
    assert second["seeded"] == [] and len(second["existing"]) == 20

    # Identity facts exactly once; spawn commands every pass (re-embodiment
    # after a restart is the whole point of re-sending them).
    assert len(publisher.of_type("VillagerCreated")) == 20
    assert len(publisher.of_type("ActionRequested")) == 40

    async with sessions() as session:
        count = (await session.execute(text("SELECT count(*) FROM villagers"))).scalar_one()
    assert count == 20
    await engine.dispose()
