# RB-race model comparison (Phase 2 sweep)

GovSim-style table (papers/GovSim.pdf): one row per LLM, every run under
the frozen config `bench/race/frozen-config.json` (Easy, mob-free, 3v3,
greedy decoding `LLM_TEMPERATURE=0.0`), N runs per model, mean ± 95% CI
(Student-t). Only honest runs (`AttemptEnded.honestRace == {0,0}`) are
aggregated; dirty runs are discarded and listed below. A stalled-but-honest
run is a kept DNF: it counts against win rate, and its Tier B behaviour is
included, but its duration is not (that would measure the watchdog).

Token and latency columns are **window-length invariant**: tokens/decision
and tokens/minute instead of tokens/run, and latency p50 is a true
percentile of the run's pooled raw per-decision latencies. Window-sensitive
totals are kept below in their own table.

> **Rows span configVersions v1, v2, v3 — they are NOT comparable to each other.** Each model is reported at its
> own highest version (`cfg` column); a version bump changes the protocol,
> not just the harness. What changed per version is listed in
> `$versionHistory` in `bench/race/frozen-config.json`. Compare within a
> version; re-bench before ranking across one.

| Model | cfg | N | Win rate | Time-to-goal s (won) | Gather eff. (blocks/req) | Waste ratio | Tokens/decision | Tokens/min | Latency p50 ms |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| `llama3.1:8b` | v3 | 1 | 1/1 | 680.6 (n=1) | 2.06 (n=1) | 0.489 (n=1) | 2128 (n=1) | 24951 (n=1) | 1701 (n=1) |
| `gemma4:latest` | v1 | 5 | 5/5 | 1001.3 ± 605.8 | 0.62 ± 0.56 | 0.745 ± 0.101 | 3121 ± 39 | 32676 ± 861 | 8518 ± 498 |
| `gemma3:12b` | v1 | 5 | 4/5 | 650.9 ± 150.7 | 0.53 ± 0.24 | 0.763 ± 0.079 | 2556 ± 28 | 29323 ± 1067 | 3593 ± 155 |
| `qwen3.5:4b` | v2 | 5 | 1/5 | 4225.4 (n=1) | 0.26 ± 0.46 | 0.603 ± 0.078 | 2689 ± 31 | 31476 ± 906 | 1576 ± 23 |
| `lfm2.5:latest` | v1 | 5 | 0/5 | — | 0.14 ± 0.22 | 0.385 ± 0.117 | 2580 ± 40 | 18546 ± 1024 | 23780 ± 2820 |

**Provisional rows (n < 3):** `llama3.1:8b` v3 (n=1). A version bump retires that model's older rows rather than
pooling them, so a re-bench in progress shows here at its true N —
which is not yet enough for a CI, let alone a ranking. The table is
sorted by win rate and mean time regardless of N: read the N column
before reading the order.

### Latency distribution (pooled raw per-decision, mean ± 95% CI across runs)

| Model | p50 ms | p90 ms | p95 ms | p99 ms |
|---|--:|--:|--:|--:|
| `llama3.1:8b` | 1701 (n=1) | 8803 (n=1) | 12923 (n=1) | 14917 (n=1) |
| `gemma4:latest` | 8518 ± 498 | 13146 ± 713 | 14422 ± 1563 | 16316 ± 1874 |
| `gemma3:12b` | 3593 ± 155 | 4706 ± 443 | 5392 ± 591 | 6172 ± 762 |
| `qwen3.5:4b` | 1576 ± 23 | 2117 ± 255 | 2424 ± 341 | 3076 ± 484 |
| `lfm2.5:latest` | 23780 ± 2820 | 35776 ± 3508 | 39584 ± 3925 | 44284 ± 3632 |

### Window-sensitive totals (secondary — read tokens/decision instead)

| Model | Tokens/run | Mean window s |
|---|--:|--:|
| `llama3.1:8b` | 283023 (n=1) | 681 (n=1) |
| `gemma4:latest` | 548793 ± 344063 | 1001 ± 606 |
| `gemma3:12b` | 772969 ± 1253815 | 1630 ± 2719 |
| `qwen3.5:4b` | 2460691 ± 362739 | 4695 ± 732 |
| `lfm2.5:latest` | 1392557 ± 76921 | 4505 ± 0 |

