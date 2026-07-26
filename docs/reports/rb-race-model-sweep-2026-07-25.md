# Which local LLM should run a Minecraft villager? — RB-race model sweep

**Date:** 2026-07-25 · **Data:** 30 honest runs (25 sweep + 5 re-bench), zero
discarded, 2026-07-24 → 2026-07-25 · **Protocol:** `bench/race/frozen-config.json`
(GovSim-style, see Method) · **Numbers table:** `bench/results/RACE_REPORT.md` ·
**Attempt ids:** `bench/results/sweep/manifest.json` (every claim below traces
to one) · **PRs:** #90 (sweep), #91 (qwen re-bench).

---

## Executive summary

Five local Ollama models each ran the Red-vs-Blue resource race five times
under an identical frozen config, varying **only the model**. The question:
which small local LLM can actually drive an embodied agent — perceive, decide
in JSON, act on a 30-second tick — well enough to finish a Minecraft
progression race?

**Answer: an 8B-class instruction-tuned model is enough, and mid-size models
are better at speed than at reliability.**

| Model | Params | Win rate | Time-to-goal (won runs) | Verdict |
|---|--:|--:|--:|---|
| `llama3.1:8b` | 8B | **5/5** | 945.3 ± 329.2 s | Most reliable |
| `gemma4:latest` | ~12B | **5/5** | 1001.3 ± 605.8 s | Reliable, high variance |
| `gemma3:12b` | 12B | 4/5 | **650.9 ± 150.7 s** | Fastest winner, one stall |
| `qwen3.5:4b` | 4B | 1/5 | 4225.4 s (n=1) | Thinking tax — **dropped from the roster** |
| `lfm2.5:latest` | ~1B | 0/5 | — | Too slow + sloppy for the tick — **dropped from the roster** |

The two bottom rows are excluded from future sweeps by owner decision
(2026-07-25, recorded in `bench/race/frozen-config.json` → `modelRoster`).
The rows themselves stand: this is a decision about future GPU-hours, not a
retraction of data.

Four results stand out:

1. **Reliability and speed split.** `llama3.1:8b` never lost (5/5) but its
   times drifted upward across its block (700.9 s → 1301.8 s, attempts
   `019f9400` → `019f9437`). `gemma3:12b` posted the fastest winning mean
   (650.9 s, best single run 580.5 s, `019f94a3`) but stalled once for 92
   minutes (`019f944e`). If one number must be picked per model, win rate and
   time-to-goal disagree about the winner.
