"""Prompt construction — pure functions from state to text, so the exact
words a villager thinks with are unit-testable and diffable in review."""

import json
from typing import Any

from agent_service.brain.awareness import LastDecision
from agent_service.brain.civics import CivicView
from agent_service.brain.race import MILESTONES, RaceView
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
- gather: {{"resource": "wood"|"stone"|"dirt"|"coal"|"iron_ore", "count": 1-8}} — chop or mine up to count blocks of that resource in one trip (both optional; wood and 1 are the defaults; reach is handled for you). Ores need a good enough pickaxe in your pack: any pickaxe for coal, a stone pickaxe or better for iron ore.
- craft: {{"item": "planks"|"sticks"|"crafting_table"|"wooden_axe"|"wooden_pickaxe"|"wooden_sword"|"stone_axe"|"stone_pickaxe"|"stone_sword"|"furnace"|"iron_pickaxe"}} — craft ONE step of a recipe chain. The chain: planks come from logs; sticks from planks; a crafting_table takes 4 planks; tools take planks/cobblestone + sticks and need a table (your body finds or places one if you carry it); an iron_pickaxe takes iron — carry raw iron (mined from iron ore) plus fuel (logs/planks/coal) and your body smelts at a furnace as part of the craft. One step per turn — a tool is a project, not a wish.
- hunt: {{"animal": "cow"|"pig"|"sheep"|"chicken"|"any"}} — chase and kill one animal for meat (param optional; nearest game is the default). Hunt when food runs low, not for sport: the herds are slow to return.
- idle: {{}} — deliberately do nothing this turn

Your body looks after itself where it can: it eats carried food by itself when hungry, and it fights or flees hostile monsters by itself when attacked. Your job is what only a mind can do — keep food in your pack (hunt), keep a weapon at your side (craft), and choose where to stand when night falls.

