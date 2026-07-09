"""Prompt construction — pure functions from state to text, so the exact
words a villager thinks with are unit-testable and diffable in review."""

import json
from typing import Any

from agent_service.brain.awareness import LastDecision
from agent_service.memory_client import RetrievedMemory

SYSTEM_TEMPLATE = """You are {name}, a villager in a small Minecraft settlement.
Personality traits: {traits}.
You value: {values}.
Speech style: {speech_style}.
{quirks_line}Backstory: {backstory}

Each turn you choose exactly ONE next action and respond ONLY with JSON matching the schema you are given.
Available actions and their params:
- move: {{"to": {{"x": number, "y": number, "z": number}}, "range": number}} — walk somewhere
- chat: {{"message": "what you say out loud (max 256 chars)"}} — speak to those nearby
- follow: {{"targetVillagerId": "uuid"}} — walk to another villager
- gather: {{"resource": "wood"|"stone"|"dirt", "maxDistance": number}} — chop or mine the nearest such resource (both params optional; wood is the default)
- idle: {{}} — deliberately do nothing this turn

Also rate this moment for your own memory: importance (0-10, how much you'll want to remember this) and sentiment (-1 to 1, how it feels).
If this moment changed how you feel about someone, set relationshipUpdates to a list of {{"villagerId", "affinityDelta" (-20..20), "trustDelta" (-20..20), "reason"}} — otherwise set it to null. Only include villagers whose villagerId you can see in the snapshot or overheard lines.
Stay in character. Prefer small, concrete actions over grand plans — and material work (gathering, exploring, providing) is as much a villager's life as conversation."""


def system_prompt(name: str, personality: dict[str, Any], backstory: str | None) -> str:
    quirks = "; ".join(personality.get("quirks", []))
    return SYSTEM_TEMPLATE.format(
        name=name,
        traits=", ".join(personality.get("traits", [])) or "unremarkable",
        values=", ".join(personality.get("values", [])) or "a quiet life",
        speech_style=personality.get("speechStyle", "plain"),
        quirks_line=f"Quirks: {quirks}.\n" if quirks else "",
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


def _resources_section(snapshot: dict[str, Any]) -> str | None:
    """The M2-2 survey, voiced. Absent field = no scan ran (old snapshot or
    scan disabled) -> no section; [] = the scan looked and found nothing ->
    say so honestly and point at the fix (moving), because 'no section' would
    read as 'resources are not a thing here'."""
    resources = snapshot.get("nearbyResources")
    if resources is None:
        return None
    if not resources:
        return (
            "Resources in sight: none — this spot is bare. "
            "Moving somewhere new would reveal more."
        )
    lines = "\n".join(
        f"- {r['family']}: nearest {r['nearestDistance']} blocks away, {r['count']} seen"
        for r in resources
    )
    return "Resources in sight (gather can reach these):\n" + lines


def user_prompt(
    snapshot: dict[str, Any] | None,
    percepts: list[dict[str, Any]],
    memories: list[RetrievedMemory],
    feelings: dict[str, Any] | None = None,
    last_decision: LastDecision | None = None,
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
        resources = _resources_section(snapshot)
        if resources:
            sections.append(resources)
    else:
        sections.append(
            "You cannot sense the world right now (no snapshot) — you may still think, speak, or wait."
        )

    # Action awareness (Sid): pair the previous decision with its observed
    # outcome. The matching outcome percept is CLAIMED here so it doesn't
    # render twice; an unmatched decision gets an honest "no outcome yet".
    claimed_index: int | None = None
    if last_decision is not None:
        for i, percept in enumerate(percepts):
            if (
                percept.get("type") in ("ActionCompleted", "ActionFailed")
                and percept.get("action") == last_decision.action
            ):
                claimed_index = i
                break
        if claimed_index is None:
            outcome = "outcome not observed yet — it may still be underway"
        elif percepts[claimed_index].get("type") == "ActionCompleted":
            outcome = f"it completed: {json.dumps(percepts[claimed_index]['detail'])}"
        else:
            outcome = f"it FAILED: {json.dumps(percepts[claimed_index]['detail'])}"
        params = f" {json.dumps(last_decision.params)}" if last_decision.params else ""
        sections.append(f"Your last decision: {last_decision.action}{params} → {outcome}")

    # Feelings for the villagers actually in sight (read seam wired -> not None).
    if feelings is not None:
        section = _feelings_section(snapshot, feelings)
        if section:
            sections.append(section)

    # Type-dispatch: unknown percept types are skipped, never a KeyError —
    # the queue outlives any single deploy's vocabulary.
    action_lines = []
    overheard_lines = []
    for i, percept in enumerate(percepts):
        if i == claimed_index:
            continue  # already voiced in "Your last decision"
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
