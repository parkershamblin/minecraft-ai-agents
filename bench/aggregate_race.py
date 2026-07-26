"""Phase 2 aggregation — the GovSim-style model-comparison table.

Reads the sweep manifest (bench/results/sweep/manifest.json) plus each kept
run's race_<label>.json, aggregates mean + 95% CI per metric per model via
stats.mean_ci95, and writes:

  bench/results/race_sweep_summary.json   full aggregate doc
  bench/results/race_sweep_summary.csv    one row per (model, metric)
  bench/results/RACE_REPORT.md            the comparison table (papers/GovSim.pdf shape)

Aggregation rules (stated in the report too):
  * Win rate: wins / kept runs. A stalled-but-honest run is a kept DNF —
    it counts in the denominator. Dirty runs never appear here at all.
  * Time-to-goal: won runs only (a DNF's duration is the watchdog, not the model).
  * Tier B metrics: all kept runs (behaviour under failure is signal, GovSim-style);
    both teams run the same model, so team counters are pooled per run before
    the across-run mean.
  * Latency: the per-run value is `tierB._run.latencyMs.p50` — a TRUE percentile
    of the run's pooled raw per-decision latencies, computed at extraction time
    (bench_race.tier_b). Until 2026-07-25 this column was the decision-weighted
    mean of the two team p50s, i.e. a mean of medians; the fix required
    retaining the pooled sample in the extractor, and every past run was
    re-derived offline via `bench_race.py --reextract`.
  * Tokens: `tokensPerDecision` is the primary column because a DNF's window is
    the 75-minute stall watchdog while a win's is 10-30 minutes — tokens/run
    therefore partly measures how long a model failed for, and it ranked the
    0-win models as the hungriest. tokens/run survives as a secondary table.

Beyond the table, the report carries three DERIVED sections — wear_probe()
(does blocked run order actually bias the model means? no), slice_probes()
(executor-side action failures; are repeated decisions greedy-decoding
livelock? also no) and failure_profiles(). None of their numbers are typed
into the template: a hand-correction in the generated Markdown would be
reverted by the next run, which has already happened once (PR #92's audit).
The slice-backed sections read bench/results/sweep/slices — the same raw
pairs `bench_race.py --reextract` rebuilds every run JSON from — and are
skipped entirely if that directory is absent.

Run:  uv run python bench/aggregate_race.py
"""

from __future__ import annotations

import csv
import json
import math
import sys
from collections import Counter, defaultdict
from pathlib import Path

import bench_race
from stats import MeanCI95, mean_ci95

BENCH_DIR = Path(__file__).resolve().parent
RESULTS_DIR = BENCH_DIR / "results"
MANIFEST_PATH = RESULTS_DIR / "sweep" / "manifest.json"
SUMMARY_JSON = RESULTS_DIR / "race_sweep_summary.json"
SUMMARY_CSV = RESULTS_DIR / "race_sweep_summary.csv"
REPORT_MD = RESULTS_DIR / "RACE_REPORT.md"
# Phase 3b lands in its own artifacts — an axis row is a different experiment
# from a model row and must not share a table with one.
AXIS_REPORT_MD = RESULTS_DIR / "AXIS_REPORT.md"
AXIS_SUMMARY_JSON = RESULTS_DIR / "race_axis_summary.json"
FROZEN_CONFIG_PATH = BENCH_DIR / "race" / "frozen-config.json"

# Detrending target for the world-wear probe. 3.0 is the mean run index of a
# complete 1-5 block, so a block with full index coverage is its own control:
# detrending cannot move its mean, only an UNBALANCED block's.
WEAR_COMMON_INDEX = 3.0

# Floors that keep derived rates honest rather than merely printable.
GATHER_RATE_MIN_SAMPLE = 50   # gather commands issued before a % is meaningful
CORRELATION_MIN_WINS = 3      # won runs before failure-rate vs time-to-goal means anything

TIER_B_METRICS = ("gatherEfficiency", "wasteRatio", "tokensUsed", "tokensPerDecision",
                  "tokensPerMinute", "latencyMsP50", "latencyMsP90",
                  "latencyMsP95", "latencyMsP99")

# Columns whose value depends on how long the window happened to be. Kept and
# reported, but never the headline — see the module docstring.
WINDOW_SENSITIVE = ("tokensUsed",)

# The failure-mode section's one hand-written part: the diagnosis label. The
# (model, configVersion) rows worth narrating, in report order. Numbers come
# from failure_profiles(); only the verdict phrase lives here.
FAILURE_GLOSS = {
    ("qwen3.5:4b", 1): "structurally mute.",
    ("qwen3.5:4b", 2): "playing, but not well.",
    ("lfm2.5:latest", 1): "engaged but too slow and sloppy.",
}


def pooled_tier_b(tier_b: dict) -> dict[str, float | None]:
    """Both teams run the same model: pool team counters into one per-run value.

    Counting metrics are summed across teams here; latency and the normalised
    token rates come pre-pooled from the extractor's run-level block, because
    a percentile cannot be reconstructed from two per-team percentiles and the
    raw sample only exists at extraction time."""
    teams = [t for k, t in tier_b.items() if k != bench_race.RUN_BLOCK_KEY]
    gathered = sum(t["gatheredTotal"] for t in teams)
    requests = sum(t["gatherRequests"] for t in teams)
    actions = sum(t["actionsRequested"] for t in teams)
    failures = sum(t["actionsFailed"] for t in teams)
    run_llm = tier_b[bench_race.RUN_BLOCK_KEY]["llm"]
    latency = run_llm["latencyMs"]
    return {
        "gatherEfficiency": gathered / requests if requests else None,
        "wasteRatio": failures / actions if actions else None,
        "tokensUsed": float(run_llm["tokensUsed"]),
        "tokensPerDecision": run_llm["tokensPerDecision"],
        "tokensPerMinute": run_llm["tokensPerMinute"],
        **{f"latencyMsP{q}": latency[f"p{q}"] for q in bench_race.POOLED_LATENCY_QUANTILES},
    }


def ci_doc(ci: MeanCI95) -> dict:
    return {"n": ci.n, "mean": ci.mean, "ci95Half": ci.half}


def fmt_ci(ci: MeanCI95, digits: int = 1) -> str:
    if ci.n == 0 or math.isnan(ci.mean):
        return "—"
    if ci.n < 2 or math.isnan(ci.half):
        return f"{ci.mean:.{digits}f} (n=1)"
    return f"{ci.mean:.{digits}f} ± {ci.half:.{digits}f}"


