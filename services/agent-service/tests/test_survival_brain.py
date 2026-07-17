"""Survival-cluster brain surfaces: the per-verb timeout table, craft/hunt in
the decision contract, hunger/danger/game prompt sections, threat percept
rendering, and the type-keyed hazard directive fix."""

import pytest

from agent_service.brain.graph import TIMEOUT_TABLE_MAX_MS, _TIMEOUT_MS_BY_ACTION, action_timeout_ms
from agent_service.brain.prompts import user_prompt
from agent_service.llm.contract import DELIBERATE_ACTIONS, MalformedDecision, validate_decision

SNAPSHOT_BASE = {
    "villagerId": "019f8e2a-0000-7000-8000-0000000e1a2a",
    "position": {"x": 12, "y": 66, "z": 4},
    "health": 20,
    "food": 18,
    "inventory": [{"item": "oak_log", "count": 3}],
    "nearbyVillagers": [],
    "timeOfDay": 1000,
}


# ------------------------------------------------------------ timeout table


def test_every_verb_fits_under_the_ceiling():
    # The cap is load-bearing: every reflex-lockout safety argument reads
    # "≤ max(per-verb timeout) = 60s". A verb over the cap is a design change.
    for action, timeout in _TIMEOUT_MS_BY_ACTION.items():
        assert timeout <= TIMEOUT_TABLE_MAX_MS, action


def test_gather_gets_the_full_session_budget_and_unknowns_get_the_default():
    assert action_timeout_ms("gather") == 60_000
    assert action_timeout_ms("hunt") == 30_000
    assert action_timeout_ms("craft") == 30_000
    assert action_timeout_ms("never_heard_of_it") == 30_000


def test_every_deliberate_action_has_a_table_row():
    # A new verb without a timeout decision silently inherits the default —
    # make that a loud choice instead.
    for action in DELIBERATE_ACTIONS:
        assert action in _TIMEOUT_MS_BY_ACTION, action


# ------------------------------------------------------- craft/hunt contract


def _decision(action: str, params: dict) -> str:
    import json

    return json.dumps(
        {
            "action": action,
            "params": params,
            "reasoning": "survival first",
            "importance": 5,
            "sentiment": 0,
            "relationshipUpdates": None,
            "governanceAction": None,
        }
    )


def test_craft_decisions_validate_against_the_real_defs():
    decision = validate_decision(_decision("craft", {"item": "wooden_sword"}))
    assert decision.action == "craft"
    assert decision.params == {"item": "wooden_sword"}


def test_craft_off_enum_item_is_malformed():
    with pytest.raises(MalformedDecision):
        validate_decision(_decision("craft", {"item": "diamond_sword"}))


def test_hunt_decisions_validate_and_null_params_strip():
    decision = validate_decision(_decision("hunt", {"animal": "cow", "maxDistance": None}))
    assert decision.action == "hunt"
    assert decision.params == {"animal": "cow"}  # the tolerant-reader seam


def test_hunt_bad_animal_is_malformed():
    with pytest.raises(MalformedDecision):
        validate_decision(_decision("hunt", {"animal": "villager"}))


# ------------------------------------------------------------ prompt sections


def test_hungry_snapshot_renders_the_standing_hunger_pressure():
    prompt = user_prompt({**SNAPSHOT_BASE, "food": 9}, [], [])
    assert "Hunger is setting in (food 9/20)" in prompt
    assert "hunt" in prompt


def test_starving_snapshot_escalates_and_legitimizes_asking():
    prompt = user_prompt({**SNAPSHOT_BASE, "food": 4}, [], [])
    assert "YOU ARE STARVING" in prompt
    assert "asking a neighbor for food in chat" in prompt


def test_well_fed_snapshot_has_no_hunger_section():
    prompt = user_prompt({**SNAPSHOT_BASE, "food": 18}, [], [])
    assert "STARVING" not in prompt
    assert "Hunger is setting in" not in prompt


