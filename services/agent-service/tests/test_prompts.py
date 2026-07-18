import uuid
from datetime import UTC, datetime

from agent_service.brain.awareness import LastDecision
from agent_service.brain.prompts import system_prompt, user_prompt
from agent_service.villagers.relationships import RelationshipEdge

BRAM_ID = "019f8e2a-0000-7000-8000-0000000b2a44"
WREN_ID = "019f8e2a-0000-7000-8000-0000000c3e55"


def _snapshot(*nearby):
    return {
        "position": {"x": 1, "y": 64, "z": 2},
        "health": 20,
        "food": 18,
        "timeOfDay": 1000,
        "inventory": [],
        "nearbyVillagers": list(nearby),
    }


def _edge(target_id, affinity, trust, last_reason):
    return RelationshipEdge(
        target_id=uuid.UUID(target_id),
        affinity=affinity,
        trust=trust,
        interaction_count=4,
        last_reason=last_reason,
        last_reason_at=datetime.now(UTC),
        last_interaction_at=datetime.now(UTC),
        updated_at=datetime.now(UTC),
    )


def test_system_prompt_carries_the_persona():
    prompt = system_prompt(
        "Elara",
        {"traits": ["warm", "nosy"], "values": ["community"], "speechStyle": "friendly and direct"},
        "Raised by the miller.",
    )
    assert "You are Elara" in prompt
    assert "warm, nosy" in prompt
    assert "friendly and direct" in prompt
    assert "Raised by the miller." in prompt
    assert "ONE next action" in prompt


def test_user_prompt_renders_snapshot_percepts_and_memories():
    snapshot = {
        "position": {"x": 1, "y": 64, "z": 2},
        "health": 20,
        "food": 18,
        "timeOfDay": 1000,
        "inventory": [{"item": "bread", "count": 3}],
        "nearbyVillagers": [{"villagerId": "abc", "name": "Bram", "distance": 5.0}],
    }
    percepts = [{"type": "ActionFailed", "action": "move", "detail": {"errorCode": "TIMEOUT"}}]
    prompt = user_prompt(snapshot, percepts, [])
    assert "Bram" in prompt
    assert "3 bread" in prompt
    assert "FAILED" in prompt and "TIMEOUT" in prompt
    assert prompt.endswith("What do you do next?")


def test_blind_prompt_when_no_snapshot():
    prompt = user_prompt(None, [], [])
    assert "cannot sense the world" in prompt


def test_no_feelings_section_when_seam_off():
    # feelings=None (default) — old callers / read seam not wired: no section.
    prompt = user_prompt(_snapshot({"villagerId": BRAM_ID, "name": "Bram", "distance": 5.0}), [], [])
    assert "How you feel" not in prompt


def test_feelings_render_affinity_trust_and_reason():
    snapshot = _snapshot({"villagerId": BRAM_ID, "name": "Bram", "distance": 5.0})
    feelings = {BRAM_ID: _edge(BRAM_ID, 11, 56, 'heard Bram say: "the pantry is bare again"')}
    prompt = user_prompt(snapshot, [], [], feelings)
    assert "How you feel about those nearby:" in prompt
    assert '- Bram (affinity +11, trust 56 — heard Bram say: "the pantry is bare again")' in prompt


def test_feelings_signed_negative_affinity():
    snapshot = _snapshot({"villagerId": BRAM_ID, "name": "Bram", "distance": 5.0})
    feelings = {BRAM_ID: _edge(BRAM_ID, -7, 40, None)}
    prompt = user_prompt(snapshot, [], [], feelings)
    # no last_reason -> no em-dash clause; affinity keeps its sign
    assert "- Bram (affinity -7, trust 40)" in prompt


def test_feelings_neutral_for_villager_without_edge():
    # Bram has an edge; Wren is in sight but no edge yet -> neutral line.
    snapshot = _snapshot(
        {"villagerId": BRAM_ID, "name": "Bram", "distance": 5.0},
        {"villagerId": WREN_ID, "name": "Wren", "distance": 9.0},
    )
    feelings = {BRAM_ID: _edge(BRAM_ID, 20, 60, "shared bread")}
    prompt = user_prompt(snapshot, [], [], feelings)
    assert "- Bram (affinity +20, trust 60 — shared bread)" in prompt
    assert "- Wren: no strong feelings yet" in prompt


