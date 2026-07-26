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

> **Rows span configVersions v1, v2, v4 — they are NOT comparable to each other.** Each model is reported at its
> own highest version (`cfg` column); a version bump changes the protocol,
> not just the harness. What changed per version is listed in
> `$versionHistory` in `bench/race/frozen-config.json`. Compare within a
> version; re-bench before ranking across one.

| Model | cfg | N | Win rate | Time-to-goal s (won) | Gather eff. (blocks/req) | Waste ratio | Tokens/decision | Tokens/min | Latency p50 ms |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| `gemma4:latest` | v4 | 5 | 5/5 | 744.7 ± 593.6 | 2.16 ± 1.09 | 0.469 ± 0.188 | 2360 ± 39 | 28409 ± 1565 | 2156 ± 211 |
| `llama3.1:8b` | v4 | 5 | 5/5 | 784.8 ± 392.4 | 1.32 ± 0.50 | 0.533 ± 0.195 | 2145 ± 15 | 25859 ± 932 | 1570 ± 196 |
| `gemma3:12b` | v4 | 5 | 5/5 | 872.7 ± 276.4 | 2.82 ± 1.62 | 0.451 ± 0.181 | 2269 ± 33 | 26179 ± 895 | 3269 ± 208 |
| `qwen3.5:4b` | v2 | 5 | 1/5 | 4225.4 (n=1) | 0.26 ± 0.46 | 0.603 ± 0.078 | 2689 ± 31 | 31476 ± 906 | 1576 ± 23 |
| `lfm2.5:latest` | v1 | 5 | 0/5 | — | 0.14 ± 0.22 | 0.385 ± 0.117 | 2580 ± 40 | 18546 ± 1024 | 23780 ± 2820 |

### Latency distribution (pooled raw per-decision, mean ± 95% CI across runs)

| Model | p50 ms | p90 ms | p95 ms | p99 ms |
|---|--:|--:|--:|--:|
| `gemma4:latest` | 2156 ± 211 | 2812 ± 418 | 3318 ± 1039 | 5250 ± 4714 |
| `llama3.1:8b` | 1570 ± 196 | 1927 ± 317 | 2314 ± 854 | 4108 ± 4824 |
| `gemma3:12b` | 3269 ± 208 | 4336 ± 621 | 5351 ± 1557 | 10330 ± 10381 |
| `qwen3.5:4b` | 1576 ± 23 | 2117 ± 255 | 2424 ± 341 | 3076 ± 484 |
| `lfm2.5:latest` | 23780 ± 2820 | 35776 ± 3508 | 39584 ± 3925 | 44284 ± 3632 |

### Window-sensitive totals (secondary — read tokens/decision instead)

| Model | Tokens/run | Mean window s |
|---|--:|--:|
| `gemma4:latest` | 345907 ± 250682 | 745 ± 594 |
| `llama3.1:8b` | 336597 ± 160176 | 785 ± 392 |
| `gemma3:12b` | 380805 ± 121051 | 873 ± 276 |
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
  the pre-v3 rows (`qwen3.5:4b` v2, `lfm2.5:latest` v1). Compose passed no `LLM_TEMPERATURE` to
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
  By contrast, blocks `llama3.1:8b` v3 → `llama3.1:8b` v4 → `gemma3:12b` v4 → `gemma4:latest` v4 ran at configVersion 3+, which restores a pristine pinned-seed world before each block: cross-block wear cannot reach them, and only within-block wear remains.
  Measured, that confound does not carry the model table:
  - `gemma4:latest` v4: 5 won runs, indices 1-5, mean index 3.00; within-block slope -238.2 ± 107.6 s/step (t = -2.21), drift -952.6 s across the observed span; mean 744.7 s → 744.7 s detrended to index 3.0.
  - `llama3.1:8b` v4: 5 won runs, indices 1-5, mean index 3.00; within-block slope +148.0 ± 77.6 s/step (t = +1.91), drift +591.9 s across the observed span; mean 784.8 s → 784.8 s detrended to index 3.0.
  - `gemma3:12b` v4: 5 won runs, indices 1-5, mean index 3.00; within-block slope -48.0 ± 76.4 s/step (t = -0.63), drift -192.1 s across the observed span; mean 872.7 s → 872.7 s detrended to index 3.0.
  - Run index can only move a between-model mean if the blocks cover different indices. `gemma4:latest` and `llama3.1:8b` have the SAME mean index (3.00), so index cannot generate the 40.1 s gap between them at all.
  - No cumulative wear ACROSS the sweep: over the 14 winners in run order (configVersion 1 sweep, winners only), Pearson +0.142, Spearman -0.029, +10.7 s per step. Durations reset at every block boundary.
  The caution against reading adjacent winner rows as a ranking STANDS —
  but it rests on raw sampling noise at n=5, not on the wear mechanism:
  `gemma4:latest`'s own sd is 478.1 s against a 40.1 s gap to `llama3.1:8b`.
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

