"""RB-race metric extractor — the Phase 1 substrate for the model-comparison
table (docs/benchmark-rb.md, GovSim-style).

Two metric tiers over an attempt's ledger events:

  * Tier A (attempt slice: AttemptStarted / ProgressionMilestone /
    AttemptEnded) — deterministic, golden-tested against
    film/flagship-slice.json: winner, time-to-goal, per-rung ladder offsets
    per team, first-to-rung + lead margin, honest-race deltas.
  * Tier B (villager event window: DecisionMade / ActionRequested /
    ActionCompleted / ActionFailed / ResourceGathered, fetched by a
    since/until window bounded by the attempt's start/end) — gather
    efficiency, waste ratio, decision mix, tokens + latency per team.
    Implemented now; its golden fixture lands with the first Phase 2 run.

Modes:
  --slice <file.json>                   Tier A offline (the golden-test path).
    [--window-slice <file.json>]        + Tier B offline from a saved
                                        villager-window slice (the Phase 2
                                        golden-test path).
  --attempt <id> [--ledger <url>]       fetch attempt slice + villager window
                                        from the event-service ledger (:8081),
                                        compute Tier A + Tier B. Needs httpx:
                                        uv run --with httpx python bench/bench_race.py --attempt <id>
    [--save-slices <dir>]               dump the fetched raw slices as
                                        <dir>/<label>.slice.json +
                                        <dir>/<label>.window.json — fixture
                                        capture and offline re-extraction.

Output: bench/results/race_<label>.json + .csv + one summary line — the
convention the Phase 2 N-run aggregation feeds into stats.py.
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from datetime import datetime
from pathlib import Path

from stats import percentile

BENCH_DIR = Path(__file__).resolve().parent
REPO_ROOT = BENCH_DIR.parent
ROSTER_PATH = REPO_ROOT / "services" / "agent-service" / "seed" / "villagers.json"
RESULTS_DIR = BENCH_DIR / "results"

# The 5-rung T1 ladder, race order (same list as scripts/render-race-film.py).
MILESTONES = ["first_coal", "first_iron_ore", "furnace_placed", "first_ingot", "iron_pickaxe"]

DEFAULT_LEDGER = "http://localhost:8081"
PAGE_LIMIT = 100  # EventFilter.MAX_LIMIT — the ledger 400s above it


def parse_ts(ts: str) -> datetime:
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def load_roster() -> tuple[dict[str, str], dict[str, str]]:
    """(id -> name, id -> team) from the single-source seed roster —
    deliberately NOT a third hardcoded NAME_OF table."""
    entries = json.loads(ROSTER_PATH.read_text(encoding="utf-8"))
    name_of = {e["id"]: e["name"] for e in entries}
    team_of = {e["id"]: e["team"] for e in entries if "team" in e}
    return name_of, team_of


def load_slice(path: str | Path) -> list[dict]:
    return json.loads(Path(path).read_text(encoding="utf-8"))["data"]


# --------------------------------------------------------------------------
# Tier A — attempt slice (deterministic, golden-tested)
# --------------------------------------------------------------------------

def tier_a(events: list[dict], name_of: dict[str, str]) -> dict:
    started = next(e for e in events if e["eventType"] == "AttemptStarted")
    ended = next(e for e in events if e["eventType"] == "AttemptEnded")
    t0 = parse_ts(started["occurredAt"])
    teams = [t["teamId"] for t in started["payload"]["teams"]]

    # First crossing per (team, milestone); the ledger is ascending by
    # occurredAt, so the first event seen IS the first crossing.
    milestones: dict[str, dict] = {team: {} for team in teams}
    for e in events:
        if e["eventType"] != "ProgressionMilestone":
            continue
        p = e["payload"]
        if p["milestone"] in milestones[p["teamId"]]:
            continue
        milestones[p["teamId"]][p["milestone"]] = {
            "offsetSeconds": round((parse_ts(e["occurredAt"]) - t0).total_seconds(), 3),
            "villager": name_of.get(p.get("villagerId", ""), p.get("villagerId", "?")),
        }

    first_to_rung: dict[str, dict] = {}
    for m in MILESTONES:
        crossings = sorted(
            ((team, milestones[team][m]["offsetSeconds"]) for team in teams if m in milestones[team]),
            key=lambda c: c[1],
        )
        if not crossings:
            continue
        leader, at = crossings[0]
        first_to_rung[m] = {
            "team": leader,
            "offsetSeconds": at,
            # None = the other team never reached this rung before the race ended.
            "leadMarginSeconds": round(crossings[1][1] - at, 3) if len(crossings) > 1 else None,
        }

    ep = ended["payload"]
    return {
        "attemptId": started["payload"]["attemptId"],
        "label": started["payload"].get("label"),
        "difficulty": started["payload"].get("difficulty"),
        "teams": {
            t["teamId"]: [name_of.get(v, v) for v in t["villagerIds"]]
            for t in started["payload"]["teams"]
        },
        "outcome": ep.get("outcome"),
        "winner": {
            "team": ep.get("winningTeamId"),
            "villager": name_of.get(ep.get("winningVillagerId", ""), "?"),
        },
        "durationSeconds": ep.get("durationSeconds"),
        "honestRace": ep.get("honestRace"),
        "milestones": milestones,
        "firstToRung": first_to_rung,
    }


# --------------------------------------------------------------------------
# Tier B — villager event window (golden fixture lands in Phase 2)
# --------------------------------------------------------------------------

def tier_b(events: list[dict], team_of: dict[str, str]) -> dict:
    """Per-team behavioural metrics from the attempt's villager-event window.
    Events from villagers outside the race roster are ignored."""
    counters: dict[str, dict] = {}

    def team_bucket(villager_id: str | None) -> dict | None:
        team = team_of.get(villager_id or "")
        if team is None:
            return None
        return counters.setdefault(team, {
            "gathered": 0,
            "gather_requests": 0,
            "actions": 0,
            "failures": 0,
            "decision_mix": {},
            "tokens": 0,
            "latencies_ms": [],
            "decisions": 0,
        })

    for e in events:
        p = e.get("payload", {})
        c = team_bucket(p.get("villagerId"))
        if c is None:
            continue
        et = e["eventType"]
        if et == "ResourceGathered":
            c["gathered"] += p.get("quantity", 0)
        elif et == "ActionRequested":
            c["actions"] += 1
            action = p.get("action", "?")
            c["decision_mix"][action] = c["decision_mix"].get(action, 0) + 1
            if action == "gather":
                c["gather_requests"] += 1
        elif et == "ActionFailed":
            c["failures"] += 1
        elif et == "DecisionMade":
            c["decisions"] += 1
            c["tokens"] += p.get("tokensUsed", 0)
            if p.get("latencyMs") is not None:
                c["latencies_ms"].append(p["latencyMs"])

    out: dict[str, dict] = {}
    for team, c in sorted(counters.items()):
        out[team] = {
            # blocks harvested per gather command issued
            "gatherEfficiency": round(c["gathered"] / c["gather_requests"], 3) if c["gather_requests"] else None,
            "gatheredTotal": c["gathered"],
            "gatherRequests": c["gather_requests"],
            # failed commands over all commands issued
            "wasteRatio": round(c["failures"] / c["actions"], 3) if c["actions"] else None,
            "actionsRequested": c["actions"],
            "actionsFailed": c["failures"],
            "decisionMix": dict(sorted(c["decision_mix"].items())),
            "llm": {
                "decisions": c["decisions"],
                "tokensUsed": c["tokens"],
                "latencyMsP50": round(percentile(c["latencies_ms"], 50), 1) if c["latencies_ms"] else None,
                "latencyMsP95": round(percentile(c["latencies_ms"], 95), 1) if c["latencies_ms"] else None,
            },
        }
    return out


# --------------------------------------------------------------------------
# Ledger fetch (--attempt mode)
# --------------------------------------------------------------------------

def _fetch_all(client, ledger: str, params: dict) -> list[dict]:
    """Follow nextCursor to exhaustion. Envelope is {data, nextCursor}."""
    events: list[dict] = []
    cursor = None
    while True:
        page_params = dict(params, limit=PAGE_LIMIT)
        if cursor:
            page_params["cursor"] = cursor
        resp = client.get(f"{ledger}/events", params=page_params)
        resp.raise_for_status()
        page = resp.json()
        events.extend(page["data"])
        cursor = page.get("nextCursor")
        if not cursor:
            return events


def fetch_attempt(attempt_id: str, ledger: str) -> tuple[list[dict], list[dict]]:
    import httpx  # only the live-ledger path needs it; --slice stays stdlib

    with httpx.Client(timeout=30.0) as client:
        attempt_events = _fetch_all(client, ledger, {
            "aggregate-type": "Attempt",
            "aggregate-id": attempt_id,
        })
        started = next(e for e in attempt_events if e["eventType"] == "AttemptStarted")
        ended = next(e for e in attempt_events if e["eventType"] == "AttemptEnded")
        villager_events = _fetch_all(client, ledger, {
            "aggregate-type": "Villager",
            "since": started["occurredAt"],
            "until": ended["occurredAt"],
        })
    return attempt_events, villager_events


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def write_results(result: dict, label: str) -> Path:
    RESULTS_DIR.mkdir(exist_ok=True)
    json_path = RESULTS_DIR / f"race_{label}.json"
    json_path.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")

    # flat CSV: one row per metric, ready for the Phase 2 N-run aggregation
    csv_path = RESULTS_DIR / f"race_{label}.csv"
    rows: list[tuple[str, str, str, object]] = [
        ("tierA", "", "durationSeconds", result["tierA"]["durationSeconds"]),
        ("tierA", result["tierA"]["winner"]["team"] or "", "winner", result["tierA"]["winner"]["villager"]),
    ]
    for team, rungs in result["tierA"]["milestones"].items():
        for m in MILESTONES:
            if m in rungs:
                rows.append(("tierA", team, f"offset.{m}", rungs[m]["offsetSeconds"]))
    for team, metrics in (result.get("tierB") or {}).items():
        for key in ("gatherEfficiency", "wasteRatio"):
            rows.append(("tierB", team, key, metrics[key]))
        rows.append(("tierB", team, "tokensUsed", metrics["llm"]["tokensUsed"]))
        rows.append(("tierB", team, "latencyMsP50", metrics["llm"]["latencyMsP50"]))
        rows.append(("tierB", team, "latencyMsP95", metrics["llm"]["latencyMsP95"]))
    with csv_path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh)
        writer.writerow(["tier", "team", "metric", "value"])
        writer.writerows(rows)
    return json_path


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--slice", help="attempt slice JSON file (Tier A only, offline)")
    src.add_argument("--attempt", help="attempt id — fetch slice + villager window from the ledger")
    ap.add_argument("--window-slice", help="villager-window slice JSON file (offline Tier B; needs --slice)")
    ap.add_argument("--save-slices", help="dir to dump fetched raw slices into (needs --attempt)")
    ap.add_argument("--ledger", default=DEFAULT_LEDGER, help=f"event-service base URL (default {DEFAULT_LEDGER})")
    ap.add_argument("--label", help="results file label (default: the attempt's label)")
    args = ap.parse_args()
    if args.window_slice and not args.slice:
        ap.error("--window-slice needs --slice")
    if args.save_slices and not args.attempt:
        ap.error("--save-slices needs --attempt")

    name_of, team_of = load_roster()
    if args.slice:
        attempt_events = load_slice(args.slice)
        villager_events = load_slice(args.window_slice) if args.window_slice else None
    else:
        attempt_events, villager_events = fetch_attempt(args.attempt, args.ledger)

    a = tier_a(attempt_events, name_of)
    result = {"tierA": a, "tierB": tier_b(villager_events, team_of) if villager_events is not None else None}

    label = args.label or a["label"] or a["attemptId"][:8]
    json_path = write_results(result, label)

    if args.save_slices:
        slices_dir = Path(args.save_slices)
        slices_dir.mkdir(parents=True, exist_ok=True)
        # Same {data: [...]} envelope the ledger returns and load_slice expects.
        (slices_dir / f"{label}.slice.json").write_text(
            json.dumps({"data": attempt_events}, indent=2) + "\n", encoding="utf-8")
        (slices_dir / f"{label}.window.json").write_text(
            json.dumps({"data": villager_events}, indent=2) + "\n", encoding="utf-8")

    honest = a["honestRace"] or {}
    leaders = " ".join(f"{m}:{r['team']}" for m, r in a["firstToRung"].items())
    print(
        f"race_{label}: {a['winner']['team']} wins in {a['durationSeconds']}s "
        f"({a['winner']['villager']}) · honest {{{honest.get('fakeProviderDelta')},{honest.get('budgetTrippedDelta')}}} "
        f"· first-to-rung [{leaders}] · wrote {json_path}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
