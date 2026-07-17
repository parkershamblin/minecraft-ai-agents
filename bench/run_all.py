"""Run every registered bench and emit bench/results/REPORT.md.

Run from the agent-service venv so the real service modules import:

    cd services/agent-service
    uv run python ../../bench/run_all.py
"""

from __future__ import annotations

import asyncio
import logging
import sys
from pathlib import Path

logging.disable(logging.INFO)  # hush the service's per-publish debug logs during benching

BENCH_DIR = Path(__file__).resolve().parent
REPO_ROOT = BENCH_DIR.parent
# make the real service packages importable (faithful A/B against shipped code).
# Run from the agent-service venv: its deps are a superset of what the memory
# bench imports (structlog, prometheus_client, pydantic), so both import cleanly.
sys.path.insert(0, str(REPO_ROOT / "services" / "agent-service" / "src"))
sys.path.insert(0, str(REPO_ROOT / "services" / "memory-service" / "src"))
sys.path.insert(0, str(BENCH_DIR))

import bench_llm_gate
import bench_producer_batch
import bench_query_cache
import bench_relationship_batch
from runner import BenchResult, run_bench

BENCHES = [
    bench_llm_gate.spec(),
    bench_producer_batch.spec(),
    bench_relationship_batch.spec(),
    bench_query_cache.spec(),
]


def _fmt(x: float) -> str:
    if x != x:  # nan
        return "-"
    if abs(x) >= 100:
        return f"{x:.0f}"
    if abs(x) >= 10:
        return f"{x:.1f}"
    return f"{x:.2f}"


def _bench_section(result: BenchResult) -> str:
    spec = result.spec
    b = result.arms[spec.baseline_arm]
    t = result.arms[spec.treatment_arm]
    lines = [
        f"### {spec.title}",
        "",
        f"*{spec.description}*",
        "",
        f"**Confirms:** {spec.report_ref}",
        "",
    ]
    if result.correctness_passed is not None:
        badge = "✅ PASS" if result.correctness_passed else "❌ FAIL"
        lines += [f"**Behaviour-preservation:** {badge} — {result.correctness_detail}", ""]

    lines += [
        "| metric | baseline p50 | baseline p95 | treatment p50 | treatment p95 | Δ p50 |",
        "|---|--:|--:|--:|--:|--:|",
    ]
    for m in sorted(b.stats):
        bp50, bp95 = b.stats[m].p50, b.stats[m].p95
        tp50, tp95 = t.stats[m].p50, t.stats[m].p95
        from stats import pct_delta
        d = pct_delta(bp50, tp50)
        star = " **←**" if m == spec.primary_metric else ""
        lines.append(
            f"| `{m}`{star} | {_fmt(bp50)} | {_fmt(bp95)} | {_fmt(tp50)} | {_fmt(tp95)} | {_fmt(d)}% |"
        )
    lines.append("")
    return "\n".join(lines)


def _headline(result: BenchResult) -> str:
    spec = result.spec
    d = result.primary_delta_pct()
    corr = ""
    if result.correctness_passed is not None:
        corr = " · behaviour preserved" if result.correctness_passed else " · ⚠ BEHAVIOUR CHANGED"
    return f"- **{spec.title}** — `{spec.primary_metric}` {_fmt(d)}% (p50){corr}"


async def main() -> None:
    results = [await run_bench(spec) for spec in BENCHES]

    report = [
        "# Bottleneck-fix benchmark report",
        "",
        "Faithful in-process A/B micro-benchmarks for the shipped bottleneck fixes in "
        "agent-service and memory-service. Each bench runs the SAME workload through "
        "the shipped code path (treatment) and a reconstruction of the pre-fix path "
        "(baseline), discards a warm-up window, and reports p50/p95 over the remaining "
        "iterations. Backends (GPU, broker, DB, embedding endpoint) are modeled "
        "deterministically so numbers are reproducible and reflect the structural "
        "change, not host noise or a live GPU. The event-service (Java) and "
        "minecraft-service (Node) fixes ship with their own in-language test suites and "
        "are out of scope for this Python in-process harness — see the bottleneck report "
        "for those. Run: `cd services/agent-service && uv run python ../../bench/run_all.py`.",
        "",
        "## Headline",
        "",
        *[_headline(r) for r in results],
        "",
        "## Method notes",
        "",
        "- **Warm-up discarded** every bench drops its first iterations before measuring — "
        "the project's own MSPT rule (post-boot world-gen spike is not steady state).",
        "- **Real code under test** the LLM gate drives the shipped `OllamaProvider` semaphore; "
        "the producer bench drives the shipped `EventPublisher.publish`/`flush`; the relationship "
        "correctness fold uses the shipped `_clamp` and `GRUDGE_AFFINITY_THRESHOLD`; the "
        "query-cache bench drives the shipped `QueryEmbeddingCache` LRU over a real "
        "`FakeEmbeddingProvider`.",
        "- **Models, not live infra** GPU/broker/DB/embedding latencies are modeled so the delta "
        "isolates the structural change. Whole-stack soak numbers (Prometheus before/after) are the "
        "next layer and need a dedicated load run.",
        "",
        "## Benches",
        "",
        *[_bench_section(r) for r in results],
        "## Raw data",
        "",
        "Per-iteration CSV and JSON summaries are in `bench/results/*.csv` / `*.json`.",
        "",
    ]
    out = BENCH_DIR / "results" / "REPORT.md"
    out.parent.mkdir(exist_ok=True)
    out.write_text("\n".join(report), encoding="utf-8")

    # console summary
    print("\n=== bottleneck-fix bench summary ===")
    for r in results:
        print(_headline(r).replace("**", "").lstrip("- "))
        if r.correctness_passed is False:
            print(f"    !! correctness FAILED: {r.correctness_detail}")
    print(f"\nreport: {out}")


if __name__ == "__main__":
    asyncio.run(main())
