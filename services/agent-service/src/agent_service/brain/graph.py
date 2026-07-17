"""The cognitive tick: perceive -> retrieve -> deliberate -> act -> reflect.

A LangGraph StateGraph over TickState; every collaborator arrives via TickDeps
so the whole brain runs offline in tests (fake world, fake LLM, collected
publishes). One fresh correlationId per tick threads through every event —
the Loki/grep story depends on it.
"""

import time
import uuid
from dataclasses import dataclass, field
from typing import Any, TypedDict

from langgraph.graph import END, START, StateGraph
from uuid6 import uuid7

from agent_service.brain.prompts import system_prompt, user_prompt
from agent_service.events.envelope import (
    TOPIC_AGENT,
    TOPIC_COMMANDS,
    TOPIC_GOVERNMENT_COMMANDS,
    TOPIC_SOCIAL,
    build_envelope,
)
from agent_service.llm.decide import DecisionOutcome, decide_safely
from agent_service.logging import logger
from agent_service.memory_client import RetrievedMemory
from agent_service.villagers.relationships import RelationshipUpdate


@dataclass(frozen=True)
class VillagerBrief:
    """The slice of a villager the brain needs."""

    id: uuid.UUID
    name: str
    personality: dict[str, Any]
    backstory: str | None


# The per-verb timeout table (SV-4). The ceiling is LOAD-BEARING: every
# no-preemption safety argument in the survival cluster reads "a reflex is
# locked out ≤ max(per-verb timeout) = 60s" — raising any verb past the cap
# triggers the PREEMPTED_BY_THREAT contingency review (risk register).
TIMEOUT_TABLE_MAX_MS = 60_000
_TIMEOUT_MS_BY_ACTION = {
    "move": 30_000,
    "follow": 30_000,
    "chat": 10_000,  # instant verb — a stuck chat is a stuck connection
    "idle": 10_000,
    "gather": 60_000,  # a full count-8 session must fit (ruling 2)
    "craft": 30_000,  # SV-3 measured worst case ~1s + a 16-block table walk
    "hunt": 30_000,  # HUNT_CHASE_TIMEOUT_MS (20s) + collection reserve
}
_TIMEOUT_DEFAULT_MS = 30_000


def action_timeout_ms(action: str) -> int:
    return _TIMEOUT_MS_BY_ACTION.get(action, _TIMEOUT_DEFAULT_MS)


@dataclass
class TickDeps:
    world: Any  # WorldGateway-shaped: snapshot(), drain_percepts()
    memory: Any  # MemoryService-shaped: search(), store()
    llm: Any  # LLMProvider-shaped: complete()
    publish: Any  # async (topic, envelope) -> None (fire-and-forget; flush confirms)
    flush: Any = None  # async () -> None: awaits delivery of the tick's publishes (None: publish is synchronous, e.g. tests)
    relationships: Any = None  # RelationshipRepo-shaped: apply_updates() (None: feature off, e.g. old tests)
    awareness: Any = None  # ActionAwareness-shaped: recall()/remember() (None: feature off)
    civics: Any = None  # CivicState-shaped: snapshot(villager_id) (None: feature off)
    community_goal: str | None = None  # D2 filming lever: one system-prompt line
    percepts_max: int = 10
    memories_k: int = 6


class TickState(TypedDict, total=False):
    villager: VillagerBrief
    correlation_id: str
    cause_event_id: str | None  # the heard ChatObserved that triggered a reactive tick
    snapshot: dict[str, Any] | None
    percepts: list[dict[str, Any]]
    memories: list[RetrievedMemory]
    outcome: DecisionOutcome
    decision_event_id: str


