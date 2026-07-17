# Bottleneck-fix benchmark report

Faithful in-process A/B micro-benchmarks for the shipped bottleneck fixes in agent-service and memory-service. Each bench runs the SAME workload through the shipped code path (treatment) and a reconstruction of the pre-fix path (baseline), discards a warm-up window, and reports p50/p95 over the remaining iterations. Backends (GPU, broker, DB, embedding endpoint) are modeled deterministically so numbers are reproducible and reflect the structural change, not host noise or a live GPU. The event-service (Java) and minecraft-service (Node) fixes ship with their own in-language test suites and are out of scope for this Python in-process harness — see the bottleneck report for those. Run: `cd services/agent-service && uv run python ../../bench/run_all.py`.

## Headline

- **LLM concurrency gate (agent-service #1, Critical)** — `batch_wall_ms` -67.6% (p50)
- **Kafka producer batching (agent-service #5)** — `awaited_round_trips` -87.5% (p50) · behaviour preserved
- **Batched relationship upserts (agent-service #7)** — `transactions` -83.3% (p50) · behaviour preserved
- **Query-embedding cache (memory-service, Tier-3)** — `embedding_round_trips` -75.0% (p50) · behaviour preserved

## Method notes

- **Warm-up discarded** every bench drops its first iterations before measuring — the project's own MSPT rule (post-boot world-gen spike is not steady state).
- **Real code under test** the LLM gate drives the shipped `OllamaProvider` semaphore; the producer bench drives the shipped `EventPublisher.publish`/`flush`; the relationship correctness fold uses the shipped `_clamp` and `GRUDGE_AFFINITY_THRESHOLD`; the query-cache bench drives the shipped `QueryEmbeddingCache` LRU over a real `FakeEmbeddingProvider`.
- **Models, not live infra** GPU/broker/DB/embedding latencies are modeled so the delta isolates the structural change. Whole-stack soak numbers (Prometheus before/after) are the next layer and need a dedicated load run.

## Benches

### LLM concurrency gate (agent-service #1, Critical)

*20 concurrent ticks against one modeled GPU that thrashes past 4 in-flight. Baseline = ungated fan-out; treatment = shipped semaphore cap of 4.*

**Confirms:** bottleneck-report §1 / providers.py:194 (asyncio.Semaphore backpressure)

| metric | baseline p50 | baseline p95 | treatment p50 | treatment p95 | Δ p50 |
|---|--:|--:|--:|--:|--:|
| `batch_wall_ms` **←** | 245 | 263 | 79.3 | 103 | -67.6% |
| `call_max_ms` | 241 | 255 | 25.7 | 26.3 | -89.3% |
| `call_p50_ms` | 95.5 | 103 | 16.5 | 18.0 | -82.7% |

### Kafka producer batching (agent-service #5)

*8 events/tick. Baseline = send_and_wait per event; treatment = real EventPublisher (buffered send() + one flush()).*

**Confirms:** bottleneck-report §5 / producer.py:26,33 (fire-and-forget + one flush)

**Behaviour-preservation:** ✅ PASS — sends=8 (want 8), flushes=1 (want 1), round_trips=1 (want 1)

| metric | baseline p50 | baseline p95 | treatment p50 | treatment p95 | Δ p50 |
|---|--:|--:|--:|--:|--:|
| `awaited_round_trips` **←** | 8.00 | 8.00 | 1.00 | 1.00 | -87.5% |
| `modeled_tick_ms` | 16.0 | 16.0 | 2.00 | 2.00 | -87.5% |

### Batched relationship upserts (agent-service #7)

*6 edges moved in one tick. Baseline = one transaction per edge; treatment = a single batched transaction. Correctness folds 4000 random sequences both ways and asserts identical final edges.*

**Confirms:** bottleneck-report §7 / relationships.py:132 (one session per tick's batch)

**Behaviour-preservation:** ✅ PASS — 4000 random update sequences: batched == sequential (bounds + grudge damping preserved)

| metric | baseline p50 | baseline p95 | treatment p50 | treatment p95 | Δ p50 |
|---|--:|--:|--:|--:|--:|
| `db_round_trips` | 12.0 | 12.0 | 3.00 | 3.00 | -75.0% |
| `modeled_tick_ms` | 18.0 | 18.0 | 4.50 | 4.50 | -75.0% |
| `transactions` **←** | 6.00 | 6.00 | 1.00 | 1.00 | -83.3% |

### Query-embedding cache (memory-service, Tier-3)

*20 retrievals in one window over 5 distinct salient queries. Baseline = embed every read; treatment = shipped QueryEmbeddingCache (one backend round-trip per distinct key).*

**Confirms:** bottleneck-report Tier-3 / embeddings.py:29,53 (LRU on the read path)

**Behaviour-preservation:** ✅ PASS — 20 reads over 5 distinct keys: backend hit 5x (want 5); all cached vectors == uncached truth

| metric | baseline p50 | baseline p95 | treatment p50 | treatment p95 | Δ p50 |
|---|--:|--:|--:|--:|--:|
| `embedding_round_trips` **←** | 20.0 | 20.0 | 5.00 | 5.00 | -75.0% |
| `modeled_window_ms` | 160 | 160 | 40.0 | 40.0 | -75.0% |

## Raw data

Per-iteration CSV and JSON summaries are in `bench/results/*.csv` / `*.json`.
