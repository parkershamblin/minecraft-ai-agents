"""Boot-time race rehydration: the ledger replays the attempt lifecycle into
RaceState so a restart mid-attempt no longer blinds the fleet (2026-07-22)."""

import json
from datetime import UTC, datetime

import httpx

from agent_service.brain.race import RaceState
from agent_service.brain.race_rehydrate import rehydrate_race

RED_1 = "019f8e2a-0000-7000-8000-0000000e1a2a"
BLUE_1 = "019f8e2a-0000-7000-8000-0000000d0004"
ATTEMPT = "019f8bec-7a74-70cf-a903-4e83fe027da8"
ORPHAN = "019f8b48-9940-703c-9ae0-fd1f5ad93a9d"


def _event(event_type: str, payload: dict) -> dict:
    return {
        "eventType": event_type,
        "occurredAt": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "payload": payload,
    }


def _started(attempt_id: str) -> dict:
    return _event(
        "AttemptStarted",
        {
            "attemptId": attempt_id,
            "teams": [
                {"teamId": "red", "villagerIds": [RED_1]},
                {"teamId": "blue", "villagerIds": [BLUE_1]},
            ],
        },
    )


def _client(pages: list[dict], calls: list[httpx.Request] | None = None) -> httpx.AsyncClient:
    """Serves each page in order; repeats the last page if asked again."""
    served = {"n": 0}

    def respond(request: httpx.Request) -> httpx.Response:
        if calls is not None:
            calls.append(request)
        page = pages[min(served["n"], len(pages) - 1)]
        served["n"] += 1
        return httpx.Response(200, text=json.dumps(page))

    return httpx.AsyncClient(transport=httpx.MockTransport(respond))


async def test_live_attempt_rehydrates_with_milestones():
    race = RaceState()
    pages = [
        {
            "data": [
                _started(ATTEMPT),
                _event("ProgressionMilestone", {"attemptId": ATTEMPT, "teamId": "red", "milestone": "first_coal"}),
            ],
            "nextCursor": None,
        }
    ]

    ok = await rehydrate_race(_client(pages), "http://ledger:8081", race, lambda v: "Elara")

    assert ok is True
    assert race.live_attempt_id == ATTEMPT
    view = race.snapshot(RED_1)
    assert view is not None
    assert view.your_milestones == {"first_coal"}
    assert race.team_of(BLUE_1) == "blue"


async def test_ended_attempt_leaves_no_live_race():
    race = RaceState()
    pages = [
        {
            "data": [
                _started(ATTEMPT),
                _event("AttemptEnded", {"attemptId": ATTEMPT, "outcome": "aborted"}),
            ],
            "nextCursor": None,
        }
    ]

    ok = await rehydrate_race(_client(pages), "http://ledger:8081", race, lambda v: "Elara")

    assert ok is True
    assert race.live_attempt_id is None
    assert race.snapshot(RED_1) is None


async def test_superseded_attempt_yields_the_newest():
    """The ledger replays oldest-first; a later AttemptStarted supersedes the
    earlier one exactly as it does on the live consumer path."""
    race = RaceState()
    pages = [
        {"data": [_started(ORPHAN)], "nextCursor": "page2"},
        {"data": [_started(ATTEMPT)], "nextCursor": None},
    ]

    ok = await rehydrate_race(_client(pages), "http://ledger:8081", race, lambda v: "Elara")

    assert ok is True
    assert race.live_attempt_id == ATTEMPT


async def test_cursor_pagination_carries_the_since_filter():
    calls: list[httpx.Request] = []
    pages = [
        {"data": [_started(ATTEMPT)], "nextCursor": "abc"},
        {"data": [], "nextCursor": None},
    ]

    await rehydrate_race(_client(pages, calls), "http://ledger:8081", RaceState(), lambda v: "Elara")

    assert len(calls) == 2
    assert "cursor=abc" in str(calls[1].url)
    assert "type=AttemptStarted" in str(calls[0].url)
    assert "since=" in str(calls[1].url)


async def test_unreachable_ledger_is_a_warning_not_a_boot_blocker():
    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("boom", request=request)

    http = httpx.AsyncClient(transport=httpx.MockTransport(refuse))
    race = RaceState()

    ok = await rehydrate_race(http, "http://ledger:8081", race, lambda v: "Elara")

    assert ok is False
    assert race.live_attempt_id is None