def build_tick_graph(deps: TickDeps):
    async def perceive(state: TickState) -> TickState:
        villager = state["villager"]
        snapshot = await deps.world.snapshot(villager.id)
        percepts = await deps.world.drain_percepts(villager.id, deps.percepts_max)
        return {"snapshot": snapshot, "percepts": percepts}

    async def retrieve(state: TickState) -> TickState:
        villager = state["villager"]
        snapshot = state.get("snapshot")
        # The retrieval cue: who and what is around right now.
        nearby = ", ".join(v["name"] for v in (snapshot or {}).get("nearbyVillagers", []))
        cue = f"what is happening around me now; nearby: {nearby or 'nobody'}"
        memories = await deps.memory.search(villager.id, cue, k=deps.memories_k)
        return {"memories": memories}

    async def _nearby_feelings(state: TickState) -> dict[str, Any] | None:
        """Read this villager's edges toward whoever is in sight, so the prompt
        can voice how she feels about them. None when the read seam is off
        (old tests) -> the feelings section is omitted entirely."""
        if deps.relationships is None:
            return None
        villager = state["villager"]
        target_ids: list[uuid.UUID] = []
        for v in (state.get("snapshot") or {}).get("nearbyVillagers", []):
            try:
                target_ids.append(uuid.UUID(str(v.get("villagerId"))))
            except (ValueError, TypeError):
                continue  # players / malformed ids have no villager edges
        edges = await deps.relationships.edges_for(villager.id, target_ids)
        return {str(edge.target_id): edge for edge in edges}

    async def deliberate(state: TickState) -> TickState:
        villager = state["villager"]
        feelings = await _nearby_feelings(state)
        outcome = await decide_safely(
            deps.llm,
            system_prompt(villager.name, villager.personality, villager.backstory,
                          community_goal=deps.community_goal),
            user_prompt(
                state.get("snapshot"),
                state.get("percepts", []),
                state.get("memories", []),
                feelings,
                last_decision=deps.awareness.recall(villager.id) if deps.awareness else None,
                civic=deps.civics.snapshot(str(villager.id)) if deps.civics else None,
            ),
        )
        return {"outcome": outcome}

    async def act(state: TickState) -> TickState:
        villager = state["villager"]
        correlation = state["correlation_id"]
        outcome = state["outcome"]
        decision = outcome.decision

        decision_text = f"{decision.action} {decision.params}" if decision.params else decision.action
        if decision.governance_action is not None:
            decision_text += f" + {decision.governance_action.action}"
        decision_event = build_envelope(
            "DecisionMade",
            villager.id,
            {
                "villagerId": str(villager.id),
                "decision": decision_text,
                "reasoning": decision.reasoning,
                "llmProvider": outcome.provider,
                "llmModel": outcome.model,
                "tokensUsed": outcome.tokens_in + outcome.tokens_out,
                "latencyMs": int(outcome.latency_seconds * 1000),
                "error": outcome.error,
            },
            correlation_id=correlation,
            causation_id=state.get("cause_event_id"),
        )
        await deps.publish(TOPIC_AGENT, decision_event)

        command_id = uuid7()
        await deps.publish(
            TOPIC_COMMANDS,
            build_envelope(
                "ActionRequested",
                villager.id,
                {
                    "commandId": str(command_id),
                    "villagerId": str(villager.id),
                    "action": decision.action,
                    "params": decision.params,
                    "timeoutMs": action_timeout_ms(decision.action),
                },
                correlation_id=correlation,
                causation_id=decision_event["eventId"],
                event_id=command_id,
            ),
        )

        if decision.governance_action is not None:
            # The second command plane (08-m2-plan ruling 3): a tick can act in
            # the world AND in civic life. Params were validated against the
            # GovernanceRequested $defs at decision time; causation threads
            # DoD #2's replay: VoteCast <- GovernanceRequested <- DecisionMade.
            governance_command_id = uuid7()
            await deps.publish(
                TOPIC_GOVERNMENT_COMMANDS,
                build_envelope(
                    "GovernanceRequested",
                    villager.id,
                    {
                        "commandId": str(governance_command_id),
                        "villagerId": str(villager.id),
                        "action": decision.governance_action.action,
                        "params": decision.governance_action.params,
                    },
                    correlation_id=correlation,
                    causation_id=decision_event["eventId"],
                    event_id=governance_command_id,
                ),
            )

        if decision.action == "chat":
            snapshot = state.get("snapshot") or {}
            await deps.publish(
                TOPIC_SOCIAL,
                build_envelope(
                    "VillagerTalked",
                    villager.id,
                    {
                        "speakerId": str(villager.id),
                        "speakerName": villager.name,
                        "listenerIds": [v["villagerId"] for v in snapshot.get("nearbyVillagers", [])],
                        "message": decision.params["message"],
                        "topic": "smalltalk",  # M1 enriches
                        "sentiment": decision.sentiment,
                        "location": snapshot.get("position", {"x": 0, "y": 0, "z": 0}),
                    },
                    correlation_id=correlation,
                    causation_id=decision_event["eventId"],
                ),
            )

        await _apply_relationships(state, decision_event["eventId"])
        if deps.awareness is not None:
            # Remember what was actually requested — a malformed deliberation
            # degraded to idle should be remembered as the idle it became.
            deps.awareness.remember(villager.id, decision.action, decision.params)
        return {"decision_event_id": decision_event["eventId"]}

    async def _apply_relationships(state: TickState, decision_event_id: str) -> None:
        """LLM-decided deltas, else the hearer-sentiment heuristic: the
        hearer's own reaction moves the hearer's edge (design ruling — zero
        extra plumbing, and arguably more correct)."""
        if deps.relationships is None:
            return
        villager = state["villager"]
        decision = state["outcome"].decision

        updates: list[tuple[str, float, float, str, str]] = [
            (u.villager_id, u.affinity_delta, u.trust_delta, u.reason, "deliberation")
            for u in decision.relationship_updates[:3]
        ]
        if not updates:
            for percept in state.get("percepts", []):
                if percept.get("type") != "ChatObserved" or not percept.get("speakerVillagerId"):
                    continue  # players have no edges (FK to villagers)
                directly_addressed = villager.name.lower() in str(percept.get("message", "")).lower()
                magnitude = 8.0 if directly_addressed else 3.0
                if decision.sentiment > 0.1:
                    delta = magnitude
                elif decision.sentiment < -0.1:
                    delta = -magnitude
                else:
                    continue
                updates.append(
                    (
                        percept["speakerVillagerId"],
                        delta,
                        delta / 2,
                        f'heard {percept.get("speakerName", "them")} say: "{percept.get("message", "")}"'[:200],
                        "heuristic",
                    )
                )

        batch: list[RelationshipUpdate] = []
        for target_id, affinity_delta, trust_delta, reason, source in updates:
            if target_id == str(villager.id):
                continue  # no self-edges, even if the LLM tries
            try:
                target_uuid = uuid.UUID(target_id)
            except (ValueError, TypeError):  # hallucinated non-UUID must not kill the tick
                logger.warning(
                    "relationship update rejected",
                    villager=villager.name,
                    target=target_id,
                    error="malformed target id",
                )
                continue
            batch.append(
                RelationshipUpdate(
                    target_id=target_uuid,
                    affinity_delta=affinity_delta,
                    trust_delta=trust_delta,
                    reason=reason,
                    ambient=(source == "heuristic"),
                )
            )
        if not batch:
            return
        try:
            # One session/transaction for the whole tick's deltas (was one per
            # edge); unknown targets are skipped inside with a warning.
            applied = await deps.relationships.apply_updates(villager.id, batch)
        except Exception as exc:  # noqa: BLE001 — a poisoned batch must not kill the tick
            logger.warning(
                "relationship batch rejected",
                villager=villager.name,
                error=str(exc),
            )
            return
        for update, change in applied:
            await deps.publish(
                TOPIC_SOCIAL,
                build_envelope(
                    "RelationshipChanged",
                    villager.id,
                    {
                        "villagerId": str(villager.id),
                        "targetId": str(update.target_id),
                        "previousAffinity": change.previous_affinity,
                        "newAffinity": change.new_affinity,
                        "previousTrust": change.previous_trust,
                        "newTrust": change.new_trust,
                        "reason": update.reason,
                        "source": "heuristic" if update.ambient else "deliberation",
                    },
                    correlation_id=state["correlation_id"],
                    causation_id=decision_event_id,
                ),
            )

    async def reflect(state: TickState) -> TickState:
        villager = state["villager"]
        outcome = state["outcome"]
        decision = outcome.decision

        content = f"I decided to {decision.action}. {decision.reasoning}"
        for percept in state.get("percepts", []):
            kind = percept.get("type")
            if kind == "ActionCompleted":
                content += f" (Earlier, my {percept['action']} completed.)"
            elif kind == "ActionFailed":
                content += f" (Earlier, my {percept['action']} failed.)"
            elif kind == "ChatObserved":
                content += f' (I heard {percept.get("speakerName", "someone")} say: "{percept.get("message", "")}")'
            elif kind == "HazardEncountered":
                hazard = str(percept.get("hazardType") or "a hazard").replace("_", " ")
                pos = percept.get("position") or {}
                near = f"({round(pos.get('x', 0))}, {round(pos.get('y', 0))}, {round(pos.get('z', 0))})"
                phase = percept.get("phase")
                if percept.get("hazardType") == "starvation":
                    # The hunger crisis is a condition, not a place — fold it
                    # in its own words or the memory reads like terrain.
                    if phase == "trapped":
                        content += " (I was starving with nothing left to eat.)"
                    elif phase == "escaped":
                        content += " (I finally ate and the strength came back.)"
                elif phase == "trapped":
                    content += f" (I was trapped in {hazard} near {near}.)"
                elif phase == "escaped":
                    content += f" (Earlier I dug myself out of {hazard} near {near}.)"
                elif phase == "escape_failed":
                    content += f" (I fought the {hazard} near {near} and could not get free.)"
            elif kind == "ThreatEncountered":
                threat = str(percept.get("threatType") or "something hostile").replace("_", " ")
                pos = percept.get("position") or {}
                near = f"({round(pos.get('x', 0))}, {round(pos.get('y', 0))}, {round(pos.get('z', 0))})"
                phase = percept.get("phase")
                if phase == "spotted":
                    content += f" (A {threat} came at me near {near}.)"
                elif phase == "killed":
                    content += f" (I fought off a {threat} near {near}.)"
                elif phase == "escaped":
                    content += f" (I ran from a {threat} near {near} and got clear.)"
                elif phase == "overwhelmed":
                    content += f" (I was overwhelmed by a {threat} near {near} — it was close.)"

        record = await deps.memory.store(
            villager.id,
            content,
            memory_type="action",
            importance=decision.importance,
            sentiment=decision.sentiment,
            source_event_id=uuid.UUID(state["decision_event_id"]),
        )
        await deps.publish(
            TOPIC_AGENT,
            build_envelope(
                "MemoryFormed",
                villager.id,
                {
                    "villagerId": str(villager.id),
                    "memoryId": str(record.id),
                    "content": content,
                    "importance": decision.importance,
                    "sentiment": decision.sentiment,
                },
                correlation_id=state["correlation_id"],
                causation_id=state["decision_event_id"],
            ),
        )
        if deps.flush is not None:
            # publish() is fire-and-forget — one confirmed round-trip per tick,
            # here at the end, instead of 4-8 serial awaited sends.
            await deps.flush()
        return {}

    graph = StateGraph(TickState)
    graph.add_node("perceive", perceive)
    graph.add_node("retrieve", retrieve)
    graph.add_node("deliberate", deliberate)
    graph.add_node("act", act)
    graph.add_node("reflect", reflect)
    graph.add_edge(START, "perceive")
    graph.add_edge("perceive", "retrieve")
    graph.add_edge("retrieve", "deliberate")
    graph.add_edge("deliberate", "act")
    graph.add_edge("act", "reflect")
    graph.add_edge("reflect", END)
    return graph.compile()


async def run_tick(
    compiled_graph,
    villager: VillagerBrief,
    *,
    cause: str | None = None,
    trigger: str = "scheduled",
) -> TickState:
    """One turn of one villager's mind, under one correlationId. A reactive
    tick carries the heard ChatObserved's eventId as `cause` — threading the
    conversation: ChatObserved -> DecisionMade -> chat -> next ChatObserved."""
    correlation = str(uuid7())
    started = time.perf_counter()
    state: TickState = {"villager": villager, "correlation_id": correlation, "cause_event_id": cause}
    result = await compiled_graph.ainvoke(state)
    logger.info(
        "tick complete",
        villager=villager.name,
        correlationId=correlation,
        trigger=trigger,
        action=result["outcome"].decision.action,
        error=result["outcome"].error,
        seconds=round(time.perf_counter() - started, 2),
    )
    return result
