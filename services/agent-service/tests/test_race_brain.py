"""RB-2: race state, the tier-checklist prompt section, and the
team-progress percept fanout."""

import json
from datetime import UTC, datetime

from agent_service.brain.race import MILESTONES, RaceState
from agent_service.brain.prompts import _race_section, user_prompt
from agent_service.kafka.percepts import PerceptConsumer

RED_1, RED_2, RED_3 = "red-1", "red-2", "red-3"
BLUE_1, BLUE_2, BLUE_3 = "blue-1", "blue-2", "blue-3"
ATTEMPT = "019fb100-0000-7000-8000-00000000c000"

NAMES = {RED_1: "Elara", RED_2: "Bram", RED_3: "Wren", BLUE_1: "Ansel", BLUE_2: "Petra", BLUE_3: "Fen"}

STARTED = {
    "attemptId": ATTEMPT,
    "label": "test",
    "difficulty": "normal",
    "teams": [
        {"teamId": "red", "villagerIds": [RED_1, RED_2, RED_3]},
        {"teamId": "blue", "villagerIds": [BLUE_1, BLUE_2, BLUE_3]},
    ],
}


def _state() -> RaceState:
    state = RaceState()
    state.attempt_started(STARTED, lambda v: NAMES.get(v, v))
    return state


def _milestone(team, milestone, villager=None):
    return {"attemptId": ATTEMPT, "teamId": team, "villagerId": villager or RED_1, "milestone": milestone, "detail": None}


# ------------------------------------------------------------------ RaceState


def test_snapshot_is_personalized_and_spectators_get_none():
    state = _state()
    state.milestone(_milestone("red", "first_coal"))
    view = state.snapshot(RED_2)
    assert view.your_team == "red"
    assert view.teammates == ("Elara", "Wren")
    assert view.your_milestones == frozenset({"first_coal"})
    assert view.rivals == (("blue", frozenset()),)
    assert state.snapshot("a-spectator") is None


def test_wrong_attempt_and_unknown_milestones_are_ignored():
    state = _state()
    state.milestone({**_milestone("red", "first_coal"), "attemptId": "someone-elses-race"})
    state.milestone(_milestone("red", "first_diamond"))
    assert state.snapshot(RED_1).your_milestones == frozenset()


def test_attempt_ended_clears_everything():
    state = _state()
    state.attempt_ended({"attemptId": ATTEMPT})
    assert state.snapshot(RED_1) is None
    assert state.participant_ids() == ()


def test_malformed_start_is_swallowed():
    state = RaceState()
    state.attempt_started({"attemptId": "x"}, lambda v: v)  # no teams
    assert state.snapshot(RED_1) is None


# -------------------------------------------------------------- prompt section


def test_race_section_renders_checklist_rivals_and_next_step():
    state = _state()
    state.milestone(_milestone("red", "first_coal"))
    state.milestone(_milestone("blue", "first_coal", BLUE_1))
    state.milestone(_milestone("blue", "first_iron_ore", BLUE_1))
    section = _race_section(state.snapshot(RED_1))
    assert "your team (red: you and Bram, Wren)" in section
    assert "[✓] coal mined" in section
    assert "[ ] iron ore mined" in section
    assert "team blue has crossed 2/5" in section
    # the next unmet rung for red is iron ore — the hint teaches the tier gate
    assert "stone pickaxe or better" in section
    assert "Chat ONLY" in section


def test_tool_check_silent_when_pack_has_a_pickaxe_or_no_snapshot():
    state = _state()
    view = state.snapshot(RED_1)
    with_pickaxe = [{"item": "wooden_pickaxe", "count": 1}]
    assert "TOOL CHECK" not in _race_section(view, with_pickaxe)
    assert "TOOL CHECK" not in _race_section(view, None)


def test_tool_check_stone_path_when_materials_are_in_the_pack():
    state = _state()
    state.milestone(_milestone("red", "first_coal"))
    inventory = [{"item": "cobblestone", "count": 5}, {"item": "stick", "count": 2}]
    section = _race_section(state.snapshot(RED_1), inventory)
    assert "TOOL CHECK" in section
    assert "craft stone_pickaxe — you already carry the cobblestone and sticks" in section
    assert "crafting_table first" in section


def test_tool_check_wood_bootstrap_when_the_pack_is_bare():
    state = _state()
    section = _race_section(state.snapshot(RED_1), [])
    assert "TOOL CHECK" in section
    assert "Your ONE next move: gather wood" in section


