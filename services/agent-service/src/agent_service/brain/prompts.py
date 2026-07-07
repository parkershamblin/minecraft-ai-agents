"""Prompt construction — pure functions from state to text, so the exact
words a villager thinks with are unit-testable and diffable in review."""

import json
from typing import Any

from agent_service.memory_client import RetrievedMemory

SYSTEM_TEMPLATE = """You are {name}, a villager in a small Minecraft settlement.
Personality traits: {traits}.
You value: {values}.
Speech style: {speech_style}.
Backstory: {backstory}

Each turn you choose exactly ONE next action and respond ONLY with JSON matching the schema you are given.
Available actions and their params:
- move: {{"to": {{"x": number, "y": number, "z": number}}, "range": number}} — walk somewhere
- chat: {{"message": "what you say out loud (max 256 chars)"}} — speak to those nearby
- follow: {{"targetVillagerId": "uuid"}} — walk to another villager
- gather: {{"resource": "wood"|"stone"|"dirt", "maxDistance": number}} — chop or mine the nearest such resource (both params optional; wood is the default)
- idle: {{}} — deliberately do nothing this turn

Also rate this moment for your own memory: importance (0-10, how much you'll want to remember this) and sentiment (-1 to 1, how it feels).
If this moment changed how you feel about someone, set relationshipUpdates to a list of {{"villagerId", "affinityDelta" (-20..20), "trustDelta" (-20..20), "reason"}} — otherwise set it to null. Only include villagers whose villagerId you can see in the snapshot or overheard lines.
Stay in character. Prefer small, concrete, social actions over grand plans."""


def system_prompt(name: str, personality: dict[str, Any], backstory: str | None) -> str:
    return SYSTEM_TEMPLATE.format(
        name=name,
        traits=", ".join(personality.get("traits", [])) or "unremarkable",
        values=", ".join(personality.get("values", [])) or "a quiet life",
        speech_style=personality.get("speechStyle", "plain"),
        backstory=backstory or "You have always lived here.",
    )


def _signed(n: int) -> str:
    return f"+{n}" if n > 0 else str(n)


def _feelings_section(
    snapshot: dict[str, Any] | None, feelings: dict[str, Any]
) -> str | None:
    """One line per nearby villager: the edge if there is one, otherwise a
    neutral 'no strong feelings yet'. `feelings` is keyed by villagerId string
    and each value is a RelationshipEdge-shaped object (affinity, trust,
    last_reason). Called only when the read seam is wired (feelings is not
    None); an empty dict still renders every nearby villager as neutral."""
    nearby = (snapshot or {}).get("nearbyVillagers", [])
    if not nearby:
        return None
    lines = []
    for v in nearby:
        edge = feelings.get(str(v.get("villagerId")))
        if edge is None:
            lines.append(f"- {v['name']}: no strong feelings yet")
        elif edge.last_reason:
            lines.append(
                f"- {v['name']} (affinity {_signed(edge.affinity)}, trust {edge.trust} "
                f"— {edge.last_reason})"
            )
        else:
            lines.append(f"- {v['name']} (affinity {_signed(edge.affinity)}, trust {edge.trust})")
    return "How you feel about those nearby:\n" + "\n".join(lines)


def user_prompt(
    snapshot: dict[str, Any] | None,
    percepts: list[dict[str, Any]],
    memories: list[RetrievedMemory],
    feelings: dict[str, Any] | None = None,
) -> str:
    sections: list[str] = []

    if snapshot:
        nearby = ", ".join(
            f"{v['name']} (villagerId {v['villagerId']}, {v['distance']} blocks away)"
            for v in snapshot.get("nearbyVillagers", [])
        )
        sections.append(
            "Current world snapshot:\n"
            f"- position: {json.dumps(snapshot['position'])}, health {snapshot['health']}/20, "
            f"food {snapshot.get('food', '?')}/20, time-of-day tick {snapshot['timeOfDay']}\n"
            f"- nearby villagers: {nearby or 'nobody in sight'}\n"
            f"- inventory: {', '.join(f'{i['count']} {i['item']}' for i in snapshot.get('inventory', [])) or 'empty'}"
        )
    else:
        sections.append(
            "You cannot sense the world right now (no snapshot) — you may still think, speak, or wait."
        )

    # Feelings for the villagers actually in sight (read seam wired -> not None).
    if feelings is not None:
        section = _feelings_section(snapshot, feelings)
        if section:
            sections.append(section)

    # Type-dispatch: unknown percept types are skipped, never a KeyError —
    # the queue outlives any single deploy's vocabulary.
    action_lines = []
    overheard_lines = []
    for percept in percepts:
        kind = percept.get("type")
        if kind == "ActionCompleted":
            action_lines.append(f"- your '{percept['action']}' completed: {json.dumps(percept['detail'])}")
        elif kind == "ActionFailed":
            action_lines.append(f"- your '{percept['action']}' FAILED: {json.dumps(percept['detail'])}")
        elif kind == "ChatObserved" and len(overheard_lines) < 5:
            overheard_lines.append(f'- {percept.get("speakerName", "someone")} said: "{percept.get("message", "")}"')
    if action_lines:
        sections.append("Since your last turn:\n" + "\n".join(action_lines))
    if overheard_lines:
        sections.append(
            "Recently overheard (you may want to respond, in your own voice):\n" + "\n".join(overheard_lines)
        )

    if memories:
        sections.append(
            "Relevant memories:\n"
            + "\n".join(f'- "{m.record.content}" (importance {m.record.importance})' for m in memories)
        )

    sections.append("What do you do next?")
    return "\n\n".join(sections)