Reference record under this config's knobs but NOT this protocol: Easy
mob-free **360.4s** (`019f7337`) — set at the 10s race tick with per-team
models and default temperature, so it is a ceiling reference, not a row.
Reproduce any row:
`uv run --with httpx python bench/sweep_race.py --models <model> --runs 5`
then `uv run python bench/aggregate_race.py`.
Re-derive every row from the saved raw slices without a ledger, a GPU or
docker: `uv run python bench/bench_race.py --reextract` then
`uv run python bench/aggregate_race.py`.

## Method caveats

- **Greedy decoding held in the deliberation half of the loop only** for
  the pre-v3 rows (`gemma4:latest` v1, `gemma3:12b` v1, `qwen3.5:4b` v2, `lfm2.5:latest` v1). Compose passed no `LLM_TEMPERATURE` to
  memory-service at the time, whose `llm_temperature` defaults to 0.7
  (`services/memory-service/src/memory_service/settings.py`) and is handed
  straight to the reflection summarizer (`memory_service/llm.py`).
  Reflections feed the memory stream, which feeds the deliberation prompt,
  so those runs are greedy where the DECISION is made and 0.7 where the
  memories it reads were written. Same class of bug as the agent-service
  one PR #90 fixed. FIXED in configVersion 3 (compose passes it and the
  sweep verifies temperature AND reflection budget inside the container
  before racing); not reconstructible for the runs above.
- **Time of day and weather ran FREE** for those same rows.
  `scripts/race-rb2.mjs` pinned keepInventory, doInsomnia, mobGriefing and
  doMobSpawning but issued no `time set` or `weather clear`, and neither
  `doDaylightCycle` nor `doWeatherCycle` was pinned anywhere, so every one
  of those runs started at an arbitrary point in the day/night and weather
  cycle — an unpinned axis that plausibly moves mob-free gathering (light
  level while digging, rain). FIXED in configVersion 3: the preflight now
  sets and reads back both gamerules and stamps day + clear weather. It
  CANNOT be reconstructed for the runs above, which is why it stays a
  threat there and not a correction.
- **Villager memory and relationships accumulate ACROSS blocks, in every
  version including v3.** The per-block world restore touches the
  `minecraft-data` volume only; `postgres-data` (memory_db, agent_db) is
  deliberately left alone, so a model raced late in a sweep inherits a
  larger memory stream and older relationship edges than one raced first —
  confounded with block order in exactly the way world wear was. v3 narrows
  the blast radius but also sharpens the oddity: after a world reset those
  carried-over memories describe terrain that no longer exists. Not fixed
  because truncating villager memory is a filming-state decision rather
  than a benchmark one — see `docs/runbooks/race-world-reset.md`,
  "What v3 does and does not fix".
- **Blocked run order — a hygiene problem, not a demonstrated bias.**
  On a shared persistent world, blocks ran `llama3.1:8b` v1 → `gemma3:12b` v1 → `gemma4:latest` v1 → `qwen3.5:4b` v1 → `lfm2.5:latest` v1 → `qwen3.5:4b` v2 with no world reset between them, so within-block run index is confounded with world age there.
  By contrast, blocks `llama3.1:8b` v3 ran at configVersion 3+, which restores a pristine pinned-seed world before each block: cross-block wear cannot reach them, and only within-block wear remains.
  Measured, that confound does not carry the model table:
  - `gemma3:12b` v1: 4 won runs, indices 2-5, mean index 3.50; within-block slope +68.2 ± 19.1 s/step (t = +3.56), drift +204.6 s across the observed span; mean 650.9 s → 616.8 s detrended to index 3.0.
  - `gemma4:latest` v1: 5 won runs, indices 1-5, mean index 3.00; within-block slope +20.0 ± 177.8 s/step (t = +0.11), drift +79.8 s across the observed span; mean 1001.3 s → 1001.3 s detrended to index 3.0.
  - The one unbalanced block is `gemma3:12b` (mean index 3.50 — run 1 did not win), i.e. shifted toward LATER, more-worn indices. Under the posited positive wear that biases AGAINST it, not for it. Detrending WIDENS its gaps rather than dissolving them (see the per-block means above). Its drift is +204.6 s across indices 2→5; extrapolating the slope to a 1→5 span (+272.8 s) multiplies a 3-step observation by 4 and is wrong.
  - No cumulative wear ACROSS the sweep: over the 14 winners in run order (configVersion 1 sweep, winners only), Pearson +0.142, Spearman -0.029, +10.7 s per step. Durations reset at every block boundary.
  The caution against reading adjacent winner rows as a ranking STANDS —
  but it rests on raw sampling noise at n=5, not on the wear mechanism:
  `gemma4:latest`'s own sd is 488.0 s against a 350.4 s gap to `gemma3:12b`.
  Resetting the world per block (or interleaving run order) is still worth
  doing as hygiene; it is simply not what makes these rows unrankable, and
  the earlier claim that run index alone could account for the winner
  ranking is withdrawn.
  DONE as hygiene in configVersion 3: `sweep_race.py` restores a pristine
  pinned-seed world (`6233701440491701965`) before every block and aborts
  if the RCON seed check fails (`docs/runbooks/race-world-reset.md`).
  WITHIN-block wear survives that — interleaving run order is the remaining
  upgrade, and it must be decided before a sweep starts, not after.