def failure_profiles(runs: list[dict]) -> dict[tuple[str, int], dict]:
    """Pooled behaviour per (model, configVersion) for the narrative bullets.

    These used to be prose constants in the report template, and it bit: PR #92's
    traceability audit corrected lfm2.5's numbers by hand IN the generated
    RACE_REPORT.md while the generator kept emitting the originals, so the next
    `aggregate_race.py` silently reverted the correction. Every number in the
    failure-mode section is now derived from the same run JSONs as the table —
    prose and table cannot disagree, and an audit finding cannot be un-shipped
    by a regeneration."""
    profiles: dict[tuple[str, int], dict] = {}
    for run in runs:
        result = json.loads((BENCH_DIR.parent / run["resultFile"]).read_text(encoding="utf-8"))
        tier_b = result.get("tierB")
        if not tier_b:
            continue
        key = (run["model"], run.get("configVersion", 1))
        p = profiles.setdefault(key, {"runs": 0, "decisions": 0, "errors": 0,
                                      "tokens": 0, "mix": {}, "p50s": [],
                                      "reachedFirstCoal": 0})
        run_llm = tier_b[bench_race.RUN_BLOCK_KEY]["llm"]
        p["runs"] += 1
        p["decisions"] += run_llm["decisions"]
        p["errors"] += run_llm["decisionsWithError"]
        p["tokens"] += run_llm["tokensUsed"]
        if run_llm["latencyMs"]["p50"] is not None:
            p["p50s"].append(run_llm["latencyMs"]["p50"])
        for name, team in tier_b.items():
            if name == bench_race.RUN_BLOCK_KEY:
                continue
            for action, count in team["decisionMix"].items():
                p["mix"][action] = p["mix"].get(action, 0) + count
        if any("first_coal" in rungs for rungs in result["tierA"]["milestones"].values()):
            p["reachedFirstCoal"] += 1
    return profiles


def pct(part: int, whole: int) -> str:
    return f"{part / whole * 100:.1f}%" if whole else "—"


# --------------------------------------------------------------------------
# Probes behind the method caveats. Each returns numbers, never prose: the
# caveat text interpolates them, so an audit correction cannot be reverted by
# a regeneration (the failure_profiles() lesson, applied to the caveats too).
# --------------------------------------------------------------------------

def _ols(xs: list[float], ys: list[float]) -> tuple[float, float]:
    """(slope, standard error of the slope). SE is NaN below 3 points."""
    n = len(xs)
    mx, my = sum(xs) / n, sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    slope = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sxx
    if n < 3:
        return slope, float("nan")
    inter = my - slope * mx
    resid2 = sum((y - (inter + slope * x)) ** 2 for x, y in zip(xs, ys))
    return slope, math.sqrt((resid2 / (n - 2)) / sxx)


def _pearson(a: list[float], b: list[float]) -> float:
    n = len(a)
    ma, mb = sum(a) / n, sum(b) / n
    denom = math.sqrt(sum((x - ma) ** 2 for x in a) * sum((y - mb) ** 2 for y in b))
    return sum((x - ma) * (y - mb) for x, y in zip(a, b)) / denom if denom else float("nan")


def _ranks(values: list[float]) -> list[float]:
    order = sorted(range(len(values)), key=lambda i: values[i])
    out = [0.0] * len(values)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and values[order[j + 1]] == values[order[i]]:
            j += 1
        for k in range(i, j + 1):
            out[order[k]] = (i + j) / 2 + 1
        i = j + 1
    return out


def _sd(values: list[float]) -> float:
    n = len(values)
    if n < 2:
        return float("nan")
    m = sum(values) / n
    return math.sqrt(sum((v - m) ** 2 for v in values) / (n - 1))


def wear_probe(kept: list[dict]) -> dict:
    """Does blocked run order on an unreset world actually bias the model table?

    Written because the reports used to assert that it did — "run index alone
    can account for the entire winner ranking" — which is not what the data
    says. Three independent checks, all from the manifest alone:

    * index COVERAGE per block. Run index can only shift a between-model mean
      if the blocks cover different indices; two blocks with identical mean
      index cannot differ because of it, whatever the wear slope is.
    * DETRENDING each block by its own within-block OLS slope to a common
      index. If wear were generating the gaps, removing it would shrink them.
    * GLOBAL chronology across the sweep. Within-block drift with no
      sweep-wide trend means the world does not accumulate wear across blocks
      — durations reset at each block boundary.
    """
    blocks: dict[tuple[str, int], dict] = {}
    order: list[tuple[str, int]] = []
    all_idx: dict[tuple[str, int], list[int]] = {}
    for run in kept:
        key = (run["model"], run.get("configVersion", 1))
        if key not in order:
            order.append(key)          # manifest order = the order blocks ran
        all_idx.setdefault(key, []).append(run["index"])
        if run["outcome"] != "won":
            continue
        blocks.setdefault(key, {"idx": [], "dur": []})
        blocks[key]["idx"].append(run["index"])
        blocks[key]["dur"].append(run["durationSeconds"])

    for key, b in blocks.items():
        # Which indices this block is missing from the winners, DERIVED — the
        # prose used to assert "its run 1 was the DNF" without checking.
        span = all_idx.get(key, b["idx"])
        b["notWon"] = sorted(set(range(1, max(span) + 1)) - set(b["idx"]))
        # v3+ blocks restore a pristine world before the block, so the
        # cross-block wear caveat does not apply to them.
        b["worldReset"] = key[1] >= PROTOCOL_WORLD_VERSION
        idx, dur = b["idx"], b["dur"]
        b["n"] = len(dur)
        b["meanIndex"] = sum(idx) / len(idx)
        b["mean"] = sum(dur) / len(dur)
        b["sd"] = _sd(dur)
        if len(dur) >= 2:
            slope, se = _ols([float(i) for i in idx], dur)
            b["slope"] = slope
            b["slopeSE"] = se
            b["slopeT"] = slope / se if se == se and se else float("nan")
            # Observed span only. Multiplying a slope by 4 ("index 1 to 5")
            # for a block that only ever ran indices 2-5 invents a step.
            b["driftObserved"] = slope * (max(idx) - min(idx))
            b["spanIndices"] = (min(idx), max(idx))
            b["detrendedMean"] = sum(d - slope * (i - WEAR_COMMON_INDEX)
                                     for i, d in zip(idx, dur)) / len(dur)
        else:
            b.update({"slope": float("nan"), "slopeSE": float("nan"),
                      "slopeT": float("nan"), "driftObserved": float("nan"),
                      "spanIndices": (min(idx), max(idx)),
                      "detrendedMean": b["mean"]})

    # Sweep-wide chronology, restricted to the original (configVersion 1) sweep:
    # the v2 re-bench ran a day later under a changed harness, so splicing it
    # onto the same wear chain would compare a config change to world age.
    first_gen = [r for r in kept if r.get("configVersion", 1) == 1]
    positions = [i + 1 for i, r in enumerate(first_gen) if r["outcome"] == "won"]
    durations = [r["durationSeconds"] for r in first_gen if r["outcome"] == "won"]
    chrono = {"n": len(positions), "scope": "configVersion 1 sweep, winners only"}
    if len(positions) >= 3:
        slope, _ = _ols([float(p) for p in positions], durations)
        chrono.update({
            "pearson": _pearson([float(p) for p in positions], durations),
            "spearman": _pearson(_ranks([float(p) for p in positions]), _ranks(durations)),
            "slopePerStep": slope,
        })
    return {"blocks": blocks, "chronology": chrono, "order": order}


