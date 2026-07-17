"""memory-service — query-embedding cache (bottleneck-report Tier-3, §4 relative).

Report: "Uncached embedding calls on every memory read AND write ... one HTTP
round-trip each, never batched or cached. An LRU keyed on (model, query) ...
reclaims fixed latency per tick" (bottleneck-report Tier-3, service.py:107,140).
Shipped in 7c1147f as `QueryEmbeddingCache` (embeddings.py:29) on the READ path
only (writes own their vector and stay uncached).

We drive the REAL shipped `QueryEmbeddingCache.embed()` — the actual OrderedDict
LRU — over a real, deterministic `FakeEmbeddingProvider` wrapped in a call counter.
Only the *pattern of queries* is modeled; the cache logic under test is the shipped
code. Each embedding miss costs one modeled backend round-trip (EMBED_MS); the
count of those round-trips is the deterministic, noise-free headline.

Workload: a short retrieval window (QUERIES reads) whose salient queries are drawn
from a small HOT pool — villagers re-issue similar retrieval keys across a tick
window, so most reads after the first repeat a warm key.

  * baseline  = no cache: every read embeds -> QUERIES round-trips
  * treatment = shipped QueryEmbeddingCache -> one round-trip per DISTINCT key
"""

from __future__ import annotations

import random

# agent-service and memory-service each register the same civ_llm_* Prometheus
# families in their own process; imported side-by-side in this one bench process
# the second registration collides. Never happens in prod (separate processes) —
# here we swallow the duplicate only while importing the memory package. The
# metric objects still work (observe/inc don't need the global registry); they
# just aren't double-exported by a bench that scrapes nothing.
import prometheus_client.registry as _prom_registry

_orig_register = _prom_registry.CollectorRegistry.register


def _lenient_register(self, collector):  # noqa: ANN001
    try:
        _orig_register(self, collector)
    except ValueError:
        pass  # cross-service metric-name collision in this single-process harness


_prom_registry.CollectorRegistry.register = _lenient_register
try:
    from memory_service.embeddings import FakeEmbeddingProvider, QueryEmbeddingCache
finally:
    _prom_registry.CollectorRegistry.register = _orig_register

from runner import BenchSpec

QUERIES = 20          # retrievals in one short window
HOT_POOL = 5          # distinct salient queries the window draws from
EMBED_MS = 8.0        # one modeled embedding backend round-trip (ollama/openai ballpark)
_RNG = random.Random(20260717)  # seeded: reproducible query order


def _window() -> list[str]:
    """A window of reads: QUERIES draws from HOT_POOL distinct keys, seeded so
    every arm and run sees the identical sequence (isolates the cache, not luck)."""
    pool = [f"what happened near the well at hour {i}" for i in range(HOT_POOL)]
    rng = random.Random(20260717)  # fresh, identical stream per arm
    return [rng.choice(pool) for _ in range(QUERIES)]


class _CountingProvider:
    """Wraps the REAL deterministic FakeEmbeddingProvider and counts embed() calls
    — each call is one modeled backend round-trip. Vectors are the provider's real
    output so the correctness fold compares actual shipped embeddings."""

    def __init__(self) -> None:
        self._inner = FakeEmbeddingProvider(dim=768)
        self.name = self._inner.name
        self.dim = self._inner.dim
        self.round_trips = 0

    async def embed(self, text: str) -> list[float]:
        self.round_trips += 1
        return await self._inner.embed(text)


async def _baseline() -> dict[str, float]:
    """OLD read path: no cache, every retrieval embeds the query afresh."""
    provider = _CountingProvider()
    for q in _window():
        await provider.embed(q)
    rt = provider.round_trips
    return {"embedding_round_trips": float(rt), "modeled_window_ms": rt * EMBED_MS}


async def _treatment() -> dict[str, float]:
    """NEW read path: the shipped QueryEmbeddingCache dedupes repeated keys."""
    provider = _CountingProvider()
    cache = QueryEmbeddingCache(provider, capacity=512)  # real shipped LRU
    for q in _window():
        await cache.embed(q)
    rt = provider.round_trips
    return {"embedding_round_trips": float(rt), "modeled_window_ms": rt * EMBED_MS}


async def _correctness() -> tuple[bool, str]:
    """The cache must return the SAME vector the backend would, and must embed
    each distinct key exactly once — a stale or wrong cached vector would poison
    every downstream cosine-distance retrieval."""
    provider = _CountingProvider()
    truth = FakeEmbeddingProvider(dim=768)  # ground-truth vectors, uncached
    cache = QueryEmbeddingCache(provider, capacity=512)
    for q in _window():
        got = await cache.embed(q)
        want = await truth.embed(q)
        if got != want:
            return False, f"cache returned a wrong vector for {q!r}"
    ok = provider.round_trips == HOT_POOL
    return ok, (
        f"{QUERIES} reads over {HOT_POOL} distinct keys: backend hit "
        f"{provider.round_trips}x (want {HOT_POOL}); all cached vectors == uncached truth"
    )


def spec() -> BenchSpec:
    return BenchSpec(
        key="query_cache",
        title="Query-embedding cache (memory-service, Tier-3)",
        description=(
            f"{QUERIES} retrievals in one window over {HOT_POOL} distinct salient "
            "queries. Baseline = embed every read; treatment = shipped "
            "QueryEmbeddingCache (one backend round-trip per distinct key)."
        ),
        report_ref="bottleneck-report Tier-3 / embeddings.py:29,53 (LRU on the read path)",
        primary_metric="embedding_round_trips",
        lower_is_better=True,
        iters=50,
        warmup=10,
        arms={"baseline": _baseline, "treatment": _treatment},
        correctness=_correctness,
    )
