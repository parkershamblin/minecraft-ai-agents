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
  --reextract [dir]                     stdlib-only batch re-extraction: every
                                        <label>.slice.json / <label>.window.json
                                        pair under dir (default the sweep's
                                        results/sweep/slices) is recomputed and
                                        race_<label>.json/.csv rewritten in
                                        place. No ledger, no docker, no httpx —
                                        the metric layer can be fixed and every
                                        past run re-derived from the raw slices.

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

SWEEP_SLICES_DIR = RESULTS_DIR / "sweep" / "slices"

# tier_b keys the per-team blocks by teamId ("red"/"blue" — straight from the
# seed roster's `team` field). The run-level block rides in the SAME dict under
# a leading-underscore key, which no roster team id can ever collide with, so
# adding it did not reshape the per-team contract other consumers read.
RUN_BLOCK_KEY = "_run"
POOLED_LATENCY_QUANTILES = (50, 90, 95, 99)


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

def tier_b(events: list[dict], team_of: dict[str, str],
           duration_seconds: float | None = None) -> dict:
    """Per-team behavioural metrics from the attempt's villager-event window,
    plus a run-level block under RUN_BLOCK_KEY. Events from villagers outside
    the race roster are ignored.

    Two validity fixes live in the run-level block (2026-07-25):

    * **Pooled raw latency percentiles.** The per-team `latencyMsP50/P95` are
      percentiles of that team's own sample; the aggregator used to reconstruct
      a per-run number by decision-weighting the two team p50s, which is a mean
      of medians and not a percentile of anything. The raw per-decision
      latencies are right here in the window, so the honest pooled percentile is
      computed at extraction time and retained — the ledger fetch is the only
      place the raw sample is ever available cheaply. The per-team fields keep
      their old meaning byte-for-byte (the golden fixture and the CSV depend on
      it); `_run.latencyMs` is the number to aggregate.
    * **Window-normalised token metrics.** A DNF's window is the 75-minute stall
      watchdog while a win's is 10-30 minutes, so tokens/run partly measures how
      long the model failed for. `tokensPerDecision` is invariant to window
      length; `tokensPerMinute` is a rate rather than a total. Pass
      `duration_seconds` (Tier A's `durationSeconds`) to get the rate — without
      it `tokensPerMinute` is None rather than silently wrong.

    Included in the pooled sample: EVERY DecisionMade carrying a latency,
    schema-violation fallbacks (`payload.error == true`) included. Those rows
    are real deliberations that really cost that latency and those tokens — for
    qwen3.5:4b under v1 they ARE the run — so excluding them would flatter the
    models that fail loudest. `_run.decisionsWithError` reports how much of the
    sample they are, so any downstream reader can see the mix.
    """
    counters: dict[str, dict] = {}
    pooled_latencies: list[float] = []
    pooled_tokens = 0
    pooled_decisions = 0
    pooled_errors = 0

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
            pooled_decisions += 1
            pooled_tokens += p.get("tokensUsed", 0)
            if p.get("error"):
                pooled_errors += 1
            if p.get("latencyMs") is not None:
                c["latencies_ms"].append(p["latencyMs"])
                pooled_latencies.append(p["latencyMs"])

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

    minutes = (duration_seconds / 60.0) if duration_seconds else None
    out[RUN_BLOCK_KEY] = {
        "durationSeconds": duration_seconds,
        "llm": {
            "decisions": pooled_decisions,
            "decisionsWithError": pooled_errors,
            "tokensUsed": pooled_tokens,
            # The window-length-invariant token column.
            "tokensPerDecision": (round(pooled_tokens / pooled_decisions, 1)
                                  if pooled_decisions else None),
            "tokensPerMinute": (round(pooled_tokens / minutes, 1) if minutes else None),
            "latencyMs": {
                "n": len(pooled_latencies),
                **{f"p{q}": (round(percentile(pooled_latencies, q), 1)
                             if pooled_latencies else None)
                   for q in POOLED_LATENCY_QUANTILES},
            },
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
        if team == RUN_BLOCK_KEY:
            continue  # run-level block emitted below under the team column "_run"
        for key in ("gatherEfficiency", "wasteRatio"):
            rows.append(("tierB", team, key, metrics[key]))
        rows.append(("tierB", team, "tokensUsed", metrics["llm"]["tokensUsed"]))
        rows.append(("tierB", team, "latencyMsP50", metrics["llm"]["latencyMsP50"]))
        rows.append(("tierB", team, "latencyMsP95", metrics["llm"]["latencyMsP95"]))
    run_block = (result.get("tierB") or {}).get(RUN_BLOCK_KEY)
    if run_block:
        llm = run_block["llm"]
        rows.append(("tierB", RUN_BLOCK_KEY, "tokensUsed", llm["tokensUsed"]))
        rows.append(("tierB", RUN_BLOCK_KEY, "tokensPerDecision", llm["tokensPerDecision"]))
        rows.append(("tierB", RUN_BLOCK_KEY, "tokensPerMinute", llm["tokensPerMinute"]))
        for q in POOLED_LATENCY_QUANTILES:
            rows.append(("tierB", RUN_BLOCK_KEY, f"pooledLatencyMsP{q}", llm["latencyMs"][f"p{q}"]))
    with csv_path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh)
        writer.writerow(["tier", "team", "metric", "value"])
        writer.writerows(rows)
    return json_path


def extract_pair(attempt_events: list[dict], villager_events: list[dict] | None,
                 name_of: dict[str, str], team_of: dict[str, str]) -> dict:
    """Tier A + Tier B for one run. Tier A runs first because Tier B's
    window-normalised token rate needs the attempt's durationSeconds — the two
    tiers are no longer independent, and this is the single place that pairs
    them so --slice, --attempt and --reextract cannot drift apart."""
    a = tier_a(attempt_events, name_of)
    b = (tier_b(villager_events, team_of, a.get("durationSeconds"))
         if villager_events is not None else None)
    return {"tierA": a, "tierB": b}


def reextract_dir(slices_dir: Path, name_of: dict[str, str],
                  team_of: dict[str, str]) -> list[str]:
    """Recompute race_<label>.json/.csv for every saved slice pair in a
    directory — the offline replay path. The sweep dumps
    <label>.slice.json + <label>.window.json for exactly this: when the metric
    layer is corrected, past runs are re-derived from the raw ledger events
    instead of being re-raced on the GPU. A .slice.json with no .window.json
    yields Tier A only (same as --slice without --window-slice)."""
    labels = sorted(p.name[: -len(".slice.json")] for p in slices_dir.glob("*.slice.json"))
    if not labels:
        raise SystemExit(f"no *.slice.json under {slices_dir}")
    for label in labels:
        window = slices_dir / f"{label}.window.json"
        result = extract_pair(
            load_slice(slices_dir / f"{label}.slice.json"),
            load_slice(window) if window.exists() else None,
            name_of, team_of,
        )
        write_results(result, label)
    return labels


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--slice", help="attempt slice JSON file (Tier A only, offline)")
    src.add_argument("--attempt", help="attempt id — fetch slice + villager window from the ledger")
    src.add_argument("--reextract", nargs="?", const=str(SWEEP_SLICES_DIR), metavar="DIR",
                     help="re-extract EVERY saved slice pair in DIR offline, rewriting "
                          f"race_<label>.json/.csv in place (default {SWEEP_SLICES_DIR})")
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
    if args.reextract:
        labels = reextract_dir(Path(args.reextract), name_of, team_of)
        print(f"re-extracted {len(labels)} runs from {args.reextract} -> {RESULTS_DIR}")
        return 0

    if args.slice:
        attempt_events = load_slice(args.slice)
        villager_events = load_slice(args.window_slice) if args.window_slice else None
    else:
        attempt_events, villager_events = fetch_attempt(args.attempt, args.ledger)

    result = extract_pair(attempt_events, villager_events, name_of, team_of)
    a = result["tierA"]

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
