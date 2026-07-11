"""Prompt construction — pure functions from state to text, so the exact
words a villager thinks with are unit-testable and diffable in review."""

import json
from typing import Any

from agent_service.brain.awareness import LastDecision
from agent_service.brain.civics import CivicView
from agent_service.memory_client import RetrievedMemory
from agent_service.villagers.relationships import GRUDGE_AFFINITY_THRESHOLD

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
- gather: {{"resource": "wood"|"stone"|"dirt"}} — chop or mine the nearest such resource (param optional; wood is the default; reach is handled for you)
- idle: {{}} — deliberately do nothing this turn

Also rate this moment for your own memory: importance (0-10, how much you'll want to remember this) and sentiment (-1 to 1, how it feels).
If this moment changed how you feel about someone, set relationshipUpdates to a list of {{"villagerId", "affinityDelta" (-20..20), "trustDelta" (-20..20), "reason"}} — otherwise set it to null. Only include villagers whose villagerId you can see in the snapshot or overheard lines.
Stay in character. Prefer small, concrete actions over grand plans — and material work (gathering, exploring, providing) is as much a villager's life as conversation."""


def system_prompt(
    name: str,
    personality: dict[str, Any],
    backstory: str | None,
    community_goal: str | None = None,
) -> str:
    quirks = "; ".join(personality.get("quirks", []))
    prompt = SYSTEM_TEMPLATE.format(
        name=name,
        traits=", ".join(personality.get("traits", [])) or "unremarkable",
        values=", ".join(personality.get("values", [])) or "a quiet life",
        speech_style=personality.get("speechStyle", "plain"),
        quirks_line=f"Quirks: {quirks}.\n" if quirks else "",
        backstory=backstory or "You have always lived here.",
    )
    if community_goal:
        # The D2 steering line (M2-10): one shared aim, phrased as village
        # talk — not an order. Off unless the operator sets COMMUNITY_GOAL.
        prompt += f"\nThe village talk lately keeps returning to one shared aim: {community_goal}"
    return prompt


def _signed(n: int) -> str:
    return f"+{n}" if n > 0 else str(n)


def _pos(position: dict[str, Any] | None) -> str:
    """Whole-block coordinates — a villager thinks in blocks, not decimals."""
    p = position or {}
    return f"({round(p.get('x', 0))}, {round(p.get('y', 0))}, {round(p.get('z', 0))})"


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
    grudge_nearby = False
    for v in nearby:
        edge = feelings.get(str(v.get("villagerId")))
        if edge is None:
            lines.append(f"- {v['name']}: no strong feelings yet")
            continue
        if edge.affinity <= GRUDGE_AFFINITY_THRESHOLD:
            grudge_nearby = True
        if edge.last_reason:
            lines.append(
                f"- {v['name']} (affinity {_signed(edge.affinity)}, trust {edge.trust} "
                f"— {edge.last_reason})"
            )
        else:
            lines.append(f"- {v['name']} (affinity {_signed(edge.affinity)}, trust {edge.trust})")
    if grudge_nearby:
        # The M2-5 behavioral directive: without it, models paper over grudges
        # with politeness and the affinity numbers above stay theater.
        lines.append(
            "You hold a grudge against someone here. Let it shape your tone and "
            "choices — refusing, avoiding, arguing, or cold words are all "
            "legitimate; do not perform warmth you do not feel."
        )
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


def _candidate_lines(view: CivicView) -> str:
    if not view.campaign or not view.campaign.candidates:
        return "- no one has stepped forward yet"
    lines = []
    for c in view.campaign.candidates:
        platform = f' — platform: "{c.platform}"' if c.platform else ""
        lines.append(f"- {c.name} (candidateVillagerId {c.villager_id}){platform}")
    return "\n".join(lines)


def _civic_section(view: CivicView) -> str | None:
    """The standing 'Village affairs' section. Percepts alone decay — an
    ongoing election must not. The affordance wording is the M2-7 smoke's
    proven shape (0/4 -> 4/4): name the stakes and the deadline, offer no
    polite way out, and say the civic act rides along with the world action.
    Affordance text renders ONLY while its window is open and only for
    villagers who can still act (already-voted/already-declared see status
    instead — no ALREADY_* rejection spam)."""
    lines: list[str] = []
    campaign, phase = view.campaign, view.phase

    if campaign is not None and phase == "scheduled":
        lines.append(
            f"VILLAGE AFFAIRS — an election for {campaign.office} has been announced; "
            "nominations open shortly. Think on whether you would run, and whom you would trust."
        )
    elif campaign is not None and phase == "nominating":
        lines.append(
            f"VILLAGE AFFAIRS — the village is choosing its {campaign.office} TODAY. "
            "Nominations are OPEN and close soon. Candidates so far:\n"
            + _candidate_lines(view)
        )
        if view.you_declared:
            lines.append(
                "Your name is already on the ballot. Campaign for it — "
                "talk to your neighbors about why."
            )
        else:
            lines.append(
                "To RUN yourself, fill governanceAction with action \"declare_candidacy\", "
                f"electionId \"{campaign.election_id}\", and your platform in your own words — "
                "a candidacy not declared is a chance lost. You can still chat or act while "
                "declaring; it rides along with whatever else you do this turn."
            )
    elif campaign is not None and phase == "voting":
        lines.append(
            f"VILLAGE AFFAIRS — the village is electing its {campaign.office} TODAY and "
            "the ballot box closes within the hour. The candidates:\n" + _candidate_lines(view)
        )
        if view.you_voted:
            lines.append(
                "You have cast your vote; the ballot box closes soon. "
                "Speak your mind while the village decides."
            )
        else:
            lines.append(
                "You have not voted yet; this is likely your last chance, and a vote not "
                "cast is a voice lost. To cast your vote NOW, fill governanceAction with "
                f"action \"vote\", electionId \"{campaign.election_id}\", the "
                "candidateVillagerId of your choice, and your reason in your own voice. "
                "You can still chat or act while voting — the vote rides along with "
                "whatever else you do this turn."
            )

    if view.mayor is not None:
        if view.you_are_mayor:
            lines.append(
                "You are the mayor of the village. The office is yours to fill with deeds."
            )
        else:
            lines.append(f"The village mayor is {view.mayor.name}.")

    return "\n".join(lines) if lines else None


def user_prompt(
    snapshot: dict[str, Any] | None,
    percepts: list[dict[str, Any]],
    memories: list[RetrievedMemory],
    feelings: dict[str, Any] | None = None,
    last_decision: LastDecision | None = None,
    civic: CivicView | None = None,
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

    # The standing civic section (M2-8): percepts decay off the queue, but an
    # ongoing election must not — the cache re-renders it every tick.
    if civic is not None:
        section = _civic_section(civic)
        if section:
            sections.append(section)

    # Type-dispatch: unknown percept types are skipped, never a KeyError —
    # the queue outlives any single deploy's vocabulary.
    action_lines = []
    overheard_lines = []
    news_lines = []
    hazard_this_tick = False
    for i, percept in enumerate(percepts):
        if i == claimed_index:
            continue  # already voiced in "Your last decision"
        kind = percept.get("type")
        if kind == "ActionCompleted":
            action_lines.append(f"- your '{percept['action']}' completed: {json.dumps(percept['detail'])}")
        elif kind == "ActionFailed":
            action_lines.append(f"- your '{percept['action']}' FAILED: {json.dumps(percept['detail'])}")
        elif kind == "HazardEncountered":
            hazard = str(percept.get("hazardType") or "a hazard").replace("_", " ")
            where = _pos(percept.get("position"))
            phase = percept.get("phase")
            if phase == "trapped":
                line = f"- you are SUNK in {hazard} at {where}, freezing and barely able to move"
            elif phase == "escaped":
                line = f"- you dug free of the {hazard} at {where}"
            elif phase == "escape_failed":
                line = f"- you fought the {hazard} at {where} and are still trapped"
            else:
                continue  # an unknown phase is unknown vocabulary — skipped
            hazard_this_tick = True
            detail = percept.get("detail")
            action_lines.append(f"{line} — {detail}" if detail else line)
        elif kind == "ChatObserved" and len(overheard_lines) < 5:
            overheard_lines.append(f'- {percept.get("speakerName", "someone")} said: "{percept.get("message", "")}"')
        elif kind == "ElectionStarted":
            news_lines.append(
                f"- an election for {percept.get('office', 'mayor')} has been called — the village will choose"
            )
        elif kind == "CandidateNominated":
            if percept.get("you"):
                news_lines.append("- your candidacy is registered — your name is on the ballot")
            else:
                platform = percept.get("platform")
                quote = f': "{platform}"' if platform else ""
                news_lines.append(
                    f"- {percept.get('candidateName', 'someone')} declared candidacy{quote}"
                )
        elif kind == "ElectionDecided":
            if percept.get("you"):
                news_lines.append("- the votes are counted: YOU have been elected mayor of the village")
            else:
                news_lines.append(
                    f"- the votes are counted: {percept.get('winnerName', 'someone')} is the new mayor"
                )
        elif kind == "GovernanceRejected":
            news_lines.append(
                f"- your {percept.get('action', 'request')} was refused: {percept.get('message', 'no reason given')}"
            )
    if hazard_this_tick:
        # The survival directive (powder-snow fix): without it, models file
        # "I am freezing" under smalltalk and carry on with the grand plan.
        action_lines.append(
            "The ground here can swallow you. Weigh survival in this decision — "
            "get off the deep snow, keep that spot out of your future plans, and "
            "consider warning your neighbors in chat; do not linger where you sink."
        )
    if action_lines:
        sections.append("Since your last turn:\n" + "\n".join(action_lines))
    if overheard_lines:
        sections.append(
            "Recently overheard (you may want to respond, in your own voice):\n" + "\n".join(overheard_lines)
        )
    if news_lines:
        sections.append("Village news since your last turn:\n" + "\n".join(news_lines))

    if memories:
        sections.append(
            "Relevant memories:\n"
            + "\n".join(f'- "{m.record.content}" (importance {m.record.importance})' for m in memories)
        )

    sections.append("What do you do next?")
    return "\n\n".join(sections)