**Scope:** pooled over all 47 kept runs across `gemma3:12b` v1, `gemma3:12b` v4, `gemma4:latest` v1, `gemma4:latest` v4, `lfm2.5:latest` v1, `llama3.1:8b` v1, `llama3.1:8b` v3, `llama3.1:8b` v4, `qwen3.5:4b` v1, `qwen3.5:4b` v2 — this is a WIDER set than the model table, which shows each model at
its highest configVersion only. The per-model rows below carry their own
`cfg`; the totals in this paragraph do not belong to any single version.

7649 of 13379 resolved actions failed (57.2%). Restricted to `gather` — the
verb that actually advances the ladder — failures over gather commands
issued:

| Model | cfg | Gather cmds | Failed | Rate |
|---|--:|--:|--:|--:|
| `qwen3.5:4b` | v2 | 2895 | 2669 | 92.2% |
| `gemma3:12b` | v1 | 1147 | 1041 | 90.8% |
| `lfm2.5:latest` | v1 | 1099 | 1031 | 93.8% |
| `gemma4:latest` | v1 | 714 | 631 | 88.4% |
| `llama3.1:8b` | v1 | 674 | 497 | 73.7% |
| `llama3.1:8b` | v4 | 438 | 318 | 72.6% |
| `gemma3:12b` | v4 | 410 | 248 | 60.5% |
| `gemma4:latest` | v4 | 343 | 230 | 67.1% |
| `llama3.1:8b` | v3 | 105 | 45 | 42.9% |

Blocks issuing fewer than 50 gather commands are omitted above — no
meaningful rate, and the orphan outcomes below can exceed the denominator: `qwen3.5:4b` v1 (3 issued, 5 failed).

A SINGLE executor-side error string accounts for 4303 of 7649
failures (56.3%): "Took to long to decide path to goal!",
errorCode INTERNAL — a mineflayer pathfinder timeout. State that
precisely: errorCode INTERNAL totals 4497, the specific string is
4303; the two are NOT interchangeable.

Full errorCode mix: INTERNAL 4497, RESOURCE_NOT_FOUND 1272, TIMEOUT 854, TOOL_TIER_REQUIRED 552, TOOL_REQUIRED 303, PATH_NOT_FOUND 122, SMELT_FAILED 32, STALE_COMMAND 14, TARGET_ESCAPED 2, SELF_DEFENSE_IN_PROGRESS 1.

Per-run failure rate tracks time-to-goal within a block. Only blocks with
wins are listed: for a 0-win block "time-to-goal" is the watchdog length,
so the correlation there measures the watchdog, not the model.
- `gemma3:12b` v1: r = +0.759 over all 5 kept runs; the won-only value r = +0.999 (n=4) is a selection artifact and should not be quoted.
- `gemma3:12b` v4: r = +0.351 over all 5 kept runs.
- `gemma4:latest` v1: r = +0.106 over all 5 kept runs.
- `gemma4:latest` v4: r = +0.841 over all 5 kept runs.
- `llama3.1:8b` v1: r = +0.966 over all 5 kept runs.
- `llama3.1:8b` v4: r = +0.939 over all 5 kept runs.

Bookkeeping caveat: 281 of 13379 outcome events (2.1%) reference a commandId
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
| `llama3.1:8b` | v4 | 339 | 259 (76.4%) | 0 |
| `gemma4:latest` | v1 | 325 | 291 (89.5%) | 0 |
| `gemma3:12b` | v4 | 152 | 73 (48.0%) | 0 |
| `qwen3.5:4b` | v1 | 143 | 0 (0.0%) | 143 |
| `gemma4:latest` | v4 | 141 | 106 (75.2%) | 0 |
| `llama3.1:8b` | v3 | 108 | 60 (55.6%) | 0 |

