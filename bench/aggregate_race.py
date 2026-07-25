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
  * Latency p50: per-run value is the decision-weighted mean of the two team p50s
    (raw latencies are not retained across the ledger fetch).

Run:  uv run python bench/aggregate_race.py
"""

from __future__ import annotations

import csv
import json
import math
import sys
from pathlib import Path

from stats import MeanCI95, mean_ci95

BENCH_DIR = Path(__file__).resolve().parent
RESULTS_DIR = BENCH_DIR / "results"
MANIFEST_PATH = RESULTS_DIR / "sweep" / "manifest.json"
SUMMARY_JSON = RESULTS_DIR / "race_sweep_summary.json"
SUMMARY_CSV = RESULTS_DIR / "race_sweep_summary.csv"
REPORT_MD = RESULTS_DIR / "RACE_REPORT.md"

TIER_B_METRICS = ("gatherEfficiency", "wasteRatio", "tokensUsed", "latencyMsP50")


def pooled_tier_b(tier_b: dict) -> dict[str, float | None]:
    """Both teams run the same model: pool team counters into one per-run value."""
    gathered = sum(t["gatheredTotal"] for t in tier_b.values())
    requests = sum(t["gatherRequests"] for t in tier_b.values())
    actions = sum(t["actionsRequested"] for t in tier_b.values())
    failures = sum(t["actionsFailed"] for t in tier_b.values())
    tokens = sum(t["llm"]["tokensUsed"] for t in tier_b.values())
    weighted = [(t["llm"]["latencyMsP50"], t["llm"]["decisions"]) for t in tier_b.values()
                if t["llm"]["latencyMsP50"] is not None and t["llm"]["decisions"]]
    total_decisions = sum(w for _, w in weighted)
    return {
        "gatherEfficiency": gathered / requests if requests else None,
        "wasteRatio": failures / actions if actions else None,
        "tokensUsed": float(tokens),
        "latencyMsP50": (sum(v * w for v, w in weighted) / total_decisions
                         if total_decisions else None),
    }


def ci_doc(ci: MeanCI95) -> dict:
    return {"n": ci.n, "mean": ci.mean, "ci95Half": ci.half}


def fmt_ci(ci: MeanCI95, digits: int = 1) -> str:
    if ci.n == 0 or math.isnan(ci.mean):
        return "—"
    if ci.n < 2 or math.isnan(ci.half):
        return f"{ci.mean:.{digits}f} (n=1)"
    return f"{ci.mean:.{digits}f} ± {ci.half:.{digits}f}"


def aggregate(manifest: dict) -> tuple[dict, list[dict]]:
    models: dict[str, dict] = {}
    all_kept = [r for r in manifest["runs"] if not r["discarded"]]
    discarded = [r for r in manifest["runs"] if r["discarded"]]
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
                                             **{k: [] for k in TIER_B_METRICS}})
        m["runs"].append(run["label"])
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
            "gatherEfficiency": mean_ci95(m["gatherEfficiency"]),
            "wasteRatio": mean_ci95(m["wasteRatio"]),
            "tokensUsed": mean_ci95(m["tokensUsed"]),
            "latencyMsP50": mean_ci95(m["latencyMsP50"]),
        })
    # Table order: best first — highest win rate, then fastest mean time-to-goal.
    rows.sort(key=lambda r: (-r["winRate"],
                             r["timeToGoalSeconds"].mean
                             if not math.isnan(r["timeToGoalSeconds"].mean) else float("inf")))
    return {"rows": rows, "discarded": discarded}, kept


def write_outputs(agg: dict, manifest: dict) -> None:
    rows, discarded = agg["rows"], agg["discarded"]

    doc = {
        "benchmark": "rb-race-sweep",
        "frozenConfig": manifest.get("frozenConfig"),
        "startedAt": manifest.get("startedAt"),
        "models": [{**r,
                    "timeToGoalSeconds": ci_doc(r["timeToGoalSeconds"]),
                    "gatherEfficiency": ci_doc(r["gatherEfficiency"]),
                    "wasteRatio": ci_doc(r["wasteRatio"]),
                    "tokensUsed": ci_doc(r["tokensUsed"]),
                    "latencyMsP50": ci_doc(r["latencyMsP50"])} for r in rows],
        "discardedRuns": discarded,
    }
    SUMMARY_JSON.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")

    with SUMMARY_CSV.open("w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["model", "metric", "n", "mean", "ci95Half"])
        for r in rows:
            w.writerow([r["model"], "winRate", r["n"], r["winRate"], ""])
            for key in ("timeToGoalSeconds", "gatherEfficiency", "wasteRatio",
                        "tokensUsed", "latencyMsP50"):
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
        "| Model | cfg | N | Win rate | Time-to-goal s (won) | Gather eff. (blocks/req) | Waste ratio | Tokens/run | Latency p50 ms |",
        "|---|--:|--:|--:|--:|--:|--:|--:|--:|",
    ]
    for r in rows:
        lines.append(
            f"| `{r['model']}` | v{r['configVersion']} | {r['n']} | {r['wins']}/{r['n']} "
            f"| {fmt_ci(r['timeToGoalSeconds'])} | {fmt_ci(r['gatherEfficiency'], 2)} "
            f"| {fmt_ci(r['wasteRatio'], 3)} | {fmt_ci(r['tokensUsed'], 0)} "
            f"| {fmt_ci(r['latencyMsP50'], 0)} |")
    lines += [
        "",
        "Reference record under this config's knobs but NOT this protocol: Easy",
        "mob-free **360.4s** (`019f7337`) — set at the 10s race tick with per-team",
        "models and default temperature, so it is a ceiling reference, not a row.",
        "Reproduce any row:",
        "`uv run --with httpx python bench/sweep_race.py --models <model> --runs 5`",
        "then `uv run python bench/aggregate_race.py`.",
        "",
        "## Method caveats",
        "",
        "- **Greedy decoding was truly in effect for the first time this sweep**:",
        "  compose never passed `LLM_TEMPERATURE` into agent-service before this",
        "  branch, so all pre-sweep reference runs sampled at the 0.7 default.",
        "- **Blocked run order on a shared persistent world**: blocks ran",
        "  llama3.1:8b → gemma3:12b → gemma4 → qwen3.5:4b → lfm2.5 without world",
        "  resets; within-block run index correlates with world wear (see the",
        "  per-run appendix — llama3.1 drifts 700.9→1301.8s across its block).",
        "  Model and world age are therefore partially confounded across blocks.",
        "- **DNF Tier B windows are watchdog-length** (~75 min vs ~10-30 min for",
        "  wins), so token totals for 0-win models measure a longer window; the",
        "  gemma3:12b tokens CI is inflated by its one DNF for the same reason.",
        "- **Latency p50 is a decision-weighted mean of team p50s** per run, not a",
        "  pooled raw-latency percentile (raw latencies are not retained).",
        "",
        "## Failure modes of the 0-win models (diagnosed from ledger + logs)",
        "",
        "- **qwen3.5:4b under v1 — structurally mute.** Hybrid reasoning model: it",
        "  burned the entire 8192-token `OLLAMA_NUM_CTX` window on chain-of-thought",
        "  and returned an EMPTY completion (~112s p50, exactly 8192",
        "  tokens/decision); every deliberation fell back to idle. That row",
        "  measured incompatibility with the non-thinking decision contract, not",
        "  Minecraft ability. **v2** sends `think: false` to thinking-capable",
        "  models (capability-probed via /api/show); qwen's current row is the",
        "  v2 re-bench. v1 rows for plain models remain valid — their request",
        "  payloads are byte-identical under v2.",
        "- **lfm2.5 — engaged but too slow and sloppy.** Real gameplay (~560",
        "  decisions/run, 54% gathers, wood collected) but ~23s deliberations at a",
        "  30s tick through the 4-lane concurrency gate, ~40% idle, and frequent",
        "  schema violations (out-of-range relationship deltas, junk targets)",
        "  falling back to idle — never reached first coal in 75 minutes.",
        "",
    ]
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


def main() -> int:
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    agg, kept = aggregate(manifest)
    write_outputs(agg, manifest)
    print(f"aggregated {len(kept)} kept runs across {len(agg['rows'])} models "
          f"({len(agg['discarded'])} discarded) -> {REPORT_MD}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