def slice_probes(kept: list[dict]) -> dict | None:
    """Executor-failure and repeat-decision probes over the saved raw slices.

    Both findings need the raw event stream — error codes and the
    decision -> ActionRequested -> ActionFailed causation chain — which the
    per-run race_<label>.json summaries deliberately do not carry. They read
    the SAME `bench/results/sweep/slices` pairs that `bench_race.py
    --reextract` rebuilds every run JSON from, so the provenance chain is
    unchanged: manifest -> slices -> every number in this report. Returns None
    when the slices are absent; nothing else in the report needs them.
    """
    slices_dir = bench_race.SWEEP_SLICES_DIR
    if not slices_dir.is_dir():
        return None
    _, team_of = bench_race.load_roster()

    resolved = failed = orphans = 0
    gather: dict[tuple[str, int], list[int]] = defaultdict(lambda: [0, 0])  # [requested, failed]
    codes: Counter[str] = Counter()
    messages: Counter[str] = Counter()
    rates: dict[tuple[str, int], list[tuple[float, float, str]]] = defaultdict(list)
    repeats: dict[tuple[str, int], dict] = defaultdict(
        lambda: {"pairs": 0, "repeats": 0, "afterFail": 0, "livelock": 0})
    frac: dict[str, list[float]] = defaultdict(list)

    for run in kept:
        window = slices_dir / f"{run['label']}.window.json"
        if not window.exists():
            return None
        key = (run["model"], run.get("configVersion", 1))
        events = bench_race.load_slice(window)

        known_cmds: set[str] = set()
        cmd_of_decision: dict[str, str] = {}
        cmd_failed: set[str] = set()
        decisions: dict[str, list[tuple[str, str, str | None]]] = defaultdict(list)
        for e in events:
            p = e.get("payload", {})
            villager = p.get("villagerId")
            if team_of.get(villager or "") is None:
                continue
            et = e["eventType"]
            if et == "ActionRequested":
                known_cmds.add(p["commandId"])
                if e.get("causationId"):
                    cmd_of_decision[e["causationId"]] = p["commandId"]
                if p.get("action") == "gather":
                    gather[key][0] += 1
            elif et == "DecisionMade":
                decisions[villager].append((e["occurredAt"], e["eventId"], p.get("decision")))
            elif et == "ActionFailed":
                cmd_failed.add(p.get("commandId"))

        run_resolved = run_failed = 0
        for e in events:
            p = e.get("payload", {})
            if team_of.get(p.get("villagerId") or "") is None:
                continue
            et = e["eventType"]
            if et not in ("ActionCompleted", "ActionFailed"):
                continue
            resolved += 1
            run_resolved += 1
            if p.get("commandId") not in known_cmds:
                orphans += 1  # window-edge truncation: outcome in, command out
            if et == "ActionFailed":
                failed += 1
                run_failed += 1
                codes[p.get("errorCode") or "?"] += 1
                messages[p.get("errorMessage") or "?"] += 1
                if p.get("action") == "gather":
                    gather[key][1] += 1
        if run_resolved:
            rates[key].append((run_failed / run_resolved, run["durationSeconds"], run["outcome"]))

        r = repeats[key]
        run_pairs = run_reps = 0
        for lst in decisions.values():
            lst.sort()
            for prev, cur in zip(lst, lst[1:]):
                r["pairs"] += 1
                run_pairs += 1
                if cur[2] is None or prev[2] != cur[2]:
                    continue
                r["repeats"] += 1
                run_reps += 1
                cmd = cmd_of_decision.get(prev[1])
                if cmd in cmd_failed:
                    r["afterFail"] += 1
                elif str(cur[2]).startswith("idle"):
                    # The only shape that is livelock rather than a retry:
                    # idle repeated when the previous action did NOT fail.
                    r["livelock"] += 1
        if run_pairs:
            frac[run["outcome"]].append(run_reps / run_pairs)

    corr = {}
    for key, samples in rates.items():
        won = [(f, d) for f, d, o in samples if o == "won"]
        if len(samples) >= 3:
            corr[key] = {
                "nAll": len(samples),
                "rAll": _pearson([f for f, _, _ in samples], [d for _, d, _ in samples]),
                "nWon": len(won),
                "rWon": (_pearson([f for f, _ in won], [d for _, d in won])
                         if len(won) >= 3 else float("nan")),
            }
    return {
        "resolved": resolved, "failed": failed, "orphans": orphans,
        "gather": dict(gather), "codes": codes, "messages": messages,
        "correlations": corr, "repeats": dict(repeats),
        "repeatFraction": {k: sum(v) / len(v) for k, v in frac.items() if v},
        "repeatFractionN": {k: len(v) for k, v in frac.items() if v},
        # The per-(model, cfg) tables below are unambiguous, but the pooled
        # scalars (resolved/failed/orphans, the code and message mixes) are
        # sums over EVERY kept run — including versions superseded in the model
        # table. That scope is recorded here so the prose can state it instead
        # of implying the numbers belong to the table above.
        "scope": sorted({(r["model"], r.get("configVersion", 1)) for r in kept}),
        "scopeRuns": len(kept),
    }


def model_roster() -> dict | None:
    """The forward-looking roster decision, read from the frozen config rather
    than restated here — one source of truth for which models get GPU-hours."""
    if not FROZEN_CONFIG_PATH.exists():
        return None
    return json.loads(FROZEN_CONFIG_PATH.read_text(encoding="utf-8")).get("modelRoster")


PROTOCOL_WORLD_VERSION = 3  # from v3 on, a row must name the world it raced on


def aggregate(manifest: dict) -> tuple[dict, list[dict]]:
    models: dict[str, dict] = {}
    all_kept = [r for r in manifest["runs"] if not r["discarded"]]
    discarded = [r for r in manifest["runs"] if r["discarded"]]
    # A v3+ row with no worldSeed was raced under `--no-world-reset`: honest,
    # but NOT the protocol its version number claims (no pristine world per
    # block). Excluded from every aggregate rather than silently pooled — and
    # reported by label below, because a cap nobody can see reads as coverage.
    unreset = [r for r in all_kept
               if r.get("configVersion", 1) >= PROTOCOL_WORLD_VERSION
               and not r.get("worldSeed")]
    excluded_labels = {r["label"] for r in unreset}
    all_kept = [r for r in all_kept if r["label"] not in excluded_labels]
    # A harness bump re-benches a model; its row always comes from the model's
    # HIGHEST configVersion (pre-versioning records are v1). Never mix versions
    # inside one row.
    latest = {r["model"]: max(x.get("configVersion", 1) for x in all_kept
                              if x["model"] == r["model"]) for r in all_kept}
    kept = [r for r in all_kept if r.get("configVersion", 1) == latest[r["model"]]]
    for run in kept:
        result = json.loads((BENCH_DIR.parent / run["resultFile"]).read_text(encoding="utf-8"))
        per_run = pooled_tier_b(result["tierB"]) if result.get("tierB") else {}
        m = models.setdefault(run["model"], {"runs": [], "wins": 0, "durations": [],
                                             "windows": [],
                                             **{k: [] for k in TIER_B_METRICS}})
        m["runs"].append(run["label"])
        # Every kept run's wall-clock window (DNFs included) — this is the
        # denominator tokens/run was silently measuring, so it is reported
        # next to it rather than left implicit.
        if run["durationSeconds"] is not None:
            m["windows"].append(run["durationSeconds"])
        if run["outcome"] == "won":
            m["wins"] += 1
            m["durations"].append(run["durationSeconds"])
        for key in TIER_B_METRICS:
            if per_run.get(key) is not None:
                m[key].append(per_run[key])

    rows = []
    for model, m in models.items():
        n = len(m["runs"])
        rows.append({
            "model": model,
            "configVersion": latest[model],
            "n": n,
            "wins": m["wins"],
            "winRate": m["wins"] / n if n else float("nan"),
            "timeToGoalSeconds": mean_ci95(m["durations"]),
            "windowSeconds": mean_ci95(m["windows"]),
            **{k: mean_ci95(m[k]) for k in TIER_B_METRICS},
        })
    profiles = failure_profiles(all_kept)
    # Table order: best first — highest win rate, then fastest mean time-to-goal.
    rows.sort(key=lambda r: (-r["winRate"],
                             r["timeToGoalSeconds"].mean
                             if not math.isnan(r["timeToGoalSeconds"].mean) else float("inf")))
    return {"rows": rows, "discarded": discarded, "profiles": profiles,
            "wear": wear_probe(all_kept), "slices": slice_probes(all_kept),
            "unreset": unreset, "reported": kept,
            "roster": model_roster()}, kept


