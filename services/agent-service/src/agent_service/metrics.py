"""Prometheus metrics — exposed via the FastAPI app from CIV-8 onward."""

from prometheus_client import Counter, Gauge, Histogram

llm_tokens_total = Counter(
    "civ_llm_tokens_total",
    "LLM tokens consumed",
    ["provider", "direction"],  # direction: input | output
)

llm_cost_dollars_total = Counter(
    "civ_llm_cost_dollars_total",
    "Estimated LLM spend in USD (0 for local/fake providers)",
    ["provider"],
)

llm_latency_seconds = Histogram(
    "civ_llm_latency_seconds",
    "Deliberation call latency per provider",
    ["provider"],
    buckets=(0.01, 0.1, 0.5, 1.0, 2.0, 3.5, 5.0, 10.0, 20.0),
)

llm_normalized_total = Counter(
    "civ_llm_normalized_total",
    "Decisions accepted after tolerant-reader param normalization (known alias drift)",
)

llm_malformed_total = Counter(
    "civ_llm_malformed_total",
    "LLM responses that failed decision-contract validation (tick fell back to idle)",
)

llm_governance_dropped_total = Counter(
    "civ_llm_governance_dropped_total",
    "governanceAction fields dropped for failing the GovernanceRequested contract (tick proceeded without the civic action)",
)

llm_budget_tripped = Gauge(
    "civ_llm_budget_tripped",
    "1 while the daily token budget circuit breaker is open (deliberation on fake)",
)

tick_seconds = Histogram(
    "civ_tick_seconds",
    "Full cognitive tick latency (perceive -> retrieve -> deliberate -> act -> reflect)",
    buckets=(0.1, 0.5, 1.0, 2.0, 3.5, 5.0, 10.0, 20.0, 30.0),
)

ticks_total = Counter(
    "civ_ticks_total",
    "Cognitive ticks executed",
    ["outcome", "trigger"],  # outcome: ok|error; trigger: scheduled|reactive (label change: M1-2)
)
