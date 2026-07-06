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
- gather: {{}} — gather resources nearby (not yet available; avoid unless nothing else makes sense)
- idle: {{}} — deliberately do nothing this turn

Also rate this moment for your own memory: importance (0-10, how much you'll want to remember this) and sentiment (-1 to 1, how it feels).
Stay in character. Prefer small, concrete, social actions over grand plans."""


def system_prompt(name: str, personality: dict[str, Any], backstory: str | None) -> str:
    return SYSTEM_TEMPLATE.format(
        name=name,
        traits=", ".join(personality.get("traits", [])) or "unremarkable",
        values=", ".join(personality.get("values", [])) or "a quiet life",
        speech_style=personality.get("speechStyle", "plain"),
        backstory=backstory or "You have always lived here.",
    )


def user_prompt(
    snapshot: dict[str, Any] | None,
    percepts: list[dict[str, Any]],
    memories: list[RetrievedMemory],
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

    if percepts:
        lines = []
        for percept in percepts:
            if percept["type"] == "ActionCompleted":
                lines.append(f"- your '{percept['action']}' completed: {json.dumps(percept['detail'])}")
            else:
                lines.append(f"- your '{percept['action']}' FAILED: {json.dumps(percept['detail'])}")
        sections.append("Since your last turn:\n" + "\n".join(lines))

    if memories:
        sections.append(
            "Relevant memories:\n"
            + "\n".join(f'- "{m.record.content}" (importance {m.record.importance})' for m in memories)
        )

    sections.append("What do you do next?")
    return "\n\n".join(sections)