def test_feelings_section_absent_when_nobody_nearby():
    # seam wired (feelings={}) but nobody in sight -> no section, no crash.
    prompt = user_prompt(_snapshot(), [], [], {})
    assert "How you feel" not in prompt


def test_grudge_directive_renders_when_grudge_in_sight():
    snapshot = _snapshot({"villagerId": BRAM_ID, "name": "Bram", "distance": 5.0})
    feelings = {BRAM_ID: _edge(BRAM_ID, -20, 30, "he spread lies")}  # -20 IS a grudge (boundary)
    prompt = user_prompt(snapshot, [], [], feelings)
    assert "You hold a grudge against someone here." in prompt
    assert "do not perform warmth you do not feel" in prompt


def test_no_grudge_directive_above_threshold():
    snapshot = _snapshot({"villagerId": BRAM_ID, "name": "Bram", "distance": 5.0})
    feelings = {BRAM_ID: _edge(BRAM_ID, -19, 30, "chilly words")}
    prompt = user_prompt(snapshot, [], [], feelings)
    assert "You hold a grudge" not in prompt


def test_grudge_directive_ignores_edges_for_absent_villagers():
    # A grudge toward someone who is NOT in sight must not fire the directive —
    # it keys off who is actually here, not every edge the dict happens to hold.
    snapshot = _snapshot({"villagerId": WREN_ID, "name": "Wren", "distance": 9.0})
    feelings = {
        WREN_ID: _edge(WREN_ID, 12, 55, None),
        BRAM_ID: _edge(BRAM_ID, -40, 10, "he spread lies"),  # absent villager
    }
    prompt = user_prompt(snapshot, [], [], feelings)
    assert "You hold a grudge" not in prompt


def test_system_prompt_renders_quirks_and_material_work():
    prompt = system_prompt(
        "Elara",
        {"traits": ["warm"], "values": ["community"], "speechStyle": "friendly", "quirks": ["hums while working", "counts jars twice"]},
        None,
    )
    assert "Quirks: hums while working; counts jars twice." in prompt
    # the M2-3 rebalance: material action is named as legitimate
    assert "material work" in prompt
    assert "social actions over grand plans" not in prompt


def test_system_prompt_omits_quirks_line_when_none():
    prompt = system_prompt("Elara", {"traits": ["warm"]}, None)
    assert "Quirks:" not in prompt


def test_system_prompt_teaches_the_guard_arc_body_autonomy():
    # PR 3 of the guard arc — the brain may only advertise what the body
    # ships (armor reflex, guard tether, iron_sword in the craft enum).
    prompt = system_prompt("Elara", {"traits": ["warm"]}, None)
    assert "wears any armor you carry" in prompt
    assert "walks back to their post" in prompt
    assert "iron_sword" in prompt


def test_resources_in_sight_render_from_snapshot():
    snapshot = _snapshot()
    snapshot["nearbyResources"] = [
        {"family": "wood", "nearestDistance": 33.7, "count": 25},
        {"family": "dirt", "nearestDistance": 1.2, "count": 32},
    ]
    prompt = user_prompt(snapshot, [], [])
    assert "Resources in sight (gather can reach these):" in prompt
    assert "- wood: nearest 33.7 blocks away, 25 seen" in prompt
    assert "- dirt: nearest 1.2 blocks away, 32 seen" in prompt


def test_resources_scanned_empty_says_so_and_points_at_moving():
    snapshot = _snapshot()
    snapshot["nearbyResources"] = []
    prompt = user_prompt(snapshot, [], [])
    assert "Resources in sight: none" in prompt
    assert "Moving somewhere new" in prompt


def test_no_resources_section_when_field_absent():
    # pre-M2-2 snapshot / scan disabled -> the section simply doesn't exist
    prompt = user_prompt(_snapshot(), [], [])
    assert "Resources in sight" not in prompt