def test_tool_check_names_the_single_next_craft_from_the_pack():
    # The 2026-07-18 drill defect: given the chain as prose, llama crafted
    # planks 4x (16 carried) and never chained on. The check must diff the
    # chain against the pack and name exactly ONE craft.
    state = _state()
    plank_rich = [{"item": "oak_planks", "count": 16}, {"item": "oak_log", "count": 2}]
    section = _race_section(state.snapshot(RED_1), plank_rich)
    assert "Your ONE next move: craft sticks" in section
    assert "do NOT craft more planks" in section
    # the generic chain prose stays out while the computed step speaks
    assert "Bootstrap: gather wood" not in section

    with_sticks = plank_rich + [{"item": "stick", "count": 2}]
    assert "Your ONE next move: craft crafting_table" in _race_section(state.snapshot(RED_1), with_sticks)

    with_table = with_sticks + [{"item": "crafting_table", "count": 1}]
    assert "Your ONE next move: craft wooden_pickaxe" in _race_section(state.snapshot(RED_1), with_table)

    short_on_planks = [{"item": "oak_log", "count": 3}]
    assert "Your ONE next move: craft planks" in _race_section(state.snapshot(RED_1), short_on_planks)


def test_tool_check_upgrades_a_wooden_pickaxe_for_the_iron_rung():
    # Drill No.2 2026-07-18: wooden pick in hand, iron tool-gated, the brain
    # crafted a stone_AXE and looped. A wooden pickaxe must not silence the
    # check at first_iron_ore — it must walk the pack to stone_pickaxe.
    state = _state()
    state.milestone(_milestone("red", "first_coal"))
    base = [{"item": "wooden_pickaxe", "count": 1}]

    ready = base + [{"item": "cobblestone", "count": 8}, {"item": "stick", "count": 2}]
    section = _race_section(state.snapshot(RED_1), ready)
    assert "TOOL CHECK" in section
    assert "Your ONE next move: craft stone_pickaxe" in section

    no_cobble = base + [{"item": "stick", "count": 2}]
    assert "Your ONE next move: gather stone" in _race_section(state.snapshot(RED_1), no_cobble)

    no_sticks = base + [{"item": "cobblestone", "count": 8}, {"item": "oak_planks", "count": 7}]
    assert "Your ONE next move: craft sticks" in _race_section(state.snapshot(RED_1), no_sticks)

    upgraded = [{"item": "stone_pickaxe", "count": 1}]
    assert "TOOL CHECK" not in _race_section(state.snapshot(RED_1), upgraded)


def test_tool_check_yields_to_the_furnace_hint_once_cobble_is_banked():
    # Sweep regression 2026-07-18: at furnace_placed with 8 cobblestone the
    # check buried "craft a furnace" under gather wood. Nothing left to mine
    # means no re-tool detour.
    state = _state()
    state.milestone(_milestone("red", "first_coal"))
    state.milestone(_milestone("red", "first_iron_ore"))
    banked = [{"item": "iron_ore", "count": 3}, {"item": "cobblestone", "count": 8}]
    section = _race_section(state.snapshot(RED_1), banked)
    assert "TOOL CHECK" not in section
    assert "craft a furnace" in section


def test_tool_check_stays_out_of_the_win_rungs():
    # A re-tool detour at first_ingot/iron_pickaxe would cost the race —
    # the check only fires on the mining rungs.
    state = _state()
    for milestone in MILESTONES[:3]:
        state.milestone(_milestone("red", milestone))
    section = _race_section(state.snapshot(RED_1), [])
    assert "TOOL CHECK" not in section


def test_sticks_check_names_the_missing_sticks_at_the_smelt_rungs():
    # Drill No.3 2026-07-18: both pickaxe crafts spent all four sticks; the win
    # craft needs two and the brain looped gather on an emptied arena with 7
    # planks carried. One cheap craft away -> say exactly that.
    state = _state()
    for milestone in MILESTONES[:3]:
        state.milestone(_milestone("red", milestone))
    beached = [{"item": "raw_iron", "count": 3}, {"item": "oak_planks", "count": 7}]
    section = _race_section(state.snapshot(RED_1), beached)
    assert "STICKS CHECK" in section
    assert "Your ONE next move: craft sticks" in section

    with_sticks = beached + [{"item": "stick", "count": 2}]
    assert "STICKS CHECK" not in _race_section(state.snapshot(RED_1), with_sticks)

    # bare pack at a win rung stays silent — no wild goose chase prose
    assert "STICKS CHECK" not in _race_section(state.snapshot(RED_1), [])


def test_race_section_win_rung_is_the_last_hint():
    state = _state()
    for milestone in MILESTONES[:-1]:
        state.milestone(_milestone("red", milestone))
    section = _race_section(state.snapshot(RED_1))
    assert "WINS THE RACE" in section


# Race mode mutes the peacetime appetites (attempt-4 data: 86 hunt decisions,
# 71 found nothing — the hunger tier and game-in-sight section drove them).


def _hungry_snapshot(food, animals=True):
    snap = {
        "position": {"x": 0, "y": 64, "z": 0},
        "health": 20,
        "food": food,
        "timeOfDay": 1000,
        "inventory": [{"item": "stone_pickaxe", "count": 1}],
    }
    if animals:
        snap["nearbyAnimals"] = [{"family": "cow", "nearestDistance": 12, "count": 3}]
    return snap


