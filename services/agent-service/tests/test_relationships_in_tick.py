"""M1-3: relationship updates flow through the act node — LLM path, heuristic
fallback, and the guards (self-edge, hallucinated target, players)."""

import json
import uuid

from agent_service.brain.graph import TickDeps, VillagerBrief, build_tick_graph, run_tick
from agent_service.llm.providers import LLMResponse
from agent_service.villagers.relationships import RelationshipChange

from test_tick_graph import SNAPSHOT, Collected, FakeMemory, FakeWorld

ELARA = VillagerBrief(
    id=uuid.UUID("019f8e2a-0000-7000-8000-0000000e1a2a"),
    name="Elara",
    personality={"traits": ["warm"]},
    backstory=None,
)
BRAM_ID = "019f8e2a-0000-7000-8000-0000000b2a44"


class ScriptedProvider:
    name = "scripted"
    model = "scripted-1"

    def __init__(self, decision: dict):
        self._decision = decision

    async def complete(self, system, user):
        return LLMResponse(
            text=json.dumps(self._decision), tokens_in=0, tokens_out=0,
            latency_seconds=0.0, provider=self.name, model=self.model,
        )


class FakeRelationships:
    def __init__(self, reject: set[str] | None = None):
        self.applied = []
        self.reasons = []
        self.ambients = []
        self._reject = reject or set()

    async def apply_update(self, villager_id, target_id, affinity_delta, trust_delta, reason=None, *, ambient=False):
        if str(target_id) in self._reject:
            raise ValueError("unknown target (FK)")
        self.applied.append((str(villager_id), str(target_id), affinity_delta, trust_delta))
        self.reasons.append(reason)
        self.ambients.append(ambient)
        return RelationshipChange(
            villager_id=villager_id, target_id=target_id,
            previous_affinity=0, new_affinity=int(affinity_delta),
            previous_trust=50, new_trust=int(50 + trust_delta),
        )

    async def edges_for(self, villager_id, target_ids):
        return []  # the read seam: no prior feelings in these tick tests

    async def list_edges(self, villager_id):
        return []


def decision(**overrides):
    base = {
        "action": "idle",
        "params": {},
        "reasoning": "thinking about my neighbors",
        "importance": 2.0,
        "sentiment": 0.5,
        "relationshipUpdates": None,
        "governanceAction": None,  # required-nullable (M2-7)
    }
    base.update(overrides)
    return base


def graph_with(llm_decision, *, percepts=None, repo=None, publish=None):
    return build_tick_graph(
        TickDeps(
            world=FakeWorld(SNAPSHOT, percepts=percepts),
            memory=FakeMemory(),
            llm=ScriptedProvider(llm_decision),
            publish=publish or Collected(),
            relationships=repo if repo is not None else FakeRelationships(),
        )
    )


async def test_llm_deltas_apply_and_emit():
    repo, published = FakeRelationships(), Collected()
    llm_decision = decision(
        relationshipUpdates=[
            {"villagerId": BRAM_ID, "affinityDelta": 15, "trustDelta": 5, "reason": "He helped me carry logs."}
        ]
    )
    await run_tick(graph_with(llm_decision, repo=repo, publish=published), ELARA)

    assert repo.applied == [(str(ELARA.id), BRAM_ID, 15.0, 5.0)]
    assert repo.reasons == ["He helped me carry logs."]  # reason reaches the repo (persisted as last_reason)
    assert repo.ambients == [False]  # deliberate delta — never grudge-damped (M2-5)
    [changed] = published.by_type("RelationshipChanged")
    assert changed["payload"]["newAffinity"] == 15
    assert changed["payload"]["source"] == "deliberation"
    assert changed["payload"]["reason"] == "He helped me carry logs."
    assert changed["causationId"] == published.by_type("DecisionMade")[0]["eventId"]


async def test_heuristic_fallback_from_overheard_chat():
    repo, published = FakeRelationships(), Collected()
    percepts = [{
        "type": "ChatObserved", "speakerVillagerId": BRAM_ID, "speakerName": "Bram",
        "message": "Elara, your fences look sturdy today.",  # direct address -> ±8
        "sourceEventId": "x", "correlationId": "y", "occurredAt": "z",
    }]
    await run_tick(graph_with(decision(sentiment=0.6), percepts=percepts, repo=repo, publish=published), ELARA)

    [(_, target, affinity, trust)] = repo.applied
    assert target == BRAM_ID and affinity == 8.0 and trust == 4.0
    assert repo.ambients == [True]  # heuristic drift is ambient -> grudge-damped in the repo (M2-5)
    assert published.by_type("RelationshipChanged")[0]["payload"]["source"] == "heuristic"


async def test_player_speech_moves_no_edges():
    repo = FakeRelationships()
    percepts = [{
        "type": "ChatObserved", "speakerVillagerId": None, "speakerName": "ParkerTheCreator",
        "message": "good morning villagers", "sourceEventId": "x", "correlationId": "y", "occurredAt": "z",
    }]
    await run_tick(graph_with(decision(sentiment=0.9), percepts=percepts, repo=repo), ELARA)
    assert repo.applied == []


async def test_hallucinated_target_is_survived():
    ghost = str(uuid.uuid4())
    repo, published = FakeRelationships(reject={ghost}), Collected()
    llm_decision = decision(
        relationshipUpdates=[{"villagerId": ghost, "affinityDelta": 10, "trustDelta": 0, "reason": "?"}]
    )
    result = await run_tick(graph_with(llm_decision, repo=repo, publish=published), ELARA)

    assert result["outcome"].decision.action == "idle"  # the tick completed
    assert published.by_type("RelationshipChanged") == []  # nothing emitted


async def test_self_edge_is_skipped():
    repo = FakeRelationships()
    llm_decision = decision(
        relationshipUpdates=[{"villagerId": str(ELARA.id), "affinityDelta": 20, "trustDelta": 20, "reason": "me"}]
    )
    await run_tick(graph_with(llm_decision, repo=repo), ELARA)
    assert repo.applied == []
