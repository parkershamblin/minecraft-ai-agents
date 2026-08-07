"""D1 — event-driven vs wall-clock deliberation, A/B metrics from the ledger.

Reads arms.json (two windows: armA wall-clock tick30/wakes-off, armB
event-driven tick300/wakes-on), queries the event-service ledger
(GET /events, cursor-paged, ALWAYS oldest-first — `since`/`until` do the
windowing), and writes metrics.json.

Metrics per arm:
  llm_calls_per_min   DecisionMade count / window minutes (every DecisionMade
                      is one completed LLM call; FakeProvider excluded by the
                      100M Ollama budget — no breaker flip possible in-window)
  noop_fraction       fraction of decisions whose verb == idle
  verb_histogram      decision verb counts
  outcome_reaction    for each substantive outcome event (same predicate the
                      wake uses), seconds until that villager's NEXT
                      DecisionMade; censored at window end (dropped + counted)

Plumbing split imported live from awareness.py. The wake predicate constants
are copied from agent_service/kafka/percepts.py (_wakes_deliberation) because
importing percepts pulls aiokafka into a plain script; keep in sync.
"""

from __future__ import annotations

import json
import statistics
import sys
import urllib.parse
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
LEDGER = "http://localhost:8081/events"

sys.path.insert(0, str(REPO / "services" / "agent-service" / "src"))
from agent_service.brain.awareness import _PLUMBING_CODES  # noqa: E402

# Mirror of percepts._wakes_deliberation (see module docstring).
_WAKE_COMPLETED_ACTIONS = {"gather", "craft", "hunt", "move", "follow"}
_TYPES = ["DecisionMade", "ActionCompleted", "ActionFailed"]


def _wakes(event_type: str, payload: dict) -> bool:
    if event_type == "ActionFailed":
        return str(payload.get("errorCode")) not in _PLUMBING_CODES
    if event_type == "ActionCompleted":
        return str(payload.get("action")) in _WAKE_COMPLETED_ACTIONS
    return False


def fetch(since: str, until: str) -> list[dict]:
    events, cursor = [], None
    while True:
        params = [("type", t) for t in _TYPES] + [
            ("since", since), ("until", until), ("limit", "500")]
        if cursor:
            params.append(("cursor", cursor))
        url = LEDGER + "?" + urllib.parse.urlencode(params)
        with urllib.request.urlopen(url, timeout=30) as r:
            page = json.load(r)
        data = page.get("data") or page.get("items") or []
        events.extend(data)
        cursor = page.get("nextCursor") or page.get("next_cursor")
        if not cursor or not data:
            return events


def _villager(e: dict) -> str | None:
    p = e.get("payload") or {}
    return p.get("villagerId") or e.get("aggregateId")


def _ts(e: dict) -> str:
    return e.get("occurredAt") or ""


def _verb(decision: str) -> str:
    return (decision or "").strip().split(" ", 1)[0] or "?"


def arm_metrics(events: list[dict], minutes: float) -> dict:
    events = sorted(events, key=_ts)
    decisions = [e for e in events if e.get("eventType") == "DecisionMade"]
    verbs: dict[str, int] = {}
    for d in decisions:
        v = _verb((d.get("payload") or {}).get("decision") or "")
        verbs[v] = verbs.get(v, 0) + 1

    # Reaction latency: substantive outcome -> that villager's next decision.
    from datetime import datetime

    def t(e):
        return datetime.fromisoformat(_ts(e).replace("Z", "+00:00"))

    lat, censored = [], 0
    for i, e in enumerate(events):
        et = e.get("eventType")
        if et not in ("ActionCompleted", "ActionFailed"):
            continue
        if not _wakes(et, e.get("payload") or {}):
            continue
        v = _villager(e)
        nxt = next((x for x in events[i + 1:]
                    if x.get("eventType") == "DecisionMade"
                    and _villager(x) == v), None)
        if nxt is None:
            censored += 1
        else:
            lat.append((t(nxt) - t(e)).total_seconds())

    n = len(decisions)
    return {
        "events_total": len(events),
        "decisions": n,
        "llm_calls_per_min": round(n / minutes, 2) if minutes else None,
        "noop_fraction": round(verbs.get("idle", 0) / n, 4) if n else None,
        "verb_histogram": dict(sorted(verbs.items(), key=lambda kv: -kv[1])),
        "outcome_events_substantive": len(lat) + censored,
        "reaction_latency_s": {
            "n": len(lat),
            "censored_at_window_end": censored,
            "median": round(statistics.median(lat), 1) if lat else None,
            "p90": round(statistics.quantiles(lat, n=10)[8], 1) if len(lat) >= 10 else None,
            "mean": round(statistics.fmean(lat), 1) if lat else None,
        },
    }


def main() -> None:
    arms = json.loads((HERE / "arms.json").read_text())
    out = {"arms": {}}
    for name, w in arms.items():
        from datetime import datetime

        t0 = datetime.fromisoformat(w["since"].replace("Z", "+00:00"))
        t1 = datetime.fromisoformat(w["until"].replace("Z", "+00:00"))
        minutes = (t1 - t0).total_seconds() / 60
        ev = fetch(w["since"], w["until"])
        m = arm_metrics(ev, minutes)
        m["window"] = {**w, "minutes": round(minutes, 1)}
        out["arms"][name] = m
    a, b = out["arms"].get("armA"), out["arms"].get("armB")
    if a and b and a["llm_calls_per_min"] and b["llm_calls_per_min"]:
        out["calls_reduction_factor"] = round(
            a["llm_calls_per_min"] / b["llm_calls_per_min"], 2)
    (HERE / "metrics.json").write_text(json.dumps(out, indent=2))
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
