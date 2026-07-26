# RB-race benchmark protocol (frozen config)

The goal is a GovSim-style model-comparison table (see `papers/GovSim.pdf`,
`docs/benchmark-rb.md`) for the Red-vs-Blue iron-pickaxe race: one row per
LLM, columns shaped like survival / efficiency / equality. The table is only
valid if **every run is identical except the model** — this directory freezes
everything else.

## The frozen config — `frozen-config.json`

| Knob                          | Value       | Why                                                                                                                     |
| ----------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------- |
| `difficulty`                  | `easy`      | Lowest non-model variance; reference record 360.4s (`019f7337`)                                                         |
| `mobs`                        | `false`     | Combat/mob-spawn noise excluded by decision — `doMobSpawning false` gamerule, muted between takes per `docs/demo-rb.md` |
| `VILLAGER_COUNT`              | `6`         | The fixed 3v3 roster (ids in `roster`)                                                                                  |
| `TICK_INTERVAL_SECONDS`       | `30`        | Race preset — same thinking cadence every run                                                                           |
| `THREAT_DEFAULT_STANCE`       | `cautious`  | Code default; `guard` costs ~80s on Easy                                                                                |
| `COMMUNITY_GOAL`              | (blank)     | Race mode mutes it anyway; pinned so it can't leak                                                                      |
| `OLLAMA_NUM_CTX`              | `8192`      | Keeps two team models resident on a 24 GB GPU                                                                           |
| `LLM_MAX_CONCURRENT_REQUESTS` | `4`         | The shipped backpressure gate                                                                                           |
| `LLM_DAILY_TOKEN_BUDGET`      | `100000000` | Ollama sizing — a mid-race breaker trip would flip brains to FakeProvider and poison the run                            |
| `LLM_TEMPERATURE`             | `0.0`       | **Greedy decoding** — the GovSim reproducibility choice. Global across all team providers (`settings.py`). Since v3 it reaches memory-service too — before that, reflections sampled at 0.7 in every "greedy" run |
| `world.seed`                  | `6233701440491701965` | v3: every block starts from the same map. Pinned in compose (`SEED`, new worlds only) and verified via RCON after each restore |
| `world.resetPolicy`           | `per-block` | v3: pristine world restored before each model block — kills cross-block wear, the confound that blocked ranking claims in v1/v2 |
| `world.timeOfDay` / `weather` | `day` / `clear` | v3: `doDaylightCycle` and `doWeatherCycle` off, day stamped, weather cleared. v1/v2 runs drifted through night and rain |

**The single varying axis** is the model: `LLM_MODEL_OLLAMA` (global) or
`LLM_TEAM_MODELS` (per-team head-to-head). Nothing else may differ between
runs in one table.

## Run protocol (Phase 2 executes this; Phase 1 only makes it possible)

0. **Restore the pristine world before every model block** (v3) from
   `pristine-6233701440491701965-v3.tgz`, then verify the seed via RCON —
   `docs/runbooks/race-world-reset.md`. `sweep_race.py --world-snapshot <path>`
   does this and aborts the sweep on a seed mismatch. A restore also clears
   dropped items and placed blocks, so it replaces the old between-take sweep.
1. **N runs per model** (N ≥ 5) under the frozen config, `LLM_TEMPERATURE=0.0`
   exported as process env (process env > `.env` > defaults). World state per
   the filming runbook `docs/demo-rb.md`: clear packs before staged gives,
   `doMobSpawning false`, deploy from main with `up -d --build`.
2. **Every run must be honest**: `AttemptEnded.honestRace` deltas `{0,0}`
   (no FakeProvider decisions, no budget trips). A dirty run is discarded and
   noted, never averaged in.
3. **Extract metrics per attempt** with `bench/bench_race.py`
   (`--attempt <id>` against the live ledger, or `--slice` on a saved slice).
4. **Aggregate** mean + 95% CI per metric per model via `bench/stats.py` —
   the Phase 2 sweep feeds `bench/results/race_*.json` straight into it.

## Sensitivity sweeps (Phase 3b) — a different experiment

`--axis <KNOB> --axis-values a,b,c` runs the same protocol while varying ONE
frozen knob, and writes a separate report (`bench/results/AXIS_REPORT.md`).
Axis rows never enter the model table — the aggregator partitions on the
manifest's `sweepKind` before computing anything. Declared axes and their legal
values live in `sensitivityAxes` in the frozen config; the baseline arm is
mandatory and is raced inside the sweep rather than borrowed from the model
table. Full rules, budget and the reason `THREAT_DEFAULT_STANCE` is refused
under this config: `docs/runbooks/race-sensitivity-sweep.md`.

## Metric tiers

- **Tier A** (attempt slice — deterministic, golden-tested now): winner,
  time-to-goal, per-rung ladder offsets per team, first-to-rung + lead margin,
  honest-race deltas.
- **Tier B** (villager event window — implemented now, golden-tested in
  Phase 2): gather efficiency, waste ratio, decision mix, tokens + latency
  per team, **plus a run-level block** (`tierB._run`) holding the numbers a
  per-team block cannot express.

### The run-level block (`tierB._run`) — two validity fixes, 2026-07-25

| Field | Why it exists |
| --- | --- |
| `llm.latencyMs.{p50,p90,p95,p99}` | A **true percentile of the run's pooled raw per-decision latencies**. The aggregator used to decision-weight the two team p50s, which is a mean of medians and not a percentile of anything. Percentiles cannot be reconstructed after the fact, so the pooled sample is percentiled at extraction time. The per-team `latencyMsP50/P95` keep their original per-team meaning — the golden fixture and the CSV depend on them. |
| `llm.tokensPerDecision` | The **primary** token column. A DNF's window is the 75-minute stall watchdog while a win's is 10–30 minutes, so tokens/run partly measures how long a model failed for; tokens/decision is invariant to window length. |
| `llm.tokensPerMinute` | The rate form. Needs Tier A's `durationSeconds`, so Tier B is computed via `bench_race.extract_pair` — never `tier_b()` alone, or it is silently `None`. |
| `llm.decisionsWithError` | Share of the sample that is a schema-violation fallback. Those rows **are** in the latency and token samples: they cost real latency and real tokens, and for the weakest models they are the whole run — dropping them would flatter exactly the models that fail loudest. |

`_run` is keyed with a leading underscore, which no roster team id can collide
with, so it rides inside the same dict as the per-team blocks without
reshaping them. Consumers that iterate teams must skip it
(`bench_race.RUN_BLOCK_KEY`).

### Offline re-extraction (no ledger, no docker, no GPU)

The sweep dumps every run's raw slices to `bench/results/sweep/slices/` as
`<label>.slice.json` + `<label>.window.json` for exactly this reason: when the
metric layer is corrected, past runs are **re-derived**, not re-raced.

```powershell
uv run python bench/bench_race.py --reextract   # rewrites every race_<label>.json/.csv
uv run python bench/aggregate_race.py           # regenerates the summary + report
```

Stdlib only (no httpx). The invariant to check after any extractor change: every
pre-existing field in every `race_<label>.json` must reproduce byte-identically;
new fields may only be added.

Golden test: `bench/test_race_metrics.py` locks Tier A against the committed
flagship fixture `film/flagship-slice.json` → expected doc
`bench/results/race_flagship.expected.json`. Tier B gets its fixture from the
first Phase 2 live run (a captured villager-window slice), then the same
golden treatment.