- **DNF Tier B windows are watchdog-length** (~75 min vs ~10-30 min for
  wins) — see the mean-window column. FIXED as a metric: the headline
  token column is now tokens/decision (window-length invariant) with
  tokens/minute as the rate; tokens/run is demoted to the secondary
  table and should not be compared across models with different win
  rates. Non-token Tier B columns (gather efficiency, waste ratio) are
  still ratios over a longer window for DNF-heavy models.
- **Latency percentiles are pooled raw**, not a mean of per-team medians.
  Each run's per-decision latencies from both teams are pooled and the
  percentile taken over that sample at extraction time
  (`tierB._run.latencyMs`); the table then averages those per-run
  percentiles across runs. The per-team `latencyMsP50/P95` fields keep
  their original per-team meaning for other consumers.
- **Schema-violation fallbacks are IN the latency and token samples.**
  A `DecisionMade` with `payload.error == true` still emits the real
  latency and token count the deliberation cost before falling back to
  idle, and for the worst models those rows are most of the run.
  Excluding them would flatter exactly the models that fail loudest.
  `tierB._run.llm.decisionsWithError` records the share per run.

## Executor-side action failures

Derived from the same saved slices every run JSON is extracted from
(`bench/results/sweep/slices`), roster villagers only.

**Scope:** pooled over all 31 kept runs across `gemma3:12b` v1, `gemma4:latest` v1, `lfm2.5:latest` v1, `llama3.1:8b` v1, `llama3.1:8b` v3, `qwen3.5:4b` v1, `qwen3.5:4b` v2 — this is a WIDER set than the model table, which shows each model at
its highest configVersion only. The per-model rows below carry their own
`cfg`; the totals in this paragraph do not belong to any single version.

6389 of 10906 resolved actions failed (58.6%). Restricted to `gather` — the
verb that actually advances the ladder — failures over gather commands
issued:

| Model | cfg | Gather cmds | Failed | Rate |
|---|--:|--:|--:|--:|
| `qwen3.5:4b` | v2 | 2895 | 2669 | 92.2% |
| `gemma3:12b` | v1 | 1147 | 1041 | 90.8% |
| `lfm2.5:latest` | v1 | 1099 | 1031 | 93.8% |
| `gemma4:latest` | v1 | 714 | 631 | 88.4% |
| `llama3.1:8b` | v1 | 674 | 497 | 73.7% |
| `llama3.1:8b` | v3 | 53 | 34 | 64.2% |

Blocks issuing fewer than 50 gather commands are omitted above — no
meaningful rate, and the orphan outcomes below can exceed the denominator: `qwen3.5:4b` v1 (3 issued, 5 failed).

A SINGLE executor-side error string accounts for 4281 of 6389
failures (67.0%): "Took to long to decide path to goal!",
errorCode INTERNAL — a mineflayer pathfinder timeout. State that
precisely: errorCode INTERNAL totals 4401, the specific string is
4281; the two are NOT interchangeable.

Full errorCode mix: INTERNAL 4401, RESOURCE_NOT_FOUND 694, TIMEOUT 576, TOOL_TIER_REQUIRED 458, TOOL_REQUIRED 207, PATH_NOT_FOUND 32, STALE_COMMAND 14, SMELT_FAILED 5, TARGET_ESCAPED 2.

