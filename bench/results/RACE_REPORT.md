# RB-race model comparison (Phase 2 sweep)

GovSim-style table (papers/GovSim.pdf): one row per LLM, every run under
the frozen config `bench/race/frozen-config.json` (Easy, mob-free, 3v3,
greedy decoding `LLM_TEMPERATURE=0.0`), N runs per model, mean ± 95% CI
(Student-t). Only honest runs (`AttemptEnded.honestRace == {0,0}`) are
aggregated; dirty runs are discarded and listed below. A stalled-but-honest
run is a kept DNF: it counts against win rate, and its Tier B behaviour is
included, but its duration is not (that would measure the watchdog).

| Model | cfg | N | Win rate | Time-to-goal s (won) | Gather eff. (blocks/req) | Waste ratio | Tokens/run | Latency p50 ms |
|---|--:|--:|--:|--:|--:|--:|--:|--:|
| `llama3.1:8b` | v1 | 5 | 5/5 | 945.3 ± 329.2 | 1.14 ± 0.82 | 0.602 ± 0.198 | 454227 ± 149529 | 1678 ± 106 |
| `gemma4:latest` | v1 | 5 | 5/5 | 1001.3 ± 605.8 | 0.62 ± 0.56 | 0.745 ± 0.101 | 548793 ± 344063 | 8529 ± 501 |
| `gemma3:12b` | v1 | 5 | 4/5 | 650.9 ± 150.7 | 0.53 ± 0.24 | 0.763 ± 0.079 | 772969 ± 1253815 | 3596 ± 142 |
| `qwen3.5:4b` | v2 | 5 | 1/5 | 4225.4 (n=1) | 0.26 ± 0.46 | 0.603 ± 0.078 | 2460691 ± 362739 | 1575 ± 24 |
| `lfm2.5:latest` | v1 | 5 | 0/5 | — | 0.14 ± 0.22 | 0.385 ± 0.117 | 1392557 ± 76921 | 23647 ± 2537 |

Reference record under this config's knobs but NOT this protocol: Easy
mob-free **360.4s** (`019f7337`) — set at the 10s race tick with per-team
models and default temperature, so it is a ceiling reference, not a row.
Reproduce any row:
`uv run --with httpx python bench/sweep_race.py --models <model> --runs 5`
then `uv run python bench/aggregate_race.py`.

## Method caveats

- **Greedy decoding was truly in effect for the first time this sweep**:
  compose never passed `LLM_TEMPERATURE` into agent-service before this
  branch, so all pre-sweep reference runs sampled at the 0.7 default.
- **Blocked run order on a shared persistent world**: blocks ran
  llama3.1:8b → gemma3:12b → gemma4 → qwen3.5:4b → lfm2.5 without world
  resets; within-block run index correlates with world wear (see the
  per-run appendix — llama3.1 drifts 700.9→1301.8s across its block).
  Model and world age are therefore partially confounded across blocks.
- **DNF Tier B windows are watchdog-length** (~75 min vs ~10-30 min for
  wins), so token totals for 0-win models measure a longer window; the
  gemma3:12b tokens CI is inflated by its one DNF for the same reason.
- **Latency p50 is a decision-weighted mean of team p50s** per run, not a
  pooled raw-latency percentile (raw latencies are not retained).

## Failure modes of the 0-win models (diagnosed from ledger + logs)

- **qwen3.5:4b under v1 — structurally mute.** Hybrid reasoning model: it
  burned the entire 8192-token `OLLAMA_NUM_CTX` window on chain-of-thought
  and returned an EMPTY completion (~112s p50, exactly 8192
  tokens/decision); every deliberation fell back to idle. That row
  measured incompatibility with the non-thinking decision contract, not
  Minecraft ability. **v2** sends `think: false` to thinking-capable
  models (capability-probed via /api/show); qwen's current row is the
  v2 re-bench. v1 rows for plain models remain valid — their request
  payloads are byte-identical under v2.
- **lfm2.5 — engaged but too slow and sloppy.** Real gameplay (~560
  decisions/run, 54% gathers, wood collected) but ~23s deliberations at a
  30s tick through the 4-lane concurrency gate, ~40% idle, and frequent
  schema violations (out-of-range relationship deltas, junk targets)
  falling back to idle — never reached first coal in 75 minutes.

## Per-run appendix (kept runs, all config versions)

| Model | cfg | Run | Outcome | Duration s | Attempt |
|---|--:|--:|---|--:|---|
| `llama3.1:8b` | v1 | 1 | won | 700.9 | `019f9400-fa5c…` |
| `llama3.1:8b` | v1 | 2 | won | 680.9 | `019f940c-4b74…` |
| `llama3.1:8b` | v1 | 3 | won | 1101.7 | `019f9417-5049…` |
| `llama3.1:8b` | v1 | 4 | won | 941.1 | `019f9428-cda9…` |
| `llama3.1:8b` | v1 | 5 | won | 1301.8 | `019f9437-c7b9…` |
| `gemma3:12b` | v1 | 1 | stalled | 5544.8 | `019f944e-1d39…` |
| `gemma3:12b` | v1 | 2 | won | 580.5 | `019f94a3-67e1…` |
| `gemma3:12b` | v1 | 3 | won | 580.8 | `019f94ac-e843…` |
| `gemma3:12b` | v1 | 4 | won | 661.1 | `019f94b6-620c…` |
| `gemma3:12b` | v1 | 5 | won | 781.1 | `019f94c1-1747…` |
| `gemma4:latest` | v1 | 1 | won | 941.3 | `019f94ce-431a…` |
| `gemma4:latest` | v1 | 2 | won | 981.3 | `019f94dd-42e8…` |
| `gemma4:latest` | v1 | 3 | won | 640.9 | `019f94ec-e90b…` |
| `gemma4:latest` | v1 | 4 | won | 1822.1 | `019f94f7-5557…` |
| `gemma4:latest` | v1 | 5 | won | 620.7 | `019f9513-c413…` |
| `qwen3.5:4b` | v1 | 1 | stalled | 4504.8 | `019f951e-e8d2…` |
| `qwen3.5:4b` | v1 | 2 | stalled | 4503.7 | `019f9564-48bb…` |
| `qwen3.5:4b` | v1 | 3 | stalled | 4505.6 | `019f95a9-9fbf…` |
| `qwen3.5:4b` | v1 | 4 | stalled | 4504.8 | `019f95ee-fe1a…` |
| `qwen3.5:4b` | v1 | 5 | stalled | 4504.8 | `019f9634-5bdc…` |
| `lfm2.5:latest` | v1 | 1 | stalled | 4505.1 | `019f967a-6085…` |
| `lfm2.5:latest` | v1 | 2 | stalled | 4505.5 | `019f96bf-c302…` |
| `lfm2.5:latest` | v1 | 3 | stalled | 4505.1 | `019f9705-28c3…` |
| `lfm2.5:latest` | v1 | 4 | stalled | 4505.5 | `019f974a-899b…` |
| `lfm2.5:latest` | v1 | 5 | stalled | 4505.2 | `019f978f-e7f3…` |
| `qwen3.5:4b` | v2 | 1 | won | 4225.4 | `019f97de-6bc7…` |
| `qwen3.5:4b` | v2 | 2 | stalled | 5726.7 | `019f981f-9383…` |
| `qwen3.5:4b` | v2 | 3 | stalled | 4509.1 | `019f9877-9f1a…` |
| `qwen3.5:4b` | v2 | 4 | stalled | 4505.8 | `019f98bd-1f56…` |
| `qwen3.5:4b` | v2 | 5 | stalled | 4506.5 | `019f9902-9137…` |