def test_last_decision_pairs_with_its_outcome_percept_and_claims_it():
    percepts = [
        {"type": "ActionFailed", "action": "gather", "detail": {"errorCode": "RESOURCE_NOT_FOUND"}},
        {"type": "ActionCompleted", "action": "move", "detail": {"blocksTraveled": 4}},
    ]
    prompt = user_prompt(_snapshot(), percepts, [], last_decision=LastDecision("gather", {"resource": "wood"}))
    assert 'Your last decision: gather {"resource": "wood"} → it FAILED: {"errorCode": "RESOURCE_NOT_FOUND"}' in prompt
    # the claimed percept must not ALSO render under "Since your last turn"
    assert prompt.count("RESOURCE_NOT_FOUND") == 1
    # the unclaimed one still does
    assert "your 'move' completed" in prompt


def test_last_decision_without_outcome_is_honest():
    prompt = user_prompt(_snapshot(), [], [], last_decision=LastDecision("move", {}))
    assert "Your last decision: move → outcome not observed yet" in prompt


def test_no_last_decision_section_by_default():
    prompt = user_prompt(_snapshot(), [], [])
    assert "Your last decision" not in prompt


# ------------------------------------------------------------------- hazards


def _hazard(phase, detail=None):
    return {
        "type": "HazardEncountered",
        "hazardType": "powder_snow",
        "phase": phase,
        "position": {"x": 42.3, "y": 143.0, "z": -212.6},
        "detail": detail,
    }


def test_trapped_hazard_renders_urgent_with_rounded_position():
    prompt = user_prompt(_snapshot(), [_hazard("trapped")], [])
    assert "Since your last turn:" in prompt
    assert "- you are SUNK in powder snow at (42, 143, -213), freezing and barely able to move" in prompt


def test_escaped_hazard_renders_with_detail_woven_in():
    prompt = user_prompt(
        _snapshot(), [_hazard("escaped", detail="dug free through 3 blocks after ~40s trapped")], []
    )
    assert (
        "- you dug free of the powder snow at (42, 143, -213) "
        "— dug free through 3 blocks after ~40s trapped" in prompt
    )


def test_escape_failed_hazard_renders_still_trapped():
    prompt = user_prompt(_snapshot(), [_hazard("escape_failed")], [])
    assert "- you fought the powder snow at (42, 143, -213) and are still trapped" in prompt


def test_survival_directive_renders_once_iff_hazard_present():
    """One directive block per tick, modeled on the grudge directive — and
    never when the queue holds no hazard."""
    calm = user_prompt(_snapshot(), [{"type": "ActionCompleted", "action": "move", "detail": {}}], [])
    assert "Weigh survival" not in calm

    doubled = user_prompt(_snapshot(), [_hazard("escape_failed"), _hazard("escaped")], [])
    assert doubled.count("Weigh survival in this decision") == 1
    assert "do not linger where you sink" in doubled


# ---------------------------------------------------------------- M2-8 civic

from datetime import timedelta  # noqa: E402

from agent_service.brain.civics import (  # noqa: E402
    CandidateEntry,
    CivicView,
    ElectionCampaign,
    Mayor,
)

ELECTION_ID = "019f8e2a-0000-7000-8000-0000e1ec0001"
T0 = datetime(2026, 7, 9, 12, 0, 0, tzinfo=UTC)


def _campaign(*candidates):
    return ElectionCampaign(
        election_id=ELECTION_ID,
        office="mayor",
        starts_at=T0,
        nominating_ends_at=T0 + timedelta(minutes=10),
        ends_at=T0 + timedelta(minutes=25),
        candidates=tuple(candidates),
    )


BRAM_CANDIDATE = CandidateEntry(BRAM_ID, "Bram", "Grain tallies posted at dawn.")
WREN_CANDIDATE = CandidateEntry(WREN_ID, "Wren", None)


def test_voting_section_uses_the_proven_affordance_shape():
    """The M2-7 smoke's 0/4 -> 4/4 wording is load-bearing: stakes named,
    deadline named, no polite out, and the vote rides along."""
    prompt = user_prompt(None, [], [], civic=CivicView(
        campaign=_campaign(BRAM_CANDIDATE, WREN_CANDIDATE),
        phase="voting", you_declared=False, you_voted=False, mayor=None,
    ))
    assert "VILLAGE AFFAIRS" in prompt
    assert "a vote not cast is a voice lost" in prompt
    assert "rides along with whatever else you do this turn" in prompt
    assert f'electionId "{ELECTION_ID}"' in prompt
    assert f"Bram (candidateVillagerId {BRAM_ID})" in prompt
    assert '"Grain tallies posted at dawn."' in prompt
    assert f"Wren (candidateVillagerId {WREN_ID})" in prompt  # platform-less renders too
    assert "declare_candidacy" not in prompt  # wrong window's affordance never leaks


