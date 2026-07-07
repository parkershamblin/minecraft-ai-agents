"""Reflection integration against REAL pgvector: the importance-pressure
trigger query, the full reflect() path (provenance-linked storage +
ReflectionCreated emission), and the M1-9 acceptance test — a fresh
reflection outranks stale raw memories in retrieval."""

import json
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import jsonschema
import pytest
from sqlalchemy import select, update

from memory_service.db import make_engine, make_session_factory
from memory_service.llm import BudgetExhausted, LLMResponse
from memory_service.models import Memory
from memory_service.reflection import ReflectionUnavailable, villagers_due_for_reflection
from memory_service.service import MemoryService
from memory_service.settings import Settings


class ScriptedSummarizer:
    """Returns exactly the insights a test hands it."""

    name = "scripted"
    model = "scripted-1"

    def __init__(self, insights: list[dict]):
        self._insights = insights

    async def complete(self, system: str, user: str) -> LLMResponse:
        return LLMResponse(
            text=json.dumps({"insights": self._insights}),
            tokens_in=10,
            tokens_out=10,
            latency_seconds=0.0,
            provider=self.name,
            model=self.model,
        )


class CapturingPublisher:
    def __init__(self):
        self.published: list[tuple[str, dict]] = []

    async def publish(self, topic: str, envelope: dict) -> None:
        self.published.append((topic, envelope))


@pytest.fixture()
async def reflective_service(database: Settings, embeddings):
    """Factory: a MemoryService whose summarizer emits the given insights and
    whose publisher captures instead of hitting Kafka."""
    engines = []

    def build(insights: list[dict]) -> tuple[MemoryService, CapturingPublisher]:
        engine = make_engine(database.memory_db_url)
        engines.append(engine)
        publisher = CapturingPublisher()
        service = MemoryService(
            make_session_factory(engine),
            embeddings,
            database,
            summarizer=ScriptedSummarizer(insights),
            publisher=publisher,
        )
        return service, publisher

    yield build
    for engine in engines:
        await engine.dispose()


def _find_contracts_dir() -> Path:
    current = Path(__file__).resolve()
    for parent in current.parents:
        candidate = parent / "packages" / "events"
        if (candidate / "schemas").is_dir():
            return candidate
    raise FileNotFoundError("packages/events not found above tests/")


async def test_pressure_trigger_selects_only_villagers_over_threshold(reflective_service):
    service, _ = reflective_service([{"insight": "The flood is why I hoard.", "sourceIndices": [1, 2]}])
    heavy, light = uuid.uuid4(), uuid.uuid4()
    for i in range(5):
        await service.store(heavy, f"dramatic event number {i}", importance=7.0)
    await service.store(light, "a quiet day", importance=3.0)

    due = dict(await villagers_due_for_reflection(service._sessions, 30.0))  # noqa: SLF001
    assert heavy in due
    assert due[heavy] == pytest.approx(35.0)
    assert light not in due

    # reflecting resets the pressure window: the villager drops off the list
    created = await service.reflect(heavy)
    assert created
    assert heavy not in dict(await villagers_due_for_reflection(service._sessions, 30.0))  # noqa: SLF001

    # ...and the reflection's own importance (floors at 7) is NOT new pressure
    await service.store(heavy, "one more small thing", importance=5.0)
    assert heavy not in dict(await villagers_due_for_reflection(service._sessions, 30.0))  # noqa: SLF001


async def test_reflect_stores_provenance_and_emits_reflection_created(reflective_service):
    villager = uuid.uuid4()
    service, publisher = reflective_service(
        [
            {"insight": "Bram keeps sharing bread; he is a true friend.", "sourceIndices": [1, 2]},
            {"insight": "The election talk in the square is turning sour.", "sourceIndices": [3]},
        ]
    )
    m1 = await service.store(villager, "Bram gave me bread.")
    m2 = await service.store(villager, "Bram waved from the mill.")
    m3 = await service.store(villager, "Angry election chatter in the square.")

    records = await service.reflect(villager)
    assert len(records) == 2
    assert all(r.memory_type == "reflection" for r in records)
    assert all(r.importance >= 7.0 for r in records)

    # provenance persisted exactly as cited
    async with service._sessions() as session:  # noqa: SLF001 — test peeks at storage
        rows = {
            row.id: row
            for row in (
                await session.execute(
                    select(Memory).where(
                        Memory.villager_id == villager, Memory.memory_type == "reflection"
                    )
                )
            ).scalars()
        }
    assert rows[records[0].id].source_memory_ids == [m1.id, m2.id]
    assert rows[records[1].id].source_memory_ids == [m3.id]

    # one ReflectionCreated per insight on agent.events, contract-valid,
    # sharing one correlationId for the pass
    contracts = _find_contracts_dir()
    envelope_schema = json.loads((contracts / "schemas" / "envelope.schema.json").read_text())
    payload_schema = json.loads(
        (contracts / "schemas" / "agent" / "ReflectionCreated.v1.schema.json").read_text()
    )
    assert [topic for topic, _ in publisher.published] == ["agent.events", "agent.events"]
    envelopes = [envelope for _, envelope in publisher.published]
    checker = jsonschema.FormatChecker()
    for envelope in envelopes:
        jsonschema.validate(envelope, envelope_schema, format_checker=checker)
        jsonschema.validate(envelope["payload"], payload_schema, format_checker=checker)
        assert envelope["aggregateId"] == str(villager)
    assert {e["payload"]["reflectionId"] for e in envelopes} == {str(r.id) for r in records}
    assert len({e["correlationId"] for e in envelopes}) == 1


