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
| `qwen3.5:4b` | 4B | 1/5 | 4225.4 s (n=1) | Thinking tax; barely viable |
| `lfm2.5:latest` | ~1B | 0/5 | — | Too slow + sloppy for the tick |

Three results stand out:

1. **Reliability and speed split.** `llama3.1:8b` never lost (5/5) but its
   times drifted upward across its block (700.9 s → 1301.8 s, attempts
   `019f9400` → `019f9437`). `gemma3:12b` posted the fastest winning mean
   (650.9 s, best single run 580.5 s, `019f94a3`) but stalled once for 92
   minutes (`019f944e`). If one number must be picked per model, win rate and
   time-to-goal disagree about the winner.
2. **A reasoning model without a thinking switch is structurally mute.**
   `qwen3.5:4b` went 0/5 under config v1 — not because it played badly, but
   because it never played: it burned the entire 8192-token context window on
   chain-of-thought and returned empty completions (~111 s median per
   decision, ~8192 tokens each). After the provider learned to send
   `think: false` (config v2, PR #91), latency collapsed from ~111 s to 1.6 s
   p50 and it won a race (`019f97de`, 4225.4 s) — still weak, but now
   measuring Minecraft ability instead of contract incompatibility.
3. **This is the first truly greedy dataset.** A compose bug meant
   `LLM_TEMPERATURE` was never passed into agent-service before this sweep —
   every earlier "temperature 0" reference actually sampled at 0.7. Fixed in
   PR #90; all 30 runs here decoded greedily at 0.0. Pre-sweep records
   (including the 360.4 s reference, `019f7337`) are therefore ceilings from a
   different protocol, not comparable rows.

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
- **Machinery:** `bench/sweep_race.py` (resume-safe blocked sweep),
  `bench/bench_race.py` (Tier A/B metric extractor, golden-tested against
  fixture `bench/race/fixtures/bench-llama3.1-8b-r1.*`, attempt `019f9400`),
  `bench/aggregate_race.py` (table builder). Harness is versioned
  (`configVersion`); v2 differs from v1 only in sending `think: false` to
  thinking-capable models — plain models' request payloads are byte-identical,
  so their v1 rows remain valid.

## Results, model by model

Full numbers, CIs, and the per-run appendix with all 30 attempt ids:
`bench/results/RACE_REPORT.md`. Highlights and interpretation here.

### llama3.1:8b — the dependable baseline (5/5)

Won every run (attempts `019f9400`, `019f940c`, `019f9417`, `019f9428`,
`019f9437`), mean 945.3 s. Best gather efficiency of the field (1.14
blocks per gather request) and lowest waste ratio among the winners (0.602).
Fast decisions (p50 ≈ 1.7 s) mean it almost never misses a tick. Its times
worsened monotonically-ish across the block (700.9, 680.9, 1101.7, 941.1,
1301.8 s) — see the world-wear confound below.

### gemma4:latest — reliable but streaky (5/5)

Also unbeaten (attempts `019f94ce` → `019f9513`), mean 1001.3 s, but with the
widest spread of any 5/5 model (± 605.8): four runs between 620.7 and
981.3 s, one 1822.1 s outlier (`019f94f7`). Decisions are slow (p50 ≈ 8.5 s),
which costs ticks but not, apparently, races.

### gemma3:12b — fastest when it works (4/5)

The four wins averaged 650.9 s with the tightest CI of the field (± 150.7);
its 580.5 s (`019f94a3`) and 580.8 s (`019f94ac`) runs are the fastest honest
greedy times recorded under this protocol. But its first run (`019f944e`)
stalled for 5544.8 s — a kept DNF that makes it the only mid-size model to
drop a race. Its token CI (± 1,253,815) is an artifact of that one
watchdog-length run, not decision verbosity.

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
(worst of any model that ever won) and burns 2.46M tokens per run. Verdict:
the contract fix worked; the model is simply too small.

### lfm2.5:latest — engaged but outpaced (0/5)

Five stalls (attempts `019f967a` → `019f978f`). Unlike v1 qwen it actually
played: ~540 decisions per run (502–569), ~41% gather actions pooled, blocks
collected in every run. But ~23 s deliberations (p50 23.6 s) against a 30 s
tick through the 4-lane gate, plus frequent schema violations (out-of-range
relationship deltas, junk targets), left ~58% of its decisions as idle
fallbacks. It never reached first coal inside the watchdog window. Failure
mode: throughput and discipline, not muteness.

## Threats to validity

Stated in full in `bench/results/RACE_REPORT.md`; the load-bearing ones:

- **World wear confounds run order.** Blocks ran on a shared persistent world
  without resets, in order llama3.1 → gemma3 → gemma4 → qwen → lfm2.5.
  Within-block run index correlates with wear (llama3.1's 700.9 → 1301.8 s
  drift), and model identity is partially confounded with world age across
  blocks. The 0/5 vs 5/5 gap is far too large for wear to explain, but
  between-winner time differences (llama vs gemma4, 945 vs 1001 s,
  overlapping CIs) should not be read as rankings. Fix queued: world reset
  per block, or interleaved run order.
- **DNF windows inflate token totals.** Stalled runs run ~75 min vs ~10–30
  for wins, so tokens/run for 0-win models measures a longer window.
- **Latency p50 is a decision-weighted mean of per-team p50s**, not a pooled
  raw percentile — raw latencies are not retained.
- **n=5 per model.** CIs are honest about it (they are wide); treat adjacent
  rows as ties unless CIs separate.

## What this changes

- **Default model choice:** `llama3.1:8b` stays the fleet default — only
  model that combined 5/5 with fast decisions and top gather efficiency.
  `gemma3:12b` is the speed-run pick when a stall is acceptable.
- **Provider layer:** thinking-capable models are now safe to bench (v2
  `think:false` path); any future reasoning-model row must be v2+.
- **Benchmark integrity:** temperature is actually greedy now; the harness is
  versioned so contract changes can never silently mix into old rows.

## Next (Phase 3b — not started)

Sensitivity sweep on the same frozen protocol, one axis at a time, never mixed
into the model table: tick interval, threat stance, `OLLAMA_NUM_CTX`. Plus the
world-reset/interleaving fix above before any between-winner ranking claims.

---

*Reproduce any row:*
`uv run --with httpx python bench/sweep_race.py --models <model> --runs 5`,
then `uv run python bench/aggregate_race.py`. Attempt ids in this report are
prefixes; full UUIDv7 ids in `bench/results/sweep/manifest.json`.
