"""Prometheus metrics — exposed via the FastAPI app from CIV-8 onward."""

from prometheus_client import Counter, Histogram

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