Per-run failure rate tracks time-to-goal within a block. Only blocks with
wins are listed: for a 0-win block "time-to-goal" is the watchdog length,
so the correlation there measures the watchdog, not the model.
- `gemma3:12b` v1: r = +0.759 over all 5 kept runs; the won-only value r = +0.999 (n=4) is a selection artifact and should not be quoted.
- `gemma4:latest` v1: r = +0.106 over all 5 kept runs.
- `llama3.1:8b` v1: r = +0.966 over all 5 kept runs.

Bookkeeping caveat: 183 of 10906 outcome events (1.7%) reference a commandId
with no in-window `ActionRequested` (window-edge truncation), and the gather
denominator is commands issued while the numerator is resolved outcomes —
these rates are robust at roughly the 2% level, not tighter.

Reading this section: the dominant cost in these races is **executor-side
pathfinding, not model quality**, which is where the next optimisation
should go rather than at the model axis this table varies.

## Greedy decoding is not the livelock cause

Consecutive identical decisions by the same villager (exact decision-string
key), classified against the causation chain
(`DecisionMade` → `ActionRequested` → `ActionFailed`/`ActionCompleted`).
"Livelock" is the only shape temperature could explain: `idle` repeated
after an action that did NOT fail.

| Model | cfg | Repeats | After a failed action | Livelock |
|---|--:|--:|--:|--:|
| `qwen3.5:4b` | v2 | 3186 | 2008 (63.0%) | 1012 |
| `lfm2.5:latest` | v1 | 1717 | 588 (34.2%) | 1096 |
| `gemma3:12b` | v1 | 633 | 555 (87.7%) | 0 |
| `llama3.1:8b` | v1 | 589 | 465 (78.9%) | 0 |
| `gemma4:latest` | v1 | 325 | 291 (89.5%) | 0 |
| `qwen3.5:4b` | v1 | 143 | 0 (0.0%) | 143 |
| `llama3.1:8b` | v3 | 66 | 43 (65.2%) | 0 |

Repeats in the three viable models are overwhelmingly RETRIES after the
action failed, and true livelock is exactly 0 in all three. It appears only
in `qwen3.5:4b` and `lfm2.5:latest`, where it is the `error == true`
schema-violation fallback to idle rather than a sampling effect.

The per-run repeat fraction IS higher in stalled runs than won ones (won 0.544 (n=16), stalled 0.749 (n=15)),
but it is collinear with the failure rate in the section above and does not
survive as an independent cause. **Temperature is not the next knob to turn.**

## Failure modes of the weak models

Every number in this section is derived from the same run JSONs as the
table above (see `failure_profiles`), never written by hand — a
regeneration can no longer revert an audit correction.

- **`qwen3.5:4b` under config v1 — structurally mute.** Pooled over 5 kept runs: 176 decisions (35/run), p50 deliberation 111.0s, 8149 tokens/decision. 98.3% of decisions (173/176) were schema-violation fallbacks to idle; gathers were 1.7% (3/176). Reached first coal in 0/5 runs.
- **`qwen3.5:4b` under config v2 — playing, but not well.** Pooled over 5 kept runs: 4577 decisions (915/run), p50 deliberation 1.6s, 2688 tokens/decision. 33.4% of decisions (1527/4577) were schema-violation fallbacks to idle; gathers were 63.3% (2895/4577). Reached first coal in 2/5 runs.
- **`lfm2.5:latest` under config v1 — engaged but too slow and sloppy.** Pooled over 5 kept runs: 2700 decisions (540/run), p50 deliberation 23.8s, 2579 tokens/decision. 57.9% of decisions (1563/2700) were schema-violation fallbacks to idle; gathers were 40.7% (1099/2700). Reached first coal in 0/5 runs.

Reading those rows: **qwen3.5:4b at v1 was structurally mute** — a hybrid
reasoning model spending the whole 8192-token `OLLAMA_NUM_CTX` window on
chain-of-thought and returning an empty completion, so its row measured
incompatibility with the non-thinking decision contract, not Minecraft
ability. **v2** sends `think: false` to thinking-capable models
(capability-probed via /api/show), which is the row in the table above;
v1 rows for plain models remain valid **against v2 only** — their request
payloads are byte-identical between those two versions. That equivalence
does NOT extend to v3, which changes the world protocol itself (per-block
pristine world, frozen day/weather, pinned reflection temperature and
budget), so no v1 or v2 row may be read against a v3 row. **lfm2.5 is the opposite failure** — it really
played, but ~24s deliberations against a 30s tick through the 4-lane
concurrency gate, plus frequent schema violations (out-of-range
relationship deltas, junk targets), left most decisions as idle fallbacks.

