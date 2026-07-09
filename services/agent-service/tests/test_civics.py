"""M2-8: the civic working memory — content-gated ingestion, per-villager
views, and the forget rules (decided -> mayor line; silence -> annulled)."""

from datetime import UTC, datetime, timedelta

import agent_service.brain.civics as civics_module
from agent_service.brain.civics import CivicState

ELARA = "019f8e2a-0000-7000-8000-0000000e1a2a"
BRAM = "019f8e2a-0000-7000-8000-0000000b2a44"
ELECTION = "019f8e2a-0000-7000-8000-0000e1ec0001"

T0 = datetime(2026, 7, 9, 12, 0, 0, tzinfo=UTC)


def _iso(dt: datetime) -> str:
    return dt.isoformat().replace("+00:00", "Z")


def started_payload(starts=T0, nominating_ends=None, ends=None, election_id=ELECTION):
    return {
        "electionId": election_id,
        "office": "mayor",
        "startsAt": _iso(starts),
        "nominatingEndsAt": _iso(nominating_ends or starts + timedelta(minutes=10)),
        "endsAt": _iso(ends or starts + timedelta(minutes=25)),
    }


def at(monkeypatch, now: datetime) -> None:
    monkeypatch.setattr(civics_module, "_now", lambda: now)


def test_empty_state_renders_nothing():
    assert CivicState().snapshot(ELARA) is None


def test_phases_follow_the_content_clock(monkeypatch):
    state = CivicState()
    at(monkeypatch, T0 - timedelta(minutes=1))
    state.election_started(started_payload())

    assert state.snapshot(ELARA).phase == "scheduled"
    at(monkeypatch, T0)  # inclusive boundary, like the server's state machine
    assert state.snapshot(ELARA).phase == "nominating"
    at(monkeypatch, T0 + timedelta(minutes=10))
    assert state.snapshot(ELARA).phase == "voting"


def test_expired_election_news_is_ignored(monkeypatch):
    state = CivicState()
    at(monkeypatch, T0 + timedelta(hours=2))  # delivered long after it ended
    state.election_started(started_payload())
    assert state.snapshot(ELARA) is None


def test_late_delivery_of_a_live_election_is_accepted(monkeypatch):
    """Content gating: 20 minutes late, but voting still runs — live news."""
    state = CivicState()
    at(monkeypatch, T0 + timedelta(minutes=20))
    state.election_started(started_payload())
    view = state.snapshot(ELARA)
    assert view is not None and view.phase == "voting"


def test_candidates_accumulate_idempotently(monkeypatch):
    state = CivicState()
    at(monkeypatch, T0 + timedelta(minutes=1))
    state.election_started(started_payload())

    nomination = {"electionId": ELECTION, "villagerId": BRAM, "platform": "Honest tallies."}
    state.candidate_nominated(nomination, "Bram")
    state.candidate_nominated(nomination, "Bram")  # redelivery
    state.candidate_nominated(  # some other election's candidate — not ours
        {"electionId": "019f8e2a-0000-7000-8000-0000e1ec0999", "villagerId": ELARA}, "Elara"
    )

    view = state.snapshot(ELARA)
    assert [c.name for c in view.campaign.candidates] == ["Bram"]
    assert view.campaign.candidates[0].platform == "Honest tallies."
    assert state.snapshot(BRAM).you_declared is True
    assert view.you_declared is False


def test_votes_suppress_the_affordance_for_the_voter_only(monkeypatch):
    state = CivicState()
    at(monkeypatch, T0 + timedelta(minutes=12))
    state.election_started(started_payload())
    state.vote_cast({"electionId": ELECTION, "voterId": ELARA})
    state.vote_cast({"electionId": "other", "voterId": BRAM})  # not our election

    assert state.snapshot(ELARA).you_voted is True
    assert state.snapshot(BRAM).you_voted is False


def test_decided_seats_the_mayor_and_ends_the_campaign(monkeypatch):
    state = CivicState()
    at(monkeypatch, T0 + timedelta(minutes=1))
    state.election_started(started_payload())
    state.election_decided({"electionId": ELECTION, "winnerVillagerId": BRAM}, "Bram")

    view = state.snapshot(ELARA)
    assert view.campaign is None  # the arc is over
    assert view.mayor.name == "Bram"
    assert view.you_are_mayor is False
    assert state.snapshot(BRAM).you_are_mayor is True


def test_decided_without_a_known_campaign_still_seats_the_mayor(monkeypatch):
    """A restart may have forgotten the election; the standing line survives."""
    state = CivicState()
    at(monkeypatch, T0)
    state.election_decided({"electionId": ELECTION, "winnerVillagerId": BRAM}, "Bram")
    assert state.snapshot(ELARA).mayor.name == "Bram"


def test_undecided_elections_are_forgotten_after_the_grace(monkeypatch):
    """No ElectionAnnulled event exists — silence past ends_at + grace IS the
    annulment, and the section disappears instead of nagging forever."""
    state = CivicState()
    at(monkeypatch, T0 + timedelta(minutes=1))
    state.election_started(started_payload())

    at(monkeypatch, T0 + timedelta(minutes=26))  # closed, within grace
    assert state.snapshot(ELARA) is None  # nothing renders while we wait

    at(monkeypatch, T0 + timedelta(minutes=31))  # beyond grace
    assert state.snapshot(ELARA) is None
    assert state._campaign is None  # actually forgotten, not just hidden


def test_malformed_news_never_crashes():
    state = CivicState()
    state.election_started({"electionId": ELECTION})  # missing boundaries
    state.election_started({"electionId": ELECTION, "startsAt": "not-a-date",
                            "nominatingEndsAt": "x", "endsAt": "y"})
    assert state.snapshot(ELARA) is None
