# Runbook: Phase 3b sensitivity sweep

The model table answers "which LLM". The sensitivity sweep answers "how much
does the answer depend on a knob we froze". It runs on the **same v3 protocol**
— pristine pinned-seed world per block, frozen day/weather, pinned reflection
temperature and budget, same honesty gate — and its rows go to a **separate
report** (`bench/results/AXIS_REPORT.md`). They never enter
`RACE_REPORT.md`; `bench/aggregate_race.py` partitions on the manifest's
`sweepKind` before any aggregate is computed.

## Run it

```powershell
uv run --with httpx python bench/sweep_race.py `
  --models llama3.1:8b `
  --axis TICK_INTERVAL_SECONDS --axis-values 15,30,60 `
  --runs 5 `
  --world-snapshot D:\backups\ai-civilization-engine\pristine-6233701440491701965-v3.tgz

uv run python bench/aggregate_race.py     # writes both reports
```

Declared axes live in `frozen.sensitivityAxes` (`bench/race/frozen-config.json`),
which is the only place an axis and its legal values exist. Adding one there is
metadata and does **not** bump `configVersion`; changing a value in `frozen`
does.

## The rules the harness enforces for you

- **One axis, verified twice.** `frozen_env()` refuses an override for a knob
  the frozen config does not pin (you cannot vary something the baseline never
  fixed), and `assert_single_axis()` then proves the effective env differs from
  baseline in *exactly* the declared axis. After the container starts, the
  printenv check proves it actually received that value. Two different claims:
  "the protocol delta is one knob" and "the container got it".
- **The baseline arm is mandatory** and is raced *inside* the axis sweep, not
  borrowed from the model table. A control that did not share the sweep's world
  restores, block order and preflight bound is not a control.
- **Arm order is not confounded with arm.** `TICK_INTERVAL_SECONDS` is
  interleaved: the arms rotate per run index, so no arm systematically runs
  late. `OLLAMA_NUM_CTX` is blocked instead — switching it forces an Ollama
  runner reload — and carries that as a stated caveat.
- **The process timeout scales with the tick arm.** The 75-minute watchdog in
  `race-rb2.mjs` is *inter-milestone*, not total: the existing manifest holds a
  5544.8 s DNF against a 6600 s process bound. A fixed bound would kill slow-arm
  runs, which are discarded and rerun, quietly shrinking N for exactly the arm
  most likely to be slow — a censoring that flatters it.
- **The preflight asserts the tick, it does not merely permit it.** The sweep
  passes `--expect-tick <arm>` and `race-rb2.mjs` checks equality. Relaxing its
  default `<= 30` bound to the arm value would only restate the request.
- **Holes are recorded, not logged and forgotten.** A run that never produces a
  clean take writes an `outcome: "no-clean-run"` row, and a block whose setup
  fails writes `outcome: "block-setup-failed"` and moves to the next arm
  instead of aborting an unattended overnight sweep. Both appear in the axis
  report's Coverage section.

## Axis status

| Axis | Runnable | Note |
|---|---|---|
| `TICK_INTERVAL_SECONDS` | yes | interleaved arms; 15 / 30 / 60 |
| `OLLAMA_NUM_CTX` | yes | blocked arms (runner reload); 4096 / 8192 / 16384 |
| `THREAT_DEFAULT_STANCE` | **no** | refused by the sweep — see below |

**Stance cannot be measured under this frozen config.** Stance governs the
hostile-threat response, but `frozen.mobs` is `false` and the race preflight
both disables `doMobSpawning` and kills every hostile type, so there is nothing
for a stance to govern. What remains is `GuardTether`'s idle-post radius — a
mobility knob wearing a threat knob's name. Measuring stance honestly needs
mobs ON, which is a **different frozen config** and cannot share a baseline
with the tick and ctx arms. The README's "`guard` costs ~80s on Easy" folklore
predates this config and does not transfer. The sweep refuses `--axis
THREAT_DEFAULT_STANCE` with that explanation rather than producing a confident
null result.

## Budget

At N=5, one model, one axis, three arms = 15 runs. Winning runs on the model
table averaged ~650–1000 s, so a tick sweep is roughly 4–8 h including restores
(~2 min each) and agent-service recreates; the 60 s arm is the long pole and its
timeout is scaled accordingly. Two axes on one model is an overnight run. Three
models × three axes at N=5 is 135 runs — budget it as a multi-day campaign or
cut N per arm and say so in the report.

## What it still cannot tell you

Villager memory and relationships accumulate across every block (the restore
touches `minecraft-data` only), so arm order effects are damped but not
eliminated — see `docs/runbooks/race-world-reset.md`, "What v3 does and does
not fix". And at N=5 per arm, a difference smaller than the arm's own CI is
noise, not sensitivity.
