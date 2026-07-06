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
    TOPIC_SOCIAL,
    build_envelope,
)
from agent_service.llm.decide import DecisionOutcome, decide_safely
from agent_service.logging import logger
from agent_service.memory_client import RetrievedMemory


@dataclass(frozen=True)
class VillagerBrief:
    """The slice of a villager the brain needs."""

    id: uuid.UUID
    name: str
    personality: dict[str, Any]
    backstory: str | None


@dataclass
class TickDeps:
    world: Any  # WorldGateway-shaped: snapshot(), drain_percepts()
    memory: Any  # MemoryService-shaped: search(), store()
    llm: Any  # LLMProvider-shaped: complete()
    publish: Any  # async (topic, envelope) -> None
    percepts_max: int = 10
    memories_k: int = 6


class TickState(TypedDict, total=False):
    villager: VillagerBrief
    correlation_id: str
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

    async def deliberate(state: TickState) -> TickState:
        villager = state["villager"]
        outcome = await decide_safely(
            deps.llm,
            system_prompt(villager.name, villager.personality, villager.backstory),
            user_prompt(state.get("snapshot"), state.get("percepts", []), state.get("memories", [])),
        )
        return {"outcome": outcome}

    async def act(state: TickState) -> TickState:
        villager = state["villager"]
        correlation = state["correlation_id"]
        outcome = state["outcome"]
        decision = outcome.decision

        decision_event = build_envelope(
            "DecisionMade",
            villager.id,
            {
                "villagerId": str(villager.id),
                "decision": f"{decision.action} {decision.params}" if decision.params else decision.action,
                "reasoning": decision.reasoning,
                "llmProvider": outcome.provider,
                "llmModel": outcome.model,
                "tokensUsed": outcome.tokens_in + outcome.tokens_out,
                "latencyMs": int(outcome.latency_seconds * 1000),
                "error": outcome.error,
            },
            correlation_id=correlation,
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
                    "timeoutMs": 30_000,
                },
                correlation_id=correlation,
                causation_id=decision_event["eventId"],
                event_id=command_id,
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

        return {"decision_event_id": decision_event["eventId"]}

    async def reflect(state: TickState) -> TickState:
        villager = state["villager"]
        outcome = state["outcome"]
        decision = outcome.decision

        content = f"I decided to {decision.action}. {decision.reasoning}"
        for percept in state.get("percepts", []):
            verb = "completed" if percept["type"] == "ActionCompleted" else "failed"
            content += f" (Earlier, my {percept['action']} {verb}.)"

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


async def run_tick(compiled_graph, villager: VillagerBrief) -> TickState:
    """One turn of one villager's mind, under one correlationId."""
    correlation = str(uuid7())
    started = time.perf_counter()
    state: TickState = {"villager": villager, "correlation_id": correlation}
    result = await compiled_graph.ainvoke(state)
    logger.info(
        "tick complete",
        villager=villager.name,
        correlationId=correlation,
        action=result["outcome"].decision.action,
        error=result["outcome"].error,
        seconds=round(time.perf_counter() - started, 2),
    )
    return result
