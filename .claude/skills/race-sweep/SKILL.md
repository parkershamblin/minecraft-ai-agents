---
name: race-sweep
description: Use when running, resuming, or troubleshooting a benchmark race sweep — bench/sweep_race.py, scripts/race-rb2.mjs, bench/race/frozen-config.json, bench/results/sweep/manifest.json, pristine-world snapshot build/restore, or diagnosing a sweep halt / discarded run. Delivers the end-to-end honest-sweep procedure: preconditions, launch commands, the two gates, manifest and resume rules, typed halt exit codes, axis-sweep rules, and post-sweep aggregation.
---

# Running an honest race sweep

Use this for any model-table or sensitivity (axis) benchmark run, resume, or
halt diagnosis. NOT for: writing/auditing the resulting report or its numbers
(see the bench-report skill), deciding whether a change needs a configVersion
bump (see the contract-change skill — one bump invalidates all older rows for
re-bench), deploying service code or clearing the shell-profile env block (see
the deploy-service skill), or ad-hoc ledger/RCON interrogation outside a sweep
(see the live-forensics skill).

## 1. Preconditions — all before any GPU is spent

- [ ] Pristine snapshot exists and is the pinned seed:
      `D:\backups\ai-civilization-engine\pristine-6233701440491701965-v3.tgz`
      (seed `6233701440491701965` = `frozen.world.seed`). Missing → build it, §7.
- [ ] `bench/race/frozen-config.json` is current: `configVersion` matches what
      you intend to publish under; `frozen.world.posts` pinned (red `[-416,-192]`,
      blue `[364,-583]`); `$versionHistory` has an entry for the version.
- [ ] Services rebuilt from main: the sweep recreates agent-service and
      memory-service with `up -d --no-deps` (NO `--build` — see
      `recreate_agent_service` in `bench/sweep_race.py`), so a stale image
      survives the sweep's own recreate. Deploy `--build --no-deps` first and
      never race off `task dev:up` (see the deploy-service skill).
- [ ] Clean shell: this machine's profile exports a stale race-config env block
      and process env beats `--env-file` (deploy-service skill). The sweep pins
      and printenv-verifies its frozen knobs, but unpinned knobs leak through.
- [ ] Ollama serving every swept model at `localhost:11434` — `warm_model`
      preloads at the ARM's `OLLAMA_NUM_CTX` so run 1 isn't cold-load skewed.
- [ ] Stack up (`task up:all`), containerized Paper on its own profile.
- [ ] `demos/.stack.lock` checked and taken — a sweep drives docker, Minecraft,
      AND Ollama, and can clobber a concurrent filming session's takes (lock
      protocol: see the demo-filming skill).
- [ ] Never edit agent-service src mid-attempt: a reload makes in-memory
      RaceState forget the race (CLAUDE.md).

## 2. Launch

Model-table sweep (blocked by model; world restored before every block):

```powershell
uv run --with httpx python bench/sweep_race.py `
  --models llama3.1:8b,gemma3:12b --runs 5 `
  --world-snapshot D:\backups\ai-civilization-engine\pristine-6233701440491701965-v3.tgz
```

Axis (sensitivity) sweep — one frozen knob varied, everything else baseline:

```powershell
uv run --with httpx python bench/sweep_race.py `
  --models llama3.1:8b `
  --axis TICK_INTERVAL_SECONDS --axis-values 15,30,60 --runs 5 `
  --world-snapshot D:\backups\ai-civilization-engine\pristine-6233701440491701965-v3.tgz
