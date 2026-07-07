"""Prometheus metrics for the memory stream. The civ_llm_* family shares
names with agent-service on purpose — budgets are per service (each process
exposes its own), and the M1-10 Grafana spend panel sums both services'
cost counters."""

from prometheus_client import Counter, Gauge, Histogram

memory_retrieval_seconds = Histogram(
    "civ_memory_retrieval_seconds",
    "Memory search latency (embed + ANN + re-rank); p95 is the design's SLO metric",
    buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5),
)

memories_stored_total = Counter(
    "civ_memories_stored_total",
    "Memories persisted to the stream",
    ["memory_type"],
)

embedding_seconds = Histogram(
    "civ_embedding_seconds",
    "Embedding call latency per provider",
    ["provider"],
    buckets=(0.005, 0.025, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0),
)

llm_tokens_total = Counter(
    "civ_llm_tokens_total",
    "LLM tokens spent on reflections",
    ["provider", "direction"],
)

llm_cost_dollars_total = Counter(
    "civ_llm_cost_dollars_total",
    "Estimated reflection LLM spend in USD",
    ["provider"],
)

llm_latency_seconds = Histogram(
    "civ_llm_latency_seconds",
    "Reflection LLM call latency per provider",
    ["provider"],
    buckets=(0.01, 0.1, 0.5, 1.0, 2.0, 3.5, 5.0, 10.0, 20.0),
)

llm_budget_tripped = Gauge(
    "civ_llm_budget_tripped",
    "1 while the reflection daily token budget breaker is open (resets midnight UTC)",
)

reflections_total = Counter(
    "civ_reflections_total",
    "Reflection attempts by outcome (created/empty/skipped_cap/skipped_budget/malformed)",
    ["outcome"],
)
