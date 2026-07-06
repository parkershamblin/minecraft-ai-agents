"""One full cognitive tick, entirely offline: fake world, fake LLM, in-memory
memory service, collected publishes. Asserts the wiring the demo depends on —
correlation threading, causation chain, VillagerTalked on chat, MemoryFormed."""

import uuid
from datetime import UTC, datetime

from agent_service.brain.graph import TickDeps, VillagerBrief, build_tick_graph, run_tick
from agent_service.llm.providers import FakeProvider
from agent_service.memory_client import MemoryRecord

ELARA = VillagerBrief(
    id=uuid.UUID("019f8e2a-0000-7000-8000-0000000e1a2a"),
    name="Elara",
    personality={"traits": ["warm"], "values": ["community"], "speechStyle": "friendly"},
    backstory="Raised by the miller.",
)

SNAPSHOT = {
    "villagerId": str(ELARA.id),
    "capturedAt": "2026-07-02T18:41:05.000Z",
    "position": {"x": 12, "y": 66, "z": 4},
    "health": 20,
    "food": 18,
    "inventory": [{"item": "oak_log", "count": 12}],
    "nearbyVillagers": [
        {"villagerId": "019f8e2a-0000-7000-8000-0000000b2a44", "name": "Bram", "distance": 6.1}
    ],
    "timeOfDay": 1000,
}


class FakeWorld:
    def __init__(self, snapshot=None, percepts=None):
        self._snapshot = snapshot
        self._percepts = percepts or []

    async def snapshot(self, villager_id):
        return self._snapshot

    async def drain_percepts(self, villager_id, max_items):
        drained, self._percepts = self._percepts, []
        return drained


class FakeMemory:
    def __init__(self):
        self.stored = []

    async def search(self, villager_id, query, k):
        return []

    async def store(self, villager_id, content, **kwargs):
        record = MemoryRecord(
            id=uuid.uuid4(),
            villager_id=villager_id,
            memory_type=kwargs.get("memory_type", "action"),
            content=content,
            importance=kwargs.get("importance", 1.0),
            sentiment=kwargs.get("sentiment", 0.0),
            occurred_at=datetime.now(UTC),
            embedding_model="fake",
        )
        self.stored.append(record)
        return record


class Collected:
    def __init__(self):
        self.envelopes: list[tuple[str, dict]] = []

    async def __call__(self, topic, envelope):
        self.envelopes.append((topic, envelope))

    def by_type(self, event_type):
        return [e for _, e in self.envelopes if e["eventType"] == event_type]


def deps(world=None, memory=None, publish=None):
    return TickDeps(
        world=world or FakeWorld(SNAPSHOT),
        memory=memory or FakeMemory(),
        llm=FakeProvider(),  # first scripted decision is a chat
        publish=publish or Collected(),
    )


async def test_one_tick_produces_the_full_event_chain():
    published = Collected()
    memory = FakeMemory()
    graph = build_tick_graph(deps(memory=memory, publish=published))

    result = await run_tick(graph, ELARA)

    # FakeProvider's first decision is a chat -> 4 events on 3 topics.
    decision = published.by_type("DecisionMade")[0]
    command = published.by_type("ActionRequested")[0]
    talked = published.by_type("VillagerTalked")[0]
    formed = published.by_type("MemoryFormed")[0]

    # one correlationId threads the whole tick
    correlation = result["correlation_id"]
    for envelope in (decision, command, talked, formed):
        assert envelope["correlationId"] == correlation

    # causation chain: everything traces back to the decision
    assert command["causationId"] == decision["eventId"]
    assert talked["causationId"] == decision["eventId"]
    assert formed["causationId"] == decision["eventId"]

    # commandId equals the command's own envelope eventId (executor contract)
    assert command["payload"]["commandId"] == command["eventId"]

    # VillagerTalked carries the snapshot's listeners and the spoken message
    assert talked["payload"]["listenerIds"] == ["019f8e2a-0000-7000-8000-0000000b2a44"]
    assert talked["payload"]["message"] == command["payload"]["params"]["message"]

    # the reflection landed in memory and MemoryFormed cites it
    assert len(memory.stored) == 1
    assert formed["payload"]["memoryId"] == str(memory.stored[0].id)
    assert "I decided to chat" in memory.stored[0].content


async def test_percepts_reach_the_reflection():
    world = FakeWorld(
        SNAPSHOT,
        percepts=[{"type": "ActionCompleted", "action": "move", "detail": {"blocksTraveled": 14}, "occurredAt": "x"}],
    )
    memory = FakeMemory()
    graph = build_tick_graph(deps(world=world, memory=memory))

    await run_tick(graph, ELARA)

    assert "my move completed" in memory.stored[0].content  # she remembers she arrived


async def test_no_snapshot_still_ticks():
    published = Collected()
    graph = build_tick_graph(deps(world=FakeWorld(snapshot=None), publish=published))

    result = await run_tick(graph, ELARA)

    assert result["outcome"].decision.action in ("chat", "move", "idle")
    assert published.by_type("DecisionMade")  # blind, but still thinking