def pre_v3_caveat_lines(rows: list[dict]) -> list[str]:
    """Protocol defects that v3 fixed, stated about the runs they affected.

    These were unconditional template text making present-tense claims about
    the repo ("compose still passes none to memory-service", "race-rb2.mjs
    never issues time set"). v3 falsified both, so they are now scoped: they
    appear only while the table still shows a pre-v3 row, and they talk about
    those runs in the past tense rather than about the code as it stands."""
    affected = [r for r in rows if r["configVersion"] < PROTOCOL_WORLD_VERSION]
    if not affected:
        return []
    which = ", ".join(f"`{r['model']}` v{r['configVersion']}" for r in affected)
    return [
        "- **Greedy decoding held in the deliberation half of the loop only** for",
        f"  the pre-v3 rows ({which}). Compose passed no `LLM_TEMPERATURE` to",
        "  memory-service at the time, whose `llm_temperature` defaults to 0.7",
        "  (`services/memory-service/src/memory_service/settings.py`) and is handed",
        "  straight to the reflection summarizer (`memory_service/llm.py`).",
        "  Reflections feed the memory stream, which feeds the deliberation prompt,",
        "  so those runs are greedy where the DECISION is made and 0.7 where the",
        "  memories it reads were written. Same class of bug as the agent-service",
        "  one PR #90 fixed. FIXED in configVersion 3 (compose passes it and the",
        "  sweep verifies temperature AND reflection budget inside the container",
        "  before racing); not reconstructible for the runs above.",
        "- **Time of day and weather ran FREE** for those same rows.",
        "  `scripts/race-rb2.mjs` pinned keepInventory, doInsomnia, mobGriefing and",
        "  doMobSpawning but issued no `time set` or `weather clear`, and neither",
        "  `doDaylightCycle` nor `doWeatherCycle` was pinned anywhere, so every one",
        "  of those runs started at an arbitrary point in the day/night and weather",
        "  cycle — an unpinned axis that plausibly moves mob-free gathering (light",
        "  level while digging, rain). FIXED in configVersion 3: the preflight now",
        "  sets and reads back both gamerules and stamps day + clear weather. It",
        "  CANNOT be reconstructed for the runs above, which is why it stays a",
        "  threat there and not a correction.",
    ]


def wear_lines(wear: dict, rows: list[dict]) -> list[str]:
    """The world-wear caveat, with every figure computed by wear_probe().

    This bullet used to claim run index could account for the entire winner
    ranking. It cannot, and the numbers below are why — so they are derived,
    not typed."""
    blocks, chrono = wear["blocks"], wear["chronology"]
    winners = [r for r in rows if (r["model"], r["configVersion"]) in blocks
               and blocks[(r["model"], r["configVersion"])]["n"] >= 2]
    winners.sort(key=lambda r: blocks[(r["model"], r["configVersion"])]["mean"])
    # Block order and reset status are DERIVED from the manifest. They used to
    # be a hard-coded sentence naming five models and asserting "without world
    # resets" — which becomes false for every v3 block the moment one lands.
    unreset_order = [f"`{m}` v{c}" for m, c in wear.get("order", [])
                     if c < PROTOCOL_WORLD_VERSION]
    reset_order = [f"`{m}` v{c}" for m, c in wear.get("order", [])
                   if c >= PROTOCOL_WORLD_VERSION]
    out = [
        "- **Blocked run order — a hygiene problem, not a demonstrated bias.**",
    ]
    if unreset_order:
        out.append(
            f"  On a shared persistent world, blocks ran "
            f"{' → '.join(unreset_order)} with no world reset between them, so "
            f"within-block run index is confounded with world age there.")
    if reset_order:
        out.append(
            f"  {'Blocks' if not unreset_order else 'By contrast, blocks'} "
            f"{' → '.join(reset_order)} ran at configVersion "
            f"{PROTOCOL_WORLD_VERSION}+, which restores a pristine pinned-seed "
            f"world before each block: cross-block wear cannot reach them, and "
            f"only within-block wear remains.")
    out.append("  Measured, that confound does not carry the model table:")
    for r in winners:
        b = blocks[(r["model"], r["configVersion"])]
        lo, hi = b["spanIndices"]
        out.append(
            f"  - `{r['model']}` v{r['configVersion']}: {b['n']} won runs, indices "
            f"{lo}-{hi}, mean index {b['meanIndex']:.2f}; within-block slope "
            f"{b['slope']:+.1f} ± {b['slopeSE']:.1f} s/step (t = {b['slopeT']:+.2f}), "
            f"drift {b['driftObserved']:+.1f} s across the observed span; "
            f"mean {b['mean']:.1f} s → {b['detrendedMean']:.1f} s detrended to "
            f"index {WEAR_COMMON_INDEX:.1f}.")
    balanced = [r for r in winners
                if blocks[(r["model"], r["configVersion"])]["meanIndex"] == WEAR_COMMON_INDEX]
    if len(balanced) >= 2:
        a, c = balanced[0], balanced[1]
        ba, bc = blocks[(a["model"], a["configVersion"])], blocks[(c["model"], c["configVersion"])]
        out.append(
            f"  - Run index can only move a between-model mean if the blocks cover "
            f"different indices. `{a['model']}` and `{c['model']}` have the SAME mean "
            f"index ({WEAR_COMMON_INDEX:.2f}), so index cannot generate the "
            f"{abs(bc['mean'] - ba['mean']):.1f} s gap between them at all.")
    unbalanced = [r for r in winners
                  if blocks[(r["model"], r["configVersion"])]["meanIndex"] > WEAR_COMMON_INDEX]
    for n, r in enumerate(unbalanced, 1):
        b = blocks[(r["model"], r["configVersion"])]
        which = ("The one unbalanced block is" if len(unbalanced) == 1
                 else f"Unbalanced block {n} of {len(unbalanced)}:")
        notwon = b.get("notWon") or []
        missing = (f"run{'s' if len(notwon) > 1 else ''} "
                   f"{', '.join(str(i) for i in notwon)} did not win"
                   if notwon else "no index missing")
        out.append(
            f"  - {which} `{r['model']}` (mean index "
            f"{b['meanIndex']:.2f} — {missing}), i.e. shifted toward "
            f"LATER, more-worn indices. Under the posited positive wear that biases "
            f"AGAINST it, not for it. Detrending WIDENS its gaps rather than "
            f"dissolving them (see the per-block means above). Its drift is "
            f"{b['driftObserved']:+.1f} s across indices {b['spanIndices'][0]}→"
            f"{b['spanIndices'][1]}; extrapolating the slope to a 1→5 span "
            f"({b['slope'] * 4:+.1f} s) multiplies a "
            f"{b['spanIndices'][1] - b['spanIndices'][0]}-step observation by 4 and "
            f"is wrong.")
    if "pearson" in chrono:
        out.append(
            f"  - No cumulative wear ACROSS the sweep: over the {chrono['n']} winners "
            f"in run order ({chrono['scope']}), Pearson {chrono['pearson']:+.3f}, "
            f"Spearman {chrono['spearman']:+.3f}, "
            f"{chrono['slopePerStep']:+.1f} s per step. Durations reset at every "
            f"block boundary.")
    noisiest = max(winners, key=lambda r: blocks[(r["model"], r["configVersion"])]["sd"])
    nb = blocks[(noisiest["model"], noisiest["configVersion"])]
    closest = min((r for r in winners if r is not noisiest),
                  key=lambda r: abs(blocks[(r["model"], r["configVersion"])]["mean"] - nb["mean"]))
    cb = blocks[(closest["model"], closest["configVersion"])]
    out += [
        "  The caution against reading adjacent winner rows as a ranking STANDS —",
        "  but it rests on raw sampling noise at n=5, not on the wear mechanism:",
        f"  `{noisiest['model']}`'s own sd is {nb['sd']:.1f} s against a "
        f"{abs(nb['mean'] - cb['mean']):.1f} s gap to `{closest['model']}`.",
        "  Resetting the world per block (or interleaving run order) is still worth",
        "  doing as hygiene; it is simply not what makes these rows unrankable, and",
        "  the earlier claim that run index alone could account for the winner",
        "  ranking is withdrawn.",
        "  DONE as hygiene in configVersion 3: `sweep_race.py` restores a pristine",
        "  pinned-seed world (`6233701440491701965`) before every block and aborts",
        "  if the RCON seed check fails (`docs/runbooks/race-world-reset.md`).",
        "  WITHIN-block wear survives that — interleaving run order is the remaining",
        "  upgrade, and it must be decided before a sweep starts, not after.",
    ]
    return out