async def test_reflect_raises_when_no_summarizer_armed(database, embeddings):
    bare = MemoryService(None, embeddings, database)  # no summarizer, no publisher
    with pytest.raises(ReflectionUnavailable):
        await bare.reflect(uuid.uuid4())


async def test_reflect_returns_empty_when_nothing_to_reflect_on(reflective_service):
    service, publisher = reflective_service([{"insight": "x", "sourceIndices": [1]}])
    assert await service.reflect(uuid.uuid4()) == []
    assert publisher.published == []


async def test_reflect_respects_hourly_cap(database, embeddings):
    capped = database.model_copy(update={"reflections_per_hour_cap": 0})
    engine = make_engine(database.memory_db_url)
    try:
        service = MemoryService(
            make_session_factory(engine),
            embeddings,
            capped,
            summarizer=ScriptedSummarizer([{"insight": "x", "sourceIndices": [1]}]),
            publisher=CapturingPublisher(),
        )
        villager = uuid.uuid4()
        await service.store(villager, "something happened")
        assert await service.reflect(villager) == []
    finally:
        await engine.dispose()


async def test_reflect_skips_on_open_budget_and_on_malformed_output(database, embeddings):
    class ExhaustedSummarizer:
        name = model = "exhausted"

        async def complete(self, system, user):
            raise BudgetExhausted("spent")

    class RamblingSummarizer:
        name = model = "rambling"

        async def complete(self, system, user):
            return LLMResponse(
                text="I refuse to emit JSON today.",
                tokens_in=1,
                tokens_out=1,
                latency_seconds=0.0,
                provider="rambling",
                model="rambling",
            )

    engine = make_engine(database.memory_db_url)
    try:
        sessions = make_session_factory(engine)
        villager = uuid.uuid4()
        exhausted = MemoryService(
            sessions, embeddings, database, summarizer=ExhaustedSummarizer(), publisher=CapturingPublisher()
        )
        await exhausted.store(villager, "a memory to reflect on")
        assert await exhausted.reflect(villager) == []  # skipped, not raised

        rambling = MemoryService(
            sessions, embeddings, database, summarizer=RamblingSummarizer(), publisher=CapturingPublisher()
        )
        assert await rambling.reflect(villager) == []  # discarded, nothing stored
    finally:
        await engine.dispose()


async def test_reflection_outranks_stale_raw_memories(reflective_service):
    """THE M1-9 acceptance test: a fresh, important reflection beats stale
    raw memories in default-weight retrieval (recency 1.0 + importance >=0.7
    vs ~0.43 + 0.3 a week later at equal relevance)."""
    villager = uuid.uuid4()
    service, _ = reflective_service(
        [{"insight": "All this fish talk: the river is the village's real pantry.", "sourceIndices": [1, 2, 3]}]
    )
    raws = [
        await service.store(villager, f"I caught a fish this morning (day {i}).", importance=3.0)
        for i in range(3)
    ]

    # age the raw memories a week: stale recency, low importance
    week_ago = datetime.now(UTC) - timedelta(days=7)
    async with service._sessions() as session:  # noqa: SLF001 — test backdates storage
        await session.execute(
            update(Memory)
            .where(Memory.id.in_([r.id for r in raws]))
            .values(occurred_at=week_ago, created_at=week_ago, last_accessed_at=week_ago)
        )
        await session.commit()

    created = await service.reflect(villager)
    assert len(created) == 1

    results = await service.search(villager, "fish", k=4)
    assert results[0].record.id == created[0].id
    assert results[0].record.memory_type == "reflection"
    # the stale raws are still retrievable, just outranked
    assert {r.record.id for r in results[1:]} == {r.id for r in raws}
