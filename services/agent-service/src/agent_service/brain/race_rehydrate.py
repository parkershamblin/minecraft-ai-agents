"""Boot-time race rehydration (RB-2 hardening, 2026-07-22).

RaceState is in-memory and its Kafka offsets are committed, so a restart
mid-attempt used to forget the race forever: the attempt kept running in the
world and the ledger while every prompt went quiet — the fleet looked alive
and never progressed (the zero-milestone evening of 2026-07-22, compounded by
the percept consumer's silent death). The ledger already holds the truth, so
a booting brain asks it once: replay the recent attempt lifecycle events, in
occurredAt order, into the same RaceState observers the live consumer feeds.

Deliberately bounded: only attempts STARTED within the window can survive
rehydration (an AttemptStarted older than the window was either ended — its
AttemptEnded clears it during replay — or is an orphan whose resurrection
would haunt every prompt; see the 019f8b48 incident). Failure to reach the
ledger is a warning, never a boot blocker — a race-less boot is the old
behavior, not a new failure mode.
"""

from datetime import UTC, datetime, timedelta
from typing import Any, Callable

import httpx

from agent_service.logging import logger

_RACE_TYPES = "AttemptStarted", "ProgressionMilestone", "AttemptEnded"
_PAGE_LIMIT = 100  # the ledger's hard cap per page
_MAX_PAGES = 50  # backstop: a race window is thousands of events, not millions


async def rehydrate_race(
    http: httpx.AsyncClient,
    event_service_url: str,
    race: Any,  # RaceState-shaped: attempt_started, milestone, attempt_ended
    name_of: Callable[[str], str],
    window_hours: float = 6.0,
) -> bool:
    """Replay recent attempt events from the ledger into `race`.

    Returns True when replay ran (even if it found nothing), False when the
    ledger was unreachable or answered malformed — callers only log; the boot
    proceeds either way.
    """
    base = event_service_url.rstrip("/")
    since = (datetime.now(UTC) - timedelta(hours=window_hours)).isoformat().replace("+00:00", "Z")
    params: dict[str, Any] = {
        "type": list(_RACE_TYPES),
        "since": since,
        "limit": _PAGE_LIMIT,
    }
    replayed = 0
    try:
        for _ in range(_MAX_PAGES):
            response = await http.get(f"{base}/events", params=params, timeout=5.0)
            response.raise_for_status()
            page = response.json()
            for event in page.get("data", []):
                event_type = event.get("eventType")
                payload = event.get("payload") or {}
                if event_type == "AttemptStarted":
                    race.attempt_started(payload, name_of)
                elif event_type == "ProgressionMilestone":
                    race.milestone(payload)
                elif event_type == "AttemptEnded":
                    race.attempt_ended(payload)
                else:
                    continue
                replayed += 1
            cursor = page.get("nextCursor")
            if not cursor:
                break
            params = {**params, "cursor": cursor}
        else:
            logger.warning("race rehydration hit the page backstop", pages=_MAX_PAGES)
    except (httpx.HTTPError, ValueError) as exc:
        logger.warning("race rehydration skipped — ledger unreachable", error=repr(exc))
        return False
    logger.info(
        "race rehydrated from ledger",
        events_replayed=replayed,
        live_attempt=getattr(race, "live_attempt_id", None),
        window_hours=window_hours,
    )
    return True
