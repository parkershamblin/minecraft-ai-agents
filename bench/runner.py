"""Shared A/B benchmark runner.

A *bench* declares two or more *arms* (baseline vs treatment) that each run the
SAME workload through a different code path, plus an optional correctness check
that proves the treatment preserves behaviour. The runner:

  * runs each arm WARMUP + ITERS times and DISCARDS the warmup window
    (the project's own MSPT rule: the first reads after a cold start are the
    world-gen spike, not steady state — docs/reports/bottleneck-report line 108
    and CLAUDE.md's "let the 1-minute window roll" gotcha),
  * summarises every numeric metric an arm returns as p50/p95/p99/mean/min/max,
  * computes the treatment-vs-baseline delta on the bench's PRIMARY metric,
  * writes per-iteration raw CSV + a JSON summary under bench/results/.

An arm is `async def (ctx) -> dict[str, float]`: it performs one iteration of
the workload and returns that iteration's raw metrics. Metric keys must be
stable across arms so they can be compared.
"""

from __future__ import annotations

import csv
import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path

from stats import MetricStats, pct_delta

Arm = Callable[[], Awaitable[dict[str, float]]]

RESULTS_DIR = Path(__file__).resolve().parent / "results"


@dataclass
class BenchSpec:
    key: str
    title: str
    description: str
    # The report claim this bench confirms/refutes, quoted for the write-up.
    report_ref: str
    # metric key the delta headline is computed on, and whether lower is better.
    primary_metric: str
    lower_is_better: bool = True
    iters: int = 30
    warmup: int = 5
    arms: dict[str, Arm] = field(default_factory=dict)
    baseline_arm: str = "baseline"
    treatment_arm: str = "treatment"
    # Optional behaviour-preservation check: returns (passed, detail).
    correctness: Callable[[], Awaitable[tuple[bool, str]]] | None = None


@dataclass
class ArmResult:
    name: str
    raw: list[dict[str, float]]
    stats: dict[str, MetricStats]


@dataclass
class BenchResult:
    spec: BenchSpec
    arms: dict[str, ArmResult]
    correctness_passed: bool | None
    correctness_detail: str

    def primary_delta_pct(self) -> float:
        b = self.arms[self.spec.baseline_arm].stats[self.spec.primary_metric].p50
        t = self.arms[self.spec.treatment_arm].stats[self.spec.primary_metric].p50
        return pct_delta(b, t)


async def _run_arm(name: str, fn: Arm, iters: int, warmup: int) -> ArmResult:
    raw: list[dict[str, float]] = []
    for i in range(warmup + iters):
        sample = await fn()
        if i >= warmup:  # discard the warm-up window
            raw.append(sample)
    metrics = sorted({k for row in raw for k in row})
    stats = {m: MetricStats.of([row[m] for row in raw if m in row]) for m in metrics}
    return ArmResult(name=name, raw=raw, stats=stats)


async def run_bench(spec: BenchSpec) -> BenchResult:
    arms: dict[str, ArmResult] = {}
    for name, fn in spec.arms.items():
        arms[name] = await _run_arm(name, fn, spec.iters, spec.warmup)

    passed: bool | None = None
    detail = "no correctness check"
    if spec.correctness is not None:
        passed, detail = await spec.correctness()

    result = BenchResult(spec, arms, passed, detail)
    _write_artifacts(result)
    return result


def _write_artifacts(result: BenchResult) -> None:
    RESULTS_DIR.mkdir(exist_ok=True)
    spec = result.spec

    # per-iteration raw CSV (one row per arm-iteration)
    metric_keys = sorted({m for arm in result.arms.values() for m in arm.stats})
    csv_path = RESULTS_DIR / f"{spec.key}.csv"
    with csv_path.open("w", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow(["arm", "iter", *metric_keys])
        for arm in result.arms.values():
            for i, row in enumerate(arm.raw):
                writer.writerow([arm.name, i, *(row.get(m, "") for m in metric_keys)])

    # JSON summary (stats per arm + headline delta + correctness)
    summary = {
        "key": spec.key,
        "title": spec.title,
        "report_ref": spec.report_ref,
        "primary_metric": spec.primary_metric,
        "lower_is_better": spec.lower_is_better,
        "iters": spec.iters,
        "warmup": spec.warmup,
        "primary_delta_pct_p50": result.primary_delta_pct(),
        "correctness_passed": result.correctness_passed,
        "correctness_detail": result.correctness_detail,
        "arms": {
            name: {
                m: vars(s) for m, s in arm.stats.items()
            }
            for name, arm in result.arms.items()
        },
    }
    (RESULTS_DIR / f"{spec.key}.json").write_text(json.dumps(summary, indent=2))