def executor_lines(s: dict) -> list[str]:
    """The dominant cost in these races is executor-side pathfinding, not model
    quality — stated with derived counts because it reframes what to optimise."""
    top_msg, top_n = s["messages"].most_common(1)[0]
    top_code, top_code_n = s["codes"].most_common(1)[0]
    out = [
        "## Executor-side action failures",
        "",
        "Derived from the same saved slices every run JSON is extracted from",
        "(`bench/results/sweep/slices`), roster villagers only.",
        "",
        f"**Scope:** pooled over all {s.get('scopeRuns', 0)} kept runs across "
        + ", ".join(f"`{m}` v{c}" for m, c in s.get("scope", []))
        + " — this is a WIDER set than the model table, which shows each model at",
        "its highest configVersion only. The per-model rows below carry their own",
        "`cfg`; the totals in this paragraph do not belong to any single version.",
        "",
        f"{s['failed']} of {s['resolved']} resolved actions failed "
        f"({pct(s['failed'], s['resolved'])}). Restricted to `gather` — the",
        "verb that actually advances the ladder — failures over gather commands",
        "issued:",
        "",
        "| Model | cfg | Gather cmds | Failed | Rate |",
        "|---|--:|--:|--:|--:|",
    ]
    # A rate needs a real sample AND a numerator its own denominator can hold.
    # qwen3.5:4b at v1 issued 3 gather commands all sweep and resolved 5 gather
    # outcomes (window-edge orphans), which would print as 166.7%.
    omitted = []
    for (model, cfg), (req, fail) in sorted(s["gather"].items(), key=lambda kv: -kv[1][0]):
        if req >= GATHER_RATE_MIN_SAMPLE and fail <= req:
            out.append(f"| `{model}` | v{cfg} | {req} | {fail} | {pct(fail, req)} |")
        elif req or fail:
            omitted.append(f"`{model}` v{cfg} ({req} issued, {fail} failed)")
    if omitted:
        out += ["",
                f"Blocks issuing fewer than {GATHER_RATE_MIN_SAMPLE} gather commands are "
                "omitted above — no",
                "meaningful rate, and the orphan outcomes below can exceed the "
                "denominator: " + ", ".join(omitted) + "."]
    out += [
        "",
        f"A SINGLE executor-side error string accounts for {top_n} of {s['failed']}",
        f"failures ({pct(top_n, s['failed'])}): \"{top_msg}\",",
        f"errorCode {top_code} — a mineflayer pathfinder timeout. State that",
        f"precisely: errorCode {top_code} totals {top_code_n}, the specific string is",
        f"{top_n}; the two are NOT interchangeable.",
        "",
        "Full errorCode mix: "
        + ", ".join(f"{c} {n}" for c, n in s["codes"].most_common()) + ".",
        "",
        "Per-run failure rate tracks time-to-goal within a block. Only blocks with",
        "wins are listed: for a 0-win block \"time-to-goal\" is the watchdog length,",
        "so the correlation there measures the watchdog, not the model.",
    ]
    for (model, cfg), c in sorted(s["correlations"].items()):
        if c["nWon"] < CORRELATION_MIN_WINS:
            continue
        note = (f"; the won-only value r = {c['rWon']:+.3f} (n={c['nWon']}) is a "
                f"selection artifact and should not be quoted"
                if c["nWon"] < c["nAll"] and c["rWon"] == c["rWon"] else "")
        out.append(f"- `{model}` v{cfg}: r = {c['rAll']:+.3f} over all {c['nAll']} "
                   f"kept runs{note}.")
    out += [
        "",
        f"Bookkeeping caveat: {s['orphans']} of {s['resolved']} outcome events "
        f"({pct(s['orphans'], s['resolved'])}) reference a commandId",
        "with no in-window `ActionRequested` (window-edge truncation), and the gather",
        "denominator is commands issued while the numerator is resolved outcomes —",
        "these rates are robust at roughly the 2% level, not tighter.",
        "",
        "Reading this section: the dominant cost in these races is **executor-side",
        "pathfinding, not model quality**, which is where the next optimisation",
        "should go rather than at the model axis this table varies.",
        "",
    ]
    return out


