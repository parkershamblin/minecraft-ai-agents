"""One full cognitive tick, entirely offline: fake world, fake LLM, in-memory
memory service, collected publishes. Asserts the wiring the demo depends on —
correlation threading, causation chain, VillagerTalked on chat, MemoryFormed."""

import json
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


def deps(world=None, memory=None, publish=None, llm=None, llm_for=None):
    return TickDeps(
        world=world or FakeWorld(SNAPSHOT),
        memory=memory or FakeMemory(),
        llm=llm or FakeProvider(),  # first scripted decision is a chat
        llm_for=llm_for,
        publish=publish or Collected(),
    )


async def test_deliberate_routes_through_llm_for_when_wired():
    """Per-team brains (RB filming): with llm_for present, deliberation uses
    the routed provider and never touches the default one."""
    routed, unrouted = FakeProvider(), FakeProvider()
    graph = build_tick_graph(
        deps(llm=unrouted, llm_for=lambda villager_id: routed if villager_id == str(ELARA.id) else unrouted)
    )

    await run_tick(graph, ELARA)

    assert routed._calls == 1
    assert unrouted._calls == 0


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


async def test_hazard_percepts_reach_the_reflection():
    """The powder-snow episode must survive the tick as long-term memory —
    rough coordinates included, so future retrieval can steer around the spot."""
    position = {"x": 42.3, "y": 143.0, "z": -212.6}
    world = FakeWorld(
        SNAPSHOT,
        percepts=[
            {"type": "HazardEncountered", "hazardType": "powder_snow", "phase": "trapped",
             "position": position, "detail": None, "occurredAt": "x"},
            {"type": "HazardEncountered", "hazardType": "powder_snow", "phase": "escape_failed",
             "position": position, "detail": "still sunk after digging", "occurredAt": "x"},
            {"type": "HazardEncountered", "hazardType": "powder_snow", "phase": "escaped",
             "position": position, "detail": "dug free through 3 blocks", "occurredAt": "x"},
        ],
    )
    memory = FakeMemory()
    graph = build_tick_graph(deps(world=world, memory=memory))

    await run_tick(graph, ELARA)

    content = memory.stored[0].content
    assert memory.stored[0].memory_type == "action"
    assert "(I was trapped in powder snow near (42, 143, -213).)" in content
    assert "(I fought the powder snow near (42, 143, -213) and could not get free.)" in content
    assert "(Earlier I dug myself out of powder snow near (42, 143, -213).)" in content


async def test_no_snapshot_still_ticks():
    published = Collected()
    graph = build_tick_graph(deps(world=FakeWorld(snapshot=None), publish=published))

    result = await run_tick(graph, ELARA)

    assert result["outcome"].decision.action in ("chat", "move", "idle")
    assert published.by_type("DecisionMade")  # blind, but still thinking


class ScriptedLLM:
    """One fixed decision, for tests that need a specific shape."""

    name = "fake"
    model = "scripted"

    def __init__(self, decision_dict):
        self._text = json.dumps(decision_dict)

    async def complete(self, system, user):
        from agent_service.llm.providers import LLMResponse

        return LLMResponse(
            text=self._text, tokens_in=0, tokens_out=0, latency_seconds=0.0,
            provider=self.name, model=self.model,
        )


ELECTION_ID = "019f8e2a-0000-7000-8000-0000e1ec0001"
BRAM_ID = "019f8e2a-0000-7000-8000-0000000b2a44"


async def test_governance_action_publishes_the_second_command_plane():
    published = Collected()
    civic = ScriptedLLM(
        {
            "action": "chat",
            "params": {"message": "Bram has my vote — he shared his bread."},
            "reasoning": "The voting window is open and my mind is made up.",
            "importance": 6.0,
            "sentiment": 0.6,
            "relationshipUpdates": None,
            "governanceAction": {
                "action": "vote",
                "electionId": ELECTION_ID,
                "candidateVillagerId": BRAM_ID,
                "reason": "He shared his bread when the pantry ran low.",
                "platform": None,
            },
        }
    )
    base = deps(publish=published)
    base.llm = civic
    graph = build_tick_graph(base)

    await run_tick(graph, ELARA)

    decision = published.by_type("DecisionMade")[0]
    [(topic, command)] = [
        (topic, envelope)
        for topic, envelope in published.envelopes
        if envelope["eventType"] == "GovernanceRequested"
    ]

    # the second command plane: right topic, per-villager key, threaded causation
    assert topic == "commands.government"
    assert command["aggregateId"] == str(ELARA.id)
    assert command["correlationId"] == decision["correlationId"]
    assert command["causationId"] == decision["eventId"]
    assert command["payload"]["commandId"] == command["eventId"]
    assert command["payload"]["action"] == "vote"
    assert command["payload"]["params"] == {
        "electionId": ELECTION_ID,
        "candidateVillagerId": BRAM_ID,
        "reason": "He shared his bread when the pantry ran low.",
    }

    # the world action still happened, and the ledger's decision names both
    assert published.by_type("ActionRequested")
    assert "+ vote" in decision["payload"]["decision"]


async def test_no_governance_action_means_nothing_on_that_plane():
    published = Collected()
    graph = build_tick_graph(deps(publish=published))  # FakeProvider: governanceAction null

    await run_tick(graph, ELARA)

    assert published.by_type("GovernanceRequested") == []


async def test_civic_state_reaches_deliberation():
    """The M2-8 seam: deps.civics -> per-villager view -> VILLAGE AFFAIRS in
    the user prompt. Optional-by-default — every deps() above passes None."""
    from datetime import timedelta

    from agent_service.brain.civics import CivicState

    class SpyLLM(ScriptedLLM):
        def __init__(self, decision_dict):
            super().__init__(decision_dict)
            self.user_prompts: list[str] = []

        async def complete(self, system, user):
            self.user_prompts.append(user)
            return await super().complete(system, user)

    civics = CivicState()
    now = datetime.now(UTC)
    civics.election_started({
        "electionId": ELECTION_ID,
        "office": "mayor",
        "startsAt": (now - timedelta(minutes=1)).isoformat(),
        "nominatingEndsAt": (now + timedelta(minutes=9)).isoformat(),
        "endsAt": (now + timedelta(minutes=24)).isoformat(),
    })

    spy = SpyLLM({
        "action": "idle", "params": {}, "reasoning": "listening",
        "importance": 1.0, "sentiment": 0.0,
        "relationshipUpdates": None, "governanceAction": None,
    })
    base = deps()
    base.llm = spy
    base.civics = civics
    graph = build_tick_graph(base)

    await run_tick(graph, ELARA)

    [prompt] = spy.user_prompts
    assert "VILLAGE AFFAIRS" in prompt
    assert 'action "declare_candidacy"' in prompt  # nominating window is open


async def test_awareness_round_trips_across_ticks():
    """Tick 1's decision is remembered; tick 2 recalls it (Sid's Action
    Awareness). Awareness is optional — deps without it (every test above)
    must keep working, which they just did."""
    from agent_service.brain.awareness import ActionAwareness

    awareness = ActionAwareness()
    base = deps()
    base.awareness = awareness
    graph = build_tick_graph(base)

    result = await run_tick(graph, ELARA)
    first = result["outcome"].decision

    remembered = awareness.recall(ELARA.id)
    assert remembered is not None
    assert remembered.action == first.action
    assert remembered.params == first.params
