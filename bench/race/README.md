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
| `LLM_TEMPERATURE`             | `0.0`       | **Greedy decoding** — the GovSim reproducibility choice. Global across all team providers (`settings.py`)               |

**The single varying axis** is the model: `LLM_MODEL_OLLAMA` (global) or
`LLM_TEAM_MODELS` (per-team head-to-head). Nothing else may differ between
runs in one table.

## Run protocol (Phase 2 executes this; Phase 1 only makes it possible)

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

## Metric tiers

- **Tier A** (attempt slice — deterministic, golden-tested now): winner,
  time-to-goal, per-rung ladder offsets per team, first-to-rung + lead margin,
  honest-race deltas.
- **Tier B** (villager event window — implemented now, golden-tested in
  Phase 2): gather efficiency, waste ratio, decision mix, tokens + latency
  per team.

Golden test: `bench/test_race_metrics.py` locks Tier A against the committed
flagship fixture `film/flagship-slice.json` → expected doc
`bench/results/race_flagship.expected.json`. Tier B gets its fixture from the
first Phase 2 live run (a captured villager-window slice), then the same
golden treatment.