Also rate this moment for your own memory: importance (0-10, how much you'll want to remember this) and sentiment (-1 to 1, how it feels).
If this moment changed how you feel about someone, set relationshipUpdates to a list of {{"villagerId", "affinityDelta" (-20..20), "trustDelta" (-20..20), "reason"}} — otherwise set it to null. Only include villagers whose villagerId you can see in the snapshot or overheard lines.
Stay in character. Prefer small, concrete actions over grand plans — and material work (gathering, hunting, crafting, providing) is as much a villager's life as conversation."""


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


def _survival_section(snapshot: dict[str, Any]) -> str | None:
    """The standing hunger pressure (SV-7): percepts decay off the queue, but
    an empty stomach must not. Escalates at the starving tier and legitimizes
    asking for help — the in-voice distress cry stays emergent."""
    food = snapshot.get("food")
    if not isinstance(food, (int, float)) or food > 10:
        return None
    if food <= 6:
        return (
            f"YOU ARE STARVING (food {food:g}/20). Your body will eat anything edible you carry, "
            "but your pack decides whether you live well — get food NOW: hunt the nearest game, "
            "and asking a neighbor for food in chat is a legitimate, honorable ask."
        )
    return (
        f"Hunger is setting in (food {food:g}/20) — your body eats from your pack by itself, "
        "so what matters is having food IN the pack: hunt while your legs are still quick, "
        "and don't wander far from the herds."
    )


def _animals_section(snapshot: dict[str, Any]) -> str | None:
    """Game in sight — absent field = feature off (no section); [] = looked
    and found nothing, said honestly with the fix (walking)."""
    animals = snapshot.get("nearbyAnimals")
    if animals is None:
        return None
    if not animals:
        return "Game in sight: none — the herds keep to open grass; hunting means walking first."
    lines = "\n".join(
        f"- {a['family']}: nearest {a['nearestDistance']} blocks away, {a['count']} seen" for a in animals
    )
    return "Game in sight (hunt can reach these):\n" + lines


def _dangers_section(snapshot: dict[str, Any]) -> str | None:
    """Hostiles in sight, from the threat watcher's pass. The body handles
    the reflex; the section exists so the MIND can preempt — move, light,
    company, warning others — before the reflex has to."""
    hostiles = snapshot.get("nearbyHostiles")
    if not hostiles:  # absent OR empty — a quiet night needs no section
        return None
    lines = "\n".join(
        f"- {h['count']} {h['type'].replace('_', ' ')}{'s' if h['count'] != 1 else ''}, nearest {h['nearestDistance']} blocks"
        for h in hostiles
    )
    return (
        "DANGERS in sight:\n"
        + lines
        + "\nYour body will fight or flee by itself if they close in — but distance, torchlight, "
        "company, and a warning shouted to neighbors are choices only you can make now."
    )


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


_MILESTONE_PROSE = {
    "first_coal": "coal mined",
    "first_iron_ore": "iron ore mined",
    "furnace_placed": "a furnace placed",
    "first_ingot": "iron smelted",
    "iron_pickaxe": "an IRON PICKAXE crafted",
}

# The tier checklist (RB-2): the next unmet rung, taught as a concrete action
# THIS villager can take this tick. The chain below iron is deliberately
# spelled out — llama reads these hints literally, and the wood→stone
# bootstrap is where races stall.
_RACE_NEXT_HINT = {
    # Bootstrap prose FIRST: this hint only shows when the pack is unreadable
    # (no snapshot yet — almost always a fresh spawn with no pickaxe), and
    # exit-1 measured llama replaying the first recognizable step: coal-first
    # wording drew 267 pickaxe-less `gather coal`, every one rejected
    # TOOL_TIER_REQUIRED by the executor.
    "first_coal": (
        "no pickaxe? Bootstrap: gather wood (count 3) → craft planks → "
        "sticks → crafting_table → wooden_pickaxe. Pickaxe in your pack? mine coal (gather coal, count 4)"
    ),
    "first_iron_ore": (
        "mine iron ore (gather iron_ore, count 3) — it only drops to a stone pickaxe or better; "
        "no stone_pickaxe yet? gather stone and craft one at a table"
    ),
    "furnace_placed": "craft a furnace (8 cobblestone at a table) and carry it — your body sets it up during the pickaxe craft",
    "first_ingot": "carry raw iron plus fuel (coal, planks, or logs) and craft iron_pickaxe — your body smelts at the furnace as part of that one craft",
    "iron_pickaxe": "craft iron_pickaxe NOW — 3 iron ingots (or raw iron + fuel to smelt) and 2 sticks at a table WINS THE RACE",
}


def _race_tool_check(inventory: list[dict] | None, next_unmet: str | None) -> str | None:
    """Attempt-3 lesson (the vanished pickaxe): Fen's wooden pickaxe hit its
    59-use durability cap mid-dig — pathfinder tunnel digs wear tools too —
    and the brain, never told that tools break, chased the next rung
    bare-handed for 35 minutes. The hint is material-aware so the recovery is
    the SHORTEST path back to mining. On a TOOLED pack it speaks the mining
    move itself (exit-1: silence here let stale bootstrap prose keep the
    fleet chopping wood), and it stays silent only at the smelt/win rungs,
    where a re-tool detour would cost the race, and at the banked-cobble
    furnace rung, where the craft hint must speak alone."""
    if inventory is None or next_unmet not in ("first_coal", "first_iron_ore", "furnace_placed"):
        return None
    count: dict[str, int] = {}
    for stack in inventory:
        item = str(stack.get("item", ""))
        count[item] = count.get(item, 0) + int(stack.get("count") or 0)
    # Tier-aware (drill №2 2026-07-18): iron ore ignores a wooden pickaxe, so
    # merely OWNING a pickaxe must not silence the check at first_iron_ore —
    # the live brain crafted a stone_AXE and looped gather-stone/fail-iron for
    # 8 minutes. Gold counts for coal but not iron (tier 0).
    has_any_pickaxe = any(item.endswith("_pickaxe") and n > 0 for item, n in count.items())
    has_stone_or_better = any(
        count.get(p, 0) > 0 for p in ("stone_pickaxe", "iron_pickaxe", "diamond_pickaxe", "netherite_pickaxe")
    )
    cobble = count.get("cobblestone", 0)
    sticks = count.get("stick", 0)
    planks = sum(n for item, n in count.items() if item.endswith("_planks"))
    logs = sum(n for item, n in count.items() if item.endswith("_log"))
    table = count.get("crafting_table", 0)
    # At the furnace rung with the cobblestone already in the pack there is
    # nothing left to MINE before the next milestone — a re-tool detour would
    # bury the "craft a furnace" hint (the sweep caught 6/6 `gather wood`
    # here). Stay silent and let the rung hint speak.
    if next_unmet == "furnace_placed" and cobble >= 8:
        return None
    # Tooled-up rungs speak a POSITIVE directive (exit-1 lesson, 2026-07-17:
    # a silent check here let the rung hint's bootstrap prose re-teach
    # `gather wood` to packs that were DONE with wood — 265 wood trips to 6
    # coal digs in 25 minutes). The mining move is named with its trip count,
    # and the dead verbs are banned by name, attempt-4 style.
    if next_unmet == "first_coal" and has_any_pickaxe:
        return (
            "TOOL CHECK: your pickaxe is ready for coal. Your ONE next move: gather coal "
            "(count 4 — one trip banks the rung and the smelt fuel). Wood is DONE — "
            "do NOT gather wood, do NOT craft planks."
        )
    if next_unmet == "first_iron_ore" and has_stone_or_better:
        return (
            "TOOL CHECK: your stone pickaxe is ready for iron. Your ONE next move: gather iron_ore "
            "(count 3 — the win craft needs 3 raw iron). Wood and stone are DONE — "
            "do NOT gather wood, do NOT gather stone, do NOT craft planks."
        )
    if next_unmet == "furnace_placed" and has_any_pickaxe:
        return (
            f"TOOL CHECK: the furnace needs 8 cobblestone and you carry {cobble}. "
            "Your ONE next move: gather stone (count 8). Do NOT gather wood."
        )
    if next_unmet == "first_iron_ore" and has_any_pickaxe:
        # Wooden (or gold) pickaxe in hand — the upgrade path, one step at a
        # time. The table already stands from the wooden craft; the body finds
        # it, so never spend 4 planks on a second one here.
        why = (
            "TOOL CHECK: iron ore only drops to a STONE pickaxe or better — the pickaxe "
            f"you carry cannot mine it. You carry {cobble} cobblestone, {sticks} sticks. "
        )
        if cobble < 3:
            step = "gather stone (3 cobblestone makes the pickaxe head)"
        elif sticks >= 2:
            step = (
                "craft stone_pickaxe (3 cobblestone + 2 sticks) — you carry everything it needs. "
                "ONLY a pickaxe mines ore: never craft an axe or shovel"
            )
        elif planks >= 2:
            step = "craft sticks (2 planks make 4 sticks)"
        elif logs > 0:
            step = "craft planks (for sticks)"
        else:
            step = "gather wood (for sticks)"
        return (
            why
            + "Your ONE next move: "
            + step
            + ". Gathering iron_ore NOW yields NOTHING — the ore breaks and drops no item to your tool. "
            + "First the stone_pickaxe, THEN iron."
        )
    why = (
        "TOOL CHECK: your pack holds NO pickaxe — tools wear out and BREAK as you dig; "
        "a pickaxe that vanished simply broke. "
    )
    # Named ban (exit-1, 2026-07-17: 267 pickaxe-less `gather coal`, all
    # rejected TOOL_TIER_REQUIRED — the ladder's coal talk outshouted the
    # chain step until the dead verb was banned in the same breath).
    ore_ban = " Never gather coal or iron_ore yet — with no pickaxe the mine FAILS and the turn is wasted."
    if cobble >= 3 and sticks >= 2:
        return why + (
            "Your ONE next move: craft stone_pickaxe — you already carry the cobblestone and sticks "
            "(no table standing near? craft crafting_table first, 4 planks)."
        ) + ore_ban
    # The single computed next step (2026-07-18 drill lesson: given the whole
    # chain as prose, llama repeated the first step it recognized — four
    # `craft planks` with 16 planks already carried, never sticks, never a
    # table. State the arithmetic and name exactly ONE craft; never re-teach
    # steps the pack proves are done.
    pack = f"You carry {planks} planks, {logs} logs, {sticks} sticks{', a crafting_table' if table else ''}."
    need_planks = (0 if table else 4) + (0 if sticks >= 2 else 2) + 3
    guard = ""
    if planks < need_planks:
        if logs > 0:
            step = f"craft planks (each log makes 4; you need {need_planks} planks total for the tool chain)"
        else:
            # count 3: 3 logs = 12 planks, more than the 9-plank worst case —
            # exit-1's single-log trips (127 of 265) re-walked the same trees.
            step = "gather wood (count 3 — one trip covers the whole tool chain)"
    else:
        guard = " You have ALL the wood this chain needs — do NOT gather wood, do NOT craft more planks."
        if sticks < 2:
            step = "craft sticks (2 planks make 4 sticks)"
        elif not table:
            step = "craft crafting_table (4 planks)"
        else:
            step = "craft wooden_pickaxe (3 planks + 2 sticks — the table in your pack gets placed for you)"
    return why + pack + " Your ONE next move: " + step + "." + guard + ore_ban


def _race_sticks_check(inventory: list[dict] | None, next_unmet: str | None) -> str | None:
    """Drill №3 (2026-07-18): both pickaxe crafts spent all 4 sticks, so the
    win craft (3 ingots + 2 STICKS) sat unreachable while the brain looped
    gather on an emptied arena — with 7 planks in the pack. At the smelt/win
    rungs the ONLY tool detour worth naming is the two sticks the iron pickaxe
    itself needs; fires only when the fix is one cheap craft away (a bare pack
    stays silent — no wild goose chase at the win rung)."""
    if inventory is None or next_unmet not in ("first_ingot", "iron_pickaxe"):
        return None
    count: dict[str, int] = {}
    for stack in inventory:
        item = str(stack.get("item", ""))
        count[item] = count.get(item, 0) + int(stack.get("count") or 0)
    if count.get("stick", 0) >= 2:
        return None
    planks = sum(n for item, n in count.items() if item.endswith("_planks"))
    logs = sum(n for item, n in count.items() if item.endswith("_log"))
    if planks >= 2:
        return (
            "STICKS CHECK: the iron_pickaxe craft needs 2 sticks and you carry none. "
            f"Your ONE next move: craft sticks (2 planks make 4; you carry {planks} planks)."
        )
    if logs > 0:
        return (
            "STICKS CHECK: the iron_pickaxe craft needs 2 sticks and you carry none. "
            "Your ONE next move: craft planks (then sticks)."
        )
    return None


def _race_section(race: RaceView, inventory: list[dict] | None = None) -> str:
    """The standing race section: percepts decay off the queue, but a race
    must not — same rule as elections. Checklist truth comes from the
    ledger-fed cache, the next step from the tier table."""
    ladder = " · ".join(
        f"[{'✓' if m in race.your_milestones else ' '}] {_MILESTONE_PROSE[m]}" for m in MILESTONES
    )
    rivals = (
        "; ".join(f"team {team_id} has crossed {len(crossed)}/{len(MILESTONES)}" for team_id, crossed in race.rivals)
        or "no rival team"
    )
    next_unmet = next((m for m in MILESTONES if m not in race.your_milestones), None)
    with_line = f"you and {', '.join(race.teammates)}" if race.teammates else "you alone"
    lines = [
        f"THE RACE — your team ({race.your_team}: {with_line}) races to the FIRST CRAFTED IRON PICKAXE. "
        f"Rival standing: {rivals}.",
        f"Your team's ladder: {ladder}",
    ]
    if next_unmet:
        # When the tool check fires it computes the ONE next move from the
        # pack — the generic chain prose would fight it for attention (the
        # 2026-07-18 drill: llama replayed the chain's first recognizable
        # step, craft planks x4, with 16 planks carried). One voice at a time.
        tool_check = _race_tool_check(inventory, next_unmet) or _race_sticks_check(inventory, next_unmet)
        if tool_check:
            lines.append(tool_check)
        else:
            lines.append(f"Your next step: {_RACE_NEXT_HINT[next_unmet]}.")
    # Directive pressure, twice-tuned. Attempt-1 lesson: 107 chats to 1
    # gather — the friendly "split the work out loud" line licensed a debate
    # club. Attempt-4 lesson: HALF of all 1060 decisions were `move` (gather
    # and craft already walk the body there), and 86 were `hunt` (71 found
    # nothing) — the verbs must be named and banned, not implied away.
    lines.append(
        "RACE DISCIPLINE: choose gather or craft EVERY turn — both walk you to the target on "
        "their own, so never choose move unless your last gather failed with nothing-in-reach. "
        "Always gather with a count of 3-8: a count-1 trip walks the same ground for one block. "
        "NEVER hunt, never idle, never follow: your body feeds itself from the pack and fights "
        "its own battles. Chat ONLY to report a handoff a teammate needs (one short line). "
        "Every turn not mining is a turn the rival team spent mining."
    )
    return "\n".join(lines)


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
    race: RaceView | None = None,
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
        # Race mode mutes the peacetime appetites (attempt-4 data, 2026-07-17:
        # 86 hunt decisions / 71 found nothing, driven by the 7-10 food
        # "hunt while your legs are quick" tier and the game-in-sight section
        # — a racing villager burns turns stalking herds it never catches).
        # True starvation (≤6) still speaks; the body's eat reflex runs
        # regardless.
        race_mode = race is not None
        food = snapshot.get("food")
        suppress_hunger = race_mode and isinstance(food, (int, float)) and food > 6
        for section in (
            None if suppress_hunger else _survival_section(snapshot),
            _dangers_section(snapshot),
            None if race_mode else _animals_section(snapshot),
            _resources_section(snapshot),
        ):
            if section:
                sections.append(section)
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

    # The standing race section (RB-2): same decay rule as elections. The
    # inventory rides along so the tier hint can catch a broken-tool pack.
    if race is not None:
        sections.append(_race_section(race, snapshot.get("inventory") if snapshot else None))

    # Type-dispatch: unknown percept types are skipped, never a KeyError —
    # the queue outlives any single deploy's vocabulary.
    action_lines = []
    overheard_lines = []
    news_lines = []
    # The hazard directive is TYPE-keyed (the SV-7 fix): the powder-snow
    # prose used to fire for ANY hazard, which would have told a starving
    # villager to get off the deep snow.
    hazard_types_this_tick: set[str] = set()
    for i, percept in enumerate(percepts):
        if i == claimed_index:
            continue  # already voiced in "Your last decision"
        kind = percept.get("type")
        if kind == "ActionCompleted":
            action_lines.append(f"- your '{percept['action']}' completed: {json.dumps(percept['detail'])}")
        elif kind == "ActionFailed":
            action_lines.append(f"- your '{percept['action']}' FAILED: {json.dumps(percept['detail'])}")
        elif kind == "HazardEncountered":
            hazard_type = str(percept.get("hazardType") or "hazard")
            hazard = hazard_type.replace("_", " ")
            where = _pos(percept.get("position"))
            phase = percept.get("phase")
            if hazard_type == "starvation":
                if phase == "trapped":
                    line = "- you are STARVING with nothing edible in your pack — your body cannot help until you get food"
                elif phase == "escaped":
                    line = "- you finally ate; the gnawing eases and your strength returns"
                else:
                    continue  # escape_failed is never emitted for starvation
            elif phase == "trapped":
                line = f"- you are SUNK in {hazard} at {where}, freezing and barely able to move"
            elif phase == "escaped":
                line = f"- you dug free of the {hazard} at {where}"
            elif phase == "escape_failed":
                line = f"- you fought the {hazard} at {where} and are still trapped"
            else:
                continue  # an unknown phase is unknown vocabulary — skipped
            hazard_types_this_tick.add(hazard_type)
            detail = percept.get("detail")
            action_lines.append(f"{line} — {detail}" if detail else line)
        elif kind == "ThreatEncountered":
            threat = str(percept.get("threatType") or "something hostile").replace("_", " ")
            where = _pos(percept.get("position"))
            phase = percept.get("phase")
            count = percept.get("count") or 1
            plural = f"{count} {threat}s" if isinstance(count, int) and count > 1 else f"a {threat}"
            if phase == "spotted":
                line = (
                    f"- {plural} SPOTTED near {where} — your body will defend itself if it must, "
                    "but right now YOU choose: distance, company, or standing ground"
                )
            elif phase == "engaged":
                response = percept.get("response")
                verb = "is fighting" if response == "fight" else "is fleeing"
                line = f"- your body {verb} {plural} near {where}"
            elif phase == "killed":
                line = f"- you KILLED the {threat} near {where}"
            elif phase == "escaped":
                line = f"- you got clear of {plural} near {where}"
            elif phase == "overwhelmed":
                line = (
                    f"- you are OVERWHELMED by {plural} near {where} — the fight is NOT working; "
                    "run somewhere else, shout for help, or change the plan NOW"
                )
            else:
                continue  # unknown phase — skipped
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
        elif kind == "AttemptStarted":
            news_lines.append(
                "- THE RACE HAS BEGUN — first team to CRAFT an iron pickaxe wins; the ladder starts with wood and a pickaxe"
            )
        elif kind == "ProgressionMilestone":
            what = _MILESTONE_PROSE.get(str(percept.get("milestone")), str(percept.get("milestone")))
            if percept.get("yourTeam"):
                news_lines.append(f"- RACE: YOUR TEAM crossed a rung — {what} ({percept.get('by', 'a teammate')})")
            else:
                news_lines.append(
                    f"- RACE: team {percept.get('teamId', '?')} crossed a rung — {what}. They are moving; are you?"
                )
        elif kind == "AttemptEnded":
            if percept.get("outcome") == "won":
                who = "YOUR TEAM" if percept.get("yourTeam") else f"team {percept.get('winningTeamId', '?')}"
                news_lines.append(f"- THE RACE IS OVER — {who} crafted the iron pickaxe first.")
            else:
                news_lines.append("- the race was called off")
    if "powder_snow" in hazard_types_this_tick:
        # The survival directive (powder-snow fix): without it, models file
        # "I am freezing" under smalltalk and carry on with the grand plan.
        action_lines.append(
            "The ground here can swallow you. Weigh survival in this decision — "
            "get off the deep snow, keep that spot out of your future plans, and "
            "consider warning your neighbors in chat; do not linger where you sink."
        )
    if "starvation" in hazard_types_this_tick:
        action_lines.append(
            "Hunger has you hollowed out. Food is the only cure and only you can get it — "
            "hunt the nearest game, or ask a neighbor in chat to share what they carry."
        )
    hazard_types_this_tick -= {"powder_snow", "starvation"}
    if hazard_types_this_tick:
        # A future hazard type still deserves weight, in general words.
        action_lines.append("Something here endangers you. Weigh survival in this decision before all else.")
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