Repeats in the three viable models are overwhelmingly RETRIES after the
action failed, and true livelock is exactly 0 in all three. It appears only
in `qwen3.5:4b` and `lfm2.5:latest`, where it is the `error == true`
schema-violation fallback to idle rather than a sampling effect.

The per-run repeat fraction IS higher in stalled runs than won ones (won 0.412 (n=32), stalled 0.749 (n=15)),
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
| `llama3.1:8b` | v3 | 2 | won | 560.8 | `019f9f0d-e898…` |
| `llama3.1:8b` | v4 | 1 | won | 541.1 | `019f9fab-a9ec…` |
| `llama3.1:8b` | v4 | 2 | won | 520.5 | `019f9fb4-9677…` |
| `llama3.1:8b` | v4 | 3 | won | 680.7 | `019f9fbd-3155…` |
| `llama3.1:8b` | v4 | 4 | won | 1280.9 | `019f9fc8-3ef7…` |
| `llama3.1:8b` | v4 | 5 | won | 900.8 | `019f9fdc-74f5…` |
| `gemma3:12b` | v4 | 1 | won | 740.7 | `019f9fec-13e8…` |
| `gemma3:12b` | v4 | 2 | won | 1261 | `019f9ff8-0296…` |
| `gemma3:12b` | v4 | 3 | won | 860.6 | `019fa00b-e70f…` |
| `gemma3:12b` | v4 | 4 | won | 740.7 | `019fa019-b699…` |
| `gemma3:12b` | v4 | 5 | won | 760.7 | `019fa025-aad0…` |
| `gemma4:latest` | v4 | 1 | won | 1581.3 | `019fa033-2b1b…` |
| `gemma4:latest` | v4 | 2 | won | 700.7 | `019fa04b-ec1f…` |
| `gemma4:latest` | v4 | 3 | won | 480.4 | `019fa057-47e1…` |
| `gemma4:latest` | v4 | 4 | won | 440.4 | `019fa05f-3aec…` |
| `gemma4:latest` | v4 | 5 | won | 520.7 | `019fa066-90e8…` |

## Discarded runs (never averaged in)