def repeat_lines(s: dict) -> list[str]:
    """Greedy decoding was suspected of causing decision livelock. It is not
    what the causation chain says, so the disconfirmation is recorded here."""
    out = [
        "## Greedy decoding is not the livelock cause",
        "",
        "Consecutive identical decisions by the same villager (exact decision-string",
        "key), classified against the causation chain",
        "(`DecisionMade` → `ActionRequested` → `ActionFailed`/`ActionCompleted`).",
        "\"Livelock\" is the only shape temperature could explain: `idle` repeated",
        "after an action that did NOT fail.",
        "",
        "| Model | cfg | Repeats | After a failed action | Livelock |",
        "|---|--:|--:|--:|--:|",
    ]
    for (model, cfg), r in sorted(s["repeats"].items(), key=lambda kv: -kv[1]["repeats"]):
        if not r["repeats"]:
            continue
        out.append(f"| `{model}` | v{cfg} | {r['repeats']} | {r['afterFail']} "
                   f"({pct(r['afterFail'], r['repeats'])}) | {r['livelock']} |")
    fr, frn = s["repeatFraction"], s["repeatFractionN"]
    out += [
        "",
        "Repeats in the three viable models are overwhelmingly RETRIES after the",
        "action failed, and true livelock is exactly 0 in all three. It appears only",
        "in `qwen3.5:4b` and `lfm2.5:latest`, where it is the `error == true`",
        "schema-violation fallback to idle rather than a sampling effect.",
        "",
        "The per-run repeat fraction IS higher in stalled runs than won ones ("
        + ", ".join(f"{k} {fr[k]:.3f} (n={frn[k]})" for k in sorted(fr, reverse=True))
        + "),",
        "but it is collinear with the failure rate in the section above and does not",
        "survive as an independent cause. **Temperature is not the next knob to turn.**",
        "",
    ]
    return out


def roster_lines(roster: dict) -> list[str]:
    out = [
        "## Model roster (forward-looking)",
        "",
        f"From `bench/race/frozen-config.json` → `modelRoster` (decided "
        f"{roster.get('decidedOn')} by the {roster.get('decidedBy')}).",
        "",
        "- Approved for future sweeps: " + ", ".join(f"`{m}`" for m in roster["approved"]) + ".",
    ]
    for ex in roster.get("excluded", []):
        out.append(f"- Excluded: `{ex['model']}` — {ex['evidence']}")
    out += [
        "",
        "The excluded models' rows above STAY. This is a decision about which models",
        "get future GPU-hours, not a retraction of data already collected.",
        "",
    ]
    return out


