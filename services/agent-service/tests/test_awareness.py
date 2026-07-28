"""Failure-streak ledger (abandon-and-repropose): consecutive substantive
refusals of the same intent surface at the threshold; plumbing failures,
successes, and time all clear them."""

import uuid

from agent_service.brain.awareness import _STREAK_TTL_TICKS, ActionAwareness

VILLAGER = uuid.uuid4()


def failed(action: str, error_code: str = "TIMEOUT") -> dict:
    return {"type": "ActionFailed", "action": action, "detail": {"errorCode": error_code, "errorMessage": "x"}}


def completed(action: str) -> dict:
    return {"type": "ActionCompleted", "action": action, "detail": {"collected": 1}}


def test_streak_surfaces_at_the_abandon_threshold():
    a = ActionAwareness(abandon_after=3)
    a.remember(VILLAGER, "gather", {"resource": "iron_ore", "count": 3})
    assert a.note_outcomes(VILLAGER, [failed("gather")]) == []
    # A different count is the SAME ask — the streak keys on the resource.
    a.remember(VILLAGER, "gather", {"resource": "iron_ore", "count": 8})
    assert a.note_outcomes(VILLAGER, [failed("gather")]) == []
    a.remember(VILLAGER, "gather", {"resource": "iron_ore"})
    hot = a.note_outcomes(VILLAGER, [failed("gather")])
    assert len(hot) == 1
    assert hot[0].intent == "gather iron_ore"
    assert hot[0].count == 3


def test_streak_stays_hot_on_a_tick_with_no_new_outcome():
    a = ActionAwareness(abandon_after=2)
    for _ in range(2):
        a.remember(VILLAGER, "craft", {"item": "iron_pickaxe"})
        a.note_outcomes(VILLAGER, [failed("craft", "TOOL_REQUIRED")])
    # Trip still underway next tick: no outcome percept, advice must persist.
    assert a.note_outcomes(VILLAGER, []) != []


def test_plumbing_failures_never_count():
    a = ActionAwareness(abandon_after=1)
    for code in ("SUPERSEDED", "STALE_COMMAND", "BODY_BUSY", "BOT_DISCONNECTED"):
        a.remember(VILLAGER, "gather", {"resource": "coal"})
        assert a.note_outcomes(VILLAGER, [failed("gather", code)]) == []


def test_success_clears_the_streak():
    a = ActionAwareness(abandon_after=2)
    for _ in range(2):
        a.remember(VILLAGER, "gather", {"resource": "iron_ore"})
        a.note_outcomes(VILLAGER, [failed("gather")])
    a.remember(VILLAGER, "gather", {"resource": "iron_ore"})
    assert a.note_outcomes(VILLAGER, [completed("gather")]) == []
    assert a.note_outcomes(VILLAGER, []) == []


def test_streak_expires_after_idle_ticks():
    a = ActionAwareness(abandon_after=2)
    for _ in range(2):
        a.remember(VILLAGER, "move", {"to": {"x": -203.5, "y": 65, "z": -200}})
        a.note_outcomes(VILLAGER, [failed("move", "PATH_NOT_FOUND")])
    assert a.note_outcomes(VILLAGER, []) != []
    for _ in range(_STREAK_TTL_TICKS):
        a.note_outcomes(VILLAGER, [])  # quiet ticks — no new refusal
    assert a.note_outcomes(VILLAGER, []) == []


def test_move_streak_keys_on_rounded_target():
    a = ActionAwareness(abandon_after=2)
    a.remember(VILLAGER, "move", {"to": {"x": -203.5, "y": 65, "z": -200}})
    a.note_outcomes(VILLAGER, [failed("move", "PATH_NOT_FOUND")])
    # Half-block jitter in the hallucination is still the same doomed spot.
    a.remember(VILLAGER, "move", {"to": {"x": -204.4, "y": 64, "z": -200.2}})
    hot = a.note_outcomes(VILLAGER, [failed("move", "PATH_NOT_FOUND")])
    assert len(hot) == 1
    assert hot[0].intent == "move to (-204, -200)"


def test_forget_clears_streaks_too():
    a = ActionAwareness(abandon_after=1)
    a.remember(VILLAGER, "gather", {"resource": "iron_ore"})
    assert a.note_outcomes(VILLAGER, [failed("gather")]) != []
    a.forget(VILLAGER)
    assert a.note_outcomes(VILLAGER, []) == []