```

Optional guards for unattended runs: `--stop-on-dirty` (halt on first honesty
trip, evidence preserved) and `--max-consecutive-dnf N` (halt a run of honest
DNFs — kept rows, but more budget buys the same non-answer).
`--no-world-reset` exists but re-arms the wear confound; rows record
`worldSeed: null` and are not protocol-complete.

Before racing, the sweep itself verifies three DIFFERENT claims — know them so
you never bypass one: (1) `frozen_env()` refuses an override for a knob the
baseline never pinned; (2) `assert_single_axis()` proves the effective env is
exactly one knob off baseline; (3) in-container printenv proves the container
received the values, and FAILS on a key absent from both sides (the
vacuous-compare guard). It also pins `LLM_TEMPERATURE` + `REFLECTION_ENABLED` +
`REFLECTION_DAILY_TOKEN_BUDGET` in memory-service, because a tripped
reflection breaker is silent and keeps the honesty gate green.

## 3. The two independent gates — both must pass to keep a row

| Gate | Reads | Catches | Fails when |
|---|---|---|---|
| Honesty (brain) | `AttemptEnded.honestRace` | FakeProvider pollution, budget trip | either delta != 0 |
| Fleet health (body) | villager-window slice | spawn storms, mute bodies | any racer > `SPAWN_STORM_THRESHOLD` (10) `VillagerSpawned`, or `DecisionMade > 0` with `ActionCompleted == 0` |

A run passing one and failing the other is NOT a benchmark row — the honesty
gate banked `{0,0}` runs while Elara spawn-stormed (manifest rows: x625, x958,
x1008) and her team raced a member short — found only by an offline session
audit on 2026-07-26 and retro-discarded. A stalled-but-honest run is
a KEPT DNF: real signal, feeds the win-rate denominator (time-to-goal averages
won runs only; schema-violation fallbacks stay in latency/token samples).
Dirty or contaminated runs are discarded and rerun (`MAX_DIRTY_RERUNS = 2`,
so 3 tries per index), never averaged.

## 4. Manifest doctrine and resume identity

Every discard and every hole is a manifest row in
`bench/results/sweep/manifest.json`, rewritten after EVERY run (a mid-sweep
crash loses at most the in-flight race). Current discard outcomes: `orphaned`
(timeout-killed), `extract-failed`, `contaminated` (fleet), `no-clean-run`
(hole after 3 tries), `block-setup-failed` — each with a `reason` string.
Two caveats when filtering: an honesty-dirty discard keeps its RACE outcome
(`won`/`stalled`) with reason "polluted honestRace deltas" — so filter on
`discarded: true`, never on outcome values; and historical rows carry legacy
outcomes the current code never emits (`crashed` ×1, `host-contended` ×7). A
hole that stays a log line is silent censoring that flatters slow arms.

Resume key (`run_key`): `(sweepKind, model, index, configVersion, worldSeed,
axis, str(axisValue))` — every field is something that, if different, makes an
existing row a non-substitute. Rerunning the same command resumes: kept rows
are skipped, holes and discards are re-raced. axisValue is stringified on both
sides so `60` and `"60"` cannot fork a key.

## 5. Typed halt exit codes

| Exit | Meaning | Response |
|---|---|---|
| 0 | sweep complete | aggregate (§8) |
| 3 | 2 consecutive preflight failures | environment broken — read `bench/results/sweep/logs/` |
| 4 | seed gate tripped (`SeedGateError`) | wrong world; check snapshot + `rcon-cli seed`, nothing retried |
| 5 | `--stop-on-dirty` honesty trip | evidence in manifest + `slices/` + `logs/`; audit before rerun |
| 6 | `--max-consecutive-dnf` reached | rows kept; arm/environment broken, diagnose before more budget |
| 7 | 2 consecutive fleet-contaminated runs | storm → recreate minecraft-service, re-seed, verify 6 racers by name; mute → read that villager's ActionFailed codes first (live-forensics skill) — rerunning will not unstick it |

Seed mismatch halts the WHOLE sweep (a wrong world is not a bad block);
ordinary block-setup failures are recorded and skipped so one bad arm does not
cost the night's GPU-hours.

## 6. Axis-sweep rules (Phase 3b)

- Axes live only in `sensitivityAxes` (frozen-config); adding one is metadata,
  no bump. The sweep refuses undeclared axes, undeclared values, and axes
  marked `runnable: false` (stance needs a mobs-ON variant config).
- The baseline arm is MANDATORY and raced inside the sweep — a control that
  did not share the world restores and preflight bound is not a control.
- Arm order: `TICK_INTERVAL_SECONDS` interleaves per run index;
  `OLLAMA_NUM_CTX` blocks (runner reload) and carries a stated order caveat.
- Per-run process timeout scales with the tick arm (`race_timeout_seconds`) —
  the 75-min watchdog is inter-milestone, NOT total; a fixed bound would
  timeout-kill exactly the slow arm's runs.
- The preflight asserts tick EQUALITY (`--expect-tick`), not a relaxed bound.
- Axis rows never enter the model table: `aggregate_race.py` partitions on
  `sweepKind` and writes `bench/results/AXIS_REPORT.md` separately.

Full rationale: `docs/runbooks/race-sensitivity-sweep.md`.

## 7. Pristine snapshot build / world reset — wrap the runbook

Follow `docs/runbooks/race-world-reset.md` verbatim; do not improvise. The
essentials it enforces:

- [ ] PowerShell only — Git Bash mangles `-v /paths` in `docker run`.
- [ ] Scoped teardown of `ai-civilization-engine_minecraft-data` ONLY. NEVER
      `task nuke` — its `down -v` destroys postgres (ledger, memories) and
      redpanda, and its confirm prompt hangs non-interactive shells.
- [ ] Bake gamerules + `time set day` + `weather clear` + `save-all`, then
      VERIFY `rcon-cli seed` BEFORE snapshotting (SEED env seeds new worlds
      only; an existing volume keeps its own seed).
- [ ] Cold-stop, tar the whole volume, verify with `tar tzf ... | wc -l`.
- [ ] New seed → re-derive posts with the operation that must succeed:
      `spreadplayers <X> <Z> 0 8 false Ansel` then `data get entity Ansel Pos`
      then locate-biome forest distance ~0, posts >= 700 apart (`locate biome`
      picks water on this seed and spreadplayers' error names neither).

Per-block restore (automated by `--world-snapshot`): stop → wipe-then-extract
in one alpine container (a leftover region file IS the wear) → `up -d --wait`
→ EXACT numeric seed compare (the sign-flipped seed CONTAINS the pinned
string) → per-name `execute if entity <name>` fleet gate, 300s deadline
(never parse `list` — ellipsized at ~26 players; POV cams satisfy any count).

## 8. Post-sweep

```powershell
uv run python bench/aggregate_race.py          # RACE_REPORT.md + AXIS_REPORT.md
uv run python bench/bench_race.py --reextract  # re-derive all rows offline from saved slices
```

Reports are generated — never hand-edit them (bench-report skill owns writeup
discipline). Known threats to state in any writeup: villager memory and
relationships accumulate across blocks (restore touches minecraft-data only),
and within-block wear still correlates with run index.

## Verification

```powershell
# Restored world is the pinned world (exact number, not substring)
docker exec ai-civilization-engine-minecraft-1 rcon-cli seed
# Each racer online by name — "Test passed" iff online
docker exec ai-civilization-engine-minecraft-1 rcon-cli "execute if entity Ansel"
# Frozen knobs actually in the container
docker exec ai-civilization-engine-agent-service-1 printenv | Select-String 'LLM_|TICK_|OLLAMA_NUM_CTX'
# Manifest has a row for every planned index (kept, discarded, or hole)
uv run python bench/aggregate_race.py   # prints kept/discarded counts per report
# Extractor still golden (part of task test)
cd bench; uv run --python 3.12 --with pytest pytest -q
```

A sweep followed this skill iff: exit code is 0 or a typed halt you diagnosed;
every planned (model, arm, index) has a manifest row; every kept row has
`honest {0,0}` and clean `fleetHealth`; and the seed logged for every block is
exactly `6233701440491701965`.