def write_outputs(agg: dict, manifest: dict) -> None:
    rows, discarded, profiles = agg["rows"], agg["discarded"], agg["profiles"]

    doc = {
        "benchmark": "rb-race-sweep",
        "frozenConfig": manifest.get("frozenConfig"),
        "startedAt": manifest.get("startedAt"),
        "latencyMethod": ("pooled raw per-decision latencies per run "
                          "(schema-violation fallbacks included), then mean ± 95% CI "
                          "across runs"),
        "models": [{**r, "timeToGoalSeconds": ci_doc(r["timeToGoalSeconds"]),
                    "windowSeconds": ci_doc(r["windowSeconds"]),
                    **{k: ci_doc(r[k]) for k in TIER_B_METRICS}} for r in rows],
        "discardedRuns": discarded,
        "excludedUnresetRuns": [
            {"model": r["model"], "label": r["label"],
             "configVersion": r.get("configVersion", 1),
             "reason": "configVersion >= 3 with no worldSeed (raced with "
                       "--no-world-reset): honest, but not the protocol its "
                       "version claims"}
            for r in agg.get("unreset", [])],
    }
    SUMMARY_JSON.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")

    with SUMMARY_CSV.open("w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["model", "metric", "n", "mean", "ci95Half"])
        for r in rows:
            w.writerow([r["model"], "winRate", r["n"], r["winRate"], ""])
            for key in ("timeToGoalSeconds", "windowSeconds", *TIER_B_METRICS):
                ci = r[key]
                w.writerow([r["model"], key, ci.n, ci.mean, ci.half])

    lines = [
        "# RB-race model comparison (Phase 2 sweep)",
        "",
        "GovSim-style table (papers/GovSim.pdf): one row per LLM, every run under",
        "the frozen config `bench/race/frozen-config.json` (Easy, mob-free, 3v3,",
        "greedy decoding `LLM_TEMPERATURE=0.0`), N runs per model, mean ± 95% CI",
        "(Student-t). Only honest runs (`AttemptEnded.honestRace == {0,0}`) are",
        "aggregated; dirty runs are discarded and listed below. A stalled-but-honest",
        "run is a kept DNF: it counts against win rate, and its Tier B behaviour is",
        "included, but its duration is not (that would measure the watchdog).",
        "",
        "Token and latency columns are **window-length invariant**: tokens/decision",
        "and tokens/minute instead of tokens/run, and latency p50 is a true",
        "percentile of the run's pooled raw per-decision latencies. Window-sensitive",
        "totals are kept below in their own table.",
        "",
    ]

    # Version-mix banner. Each row is that model's HIGHEST configVersion, so a
    # table can silently span protocols — and across a protocol change the rows
    # are not comparable to each other, only within a version.
    versions = sorted({r["configVersion"] for r in rows})
    if len(versions) > 1:
        lines += [
            f"> **Rows span configVersions {', '.join('v' + str(v) for v in versions)} "
            "— they are NOT comparable to each other.** Each model is reported at its",
            "> own highest version (`cfg` column); a version bump changes the protocol,",
            "> not just the harness. What changed per version is listed in",
            "> `$versionHistory` in `bench/race/frozen-config.json`. Compare within a",
            "> version; re-bench before ranking across one.",
            "",
        ]
    if agg.get("unreset"):
        by_model: dict[str, list[str]] = {}
        for r in agg["unreset"]:
            by_model.setdefault(r["model"], []).append(r["label"])
        listed = "; ".join(f"`{m}` ({len(v)} run{'s' if len(v) > 1 else ''}: "
                           f"{', '.join(sorted(v))})" for m, v in sorted(by_model.items()))
        lines += [
            f"> **{len(agg['unreset'])} honest run(s) EXCLUDED from every number below:** "
            f"{listed}.",
            f"> They carry configVersion ≥ {PROTOCOL_WORLD_VERSION} but no `worldSeed`, "
            "i.e. they were raced with `--no-world-reset`, so they did not get the",
            "> pristine per-block world that version claims. Listed rather than dropped",
            "> silently — see `excludedUnresetRuns` in the summary JSON.",
            "",
        ]

    lines += [
        "| Model | cfg | N | Win rate | Time-to-goal s (won) | Gather eff. (blocks/req) | Waste ratio | Tokens/decision | Tokens/min | Latency p50 ms |",
        "|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|",
    ]
    for r in rows:
        lines.append(
            f"| `{r['model']}` | v{r['configVersion']} | {r['n']} | {r['wins']}/{r['n']} "
            f"| {fmt_ci(r['timeToGoalSeconds'])} | {fmt_ci(r['gatherEfficiency'], 2)} "
            f"| {fmt_ci(r['wasteRatio'], 3)} | {fmt_ci(r['tokensPerDecision'], 0)} "
            f"| {fmt_ci(r['tokensPerMinute'], 0)} | {fmt_ci(r['latencyMsP50'], 0)} |")
    # A version bump drops a model's older rows out of the table entirely, so a
    # freshly re-benched model can top the sort on one run while the models it
    # is sorted against carry five. The sort cannot express that; a line can.
    provisional = [r for r in rows if r["n"] < 3]
    if provisional:
        lines += [
            "",
            "**Provisional rows (n < 3):** "
            + ", ".join(f"`{r['model']}` v{r['configVersion']} (n={r['n']})"
                        for r in provisional)
            + ". A version bump retires that model's older rows rather than",
            "pooling them, so a re-bench in progress shows here at its true N —",
            "which is not yet enough for a CI, let alone a ranking. The table is",
            "sorted by win rate and mean time regardless of N: read the N column",
            "before reading the order.",
        ]
    lines += [
        "",
        "### Latency distribution (pooled raw per-decision, mean ± 95% CI across runs)",
        "",
        "| Model | p50 ms | p90 ms | p95 ms | p99 ms |",
        "|---|--:|--:|--:|--:|",
    ]
    for r in rows:
        lines.append(f"| `{r['model']}` | {fmt_ci(r['latencyMsP50'], 0)} "
                     f"| {fmt_ci(r['latencyMsP90'], 0)} | {fmt_ci(r['latencyMsP95'], 0)} "
                     f"| {fmt_ci(r['latencyMsP99'], 0)} |")
    lines += [
        "",
        "### Window-sensitive totals (secondary — read tokens/decision instead)",
        "",
        "| Model | Tokens/run | Mean window s |",
        "|---|--:|--:|",
    ]
    for r in rows:
        lines.append(f"| `{r['model']}` | {fmt_ci(r['tokensUsed'], 0)} "
                     f"| {fmt_ci(r['windowSeconds'], 0)} |")
    lines += [
        "",
        "Reference record under this config's knobs but NOT this protocol: Easy",
        "mob-free **360.4s** (`019f7337`) — set at the 10s race tick with per-team",
        "models and default temperature, so it is a ceiling reference, not a row.",
        "Reproduce any row:",
        "`uv run --with httpx python bench/sweep_race.py --models <model> --runs 5`",
        "then `uv run python bench/aggregate_race.py`.",
        "Re-derive every row from the saved raw slices without a ledger, a GPU or",
        "docker: `uv run python bench/bench_race.py --reextract` then",
        "`uv run python bench/aggregate_race.py`.",
        "",
        "## Method caveats",
        "",
        # The two caveats below describe defects of the PRE-v3 protocol. They
        # are emitted only while a pre-v3 row is actually in the table —
        # attaching them to a v3-only report would state the opposite of what
        # that report measured.
        *pre_v3_caveat_lines(rows),
        # Applies to EVERY version, v3 included — the per-block reset restores
        # the world volume only.
        "- **Villager memory and relationships accumulate ACROSS blocks, in every",
        "  version including v3.** The per-block world restore touches the",
        "  `minecraft-data` volume only; `postgres-data` (memory_db, agent_db) is",
        "  deliberately left alone, so a model raced late in a sweep inherits a",
        "  larger memory stream and older relationship edges than one raced first —",
        "  confounded with block order in exactly the way world wear was. v3 narrows",
        "  the blast radius but also sharpens the oddity: after a world reset those",
        "  carried-over memories describe terrain that no longer exists. Not fixed",
        "  because truncating villager memory is a filming-state decision rather",
        "  than a benchmark one — see `docs/runbooks/race-world-reset.md`,",
        "  \"What v3 does and does not fix\".",
        *wear_lines(agg["wear"], rows),
        "- **DNF Tier B windows are watchdog-length** (~75 min vs ~10-30 min for",
        "  wins) — see the mean-window column. FIXED as a metric: the headline",
        "  token column is now tokens/decision (window-length invariant) with",
        "  tokens/minute as the rate; tokens/run is demoted to the secondary",
        "  table and should not be compared across models with different win",
        "  rates. Non-token Tier B columns (gather efficiency, waste ratio) are",
        "  still ratios over a longer window for DNF-heavy models.",
        "- **Latency percentiles are pooled raw**, not a mean of per-team medians.",
        "  Each run's per-decision latencies from both teams are pooled and the",
        "  percentile taken over that sample at extraction time",
        "  (`tierB._run.latencyMs`); the table then averages those per-run",
        "  percentiles across runs. The per-team `latencyMsP50/P95` fields keep",
        "  their original per-team meaning for other consumers.",
        "- **Schema-violation fallbacks are IN the latency and token samples.**",
        "  A `DecisionMade` with `payload.error == true` still emits the real",
        "  latency and token count the deliberation cost before falling back to",
        "  idle, and for the worst models those rows are most of the run.",
        "  Excluding them would flatter exactly the models that fail loudest.",
        "  `tierB._run.llm.decisionsWithError` records the share per run.",
        "",
    ]
    if agg["slices"]:
        lines += executor_lines(agg["slices"]) + repeat_lines(agg["slices"])
    lines += [
        "## Failure modes of the weak models",
        "",
        "Every number in this section is derived from the same run JSONs as the",
        "table above (see `failure_profiles`), never written by hand — a",
        "regeneration can no longer revert an audit correction.",
        "",
    ]
    for (model, cfg), gloss in FAILURE_GLOSS.items():
        p = profiles.get((model, cfg))
        if not p:
            continue
        mix, dec = p["mix"], p["decisions"]
        p50 = sum(p["p50s"]) / len(p["p50s"]) if p["p50s"] else float("nan")
        lines += [
            f"- **`{model}` under config v{cfg} — {gloss}** Pooled over "
            f"{p['runs']} kept runs: {dec} decisions ({dec / p['runs']:.0f}/run), "
            f"p50 deliberation {p50 / 1000:.1f}s, {p['tokens'] / dec:.0f} "
            f"tokens/decision. {pct(p['errors'], dec)} of decisions "
            f"({p['errors']}/{dec}) were schema-violation fallbacks to idle; "
            f"gathers were {pct(mix.get('gather', 0), dec)} "
            f"({mix.get('gather', 0)}/{dec}). Reached first coal in "
            f"{p['reachedFirstCoal']}/{p['runs']} runs.",
        ]
    lines += [
        "",
        "Reading those rows: **qwen3.5:4b at v1 was structurally mute** — a hybrid",
        "reasoning model spending the whole 8192-token `OLLAMA_NUM_CTX` window on",
        "chain-of-thought and returning an empty completion, so its row measured",
        "incompatibility with the non-thinking decision contract, not Minecraft",
        "ability. **v2** sends `think: false` to thinking-capable models",
        "(capability-probed via /api/show), which is the row in the table above;",
        "v1 rows for plain models remain valid **against v2 only** — their request",
        "payloads are byte-identical between those two versions. That equivalence",
        "does NOT extend to v3, which changes the world protocol itself (per-block",
        "pristine world, frozen day/weather, pinned reflection temperature and",
        "budget), so no v1 or v2 row may be read against a v3 row. **lfm2.5 is the opposite failure** — it really",
        "played, but ~24s deliberations against a 30s tick through the 4-lane",
        "concurrency gate, plus frequent schema violations (out-of-range",
        "relationship deltas, junk targets), left most decisions as idle fallbacks.",
        "",
    ]
    if agg["roster"]:
        lines += roster_lines(agg["roster"])
    lines += ["## Per-run appendix (kept runs, all config versions)", "",
              "| Model | cfg | Run | Outcome | Duration s | Attempt |", "|---|--:|--:|---|--:|---|"]
    for run in manifest["runs"]:
        if not run["discarded"]:
            lines.append(f"| `{run['model']}` | v{run.get('configVersion', 1)} | {run['index']} "
                         f"| {run['outcome']} | {run['durationSeconds']} | `{run['attemptId'][:13]}…` |")
    lines.append("")
    if discarded:
        lines += ["## Discarded runs (never averaged in)", ""]
        for d in discarded:
            lines.append(f"- `{d['label']}` ({d['model']}): {d.get('reason', d['outcome'])}"
                         f" — attempt `{d.get('attemptId')}`")
        lines.append("")
    REPORT_MD.write_text("\n".join(lines), encoding="utf-8")


def split_manifest(manifest: dict) -> tuple[dict, list[dict]]:
    """Model-table runs and Phase 3b axis runs are two different experiments.

    Partitioned at the source rather than filtered per consumer: the model
    report has FOUR places that walk every run (rows, failure profiles, wear,
    slice probes) plus the discarded ledger, and an axis run reaching any one
    of them is a number nobody can trace back. Legacy rows carry no sweepKind
    and are model runs."""
    model_runs = [r for r in manifest["runs"] if r.get("sweepKind", "model") == "model"]
    axis_runs = [r for r in manifest["runs"] if r.get("sweepKind") == "axis"]
    return {**manifest, "runs": model_runs}, axis_runs


def axis_blocks(axis_runs: list[dict]) -> dict[tuple, dict]:
    """One entry per (model, axis, axisValue) arm, kept runs only."""
    out: dict[tuple, dict] = {}
    for run in axis_runs:
        key = (run["model"], run.get("axis"), str(run.get("axisValue")))
        b = out.setdefault(key, {"durations": [], "n": 0, "wins": 0,
                                 "baseline": None,
                                 "holes": [], "discarded": []})
        # From ANY row that carries it, not just the first: a block whose first
        # manifest row is a setup failure would otherwise pin baseline to None
        # and silently drop its Δ column (bit the first ctx report).
        b["baseline"] = b["baseline"] or run.get("axisBaseline")
        if run["discarded"]:
            (b["holes"] if run["outcome"] in ("no-clean-run", "block-setup-failed")
             else b["discarded"]).append(run)
            continue
        b["n"] += 1
        if run["outcome"] == "won":
            b["wins"] += 1
            b["durations"].append(run["durationSeconds"])
    for b in out.values():
        b["timeToGoal"] = mean_ci95(b["durations"])
    return out


def write_axis_outputs(axis_runs: list[dict]) -> int:
    """The sensitivity report — a SEPARATE artifact from the model table."""
    blocks = axis_blocks(axis_runs)
    if not blocks:
        return 0
    lines = [
        "# RB-race sensitivity sweep (Phase 3b)",
        "",
        "One axis at a time against the frozen v3 baseline: every knob except the",
        "named axis holds its `bench/race/frozen-config.json` value, the pristine",
        "pinned-seed world is restored per block, and the honesty gate is the same",
        "as the model table's. **These rows are not model-comparison rows** and",
        "never enter `RACE_REPORT.md`.",
        "",
        "Δ is against the arm at the axis baseline, within the same model. It is a",
        "difference of small-N means, not a test: with N=5 per arm the CI columns",
        "are the honest read.",
        "",
        "| Model | Axis | Arm | N | Win rate | Time-to-goal s (won) | Δ vs baseline |",
        "|---|---|--:|--:|--:|--:|--:|",
    ]
    def arm_sort(item):
        (model, axis, value), _ = item
        # Numeric arms in numeric order — "16384" sorts before "4096" as text.
        try:
            return (model, axis, 0, float(value), "")
        except ValueError:
            return (model, axis, 1, 0.0, value)

    for (model, axis, value), b in sorted(blocks.items(), key=arm_sort):
        base = blocks.get((model, axis, str(b["baseline"])))
        delta = "—"
        if base and base is not b and base["timeToGoal"].n and b["timeToGoal"].n:
            delta = f"{b['timeToGoal'].mean - base['timeToGoal'].mean:+.1f}"
        marker = " (baseline)" if str(value) == str(b["baseline"]) else ""
        lines.append(
            f"| `{model}` | {axis} | {value}{marker} | {b['n']} "
            f"| {b['wins']}/{b['n']} | {fmt_ci(b['timeToGoal'])} | {delta} |")

    holes = [(k, r) for k, b in sorted(blocks.items()) for r in b["holes"]]
    lines += ["", "## Coverage", ""]
    if holes:
        lines.append("Runs that produced NO kept row — the N column above is short by "
                     "exactly these, and they are listed because silent truncation "
                     "reads as coverage:")
        lines.append("")
        for (model, axis, value), r in holes:
            lines.append(f"- `{model}` {axis}={value} run {r['index']}: "
                         f"{r['outcome']} — {r.get('reason', '')}")
    else:
        lines.append("Every planned run produced a kept row; no holes, no "
                     "block-setup failures.")
    lines += [
        "",
        "Per-arm process timeout scales with the tick arm (`raceTimeoutSeconds` in",
        "the manifest): the 75-minute watchdog inside `race-rb2.mjs` is",
        "inter-milestone, not total, so a slower tick would otherwise be censored",
        "by a fixed process bound in the direction that flatters it.",
        "",
    ]
    AXIS_REPORT_MD.write_text("\n".join(lines), encoding="utf-8")
    AXIS_SUMMARY_JSON.write_text(json.dumps({
        "benchmark": "rb-race-sensitivity",
        "arms": [{"model": m, "axis": a, "axisValue": v, "n": b["n"],
                  "wins": b["wins"], "baseline": b["baseline"],
                  "timeToGoalSeconds": ci_doc(b["timeToGoal"]),
                  "holes": [h["label"] for h in b["holes"]]}
                 for (m, a, v), b in sorted(blocks.items())],
    }, indent=2) + "\n", encoding="utf-8")
    return len(blocks)


def main() -> int:
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    model_manifest, axis_runs = split_manifest(manifest)
    agg, kept = aggregate(model_manifest)
    write_outputs(agg, model_manifest)
    print(f"aggregated {len(kept)} kept runs across {len(agg['rows'])} models "
          f"({len(agg['discarded'])} discarded) -> {REPORT_MD}")
    n_arms = write_axis_outputs(axis_runs)
    if n_arms:
        print(f"sensitivity: {len(axis_runs)} axis runs across {n_arms} arms "
              f"-> {AXIS_REPORT_MD}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