def test_voting_section_suppresses_the_affordance_after_voting():
    prompt = user_prompt(None, [], [], civic=CivicView(
        campaign=_campaign(BRAM_CANDIDATE),
        phase="voting", you_declared=False, you_voted=True, mayor=None,
    ))
    assert "You have cast your vote" in prompt
    assert "governanceAction" not in prompt  # no ALREADY_VOTED spam invitation


def test_nominating_section_offers_candidacy_until_declared():
    open_prompt = user_prompt(None, [], [], civic=CivicView(
        campaign=_campaign(), phase="nominating",
        you_declared=False, you_voted=False, mayor=None,
    ))
    assert "no one has stepped forward yet" in open_prompt
    assert 'action "declare_candidacy"' in open_prompt
    assert "a candidacy not declared is a chance lost" in open_prompt

    declared_prompt = user_prompt(None, [], [], civic=CivicView(
        campaign=_campaign(BRAM_CANDIDATE), phase="nominating",
        you_declared=True, you_voted=False, mayor=None,
    ))
    assert "Your name is already on the ballot" in declared_prompt
    assert "governanceAction" not in declared_prompt


def test_mayor_line_stands_after_the_campaign():
    prompt = user_prompt(None, [], [], civic=CivicView(
        campaign=None, phase=None, you_declared=False, you_voted=False,
        mayor=Mayor(BRAM_ID, "Bram"),
    ))
    assert "The village mayor is Bram." in prompt
    assert "VILLAGE AFFAIRS" not in prompt  # no campaign, no drumroll

    own_prompt = user_prompt(None, [], [], civic=CivicView(
        campaign=None, phase=None, you_declared=False, you_voted=False,
        mayor=Mayor(BRAM_ID, "Bram"), you_are_mayor=True,
    ))
    assert "You are the mayor of the village." in own_prompt


def test_no_civic_section_by_default():
    assert "VILLAGE AFFAIRS" not in user_prompt(None, [], [])
    assert "mayor" not in user_prompt(None, [], [])


def test_civic_news_renderers_and_the_mixed_queue():
    """New percept types render as village news; unknown types are still
    skipped (the queue outlives any single deploy's vocabulary)."""
    percepts = [
        {"type": "ElectionStarted", "office": "mayor"},
        {"type": "CandidateNominated", "candidateName": "Bram",
         "platform": "Honest tallies.", "you": False},
        {"type": "CandidateNominated", "you": True},
        {"type": "ElectionDecided", "winnerName": "Bram", "you": False},
        {"type": "GovernanceRejected", "action": "vote",
         "message": "you already voted in this election"},
        {"type": "SomeFuturePerceptType", "payload": "whatever"},
        {"type": "ChatObserved", "speakerName": "Wren", "message": "did you vote yet?"},
    ]
    prompt = user_prompt(None, percepts, [])
    assert "Village news since your last turn:" in prompt
    assert "an election for mayor has been called" in prompt
    assert 'Bram declared candidacy: "Honest tallies."' in prompt
    assert "your candidacy is registered" in prompt
    assert "Bram is the new mayor" in prompt
    assert "your vote was refused: you already voted" in prompt
    assert "SomeFuturePerceptType" not in prompt  # mixed-queue regression
    assert 'Wren said: "did you vote yet?"' in prompt  # chat still renders


def test_you_won_percept_is_second_person():
    prompt = user_prompt(None, [{"type": "ElectionDecided", "winnerName": "Elara", "you": True}], [])
    assert "YOU have been elected mayor" in prompt


def test_community_goal_line_is_off_by_default_and_on_when_set():
    base = system_prompt("Elara", {"traits": ["warm"]}, None)
    assert "shared aim" not in base

    steered = system_prompt(
        "Elara", {"traits": ["warm"]}, None,
        community_goal="the village needs a proper granary before winter",
    )
    assert steered.startswith(base)  # additive: one line, nothing else moves
    assert "one shared aim: the village needs a proper granary before winter" in steered
