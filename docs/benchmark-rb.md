# Phase 1 — Metric Substrate for the RB Race Benchmark

> **NEW-SESSION KICKOFF — read this box first.** This plan is executed cold in a
> fresh session. Nothing from the planning conversation is assumed. Everything
> needed is below.
>
> **What this is:** Phase 1 of a plan to produce a GovSim-style model-comparison
> table for the Minecraft Red-vs-Blue race (see `papers/GovSim.pdf`). Phase 0
> (film one clean take) is already done. Phase 1 builds only the *substrate* —
> frozen config + a tested metric extractor + temperature docs. NO model sweep,
> NO live races here (that is Phase 2).
>
> **Locked decisions (do not re-litigate):**
> - Language/home: **Python in `bench/`** (mirrors `bench/bench_llm_gate.py`).
> - Frozen benchmark config: **Easy, mob-free** (lowest non-model variance).
> - Phase 1 scope: build **both** metric tiers; golden-test **Tier A** now,
>   Tier B's fixture lands in Phase 2.
> - Temperature: `LLM_TEMPERATURE` is already wired (`settings.py:48`, default
>   0.7). Phase 1 only **documents** it and pins `0.0` in the frozen config —
>   **no provider code**.
>
> **First moves when you start:** re-read the four files in "Reuse (no edit)"
> below to refresh their current line numbers (they may have drifted), confirm
> `film/flagship-slice.json` still exists, then implement the Deliverables in
> order 1→4. Do not run live races.

## Context

Phase 0 (film one clean honest take) is done: attempt
`019f9361-5913-7642-903e-1826f731c0d4`, blue won 911.4s, honest `{0,0}`,
saved as `film/flagship-slice.json`. The larger goal is a GovSim-style model
comparison table (survival/efficiency/equality-shaped metrics per LLM) for the
Red-vs-Blue race. Before any model can be benchmarked, two things must exist:

1. **A frozen benchmark config** — every run must be identical except the model,
   or the table measures the harness, not the LLM. GovSim's validity rests on
   this plus greedy decoding (temperature 0) and N runs with confidence
   intervals.
2. **A deterministic, tested metric extractor** — the table is only trustworthy
   if the numbers are computed the same way every time and the computation is
   golden-tested. Today the only per-attempt number is wall-clock time-to-goal.

This phase builds the substrate (config + extractor + temperature knob docs),
NOT the model sweep — that is Phase 2.

## Key facts from exploration

- **Attempt ledger slice** (`aggregate-type=Attempt&aggregate-id=<id>`) holds
  ONLY `AttemptStarted` / `ProgressionMilestone` / `AttemptEnded`. Per-villager
  events (`DecisionMade`, `ActionRequested/Completed/Failed`, `ResourceGathered`)
  are `aggregateType:"Villager"` — invisible to that query. They are fetched by a
  `since`/`until` window bounded by the AttemptStarted/AttemptEnded `occurredAt`.
  Envelope is `{data, nextCursor}` (NOT `items`); ledger is event-service on
  **:8081**, ascending by `occurredAt`, keyset `cursor` pagination
  (`services/event-service/.../EventsController.java:37`).
- **`LLM_TEMPERATURE` already exists end-to-end** — `settings.py:48` (default
  0.7), threaded into OpenAI + Ollama + every per-team provider
  (`llm/providers.py:313,330,397`). It is GLOBAL (all teams share). It is
  **undocumented** — absent from `.env.example` and `.env`. GovSim greedy =
  set it to `0.0`. No provider code needed.
- **`bench/` is the metric home** — Python: `bench_*.py` runners, `stats.py`
  (mean/CI helpers for the N-run aggregation), `runner.py`, output to
  `bench/results/*.json` + `*.csv` + `REPORT.md`. Mirror `bench/bench_llm_gate.py`.
- **Slice parsing already exists** in `scripts/render-race-film.py`: `load()`
  (`:64`), `parse()` (`:60`), `fmt()` (`:84`), `MILESTONES` (`:29`). Reuse the
  parsing shape.
- **Roster is single-source** in `services/agent-service/seed/villagers.json`
  (6 entries carry a `team` field; ids match the AttemptStarted payload). Load
  the roster from there to group `villagerId` events by team — do NOT add a
  third hardcoded `NAME_OF` table (render-race-film.py:38 and race-rb2.mjs:90
  each have one already).
- **No test covers `scripts/` or `bench/`** today. `task test`
  (`Taskfile.yml:84-97`) runs 6 service suites; a new golden test must be a
  pytest wired in with one line.

## Deliverables

### 1. Frozen benchmark config — `bench/race/`
- `bench/race/frozen-config.json` — pins every benchmark-invariant knob:
  `difficulty: "easy"`, `mobs: false`, `VILLAGER_COUNT: 6`,
  `TICK_INTERVAL_SECONDS`, `THREAT_DEFAULT_STANCE: "cautious"`,
  `OLLAMA_NUM_CTX: 8192`, `LLM_TEMPERATURE: 0.0`, and the fixed 3v3 roster ids.
  Declares the single varying axis: `LLM_MODEL_OLLAMA` or `LLM_TEAM_MODELS`.