2. **A reasoning model without a thinking switch is structurally mute.**
   `qwen3.5:4b` went 0/5 under config v1 — not because it played badly, but
   because it never played: it spent the context window on chain-of-thought
   and returned empty completions (pooled p50 111.0 s per decision, 8,149
   tokens per decision against an `OLLAMA_NUM_CTX` of 8192). After the
   provider learned to send `think: false` (config v2, PR #91), pooled p50
   latency collapsed to 1,576 ms and it won a race (`019f97de`, 4225.4 s) —
   still weak, but now measuring Minecraft ability instead of contract
   incompatibility.
3. **This is the first truly greedy dataset — on the deliberation half of
   the loop.** A compose bug meant `LLM_TEMPERATURE` was never passed into
   agent-service before this sweep — every earlier "temperature 0" reference
   actually sampled at 0.7. Fixed in PR #90; all 30 runs here *deliberated*
   greedily at 0.0. One honest qualifier: compose passes no `LLM_TEMPERATURE`
   to memory-service either
   (`infrastructure/docker/docker-compose.yml`, the memory-service
   `environment:` block), and that service's `llm_temperature` defaults to
   0.7 (`services/memory-service/src/memory_service/settings.py`), handed
   straight to the reflection summarizer (`memory_service/llm.py`).
   Reflections write the memory stream, and the memory stream is retrieved
   into the deliberation prompt — so these 30 runs are greedy where the
   decision is made and 0.7 where the memories it reads are written. It is
   the same class of bug PR #90 fixed one service over, it is not fixed here,
   and it cannot be reconstructed for these runs. Pre-sweep records
   (including the 360.4 s reference, `019f7337`) remain ceilings from a
   different protocol, not comparable rows.
4. **The biggest cost is not the model at all.** 6,324 of 10,772 resolved
   actions across the sweep failed (58.7%), and a single executor-side error
   string — `"Took to long to decide path to goal!"`, a mineflayer pathfinder
   timeout — is 4,280 of those 6,324 failures (67.7%). It is identical for
   every model, sits on the `minecraft-service` side of the seam, and tracks
   time-to-goal within a block at r = +0.966 (llama3.1:8b). The model axis
   this sweep varied has less headroom left than that one call does.

## Method

GovSim-style validity (papers/GovSim.pdf): one frozen environment, greedy
decoding, N repeated runs, mean ± 95% CI (Student-t, `bench/stats.py`).

- **Frozen config** (`bench/race/frozen-config.json`): Easy difficulty,
  mob-free, 6 villagers in fixed 3v3 teams, 30 s tick, `OLLAMA_NUM_CTX=8192`,
  4-lane LLM concurrency gate, `LLM_TEMPERATURE=0.0`. The **only** varying
  axis is the model (`LLM_MODEL_OLLAMA`).
- **Race:** both teams start bare-handed; first team to the top of the 5-rung
  progression ladder (through first coal, etc.) wins. A run with no winner
  when the sweep harness calls the stall (watchdog nominally ~75 min; two
  kept DNFs ran 92.4 and 95.4 min before the call — `019f944e`, `019f981f`)
  is a DNF ("stalled").
- **Honesty gate:** a run counts only if `AttemptEnded.honestRace == {0,0}` —
  zero FakeProvider fallbacks, zero budget-breaker trips. All 30 runs passed;
  none were discarded (`bench/results/sweep/manifest.json`, every entry
  `"discarded": false`).
- **DNF policy:** a stalled-but-honest run is kept — it counts against win
  rate and contributes behavioural (Tier B) metrics, but its duration is
  excluded from time-to-goal (that would measure the watchdog, not the model).
- **Metric definitions** (revised 2026-07-25, applied to all 30 runs by
  offline re-extraction from the saved slices — no re-racing):
  - *Latency* is a **true percentile of each run's pooled raw per-decision
    latencies**, both teams' samples merged, taken at extraction time
    (`tierB._run.latencyMs`) and then averaged across runs. It was previously
    a decision-weighted mean of the two per-team p50s — a mean of medians,
    which is not a percentile of anything. The per-model p50s moved under 1%
    (the two teams' distributions nearly coincide); the point is that the
    quantity is now the thing it is labelled.
  - *Tokens* are reported as **tokens/decision**, which is invariant to how
    long the window happened to be, plus tokens/minute as a rate. Tokens/run
    is demoted to a secondary table beside the mean window length it depends
    on: a DNF's window is the ~75 min watchdog against ~10–30 min for a win,
    so tokens/run partly measured how long a model failed for.
  - *Schema-violation fallbacks are IN both samples.* A `DecisionMade` with
    `payload.error == true` still cost the latency and the tokens it reports
    before falling back to `idle`, and for the weakest models those rows are
    most of the run (lfm2.5 57.9%, qwen v1 98.3%) — excluding them would
    flatter exactly the models that fail loudest. The per-run share is
    recorded in `tierB._run.llm.decisionsWithError`.
- **Machinery:** `bench/sweep_race.py` (resume-safe blocked sweep),
  `bench/bench_race.py` (Tier A/B metric extractor, golden-tested against
  fixture `bench/race/fixtures/bench-llama3.1-8b-r1.*`, attempt `019f9400`;
  `--reextract` replays every saved slice offline),
  `bench/aggregate_race.py` (table builder, and the source of every derived
  number in `RACE_REPORT.md` — including its threats-to-validity figures, so
  a hand-edit to that generated file cannot survive a regeneration). Harness
  is versioned (`configVersion`); v2 differs from v1 only in sending
  `think: false` to thinking-capable models — plain models' request payloads
  are byte-identical, so their v1 rows remain valid.

## Results, model by model

Full numbers, CIs, and the per-run appendix with all 30 attempt ids:
`bench/results/RACE_REPORT.md`. Highlights and interpretation here.

### llama3.1:8b — the dependable baseline (5/5)

Won every run (attempts `019f9400`, `019f940c`, `019f9417`, `019f9428`,
`019f9437`), mean 945.3 s. Best gather efficiency of the field (1.14
blocks per gather request) and lowest waste ratio among the winners (0.602).
Fast decisions (pooled p50 1,687 ms) mean it almost never misses a tick, and
it is the leanest model per decision in the field (2,416 ± 22 tokens). Its
times worsened monotonically-ish across the block (700.9, 680.9, 1101.7,
941.1, 1301.8 s) — a real within-block drift (+146.2 ± 47.4 s per run index,
t = +3.08), though not one that shifts the between-model table; see the
world-wear discussion below.

### gemma4:latest — reliable but streaky (5/5)

Also unbeaten (attempts `019f94ce` → `019f9513`), mean 1001.3 s, but with the
widest spread of any 5/5 model (± 605.8, sd 488.0 s): four runs between 620.7
and 981.3 s, one 1822.1 s outlier (`019f94f7`). Decisions are slow (pooled p50
8,518 ms, p99 16,316 ms), which costs ticks but not, apparently, races. It is
also the most token-hungry model per decision in the field (3,121 ± 39) —
an ordering that only became visible once tokens were normalised by decision
rather than by run.

### gemma3:12b — fastest when it works (4/5)

The four wins averaged 650.9 s with the tightest CI of the field (± 150.7);
its 580.5 s (`019f94a3`) and 580.8 s (`019f94ac`) runs are the fastest honest
greedy times recorded under this protocol. But its first run (`019f944e`)
stalled for 5544.8 s — a kept DNF that makes it the only mid-size model to
drop a race. Its tokens/run CI (± 1,253,815) is an artifact of that one
watchdog-length run, not decision verbosity: per decision it is an ordinary
2,556 ± 28, which is exactly why tokens/decision is now the headline column.
Pooled p50 latency 3,593 ms.

### qwen3.5:4b — the thinking-tax case study (0/5 v1, 1/5 v2)

Under v1 (attempts `019f951e` → `019f9634`): five stalls, ~100% effective
idle. Diagnosis from ledger + logs: as a hybrid reasoning model it spent the
whole context window thinking and produced empty completions, so nearly every
deliberation fell back to idle (3 gather decisions in the entire v1 block).
That row measured incompatibility with the non-thinking decision contract,
not ability.

The fix (PR #91): the Ollama provider now probes `/api/show` once per model
(cached) and sends `think: false` to thinking-capable models; probe failure
degrades to the plain payload. Smoke test: valid JSON in 2.0 s / 47 tokens
where v1 returned emptiness at 8192.

Under v2 (attempts `019f97de` → `019f9902`): one win at 4225.4 s plus four
honest DNFs — including one 5726.7 s stall (`019f981f`). Now it genuinely
plays and genuinely loses: at 4B params it gathers at 0.26 blocks/request
(worst of any model that ever won) and 2,669 of its 2,895 gather commands
(92.2%) failed. Its 2.46M tokens/run is mostly window length — 2,689 ± 31
tokens per decision is mid-pack — so the indictment is competence, not
appetite. Verdict: the contract fix worked; the model is simply too small.

### lfm2.5:latest — engaged but outpaced (0/5)

Five stalls (attempts `019f967a` → `019f978f`). Unlike v1 qwen it actually
played: 540 decisions per run pooled (502–569 per run), 40.7% gather actions
pooled, blocks collected in every run. But ~24 s deliberations (pooled p50
23,780 ms, p99 44,284 ms) against a 30 s tick through the 4-lane gate, plus
frequent schema violations (out-of-range relationship deltas, junk targets),
left 57.9% of its decisions as idle fallbacks and 1,031 of its 1,099 gather
commands (93.8%) failed. It never reached first coal inside the watchdog
window. Failure mode: throughput and discipline, not muteness.

## The result that reframes the sweep: it is the executor, not the model

The model table above varies the one axis the benchmark was built to vary.
Counting what actually failed says most of the wall-clock is being spent
somewhere else entirely.

Across all 30 runs, **6,324 of 10,772 resolved actions failed (58.7%)**.
Restricted to `gather`, the verb that actually advances the ladder, the
failure rate over gather commands issued is:

| Model | Gather cmds | Failed | Rate |
|---|--:|--:|--:|
| `llama3.1:8b` | 674 | 497 | 73.7% |
| `gemma4:latest` | 714 | 631 | 88.4% |
| `gemma3:12b` | 1147 | 1041 | 90.8% |

Even the fleet default fails roughly three gather commands in four. And the
failures are not spread across the executor's surface — **a single error
string is 4,280 of the 6,324 failures (67.7%)**: `"Took to long to decide
path to goal!"`, errorCode `INTERNAL`, a mineflayer pathfinder timeout.
State that precisely, because the two are not interchangeable: errorCode
`INTERNAL` totals 4,399; the specific string is 4,280. The second largest
cause is the 60 s gather-trip cutoff (520). The entire remaining errorCode
mix is small by comparison: `RESOURCE_NOT_FOUND` 666, `TOOL_TIER_REQUIRED`
455, `TOOL_REQUIRED` 204, `PATH_NOT_FOUND` 20, `STALE_COMMAND` 14,
`SMELT_FAILED` 4, `TARGET_ESCAPED` 2.

The failure rate is not incidental to the score. Within a block, a run's
failure rate tracks its time-to-goal at **r = +0.966** for `llama3.1:8b`
(n=5) and **r = +0.759** for `gemma3:12b` (all five runs). The won-only
`gemma3:12b` value of +0.999 is a selection artifact over n=4 and should not
be quoted. `gemma4:latest` is the exception at r = +0.106 — its variance is
dominated by the single 1822.1 s outlier rather than by failure rate.

Bookkeeping caveat: ~180 of the 10,772 outcome events (1.7%) reference a
`commandId` with no in-window `ActionRequested` (window-edge truncation),
and the gather denominator counts commands issued while the numerator counts
resolved outcomes. These rates are robust at roughly the 2% level, not
tighter — which does not touch the conclusion at these effect sizes.

**What this reframes:** the sweep asked which LLM is best at driving a
villager, and answered it. But two thirds of everything that goes wrong in
these races is one pathfinder timeout in `minecraft-service`, on the
executor side of the seam, identical for every model. Optimising the model
axis further has less headroom than fixing that one call. This is the next
thing to work on, and it is not an LLM problem.

## Temperature is not the next knob either

A standing hypothesis was that greedy decoding (temperature 0.0) causes
decision livelock — a villager deterministically re-emitting the same
decision forever. Tested offline against all 30 runs, it is **not supported
for any viable model.**

Consecutive identical decisions by the same villager are common. Classified
against the causation chain (`DecisionMade` → `ActionRequested` →
`ActionFailed`/`ActionCompleted`), they are overwhelmingly *retries after the
action failed*, which is correct behaviour, not livelock:

| Model | Repeats | After a failed action | True livelock |
|---|--:|--:|--:|
| `llama3.1:8b` | 589 | 465 (79%) | 0 |
| `gemma3:12b` | 633 | 555 (88%) | 0 |
| `gemma4:latest` | 325 | 291 (90%) | 0 |
| `qwen3.5:4b` (v1) | 143 | 0 (0%) | 143 |
| `qwen3.5:4b` (v2) | 3186 | 2008 (63%) | 1012 |
| `lfm2.5:latest` | 1717 | 588 (34%) | 1096 |

"True livelock" is the only shape temperature could explain: `idle` repeated
after an action that did **not** fail. It is exactly **0** in all three
viable models. It appears only in the two excluded models, and there it is
the `error == true` schema-violation fallback to `idle` — a contract failure
with a deterministic output, not a sampling effect. Turning temperature up
would not fix it; emitting valid JSON would.

Stated honestly against my own conclusion: the per-run repeat fraction *is*
higher in stalled runs than in won ones (0.749 vs 0.546, exact-key,
averaged over the 15 runs of each outcome). But that is collinear with the
failure rate in the section above — more failed actions means more retries —
and it does not survive as an independent cause once the causation chain is
consulted. **Temperature is not the next knob to turn.**

## Threats to validity

Stated in full in `bench/results/RACE_REPORT.md`; the load-bearing ones:

- **Time of day and weather ran free — a genuinely unpinned axis.**
  `scripts/race-rb2.mjs` pins `keepInventory`, `doInsomnia`, `mobGriefing`
  and `doMobSpawning`, but it never issues `time set` or `weather clear` —
  only the non-benchmark drills do (`scripts/drill-rb1.mjs:140-141`,
  `scripts/drill-rb2.mjs:138-139`). Neither `doDaylightCycle` nor
  `doWeatherCycle` is pinned in `bench/race/frozen-config.json`, and nothing
  in the repo ever disables them. Every one of the 30 runs therefore started
  at an arbitrary point in the day/night and weather cycle — an axis that
  plausibly moves mob-free gathering (light level at the dig face, rain) and
  that the frozen config silently does not freeze. It is trivially fixable
  going forward by adding both commands to the race script; it **cannot** be
  reconstructed for the existing 30 runs, which is why it is recorded here as
  a threat rather than corrected as an error. This was previously documented
  in neither report.
- **World wear is a hygiene problem, not a demonstrated bias — the earlier,
  stronger claim is withdrawn.** Blocks ran on a shared persistent world
  without resets, in order llama3.1 → gemma3 → gemma4 → qwen → lfm2.5, so
  within-block run index is confounded with world age. Earlier drafts of this
  report said run index alone could account for the entire winner ranking.
  Measured against the manifest, it cannot:
  - Run index can only shift a between-model mean if the blocks cover
    different indices. `llama3.1:8b` and `gemma4:latest` each won all five
    runs, spanning indices 1–5, **identical mean index 3.00** — so run index
    cannot generate the 56.0 s gap between their means at all.
  - The only unbalanced block is `gemma3:12b` (won indices 2–5, mean index
    3.50, because its run 1 was the DNF). That shifts it toward *later*,
    more-worn indices, which under the posited positive wear biases
    **against** gemma3, not for it.
  - Detrending each block by its own within-block OLS slope to a common index
    **widens** the gaps rather than dissolving them: llama–gemma3 294.4 →
    328.5 s, gemma3–gemma4 350.4 → 384.5 s.
  - There is no cumulative wear across the sweep. Over the 14 winners of the
    v1 sweep in run order: Pearson **+0.142**, Spearman **−0.029**, **+10.7 s
    per step**. Durations reset at every block boundary.
  - `gemma4:latest`'s own within-block slope is **+20.0 ± 177.8 s per step
    (t = +0.11)** — indistinguishable from zero. Only `llama3.1:8b`
    (+146.2 ± 47.4, t = +3.08) and `gemma3:12b` (+68.2 ± 19.1, t = +3.56)
    drift within their blocks, and gemma3's drift is **+204.6 s across its
    observed idx 2→5 span**. (An earlier figure of +272.8 s was an off-by-one:
    it multiplied a 3-step observed span by 4.)

  The caution itself survives — do not read adjacent winner rows as a
  ranking — but it is justified by **raw sampling noise at n=5**, not by the
  wear mechanism: `gemma4:latest`'s sd is 488.0 s against a 56.0 s gap to
  `llama3.1:8b`. Resetting the world per block or interleaving run order is
  still worth doing as experimental hygiene. It is simply not what makes
  these rows unrankable.
- **DNF windows inflate token totals — FIXED in the metric layer.** Stalled
  runs run ~75 min vs ~10–30 for wins, so tokens/run for 0-win models measured
  a longer window. The headline token column is now **tokens/decision** (window-
  length invariant) with tokens/minute as the rate; tokens/run survives only in
  a secondary table next to the mean window length it depends on. Gather
  efficiency and waste ratio are still ratios taken over a longer window for
  DNF-heavy models.
- **Latency p50 was a decision-weighted mean of per-team p50s — FIXED.** It is
  now a true percentile of each run's pooled raw per-decision latencies
  (`tierB._run.latencyMs`, retained at extraction time), averaged across runs.
  Schema-violation fallbacks (`DecisionMade.error == true`) stay in the sample:
  they cost real latency and real tokens, and for the weakest models they are
  most of the run. The per-model p50s moved by under 1% (the two teams'
  distributions nearly coincide) except lfm2.5, 23.6 → 23.8 s.
- **Only half the loop is greedy.** memory-service receives no
  `LLM_TEMPERATURE` from compose and defaults to 0.7, so reflections — which
  write the memory stream the deliberation prompt retrieves from — sampled at
  0.7 in all 30 runs. See executive-summary point 3; it is the same class of
  bug PR #90 fixed in agent-service, it is unfixed, and it is not
  reconstructible for these runs.
- **n=5 per model.** CIs are honest about it (they are wide); treat adjacent
  rows as ties unless CIs separate.

## What this changes

- **Default model choice:** `llama3.1:8b` stays the fleet default — only
  model that combined 5/5 with fast decisions and top gather efficiency.
  `gemma3:12b` is the speed-run pick when a stall is acceptable.
- **Model roster narrowed (project owner, 2026-07-25).** `qwen3.5:4b` and
  `lfm2.5:latest` are **dropped from the viable set** and will not be given
  GPU-hours in future sweeps, on the evidence already in this report:
  qwen3.5:4b 0/5 at v1 and 1/5 at v2 with 92.2% of its gather commands
  failing; lfm2.5:latest 0/5, never reaching first coal in any run, with
  57.9% of decisions falling back to `idle`. The decision is recorded in
  `bench/race/frozen-config.json` → `modelRoster` (metadata only — lowercase,
  so it is never exported to a container and warrants no `configVersion`
  bump). **Their rows in the table above stay.** This is a forward-looking
  decision about where to spend GPU time, not a retraction of collected data.
- **Provider layer:** thinking-capable models are now safe to bench (v2
  `think:false` path); any future reasoning-model row must be v2+.
- **Benchmark integrity:** deliberation temperature is actually greedy now
  (reflections still are not); the harness is versioned so contract changes
  can never silently mix into old rows; and the threats-to-validity figures
  in `bench/results/RACE_REPORT.md` are now *derived by the generator* rather
  than typed, so an audit correction can no longer be reverted by a
  regeneration.
- **Next optimisation target is not the model.** Two thirds of all action
  failures are one mineflayer pathfinder timeout in `minecraft-service`.
  That is where the wall-clock is, and it is model-independent.

## Next (Phase 3b — not started)

Sensitivity sweep on the same frozen protocol, one axis at a time, never mixed
into the model table: tick interval, threat stance, `OLLAMA_NUM_CTX` — over
the approved roster only (`llama3.1:8b`, `gemma3:12b`, `gemma4:latest`).
Those protocol fixes have since landed as **configVersion 3** (code only — no
run has yet used it): `race-rb2.mjs` now freezes and reads back
`doDaylightCycle`/`doWeatherCycle` and stamps day + clear weather;
`sweep_race.py` restores a pristine pinned-seed world
(`6233701440491701965`) before every model block behind an RCON seed gate;
and compose finally passes `LLM_TEMPERATURE` to memory-service, so
reflections stop sampling at 0.7 inside a greedy run. Procedure:
`docs/runbooks/race-world-reset.md`. Consequence for this report: **v3 rows
cannot be pooled with anything above** — the three approved models need an
N=5 re-baseline at v3 before 3b's axes mean anything, and within-block wear
still argues for interleaving. The pathfinder timeout above is still the
larger prize.

---

*Reproduce any row:*
`uv run --with httpx python bench/sweep_race.py --models <model> --runs 5
--world-snapshot <pristine.tgz>`, then `uv run python bench/aggregate_race.py`.
That now races at configVersion 3, so it produces a NEW block rather than
re-running a row above — the v1/v2 world is gone and those rows are not
reproducible, only re-derivable from the saved slices
(`bench/bench_race.py --reextract`). Attempt ids in this report are
prefixes; full UUIDv7 ids in `bench/results/sweep/manifest.json`.
