"""D1 outcome-wake predicate: substantive outcomes wake deliberation,
plumbing never does (SUPERSEDED alone floods ~13/run at v7)."""

from agent_service.kafka.percepts import _wakes_deliberation


def test_substantive_failure_wakes():
    assert _wakes_deliberation("ActionFailed", {"errorCode": "RESOURCE_NOT_FOUND"})
    assert _wakes_deliberation("ActionFailed", {"errorCode": "TIMEOUT"})


def test_plumbing_failure_never_wakes():
    for code in ("SUPERSEDED", "STALE_COMMAND", "BODY_BUSY", "BOT_DISCONNECTED"):
        assert not _wakes_deliberation("ActionFailed", {"errorCode": code})


def test_material_completion_wakes_idle_does_not():
    assert _wakes_deliberation("ActionCompleted", {"action": "gather"})
    assert not _wakes_deliberation("ActionCompleted", {"action": "idle"})
    assert not _wakes_deliberation("ActionCompleted", {"action": "chat"})


def test_other_event_types_never_wake():
    assert not _wakes_deliberation("VillagerMoved", {})
