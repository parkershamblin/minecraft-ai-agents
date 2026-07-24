"""Percentile + summary helpers — stdlib only (no numpy on the service venvs).

Percentiles use the nearest-rank-with-interpolation method on the sorted
sample, which is what we want for latency tails: p95 of 20 samples lands
between the 19th and 20th ordered value rather than snapping to one of them.
"""

from __future__ import annotations

import math
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


# Two-tailed 95% critical values of Student's t by degrees of freedom.
# Stdlib has no inverse-t; a table is exact for the df range benchmark sweeps
# actually hit (N>=5 → df>=4). Above 30 the normal approximation is <1% off.
_T_CRIT_95 = {
    1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365,
    8: 2.306, 9: 2.262, 10: 2.228, 11: 2.201, 12: 2.179, 13: 2.160,
    14: 2.145, 15: 2.131, 16: 2.120, 17: 2.110, 18: 2.101, 19: 2.093,
    20: 2.086, 21: 2.080, 22: 2.074, 23: 2.069, 24: 2.064, 25: 2.060,
    26: 2.056, 27: 2.052, 28: 2.048, 29: 2.045, 30: 2.042,
}
_Z_95 = 1.960


@dataclass(frozen=True)
class MeanCI95:
    """Sample mean with a Student-t 95% confidence interval (GovSim-style
    N-run aggregation). half is NaN when n < 2 — one run has no interval."""

    n: int
    mean: float
    half: float

    @property
    def low(self) -> float:
        return self.mean - self.half

    @property
    def high(self) -> float:
        return self.mean + self.half


def mean_ci95(values: list[float]) -> MeanCI95:
    if not values:
        return MeanCI95(0, float("nan"), float("nan"))
    n = len(values)
    mean = sum(values) / n
    if n < 2:
        return MeanCI95(n, mean, float("nan"))
    variance = sum((v - mean) ** 2 for v in values) / (n - 1)
    se = math.sqrt(variance / n)
    t = _T_CRIT_95.get(n - 1, _Z_95)
    return MeanCI95(n, mean, t * se)


def pct_delta(baseline: float, treatment: float) -> float:
    """Signed % change treatment vs baseline. Negative = treatment lower."""
    if baseline == 0:
        return float("nan") if treatment == 0 else float("inf")
    return (treatment - baseline) / baseline * 100.0