- `bench/race/README.md` — the protocol: N seeded runs per model, greedy
  temp 0, aggregate mean + 95% CI via `bench/stats.py`, Easy mob-free chosen to
  minimize non-model variance (combat/mob-spawn noise excluded by decision).
  Reference record for this config: **Easy mob-free 360.4s** (`019f7337`).

### 2. Temperature knob documentation (no code)
- Add `LLM_TEMPERATURE=0.7` with an explanatory comment to `.env.example`
  (block near `LLM_MODEL_OLLAMA`), noting `0.0` = greedy/reproducible for
  benchmark runs, and that it is global across all team providers.
- Mirror the same commented line into `.env` (kept 0.7 for normal play; the
  benchmark harness overrides to 0.0 via the frozen config / process env).

### 3. Metric extractor — `bench/bench_race.py`
Mirror `bench/bench_llm_gate.py` structure. Reuse roster load from
`villagers.json`; reuse the `render-race-film.py` slice-parse shape.

Modes:
- `--slice <file.json>` → Tier A offline (the golden-test path).
- `--attempt <id> [--ledger http://localhost:8081]` → fetch the attempt slice
  AND the villager window (`since`/`until` from AttemptStarted/AttemptEnded
  `occurredAt`, follow `nextCursor`), compute Tier A + Tier B.

**Tier A** (attempt slice — deterministic, golden-tested now):
- winner team + winning villager, `durationSeconds` (time-to-goal)
- per-milestone offset seconds for the 5-rung ladder, per team; who reached
  each rung first + lead margin
- `honestRace` deltas (fakeProviderDelta, budgetTrippedDelta), difficulty,
  config echo.

**Tier B** (villager window — implemented now, golden-tested in Phase 2):
- per-team gather efficiency = `ResourceGathered.quantity` sum ÷ gather
  `ActionRequested` count
- waste ratio = `ActionFailed` count (+ redundant/overshoot gathers) ÷ total
  actions
- decision mix = counts of move/gather/craft/hunt from
  `DecisionMade`/`ActionRequested`
- LLM stats = `tokensUsed` sum + latency p50/p95 from `DecisionMade`
  (`latencyMs`), per team.

Output: `bench/results/race_<label>.json` + `.csv`, REPORT-style summary line —
matches the existing `bench/results/` convention so the N-run aggregation (Phase
2) feeds straight into `stats.py`.

### 4. Golden test — `bench/test_race_metrics.py` (pytest)
- Input fixture: existing committed `film/flagship-slice.json`.
- Assert computed **Tier A** equals a committed expected doc
  `bench/results/race_flagship.expected.json` (winner=blue, duration=911.4,
  the 5 milestone offsets, honest `{0,0}`).
- Wire into `Taskfile.yml` test list: one line `cd bench && uv run pytest -q`
  (add a `.github/workflows/` entry mirroring the other per-suite gates so CI
  catches extractor drift).
- Tier B is NOT golden-tested this phase (no window fixture yet) — it is
  verified live against the ledger during the first Phase 2 run, then a captured
  window slice is committed as its fixture. Stated as an explicit scope boundary.

## Scope boundaries (explicit)
- No model sweep, no N-run loop wiring, no live races run in this phase — that is
  Phase 2. This phase makes the sweep *possible and trustworthy*.
- No provider/agent-service code changes (temperature already wired).
- Tier B ships as code but its golden fixture + test land in Phase 2.

## Verification
1. `cd bench && uv run pytest -q` — Tier A golden test green against
   `film/flagship-slice.json`.
2. `uv run --with httpx python bench/bench_race.py --slice film/flagship-slice.json`
   → prints/writes `bench/results/race_flagship.json`; eyeball winner=blue,
   911.4s, 5 milestone offsets.
3. Tier B live smoke (optional, needs a live ledger): `... --attempt <id>` on any
   past attempt id present in the ledger; confirm per-team gather/decision tallies
   are non-empty and grouped correctly.
4. `task test` still green (new suite included).
5. Confirm `LLM_TEMPERATURE` documented in `.env.example`; `frozen-config.json`
   pins `0.0`.

## Files
- New: `bench/bench_race.py`, `bench/test_race_metrics.py`,
  `bench/race/frozen-config.json`, `bench/race/README.md`,
  `bench/results/race_flagship.expected.json`, `.github/workflows/` bench entry.
- Edit: `.env.example`, `.env`, `Taskfile.yml` (test list).
- Reuse (no edit): `bench/stats.py`, `bench/bench_llm_gate.py` (template),
  `scripts/render-race-film.py` (parse shape),
  `services/agent-service/seed/villagers.json` (roster).