## Model roster (forward-looking)

From `bench/race/frozen-config.json` → `modelRoster` (decided 2026-07-25 by the project owner).

- Approved for future sweeps: `llama3.1:8b`, `gemma3:12b`, `gemma4:latest`.
- Excluded: `qwen3.5:4b` — 0/5 wins at configVersion 1 (0/5 runs reached first_coal; 173/176 decisions = 98.3% were schema-violation fallbacks) and 1/5 at configVersion 2 with think:false — best run 4225.4 s vs 580.5–1822.1 s for viable-model wins, 2669/2895 = 92.2% of gather commands failed, 1527/4577 = 33.4% fallbacks.
- Excluded: `lfm2.5:latest` — 0/5 wins at configVersion 1, no run ever reached first_coal; 1563/2700 = 57.9% of decisions were schema-violation fallbacks and 1031/1099 = 93.8% of gather commands failed.

The excluded models' rows above STAY. This is a decision about which models
get future GPU-hours, not a retraction of data already collected.

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
| `llama3.1:8b` | v3 | 1 | won | 680.6 | `019f9bf3-4634…` |

## Discarded runs (never averaged in)

- `bench-llama3.1-8b-v3-r2` (llama3.1:8b): bot session reconnect loop during the race (Elara x1117 VillagerSpawned events): that villager's body was absent/thrashing, its team raced a member short, and the shared minecraft-service event loop was saturated. Undetectable by the honesty gate (honestRace was {0,0}); found by an offline session audit on 2026-07-26 after Elara was seen looping live. — attempt `019f9ea4-5bb1-721e-a758-8a1cbce03cd6`
- `bench-llama3.1-8b-v3-r3` (llama3.1:8b): bot session reconnect loop during the race (Elara x913 VillagerSpawned events): that villager's body was absent/thrashing, its team raced a member short, and the shared minecraft-service event loop was saturated. Undetectable by the honesty gate (honestRace was {0,0}); found by an offline session audit on 2026-07-26 after Elara was seen looping live. — attempt `019f9eae-45ef-73cf-880d-3f52af6d9184`
- `bench-llama3.1-8b-v3-r4` (llama3.1:8b): bot session reconnect loop during the race (Elara x1066 VillagerSpawned events): that villager's body was absent/thrashing, its team raced a member short, and the shared minecraft-service event loop was saturated. Undetectable by the honesty gate (honestRace was {0,0}); found by an offline session audit on 2026-07-26 after Elara was seen looping live. — attempt `019f9eb6-8775-71bf-b5e5-7177e531ac5c`
- `bench-llama3.1-8b-v3-r5` (llama3.1:8b): bot session reconnect loop during the race (Elara x1655 VillagerSpawned events): that villager's body was absent/thrashing, its team raced a member short, and the shared minecraft-service event loop was saturated. Undetectable by the honesty gate (honestRace was {0,0}); found by an offline session audit on 2026-07-26 after Elara was seen looping live. — attempt `019f9ebf-d181-702c-9bd8-7560ea58d1e7`
- `bench-gemma3-12b-v3-r1` (gemma3:12b): bot session reconnect loop during the race (Elara x1962 VillagerSpawned events): that villager's body was absent/thrashing, its team raced a member short, and the shared minecraft-service event loop was saturated. Undetectable by the honesty gate (honestRace was {0,0}); found by an offline session audit on 2026-07-26 after Elara was seen looping live. — attempt `019f9ecf-11ac-76ed-afef-7af40a21c184`
- `bench-gemma3-12b-v3-r2` (gemma3:12b): bot session reconnect loop during the race (Elara x1037 VillagerSpawned events): that villager's body was absent/thrashing, its team raced a member short, and the shared minecraft-service event loop was saturated. Undetectable by the honesty gate (honestRace was {0,0}); found by an offline session audit on 2026-07-26 after Elara was seen looping live. — attempt `019f9edf-e450-72e8-8a97-b718077fd661`