- `bench-llama3.1-8b-v3-r2` (llama3.1:8b): bot session reconnect loop during the race (Elara x1117 VillagerSpawned events): that villager's body was absent/thrashing, its team raced a member short, and the shared minecraft-service event loop was saturated. Undetectable by the honesty gate (honestRace was {0,0}); found by an offline session audit on 2026-07-26 after Elara was seen looping live. — attempt `019f9ea4-5bb1-721e-a758-8a1cbce03cd6`
- `bench-llama3.1-8b-v3-r3` (llama3.1:8b): bot session reconnect loop during the race (Elara x913 VillagerSpawned events): that villager's body was absent/thrashing, its team raced a member short, and the shared minecraft-service event loop was saturated. Undetectable by the honesty gate (honestRace was {0,0}); found by an offline session audit on 2026-07-26 after Elara was seen looping live. — attempt `019f9eae-45ef-73cf-880d-3f52af6d9184`
- `bench-llama3.1-8b-v3-r4` (llama3.1:8b): bot session reconnect loop during the race (Elara x1066 VillagerSpawned events): that villager's body was absent/thrashing, its team raced a member short, and the shared minecraft-service event loop was saturated. Undetectable by the honesty gate (honestRace was {0,0}); found by an offline session audit on 2026-07-26 after Elara was seen looping live. — attempt `019f9eb6-8775-71bf-b5e5-7177e531ac5c`
- `bench-llama3.1-8b-v3-r5` (llama3.1:8b): bot session reconnect loop during the race (Elara x1655 VillagerSpawned events): that villager's body was absent/thrashing, its team raced a member short, and the shared minecraft-service event loop was saturated. Undetectable by the honesty gate (honestRace was {0,0}); found by an offline session audit on 2026-07-26 after Elara was seen looping live. — attempt `019f9ebf-d181-702c-9bd8-7560ea58d1e7`
- `bench-gemma3-12b-v3-r1` (gemma3:12b): bot session reconnect loop during the race (Elara x1962 VillagerSpawned events): that villager's body was absent/thrashing, its team raced a member short, and the shared minecraft-service event loop was saturated. Undetectable by the honesty gate (honestRace was {0,0}); found by an offline session audit on 2026-07-26 after Elara was seen looping live. — attempt `019f9ecf-11ac-76ed-afef-7af40a21c184`
- `bench-gemma3-12b-v3-r2` (gemma3:12b): bot session reconnect loop during the race (Elara x1037 VillagerSpawned events): that villager's body was absent/thrashing, its team raced a member short, and the shared minecraft-service event loop was saturated. Undetectable by the honesty gate (honestRace was {0,0}); found by an offline session audit on 2026-07-26 after Elara was seen looping live. — attempt `019f9edf-e450-72e8-8a97-b718077fd661`
- `bench-llama3.1-8b-v4-r1` (llama3.1:8b): host contention: the workstation was in interactive use during this run (operator report, 2026-07-26). Ollama shared the GPU and the executor shared the CPU with foreground work, which inflates deliberation latency and time-to-goal — the two headline columns — by an unmeasured amount. No gate can detect this: the run is honest, the fleet is healthy, the seed is right. Discarded on the operator's instruction and re-raced on a quiet box. — attempt `019f9f1f-199a-77fb-bafb-c06866a6d87c`
- `bench-llama3.1-8b-v4-r2` (llama3.1:8b): host contention: the workstation was in interactive use during this run (operator report, 2026-07-26). Ollama shared the GPU and the executor shared the CPU with foreground work, which inflates deliberation latency and time-to-goal — the two headline columns — by an unmeasured amount. No gate can detect this: the run is honest, the fleet is healthy, the seed is right. Discarded on the operator's instruction and re-raced on a quiet box. — attempt `019f9f2d-8529-7732-aaf6-0f80351901d8`
- `bench-llama3.1-8b-v4-r3` (llama3.1:8b): host contention: the workstation was in interactive use during this run (operator report, 2026-07-26). Ollama shared the GPU and the executor shared the CPU with foreground work, which inflates deliberation latency and time-to-goal — the two headline columns — by an unmeasured amount. No gate can detect this: the run is honest, the fleet is healthy, the seed is right. Discarded on the operator's instruction and re-raced on a quiet box. — attempt `019f9f40-8401-761e-834e-af68486ed3b5`
- `bench-llama3.1-8b-v4-r4` (llama3.1:8b): host contention: the workstation was in interactive use during this run (operator report, 2026-07-26). Ollama shared the GPU and the executor shared the CPU with foreground work, which inflates deliberation latency and time-to-goal — the two headline columns — by an unmeasured amount. No gate can detect this: the run is honest, the fleet is healthy, the seed is right. Discarded on the operator's instruction and re-raced on a quiet box. — attempt `019f9f4d-1e9b-761f-aaa1-21eccf7f5876`
- `bench-llama3.1-8b-v4-r5` (llama3.1:8b): host contention: the workstation was in interactive use during this run (operator report, 2026-07-26). Ollama shared the GPU and the executor shared the CPU with foreground work, which inflates deliberation latency and time-to-goal — the two headline columns — by an unmeasured amount. No gate can detect this: the run is honest, the fleet is healthy, the seed is right. Discarded on the operator's instruction and re-raced on a quiet box. — attempt `019f9f55-b9cf-73ce-9e52-32ecd4106e0f`
- `bench-gemma3-12b-v4-r1` (gemma3:12b): host contention: the workstation was in interactive use during this run (operator report, 2026-07-26). Ollama shared the GPU and the executor shared the CPU with foreground work, which inflates deliberation latency and time-to-goal — the two headline columns — by an unmeasured amount. No gate can detect this: the run is honest, the fleet is healthy, the seed is right. Discarded on the operator's instruction and re-raced on a quiet box. — attempt `019f9f5e-891c-715d-9a19-54b2cd041140`
- `bench-gemma3-12b-v4-r2` (gemma3:12b): host contention: the workstation was in interactive use during this run (operator report, 2026-07-26). Ollama shared the GPU and the executor shared the CPU with foreground work, which inflates deliberation latency and time-to-goal — the two headline columns — by an unmeasured amount. No gate can detect this: the run is honest, the fleet is healthy, the seed is right. Discarded on the operator's instruction and re-raced on a quiet box. — attempt `019f9f6f-f71e-742f-a11b-3e8750d2067d`