def test_game_in_sight_renders_and_empty_is_honest():
    seen = user_prompt({**SNAPSHOT_BASE, "nearbyAnimals": [{"family": "cow", "nearestDistance": 21.7, "count": 3}]}, [], [])
    assert "Game in sight (hunt can reach these):" in seen
    assert "- cow: nearest 21.7 blocks away, 3 seen" in seen
    empty = user_prompt({**SNAPSHOT_BASE, "nearbyAnimals": []}, [], [])
    assert "the herds keep to open grass" in empty
    absent = user_prompt(SNAPSHOT_BASE, [], [])
    assert "Game in sight" not in absent


def test_dangers_in_sight_render_with_the_preemption_teaching():
    prompt = user_prompt(
        {**SNAPSHOT_BASE, "nearbyHostiles": [{"type": "zombie", "count": 2, "nearestDistance": 18.5}]},
        [],
        [],
    )
    assert "DANGERS in sight:" in prompt
    assert "- 2 zombies, nearest 18.5 blocks" in prompt
    assert "choices only you can make" in prompt


def test_quiet_night_has_no_dangers_section():
    prompt = user_prompt({**SNAPSHOT_BASE, "nearbyHostiles": []}, [], [])
    assert "DANGERS" not in prompt


# ------------------------------------------------------- threat percept lines


def _threat(phase: str, **over):
    return {
        "type": "ThreatEncountered",
        "threatType": "zombie",
        "phase": phase,
        "response": over.get("response"),
        "count": over.get("count", 1),
        "distance": 9.4,
        "position": {"x": -131, "y": 92, "z": 18},
        "detail": over.get("detail"),
    }


def test_spotted_renders_the_preemption_window():
    prompt = user_prompt(SNAPSHOT_BASE, [_threat("spotted")], [])
    assert "a zombie SPOTTED near (-131, 92, 18)" in prompt
    assert "YOU choose" in prompt


def test_engaged_names_the_bodys_response():
    fleeing = user_prompt(SNAPSHOT_BASE, [_threat("engaged", response="flee")], [])
    assert "your body is fleeing a zombie" in fleeing
    fighting = user_prompt(SNAPSHOT_BASE, [_threat("engaged", response="fight")], [])
    assert "your body is fighting a zombie" in fighting


def test_overwhelmed_is_the_change_the_plan_moment():
    prompt = user_prompt(SNAPSHOT_BASE, [_threat("overwhelmed", response="flee")], [])
    assert "OVERWHELMED" in prompt
    assert "change the plan NOW" in prompt


def test_unknown_threat_phase_is_skipped_not_crashed():
    prompt = user_prompt(SNAPSHOT_BASE, [_threat("vanquished")], [])
    assert "vanquished" not in prompt


# ----------------------------------------------- type-keyed hazard directive


def _hazard(hazard_type: str, phase: str):
    return {
        "type": "HazardEncountered",
        "hazardType": hazard_type,
        "phase": phase,
        "position": {"x": 42, "y": 143, "z": -212},
        "detail": None,
    }


def test_powder_snow_still_gets_the_snow_directive():
    prompt = user_prompt(SNAPSHOT_BASE, [_hazard("powder_snow", "trapped")], [])
    assert "get off the deep snow" in prompt


def test_starvation_gets_the_hunger_directive_not_the_snow_prose():
    # THE SV-7 FIX: the directive used to be type-blind — a starving villager
    # would have been told to get off the deep snow.
    prompt = user_prompt(SNAPSHOT_BASE, [_hazard("starvation", "trapped")], [])
    assert "you are STARVING with nothing edible in your pack" in prompt
    assert "Hunger has you hollowed out" in prompt
    assert "get off the deep snow" not in prompt


def test_starvation_recovery_renders_relief():
    prompt = user_prompt(SNAPSHOT_BASE, [_hazard("starvation", "escaped")], [])
    assert "you finally ate" in prompt


def test_unknown_hazard_type_gets_the_generic_survival_weight():
    prompt = user_prompt(SNAPSHOT_BASE, [_hazard("lava", "trapped")], [])
    assert "Something here endangers you" in prompt
    assert "get off the deep snow" not in prompt