def test_race_mode_mutes_mild_hunger_and_game_in_sight():
    state = _state()
    prompt = user_prompt(_hungry_snapshot(8), [], [], race=state.snapshot(RED_1))
    assert "Hunger is setting in" not in prompt
    assert "Game in sight" not in prompt
    assert "RACE DISCIPLINE" in prompt
    assert "NEVER hunt" in prompt


def test_race_mode_still_screams_at_true_starvation():
    state = _state()
    prompt = user_prompt(_hungry_snapshot(5), [], [], race=state.snapshot(RED_1))
    assert "YOU ARE STARVING" in prompt


def test_peacetime_keeps_hunger_and_animals():
    prompt = user_prompt(_hungry_snapshot(8), [], [], race=None)
    assert "Hunger is setting in" in prompt
    assert "Game in sight" in prompt


def test_user_prompt_carries_the_standing_race_section_and_news_lines():
    state = _state()
    prompt = user_prompt(
        None,
        [
            {"type": "AttemptStarted"},
            {"type": "ProgressionMilestone", "milestone": "first_iron_ore", "teamId": "blue", "by": "Fen", "yourTeam": False},
            {"type": "ProgressionMilestone", "milestone": "first_coal", "teamId": "red", "by": "Bram", "yourTeam": True},
        ],
        [],
        race=state.snapshot(RED_1),
    )
    assert "THE RACE — your team" in prompt
    assert "THE RACE HAS BEGUN" in prompt
    assert "team blue crossed a rung — iron ore mined" in prompt
    assert "YOUR TEAM crossed a rung — coal mined (Bram)" in prompt


# ------------------------------------------------------------- percept fanout


def _now() -> str:
    """Runtime-stamped: the consumer's freshness guard treats hardcoded
    dates as a time bomb (the test_percept_fanout lesson)."""
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


class FakePipeline:
    def __init__(self, store):
        self._store = store
        self._ops = []

    def rpush(self, key, value):
        self._ops.append((key, value))

    def ltrim(self, key, start, stop):
        pass

    def expire(self, key, ttl):
        pass

    async def execute(self):
        for key, value in self._ops:
            self._store.setdefault(key, []).append(value)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


class FakeRedis:
    def __init__(self):
        self.store: dict[str, list[str]] = {}

    def pipeline(self, transaction=True):
        return FakePipeline(self.store)


def _consumer(redis, roster):
    consumer = PerceptConsumer.__new__(PerceptConsumer)
    consumer._redis = redis
    consumer.on_chat_percept = None
    consumer.civics = None
    consumer.race = RaceState()
    consumer.roster = roster
    return consumer


def _envelope(event_type, payload):
    return {
        "eventId": "019fb100-2222-7000-8000-000000000001",
        "eventType": event_type,
        "correlationId": "019fb100-2222-7000-8000-00000000c0de",
        "occurredAt": _now(),
        "payload": payload,
    }


def _percepts(redis, villager_id):
    return [json.loads(raw) for raw in redis.store.get(f"percepts:{villager_id}", [])]


async def test_milestone_fans_out_to_ticked_participants_personalized():
    redis = FakeRedis()
    # Fen (BLUE_3) is deliberately absent from the ticked roster.
    consumer = _consumer(redis, {RED_1: "Elara", RED_2: "Bram", BLUE_1: "Ansel"})
    await consumer.handle(_envelope("AttemptStarted", STARTED))
    await consumer.handle(_envelope("ProgressionMilestone", _milestone("red", "first_coal", RED_2)))

    assert [p["type"] for p in _percepts(redis, RED_1)] == ["AttemptStarted", "ProgressionMilestone"]
    red_view = _percepts(redis, RED_1)[1]
    assert red_view["yourTeam"] is True
    assert red_view["by"] == "Bram"
    blue_view = _percepts(redis, BLUE_1)[1]
    assert blue_view["yourTeam"] is False
    assert _percepts(redis, BLUE_3) == []  # not ticked -> no queue


async def test_attempt_ended_personalizes_before_the_cache_clears():
    redis = FakeRedis()
    consumer = _consumer(redis, {RED_1: "Elara", BLUE_1: "Ansel"})
    await consumer.handle(_envelope("AttemptStarted", STARTED))
    await consumer.handle(
        _envelope(
            "AttemptEnded",
            {"attemptId": ATTEMPT, "outcome": "won", "winningTeamId": "blue", "winningVillagerId": BLUE_3},
        )
    )
    assert _percepts(redis, BLUE_1)[-1]["yourTeam"] is True
    assert _percepts(redis, RED_1)[-1]["yourTeam"] is False
    assert consumer.race.snapshot(RED_1) is None  # and the cache did clear


async def test_non_participants_hear_nothing():
    redis = FakeRedis()
    consumer = _consumer(redis, {"villager-x": "Hollis"})
    await consumer.handle(_envelope("AttemptStarted", STARTED))
    await consumer.handle(_envelope("ProgressionMilestone", _milestone("red", "first_coal")))
    assert _percepts(redis, "villager-x") == []
