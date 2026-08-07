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

## Stance axis — design APPROVED, execution DEFERRED (2026-07-26)

Owner's ruling: the design below is accepted, nothing is to be run. Kept here
so the mechanics are documented rather than re-derived. The sweep still refuses
`--axis THREAT_DEFAULT_STANCE`, and that refusal stays until someone
deliberately builds the variant described here.

**Why it cannot run under the current frozen config.** Stance gates the
hostile-threat response — `flee` vs `fight` at
`services/minecraft-service/src/bots/threat.ts:96`, plus `guard`'s wider ranged
window at `threat.ts:92`. `frozen.mobs` is `false` and the race preflight both
sets `doMobSpawning false` and kills all 16 hostile types, so there is nothing
for a stance to govern. The only code still live across arms is `GuardTether`'s
idle-post radius — a mobility knob wearing a threat knob's name. A sweep today
would return a confident null about the wrong mechanism.

**Config shape: a parallel VARIANT, not a v4 bump.** Add a `variants.mobs`
overlay to `frozen-config.json` that sets `mobs: true` and inherits every other
knob; select it with `--variant mobs`; rows carry `configVariant: "mobs"`; the
aggregator partitions on it exactly as it already partitions `sweepKind`.

A version bump would be the wrong tool. `configVersion` means *the old rows are
invalid, re-bench them* — that is why the aggregator retires lower versions and
why the v3 bump cost a re-baseline. Mob-free rows are not invalidated by a
mobs-on experiment; they answer a different question. **Versions are for
protocol corrections; variants are for protocol forks.**

**Consequences of that choice:**

- **No re-baselining.** The existing v3 table is untouched, and the variant's
  control is the `cautious` arm raced inside the same sweep — never a borrowed
  row from the mob-free table.
- Arms are the real stance set (`config.ts:95`): `brave`, `cautious`
  (baseline), `guard`. All three are informative once hostiles exist —
  brave-vs-cautious is pure fight/flee, guard adds the ranged window.
- `THREAT_DEFAULT_STANCE` is a **minecraft-service** variable, not
  agent-service. Each arm recreates that container, which drops the in-memory
  bot fleet, so the sweep must re-publish spawns and then wait on the per-name
  fleet gate. That machinery exists and is crash-tested.
- The pristine snapshot works unchanged: `--mobs` flips `doMobSpawning` per run
  and verifies it, and the frozen day keeps the surface clear so hostiles
  concentrate in caves — which is exactly where the race spends its time.

**Cost:** 15 runs at N=5 across three arms. Mobs add the threat tax (attempt-4
measured 254 commands failing `SELF_DEFENSE_IN_PROGRESS` in 32 minutes), so
budget 12–30 min per run and a higher DNF rate: **~5–9 h GPU/wall**, plus a
small harness delta (variant plumbing, `--mobs` passthrough, marking stance
runnable only under the variant).

**Decide before running:** if DNFs dominate, N=5 yields win-rate rows rather
than duration rows. That is still an answer — stance moves survivability, not
speed — but it has to be accepted as the deliverable up front, not discovered
afterwards.

## Budget

At N=5, one model, one axis, three arms = 15 runs. Winning runs on the model
table averaged ~650–1000 s, so a tick sweep is roughly 4–8 h including restores
(~2 min each) and agent-service recreates; the 60 s arm is the long pole and its
timeout is scaled accordingly. Two axes on one model is an overnight run. Three
models × three axes at N=5 is 135 runs — budget it as a multi-day campaign or
cut N per arm and say so in the report.

## Results, and why the axes are closed (2026-07-26)

Both runnable axes are DONE for `llama3.1:8b` at N=5, all v3, 25 kept honest
rows (`bench/results/AXIS_REPORT.md`). (CORRECTION 2026-08-07: this section
originally said 30 kept and "4096 / 8192 / 16384 all went 5/5" — the entire
16384 arm was later retro-discarded as fleet-contaminated (manifest: five
`contaminated` rows plus one `block-setup-failed`; AXIS_REPORT correctly
shows N=0) and this prose was never updated. The generated report was right;
the narrative drifted.)

- **`OLLAMA_NUM_CTX` is a null with a mechanism — on two arms, not three.**
  4096 / 8192 went 5/5 with overlapping CIs; the 16384 arm has ZERO kept rows.
  Deliberations cost ~2.4k tokens, so the prompt fits in 4096 and extra window
  is dead weight. (The previously-quoted "16384 arm's −224 s" came from the
  since-discarded rows and is withdrawn.)
- **`TICK_INTERVAL_SECONDS` has an asymmetric cliff.** 15 s buys ~75 s (inside
  noise); 60 s costs +572 s *and* drops the win rate to 3/5 with honest DNFs at
  runs 2 and 4. Cadence starves the race long before context does.

**Not extending either axis to `gemma3:12b` / `gemma4:latest`** (owner's call,
2026-07-26). The ctx null generalises by mechanism — gemma4 at ~3.1k
tokens/decision still fits in 4096 — so those 15 runs would buy nothing. The
tick extension was only ever a filming-lever question (where does gemma's cliff
sit?), and filming stays at tick-30, so it is moot. Revisit only if filming
plans change.

## What it still cannot tell you

Villager memory and relationships accumulate across every block (the restore
touches `minecraft-data` only), so arm order effects are damped but not
eliminated — see `docs/runbooks/race-world-reset.md`, "What v3 does and does
not fix". And at N=5 per arm, a difference smaller than the arm's own CI is
noise, not sensitivity.
