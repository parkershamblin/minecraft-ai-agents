"""Percentile + summary helpers — stdlib only (no numpy on the service venvs).

Percentiles use the nearest-rank-with-interpolation method on the sorted
sample, which is what we want for latency tails: p95 of 20 samples lands
between the 19th and 20th ordered value rather than snapping to one of them.
"""

from __future__ import annotations

from dataclasses import dataclass


def percentile(values: list[float], q: float) -> float:
    """q in [0, 100]. Linear interpolation between closest ranks."""
    if not values:
        return float("nan")
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    rank = (q / 100.0) * (len(ordered) - 1)
    low = int(rank)
    high = min(low + 1, len(ordered) - 1)
    frac = rank - low
    return ordered[low] + (ordered[high] - ordered[low]) * frac


@dataclass(frozen=True)
class MetricStats:
    n: int
    mean: float
    p50: float
    p95: float
    p99: float
    minimum: float
    maximum: float

    @classmethod
    def of(cls, values: list[float]) -> "MetricStats":
        if not values:
            return cls(0, float("nan"), float("nan"), float("nan"), float("nan"), float("nan"), float("nan"))
        return cls(
            n=len(values),
            mean=sum(values) / len(values),
            p50=percentile(values, 50),
            p95=percentile(values, 95),
            p99=percentile(values, 99),
            minimum=min(values),
            maximum=max(values),
        )


def pct_delta(baseline: float, treatment: float) -> float:
    """Signed % change treatment vs baseline. Negative = treatment lower."""
    if baseline == 0:
        return float("nan") if treatment == 0 else float("inf")
    return (treatment - baseline) / baseline * 100.0
