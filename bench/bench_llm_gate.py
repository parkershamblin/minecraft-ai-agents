"""#1 (Critical) — LLM concurrency gate.

Report: "All 20 tick loops run concurrently, but each awaits provider.complete()
against a single shared backend ... a single local GPU thrashes under 20 parallel
completions; queued ticks wait here on purpose" (bottleneck-report §1, providers.py:194).

We drive the REAL `OllamaProvider.complete()` — the actual shipped `asyncio.Semaphore`
gate — and override only `_complete` (the network call) with a modeled backend.
The single knob that differs between arms is the real tunable
`llm_max_concurrent_requests`:

  * baseline  = gate wide open (max_concurrent = fleet size) -> ungated fan-out
  * treatment = gate at the shipped default (4)

Backend model: one serialising resource (a single GPU). Per-request latency grows
with the number of in-flight requests — linearly up to a `knee` (fair-share token
generation), then SUPERLINEARLY beyond it (VRAM pressure / thrash). This is a model,
not a measured 4090 number; its job is to show that capping concurrency at the knee
avoids the superlinear region, which is exactly the gate's design claim.
"""

from __future__ import annotations

import asyncio
import random
import time

import httpx

from agent_service.llm.providers import LLMResponse, OllamaProvider

from runner import BenchSpec

FLEET = 20          # concurrent ticks hitting the one backend
BASE_MS = 6.0       # single-request service time with nothing else in flight
KNEE = 4            # concurrency the backend absorbs before it starts thrashing
THRASH = 0.06       # superlinear penalty per in-flight request past the knee
JITTER = 0.10       # ±10% per-request noise -> a realistic latency tail
_RNG = random.Random(20260717)  # seeded: the run is reproducible


class _ModeledBackend:
    """A single serialising GPU. `inflight` is safe to read/mutate without a lock:
    asyncio is single-threaded and we only touch it between awaits."""

    def __init__(self) -> None:
        self.inflight = 0

    async def call(self) -> float:
        self.inflight += 1
        c = self.inflight
        over = max(0, c - KNEE)
        noise = 1.0 + _RNG.uniform(-JITTER, JITTER)
        latency_ms = BASE_MS * c * (1.0 + THRASH * over) * noise
        try:
            await asyncio.sleep(latency_ms / 1000.0)
        finally:
            self.inflight -= 1
        return latency_ms


class _BenchProvider(OllamaProvider):
    """Real gate (inherited complete() + semaphore); modeled transport."""

    def __init__(self, backend: _ModeledBackend, max_concurrent: int):
        # httpx client is never used — _complete is overridden — but the real
        # __init__ builds the semaphore we are here to exercise.
        super().__init__("http://unused", "bench", 0.0, httpx.AsyncClient(), max_concurrent)
        self._backend = backend

    async def _complete(self, system: str, user: str) -> LLMResponse:
        latency_ms = await self._backend.call()
        return LLMResponse(
            text="{}", tokens_in=0, tokens_out=0,
            latency_seconds=latency_ms / 1000.0, provider="bench", model="bench",
        )


def _make_arm(max_concurrent: int):
    async def arm() -> dict[str, float]:
        backend = _ModeledBackend()
        provider = _BenchProvider(backend, max_concurrent)
        started = time.perf_counter()
        # per-call latency, measured end to end (queue wait + service), as a tick sees it
        latencies = await asyncio.gather(
            *(provider.complete("s", "u") for _ in range(FLEET))
        )
        wall_ms = (time.perf_counter() - started) * 1000.0
        await provider._client.aclose()
        per_call = sorted(r.latency_seconds * 1000.0 for r in latencies)
        return {
            "batch_wall_ms": wall_ms,          # time for all 20 ticks to finish deliberating
            "call_p50_ms": per_call[len(per_call) // 2],
            "call_max_ms": per_call[-1],       # the worst-served tick this round
        }

    return arm


def spec() -> BenchSpec:
    return BenchSpec(
        key="llm_gate",
        title="LLM concurrency gate (agent-service #1, Critical)",
        description=(
            f"{FLEET} concurrent ticks against one modeled GPU that thrashes past "
            f"{KNEE} in-flight. Baseline = ungated fan-out; treatment = shipped "
            f"semaphore cap of {KNEE}."
        ),
        report_ref="bottleneck-report §1 / providers.py:194 (asyncio.Semaphore backpressure)",
        primary_metric="batch_wall_ms",
        lower_is_better=True,
        iters=40,
        warmup=8,
        arms={
            "baseline": _make_arm(FLEET),   # gate effectively open
            "treatment": _make_arm(KNEE),   # gate at the shipped default
        },
    )
