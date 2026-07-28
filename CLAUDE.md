## HANDOFF (current session)

**Last checkpoint:** PHASE 2 MODEL SWEEP COMPLETE (2026-07-25, branch
`phase2-model-sweep`). 25/25 honest runs (zero dirty), 5 models × N=5
under `bench/race/frozen-config.json`: llama3.1:8b 5/5 wins 945.3s±329.2,
gemma4 5/5 1001.3s±605.8, gemma3:12b 4/5 650.9s±150.7 (fastest winner),
qwen3.5:4b 0/5, lfm2.5 0/5. Full table + method caveats + failure
diagnoses: `bench/results/RACE_REPORT.md`; per-attempt ids in
`bench/results/sweep/manifest.json`. CRITICAL FIX shipped: compose never
passed `LLM_TEMPERATURE` into agent-service — this sweep is the FIRST
truly greedy (0.0) data; all earlier references ran 0.7. New machinery:
`bench/sweep_race.py` (resume-safe blocked sweep, honesty gate, DNF-kept
policy), `bench/aggregate_race.py` (mean+95% CI via `stats.mean_ci95`),
Tier B golden fixture `bench/race/fixtures/bench-llama3.1-8b-r1.*`
(3-way verified, attempt `019f9400-…`). 0-win diagnoses: qwen3.5:4b =
reasoning model burns whole 8192 ctx on think, EMPTY completions, ~100%
idle; lfm2.5 = plays but ~23s deliberations at 30s tick + schema
violations, never reached coal. Known confound (in report): blocked run
order on shared world — wear correlates with run index.

**Update (2026-07-25, branch `qwen-think-rebench`):** PR #90 merged.
Follow-ups (1) and (3) DONE: OllamaProvider now probes /api/show (once,
cached) and sends `think:false` to thinking-capable models — plain
models' payloads byte-identical; probe failure degrades to plain. Bench
harness versioned (`configVersion: 2`; sweep skips/labels/records by
version, aggregator uses each model's highest). qwen3.5:4b v2 re-bench:
**1/5 win 4225.4s + 4 honest DNFs** (was 0/5 mute); latency p50 111s →
1.6s; smoke: think:false → valid JSON in 2.0s/47 tokens (was empty at
8192). `test_no_key_falls_to_ollama_with_warmup` pins llm_model_ollama —
the .env flake is dead, plain `task test` green locally.

**Update (2026-07-25, branch `phase3-race-writeup`):** PHASE 3 DONE.
Narrative report `docs/reports/rb-race-model-sweep-2026-07-25.md`
(exec summary, method, per-model analysis, threats to validity).
Traceability review pass ran (fresh-eyes agent): 30/30 attempt ids,
all appendix rows, all 25 aggregate cells reproduce from
manifest+result JSONs; found and FIXED 3 run-1-only lfm2.5 numbers
that had propagated from PR #90's diagnosis (54% gathers→41% pooled,
~560 decisions→~540, ~40% idle→58% idle decisions) plus qwen v1
overstatements ("exactly 8192", "every deliberation") in BOTH
RACE_REPORT.md and the narrative. Known-unverifiable-from-repo claims
(smoke 2.0s/47tok, param counts, reference-record knobs) flagged in
review, kept with secondary sourcing.

**Update (2026-07-26, v3 EXECUTED + 3b harness):** World transition RUN.
Pre-wipe backup `D:\backups\ai-civilization-engine\pre-v3-world-
1709071022456631449.tgz` (264 MB, seed RCON-verified before the wipe);
pristine `pristine-6233701440491701965-v3.tgz` (232 MB) built with
gamerules baked + seed gate + graceful stop. FIRST v3 RUN GREEN:
`bench-llama3.1-8b-v3-r1`, attempt `019f9bf3-4634…`, **won 680.6s**,
honest {0,0}. Consequence: llama3.1:8b's row is now v3 n=1 and its five
v1 runs left the table (25 -> 21 kept) — report marks provisional rows
(n<3) and banners the v1/v2/v3 version mix. TWO REAL BUGS caught by
running it: (1) the fleet-readiness gate counted PLAYERS, and the POV
rig's 6 cams satisfy any count gate with zero villagers — now waits by
roster name; (2) on this seed `locate biome` picks WATER for the blue
post, `spreadplayers` refuses liquid with a message naming neither —
posts now PINNED in `frozen.world.posts` (red [-416,-192], blue
[364,-583], both forest-distance 0, 873 apart, symmetry checked). 9
review findings applied (no-reset rows can't be resumed into or pooled
as v3; reflection budget pinned+verified — a tripped breaker keeps the
honesty gate green; exact seed match; wear prose + caveats now derived,
not asserted). Phase 3b harness IMPLEMENTED: `--axis/--axis-values`,
axis rows partitioned out of the model table by `sweepKind`, separate
`AXIS_REPORT.md`, interleaved tick arms, tick-scaled process timeout
(the 75m watchdog is inter-milestone, NOT total), holes recorded as
rows, `--expect-tick` equality. **Stance axis REFUSED** under
`mobs:false` — no hostiles to govern, so it would measure GuardTether's
idle radius; needs a mobs-ON config. Tests 20 green. Runbooks:
`docs/runbooks/race-world-reset.md`, `race-sensitivity-sweep.md`.
NOTHING COMMITTED YET — tree also carries prior uncommitted bench work.

**Update (2026-07-25, v3 world protocol — CODE LANDED, NOT YET RUN):**
Owner's call: land the whole protocol in ONE bump before any new runs,
so 3b doesn't bake in confounds a v3 would invalidate anyway. Shipped:
compose pins `SEED: "6233701440491701965"` (minecraft, new worlds only)
and finally passes `LLM_TEMPERATURE` to **memory-service** — reflections
ran at the 0.7 default in every v1/v2 "greedy" run; `frozen-config.json`
is `configVersion: 3` with a `frozen.world` block (seed, per-block reset,
gamerules, day/clear); `race-rb2.mjs` preflight freezes and reads back
`doDaylightCycle`/`doWeatherCycle` + `time set day` + `weather clear`;
`sweep_race.py` restores a pristine snapshot per block (wipe-then-extract,
RCON seed gate, waits for the fleet to reconnect), recreates+verifies
memory-service, and records `worldSeed` per run; the 30 pre-v3 manifest
rows are labelled with the old seed `1709071022456631449`. Runbook:
`docs/runbooks/race-world-reset.md`. **Nothing has been raced under v3** —
the pristine snapshot does not exist yet; build it (one-time section of
the runbook) before the first sweep. No v2 re-bench: that budget goes to
v3 re-baseline (llama3.1:8b, gemma3:12b, gemma4:latest, N=5) plus the
free `/api/show` probe on lfm2.5 before writing it off.

**Update (2026-07-26, 3b RESULTS — llama3.1:8b, N=5, all v3):** Both
axes DONE, 30 kept honest rows, zero dirty (`bench/results/
AXIS_REPORT.md`, commit `1cd1eff` on `v3-protocol`). num_ctx 4096/8192/
16384: all 5/5, overlapping CIs — INSENSITIVE (prompts fit in 4096).
Tick: 15s = 533.1±152.6 (no real gain), 30s = 608.6±136.7, 60s =
1181.1±1077.4 **and 3/5 with honest DNFs at r2/r4** — asymmetric cliff;
cadence starves the race, context does not. Mid-sweep power loss
recovered via resume-safe path (crashed attempt `019f9d4a` recorded as
discarded row, log preserved as `.log.crashed`). NEW GOTCHA promoted to
the permanent list: RCON `list` is ellipsized at ~26 players — fleet
gate now probes `execute if entity <name>` per name. Fleet recovery:
`task seed` spawns nothing for EXISTING villagers; `spawn-fleet.mjs`
spawns ALL 20 — for the race fleet use spawn-fleet then
`despawn-fleet.mjs 6` (racers are villagers.json[0:6]).

**Update (2026-07-27, v7 — latest-intent-wins, model table re-benched):**
`configVersion 7`, 15/15 kept, zero mute among kept rows, one run
discarded+re-raced (llama r4: Elara AND Petra mute). gemma4:latest
696.8±255.6 · llama3.1:8b 864.8±180.3 · gemma3:12b 944.9±296.3 — means
still overlap, so still RELIABILITY not ranking. **The fix worked on its
own terms: `STALE_COMMAND` 0.44/run at v6 -> 0.00/run at v7, replaced by
~13 `SUPERSEDED`/run** (a villager dropping its own older intent, logged
to the ledger instead of vanishing). sd tightened for llama (441.6 ->
180.3) and gemma4 — plausible but n=5, not established. Muteness still
occurred once, so stale queues were A cause not THE cause; the 60s-trip-
inside-30s-tick ceiling stands, gate costs ~1 re-race per 16 runs.
GOTCHA THE DEPLOY CAUGHT (unit tests were green): superseding must NEVER
apply to lifecycle actions — the first live deploy dropped `spawn` for
Bram and Ansel in favour of a newer gather, leaving them bodiless and
every later command `BOT_DISCONNECTED`. `LIFECYCLE_ACTIONS` exempts
spawn/despawn; regression test in `test/executor.test.ts`.

**Update (2026-07-27, v6 SHIPPED — model table final):** `configVersion 6`,
15/15 kept, all won, all honest, zero mute among kept rows. gemma4:latest
716.8±394.0 · llama3.1:8b 788.8±548.2 · gemma3:12b 816.8±294.3 — three
means inside each other's CIs, so the table shows RELIABILITY, not a
ranking. Path here cost four protocol bumps: v4 cluster-blacklist (a
per-block mark cannot escape a tree), v5 relocation (built the escape
hatch, locked it with the same blacklist — fired ZERO times, two mutes,
guard halted the sweep), v6 relocation fallback (walk toward blacklisted
ground when nothing else exists; clear region marks on arrival) —
validated by replaying real mute-run coordinates BEFORE spending GPU
(`services/minecraft-service/test/relocationReplay.test.ts`). Gates now:
honesty + seed + fleet-health (spawn storms AND mute villagers) +
2-consecutive halts. **Known and accepted (owner's call): the 60s gather
trip budget sits inside a 30s tick, and iron_ore trips routinely exceed
it — top timeout source for ALL SIX villagers (Wren 19% iron success vs
roster 32-41%). Dense timeouts saturate one villager's command queue
(`STALE_COMMAND`, aged 617s) and that villager goes mute. Uniform across
models, so it caps absolute performance without biasing the comparison.**
Open if revisited: latest-intent-wins in the command consumer, or a
depth-scaled trip budget. Discards on record, none silent: 11 v3 (Elara
reconnect storm, 625-1962 spawns/race), 7 v4 (host contention — honest,
healthy, correct seed, still not comparable), 2 v4 + 1 v6 (mute).

**Update (2026-07-27, branch `feedback-loop-close` — papers READ, top
candidate BUILT):** Six-paper sweep done (one subagent per paper);
synthesis + ranked shortlist: `docs/reports/papers-synthesis-2026-07-27.md`.
Convergent verdicts: NL negotiation/coordination is DEAD at 8B (GovSim,
MINDcraft, MineLand independently — structured state, not chat, must carry
coordination); GovSim's oracle universalization hint is the ONE finding
proven on our model class (llama-3-8B 1.0→8.0 months, temp 0); Voyager's
self-verification is the −73% component and our ledger does it rule-based
for free; VoT REGRESSES at 8B (spatial truth stays code-side); MINDcraft's
success-filtered SFT lifts llama3-8b 0.00→0.28 (beats gpt-4o) from ~200
winning trajectories — our ledger already logs that raw material. Shortlist:
(1) close-the-loop BUILT, (2) governance-quota arc (universalization as
elected policy), (3) ledger→SFT exporter, (4) verb-plan skill library,
(5) prompt-wins bundle. BUILT this session, tests green (minecraft-service
379 + tsc clean, agent-service 228), NOT deployed, zero contract changes:
far-target move gate (`MOVE_MAX_DISTANCE` env, default 128 horizontal
blocks; fast PATH_NOT_FOUND with a staging-waypoint message BEFORE
pathfinding — gather/hunt already had contract clamps 64/48, move had none)
+ abandon-and-repropose (`ActionAwareness` failure streaks keyed by intent
identity; plumbing codes SUPERSEDED/STALE_COMMAND/BODY_BUSY/… never count;
3 consecutive substantive refusals → standing "CHANGE COURSE" prompt
section, cleared by success or 10 quiet ticks — expiry so a stale ban can't
block a race win).

**Update (2026-07-27, same branch — owner reset + function calling at the
provider seam):** Owner DISCARDED everything after the paper-sweep baseline
(commit `56823ad` reverts ADR 11 beat-the-game, phase-A verbs+skills,
hawkeye pin, and the first FC pass — all recoverable at `5f738d6`) and
directed: implement Stephen Blum's function-calling advice, native tools
where APIs support it. SHIPPED (`e47baae`, agent-service 241 green, 13 new):
OpenAI now sends ONE forced strict function tool `decide`
(tool_choice pinned, parallel off) instead of response_format; NEW
AnthropicProvider (Messages API, forced strict tool, thinking disabled, NO
temperature — sampling params are removed on current Claude models, so
Anthropic decisions are not greedy-reproducible); `decision_tool_schema()`
in contract.py (reasoning-first, params anyOf union of ActionRequested
$defs, strictified, bounds stripped for the wire); chain now
openai → anthropic → ollama → fake; settings `ANTHROPIC_API_KEY` +
`LLM_MODEL_ANTHROPIC` (default claude-sonnet-5 — fable rejects the
disabled-thinking fast path). **Ollama decode grammar BYTE-IDENTICAL —
no configVersion churn; test-pinned in `test_tool_schema.py`.**
Re-verification workflow (5 lanes, live sources + live probes on this box's
Ollama, full verdict `docs/reports/function-calling-2026-07-27.md`):
Ollama do-not-migrate CONFIRMED on every claim at v0.32.5 (tools
template-parsed — `tools/tools.go` is a text parser; no tool_choice —
"required" silently ignored live; gemma3 400s; tools+format suppression
reproduced live; NEW #15539: gemma4 tools parser fails under
system+think:false — our exact config; live llama probe: tools-channel
decisions THINNER than grammar-channel — params {} vs real params).
Stale belief corrected: OpenAI strict mode DOES support numeric
bounds/anyOf/$refs since May 2025; conservative strip kept because
Anthropic strict does not. Stephen's advice + RSG architecture points saved
to agent memory (stephen-blum-function-calling-advice).

**Update (2026-07-28, DEPLOYED — villagers LIVE on Claude):** Owner funded
the key; agent-service redeployed (`up -d --build --no-deps agent-service`),
boot log `llm provider: anthropic` model claude-sonnet-5, 6 villagers at
30s tick. Ledger confirms the full loop: Claude decision (gather iron_ore,
percept-grounded reasoning) → ActionRequested → executor
`TOOL_TIER_REQUIRED` refusal → memory written → follow-up `craft planks`.
Run config: `.env` LLM_PROVIDER=anthropic, LLM_DAILY_TOKEN_BUDGET=4000000
(≈63 min at observed 5.3k tok/tick × 12 calls/min before the breaker flips
to FAKE — pollution risk, watch it), LLM_TEAM_MODELS blanked. Burn ≈
$13-14/hr at Sonnet rates, no prompt caching yet (cache_control on the
tools/system prefix is the obvious next cost lever). NEW PERMANENT GOTCHA:
**this machine's shell profile EXPORTS a race-config env block
(LLM_PROVIDER=ollama, LLM_TEAM_MODELS=red/blue, LLM_DAILY_TOKEN_BUDGET=100M,
VILLAGER_COUNT, TICK_INTERVAL_SECONDS…) and compose interpolation takes
process env OVER --env-file** — the first deploy silently came up on
ollama+team brains despite a correct .env. `unset` the block (or run
compose from a clean shell) before any deploy that changes LLM config.

**Update (2026-07-28 04:16Z, Claude run HALTED — owner call, cost):** The
live Claude run burned its 4M budget in 69 min (breaker tripped 03:58:12,
~$12-14 of $20 — Sonnet at 6×30s tick is ~$13.7/hr) then ran FAKE
deliberation 03:58→04:16 stop (**pollution window UNAUDITED** — check the
ledger for the FakeProvider fingerprints: "A pleasant exchange in the
morning sun", "Good day! The weather holds…", scripted relationshipUpdates
toward Bram). Fleet restored on ollama/gemma3:12b 04:17, zero API burn.
Owner's affordability ceiling: **$1/hr**. Agreed direction (NOT built):
event-driven deliberation — wire `request_reactive` to
ActionCompleted/ActionFailed + threat percepts (today it fires on chat
only, scheduler.py already has wakeups+guards), clock tick becomes ~300s
fallback heartbeat, pacing caps as the enforced $-ceiling; then Haiku
fleet ≈ $1/hr ≈ ~140 event-aligned decisions/hr. Multi-step plan-slices
(one decision drives minutes) is the follow-up multiplier.

**Next session:** (1) Anthropic live smoke DONE (2026-07-27, owner added
key + credits): claude-sonnet-5 forced decide call green end-to-end after
one real 400 the smoke caught — Anthropic strict rejects type-array+enum
nullable shapes; fixed as anyOf(enum, null) in `_strictify` (`9bf2620`).
9.9s latency, 3001/245 tokens. OpenAI smoke STILL PENDING (no key) —
required before any OpenAI filming run (risk: anyOf-union acceptance).
(2) Owner decisions still open from the paper sweep: deploy/A-B of the
far-target gate + failure streaks (GPU cost), governance-quota arc
(contract sign-off). (3) The discarded beat-the-game arc is one
`git revert 56823ad` (or cherry-picks from `5f738d6`) away if the owner
wants it back — do NOT resurrect without an explicit ask.

**Benchmark: DONE and merged** (PR #93 v3-v6, PR #94 v7, both on `main`).
No benchmark work is queued. Open items carried forward, none blocking:
- Accepted ceiling: 60s gather trip inside a 30s tick; `iron_ore` exceeds
  it for every villager. ~1 mute run per 16; the gate catches and
  re-races it. Fix would be a depth-scaled trip budget.
- Unfixed threat: villager memory/relationships accumulate across blocks
  (the restore touches `minecraft-data` only; postgres is untouched).
  Within-block wear also survives.
- Deferred: stance axis — design approved, needs a mobs-ON variant
  config (`docs/runbooks/race-sensitivity-sweep.md`).
- Stale: the Elara persona×model finding was computed on pre-v6 data;
  recompute before citing it.
- Still open: the OpenAI `params` strict-mode reshape before any OpenAI
  filming run. SV-14 row unchanged.
- Decision worth making: the published table moved twice in two days
  because every executor fix bumped `configVersion`. If that churn is
  unwanted, batch executor fixes behind one bump instead.

# AI Civilization Engine — project guide

Autonomous LLM-driven villagers in Minecraft: event-driven microservices,
LangGraph agents, pgvector memory. Everything villagers do is an immutable
event; the event ledger is the integration seam, the analytics source, and
the YouTube-episode raw material. Full design: `docs/architecture/` (00–07).
Session-to-session state: `docs/HANDOFF.md`.

## Architecture (one paragraph)

`agent-service` (Python 3.12, FastAPI, LangGraph) runs each villager's tick —
perceive → retrieve → deliberate (LLM) → act → reflect — and owns
villagers/relationships in `agent_db`. It publishes `ActionRequested` commands;
`minecraft-service` (Node 22, mineflayer) is the single executor, embodying
villagers as bots and emitting world facts. `memory-service` (Python, pgvector)
owns the generative-agents memory stream in `memory_db` (recency × importance ×
relevance retrieval). `event-service` (Java 21, Spring Boot) consumes every
topic — including commands, for causation chains — into an append-only Postgres
ledger with cursor-paged reads and an SSE live feed. `government-service`
(Java 21, Spring Boot, hexagonal like event-service) owns
elections/governments in `government_db`: the clock-driven election state
machine (scheduled → nominating → voting → decided) and the idempotent ballot
box — REST-driven since M2-6; it joins the Kafka planes with M2-7's contracts. Relationships are directed
edges (affinity −100..100, trust 0..100); every change is a
`RelationshipChanged` ledger event. Kafka = Redpanda locally. Contracts live in
`packages/events` (JSON Schema → generated TS/Python types; additive-only
within a version). `apps/dashboard` is Next.js reading via rewrites + SSE.

Ports: 3000 dashboard · 8001 agent · 8002 memory · 8003 minecraft ·
8080 BFF (M2) · 8081 event · 8082 government · 8083 analytics (M2) ·
3001 Grafana · 9090 Prometheus · 8085 Redpanda console · 25565 Minecraft.

## Start / stop the stack

```powershell
task up        # infra only (Postgres+pgvector, Redis, Redpanda, Prometheus, Grafana)
task up:all    # + the services (docker compose --profile infra --profile app)
task topics    # provision the Kafka topic map (runs inside up/up:all; partition
               # changes need docs/runbooks/kafka-topic-migration.md)
task seed      # provision villagers.json (first VILLAGER_COUNT) + spawn bots
               # (VILLAGER_COUNT=0 preset: use node scripts/spawn-fleet.mjs instead)
task test      # all test suites   ·   task gen  # regen contract types (committed!)
task down      # stop containers (volumes survive)  ·  task nuke  # fresh world
task dashboard # Next.js dashboard dev server on :3000 (host-run by decision — #78)
```

The Minecraft server is NOT in compose by default: run
`java -Xmx3G -jar server.jar nogui` in `../Minecraft 1.21.6 Server`
(type `stop` in its console to save+exit). Containers reach it via
`host.docker.internal`. Key env (in `.env`): `VILLAGER_COUNT`,
`TICK_INTERVAL_SECONDS`, `LLM_PROVIDER` (auto → openai if key, else Ollama,
else fake), `OPENAI_API_KEY` (optional — never required).

## Conventions (enforced by review and CI)

- **Contract-first**: no event/state shape ships without a schema + fixture in
  `packages/events`; regenerate with `task gen` and COMMIT the output (CI
  drift-gates it). Schema evolution is additive-only within a version.
- **Exact pins at boundaries we don't control**: `mineflayer` (with
  `MC_VERSION=1.21.6`) moves only in an atomic PR gated by `task smoke`;
  compose images pin full patch tags, never floating.
- **A service enters docker-compose.yml with its first real feature, never before.**
- Budget breakers are **per service** — any service that calls an LLM needs
  its own daily token circuit breaker and `civ_llm_*` metrics.
- Structured JSON logs everywhere with `correlationId`; one id traces a tick
  across services and the ledger.

## Permanent gotchas (this machine / this stack)

- **Docker Desktop won't start** ("cannot be accessed by the system" on a
  socket): stale AF_UNIX sockets from a crash. **Rename** (not delete — they
  resist deletion) `%LOCALAPPDATA%\Docker\run` AND
  `%LOCALAPPDATA%\docker-secrets-engine`, then relaunch. **Never "Reset to
  factory defaults"** — it wipes volumes (villager memories, the ledger).
  Wrinkle (2026-07-08, bit twice the same night): the rename can RACE a
  crashed instance's own recovery, which quietly puts a zombie sock back and
  the relaunch dies the same way. The on-screen error dialog IS the
  lingering instance — behind one such dialog sat nine live processes
  (backend, build, 5× electron, docker-agent). Order matters:
  (1) `Get-Process | ? { $_.ProcessName -match 'docker|vpnkit' } |
  Stop-Process -Force` — don't eyeball, kill; (2) rename both dirs;
  (3) verify both paths are actually GONE; (4) relaunch. Any socket under
  those dirs can be the victim (`engine.sock`, `run\dockerInference` — the
  error names whichever bind failed first). Failed-launch forensics: tail
  `%LOCALAPPDATA%\Docker\log\host\com.docker.backend.exe.log`. Variant
  (2026-07-12, after a machine reboot): the wedge can present with NO
  socket-bind error in that log — the tells are the `docker-desktop` WSL
  distro stuck `Stopped` (`wsl -l -v`), a `com.docker.diagnose` process, and
  the GUI polling `ErrorReportAPI /diagnostics/status` in a loop. Same
  ritual fixes it (that day: first try, no zombie race).
- Bare `python` on this box is a stale 3.8 — always `uv run` / `uvx` / `py`.
- New `gradlew` files need `git update-index --chmod=+x` (Windows can't store
  the exec bit; Linux CI fails without it).
- Agent/hardened shells set `NoDefaultCurrentDirectoryInExePath=1`, so cmd.exe
  won't resolve bare batch names from the CWD: `cmd /c gradlew.bat` fails with
  "not recognized" there while working fine in a normal terminal. Use the
  explicit form `cmd /c .\gradlew.bat` (the Taskfile does since M1-9).
  Second trap in the same pit (M2-6): GIT BASH converts `/c` into `C:\`
  (MSYS path mangling) — cmd prints its banner, runs NOTHING, exits 0.
  Run gradlew from PowerShell (or `cmd //c` in Git Bash).
- Git Bash mangles `/paths` in `docker run -v` args — use PowerShell for
  Docker volume mounts.
- kafkajs has no built-in Snappy codec (rpk produces snappy by default) —
  minecraft-service registers `kafkajs-snappy`; keep that import first.
  PYTHON EDITION (2026-07-22, cost a whole evening of races): aiokafka needs
  `python-snappy` for the same reason, and without it ONE rpk-produced batch
  on world.events (a Mission-Control test replayed old attempt events; rpk
  compressed them snappy) killed agent-service's percept consumer with
  `UnsupportedCodecError` AT that offset — on EVERY boot, deterministically,
  while heartbeats kept the group Stable (lag frozen, brains blind: no
  percepts, no race sections, gather discipline collapsed into move-spam and
  748 phantom-election governanceActions fed by the COMMUNITY_GOAL line).
  Codec deps (python-snappy/lz4/zstandard) are now pinned in agent-service,
  the consume-loop has a done-callback that exits(1) (compose restarts it),
  and RaceState rehydrates from the ledger at boot. Forensics that found it:
  `rpk group describe` (frozen offsets, Stable state), then an assign+seek
  probe at the committed offset inside the container venv. When you rpk
  produce onto a topic a python service consumes, pass `-z none` — or just
  don't hand-produce onto live consumer topics.
- OpenAI strict structured outputs reject optional schema properties — new
  decision-contract fields must be **required-nullable** (`type: ["x","null"]`).
  Corollary (M2-7 structural audit): strict mode ALSO rejects free-form
  objects (`{type: object}` with no properties/additionalProperties:false) —
  DECISION_SCHEMA's world `params` is exactly that, so the OpenAI provider
  path 400s TODAY, latent since M1-3 (every run so far was Ollama).
  governanceAction was built flat + strict-safe for this reason. Reshape
  `params` (superset-with-nullables) BEFORE any OpenAI filming run — and
  re-verify llama behavior after, since llama sees the same schema.
- `LLM_DAILY_TOKEN_BUDGET=2000000` is sized for PAID providers. On free local
  Ollama, 20 villagers burn it in ~30 minutes and the breaker silently flips
  deliberation to the FakeProvider — whose scripted chat + relationshipUpdates
  then POLLUTE narrative state (it manufactured a +100 "friendship" toward
  Bram on 2026-07-07; repaired from the ledger). For Ollama runs set the
  budget to 100000000. Fake-pollution fingerprints: reason "A pleasant
  exchange in the morning sun.", the greeting "Good day! The weather holds…".
- Postgres CHECK constraints pass on NULL (three-valued logic) — write
  NULL-proof constraints (see `memories_reflection_provenance`).
- Kafka consumer groups keep committed offsets across deploys: consumers that
  turn events into *time-sensitive* state need a freshness guard (see
  `agent_service/kafka/percepts.py`).
- Corollary: tests feeding envelopes through that freshness guard must stamp
  `occurredAt` at runtime (`datetime.now(UTC)`) — a hardcoded "fresh" date is
  a time bomb: green until the wall clock passes it, then silently dropped as
  stale backlog (bit `test_percept_fanout.py` on 2026-07-07).
- Corollary 2 (M1-10): the COMMAND topic needed the same guard. A kafkajs
  consumer can die silently inside a healthy-looking container (the M1-8
  connect storm did — crash without restart), freezing committed offsets;
  the next boot then replays hours of dead intents INTO THE LIVE WORLD (bots
  spoke 3.5h-old chat lines on camera day). The executor now drops commands
  older than `COMMAND_MAX_AGE_SECONDS` (600) with `ActionFailed{STALE_COMMAND}`
  (dedupe can't help — never-executed commands have no dedupe keys), and the
  consumer `exit(1)`s on unrecoverable crash with `restart: on-failure` so
  failure shows up in restart counts instead of as silence.
- Corollary 3 (same day, second wedge): the executor must `Promise.race` the
  action against the watchdog, NEVER `await` the action promise directly — a
  pathfinder promise never settles on a connection that died mid-move (any MC
  server restart can cause one), and with a single-partition command topic ONE
  pending promise freezes eachMessage and therefore EVERY bot, with no crash
  event for the exit-handler to see. Bots keep thinking; bodies freeze.
  Regression-tested in executor.test.ts ("wedge regression").
- GitHub Actions: called workflows can't escalate `GITHUB_TOKEN` permissions
  (callers must grant, even for statically-skipped jobs); caller workflows
  must include **their own file** in `paths:` filters.
- The SSE feed buffers to browsers if compression is on — `compress: false`
  in `next.config.ts` (curl streams fine either way; that's the trap).
- Service images bake their migrations and run `alembic upgrade head` on boot:
  after adding a migration, plain `up` reuses the stale image and exits with
  "Can't locate revision" — restart that service with `up --build`. Same trap
  for CODE, silently (2026-07-18): after a merge, plain `up` raced rb2-exit-1
  on a pre-#43 brain — 163 logs, 29 plank crafts, 1 stick, 0 milestones in
  15m. After ANY merge touching a service, deploy with `up -d --build
  --no-deps <service>` and verify the fix is IN the container (grep a marker
  symbol) before an attempt.
- Compose commands naming individual services still need **both**
  `--profile infra --profile app`, or cross-profile `depends_on` fails with
  "depends on undefined service: invalid compose project". Exception: the
  `minecraft` (Paper) service has **no** `depends_on`, so it starts standalone
  with a bare `--profile minecraft up -d minecraft`.
- Containerized Paper (M1-8): read server tick health via RCON —
  `docker exec ai-civilization-engine-minecraft-1 rcon-cli mspt` (also `tps`,
  `list`); `rcon-cli` inside the image auto-reads `RCON_PORT`/`RCON_PASSWORD`,
  no args needed. First-boot world-gen is ~25–30s and gated by the `mc-health`
  healthcheck (`start_period: 90s`) — use `up --wait`. The 80–118 ms MSPT `max`
  right after boot is the world-gen spike, **not** steady state: read the avg
  and let the 1-minute window roll over before trusting it (idle steady-state
  is ~2–4 ms). Point bots at it with **`MC_HOST=minecraft`** (the compose
  service name); the vanilla host server stays the fallback via
  `MC_HOST=host.docker.internal`.
- mineflayer world sweeps (`findBlocks` etc.) are CLIENT-side: they never
  cost Paper MSPT — they cost the minecraft-service **event loop**, the one
  thread that executes every bot's commands. Measured M2-2: ungated 5s
  resource scans × 20 bots pinned a full core (~175 ms/bot-scan). Any
  recurring sweep must pass a skip gate (see `shouldRescan`: movement ≥8
  blocks or survey ≥60s old, 15s hard floor between sweeps, skipped while
  the body is busy). Corollary (2026-07-17, profiled — the ~100%-core
  mystery): the pathfinder burns the loop while bots merely WALK —
  monitorMovement re-decides sprint/jump EVERY tick with up-to-340-tick
  player simulations (~40% of a core at 20 bots), each sim tick re-reading
  the same ~12 blocks as freshly constructed prismarine Blocks.
  `physicsSimCache.ts` (turn-scoped cache over `bot.physics.simulatePlayer`;
  safe because world mutations only land in packet turns) makes it cheap —
  keep it installed, profile with `scripts/profile/` before touching any of
  it, and NEVER cache at the `bot.blockAt` layer: pathfinder's
  `movements.getBlock` mutates returned blocks with query-relative fields,
  so aliasing corrupts A*. Related: bot sessions are in-memory — a
  minecraft-service container recreate silently drops the whole fleet;
  re-publish spawn commands (or `task seed`) after recreating it.
- Paper's `bukkit.yml` `connection-throttle: 4000` (per-IP) chokes the bot
  fleet after any server restart: all 20 bots share the minecraft-service
  container IP and reconnect in a synchronized 60s-backoff herd, so the
  throttle admits **one bot per minute** (~20 min to full recovery). Baked
  into the compose profile since #79 (`PATCH_DEFINITIONS` patches bukkit.yml
  to -1 every start; no first-boot hole — the image materializes
  /data/bukkit.yml before patches run). Nuke-proof for the CONTAINERIZED
  server; a host-run server's bukkit.yml is still manual. Patch-format trap:
  a file in a PATCH_DEFINITIONS directory is a bare `{file, ops}` object —
  the `{patches: [...]}` wrapper is for single-file mode, and the wrong shape
  kills the boot (exit 2).
- Worktree sessions vs the live stack (M2-6): worktrees don't carry `.env`
  (gitignored) — copy it from the main repo or compose's `--env-file .env`
  fails. Compose run from a worktree attaches to the SAME running project
  (the `name:` key), so `up -d --build --no-deps <service>` deploys the
  worktree's code without recreating anything else. But bind-mounted configs
  (prometheus.yml, postgres-init) resolve relative to the compose file each
  container was STARTED from — a worktree-side config edit reaches a running
  container only after merge + that container's restart.
  Second trap (SV-2, bit twice in one session — root cause found same day):
  a session's worktree can vanish MID-SESSION. It was NOT the harness: a
  SECOND concurrent Claude session doing branch cleanup removed the
  worktree (its dirs looked stale), stole the branch checkout, and
  re-implemented the same ticket before discovering the first session's PR.
  Recovery when it happens: whole dir emptied+deregistered → `git worktree
  add` again (branches survive); only `.git\worktrees\<name>` metadata
  deleted with files intact → recreate `HEAD`/`commondir`/`gitdir` by hand,
  then `git reset` rebuilds the index. Working files are the only
  unrecoverable part — commit and push at every green boundary. Prevention,
  BOTH directions: a file-locked `.claude/worktrees/*` dir means a LIVE
  session — check `gh pr list` and the branch's recent commits before
  removing worktrees or checking out a branch that's checked out elsewhere.
- Paper persists difficulty per-world in `level.dat`, which overrides
  `server.properties` on boot for existing worlds. An RCON `difficulty` change
  is in-memory until a world save — run `save-all` after it, or the container's
  10s stop window can discard it. `DIFFICULTY` env in compose only seeds new
  worlds. Both servers run offline mode: op entries need the offline UUID
  (derived from the name), not the Mojang one.
- Paper's `spawn-protection=16` (server.properties default) silently rejects
  block breaks by non-op players within 16 blocks of WORLD spawn — the bot's
  client thinks the block broke, the server keeps it, and the dig "completes"
  with zero yield (the ghost-dig fingerprint, cost two RB-1 drill runs).
  Baked into the compose profile since #79 (`SPAWN_PROTECTION: "0"` env,
  re-applied every boot) — nuke-proof for the CONTAINERIZED server; a
  host-run server's server.properties is still manual. Gotcha while
  seeding configs: `/config` mount contents sync to `/data/config` (the
  paper-global.yml land), NOT `/data` — bukkit.yml/server.properties can't
  be seeded that way.
  Related mineflayer flake: `placeBlock` can throw "blockUpdate did not fire
  within 5000ms" when the placement actually landed — placeCarried in
  BotSession verifies the world instead of trusting the throw.
- Docker Desktop (Windows) bind mounts forward NO inotify events for host-side
  edits: fs-event watchers inside containers (`tsx watch`, chokidar defaults)
  never fire — only POLLING watchers see host edits (uvicorn's StatReload
  polls, which is why agent-service hot-reload "just worked"). Fix for tsx:
  `CHOKIDAR_USEPOLLING=1` + `CHOKIDAR_INTERVAL=1000` env (tsx bundles
  chokidar; wired in `docker-compose.dev.yml`, verified 2026-07-18).
  Corollary: NEVER edit agent-service src mid-attempt — the reload restarts
  the worker and in-memory RaceState forgets the race (offsets committed, no
  replay; `brain/race.py` docstring).
- The ledger `GET /events` has NO `order` param (silently ignored) — pages are
  ALWAYS oldest-first within the filter. "What happened recently" queries MUST
  pass `since=` (ISO); reading page 1 as "newest" invents phantom outages
  (cost 20 min on 2026-07-18).
- `locate biome` returns a point that can be WATER, and `spreadplayers`
  refuses to place anyone on liquid — it fails with `Could not spread 1
  entity/entities around X, Z (too many entities for space - try using spread
  of at most 0.00)`, which names neither water nor the real cause. On the
  pinned benchmark seed the auto-located blue post (342,160) is water at y=62
  with air above, so the race preflight burned five growing-radius retries and
  died with "could not station Ansel" (cost the first v3 attempt). Force-loading
  the chunks does NOT help — it is not a generation problem. Probe a candidate
  with `execute if block <x> <y> <z> minecraft:water` (`data get block … id`
  only works on block entities and answers "not a block entity" for everything
  else), and pick posts with the operation that has to succeed:
  `spreadplayers` itself, then `data get entity <bot> Pos` to see where it
  actually landed. Benchmark posts are pinned in `frozen.world.posts` for
  exactly this reason (`docs/runbooks/race-world-reset.md`).
- RCON `data get` output is ELLIPSIZED server-side past ~150 chars (measured
  2026-07-09: a literal `...` mid-SNBT) — full-inventory reads are impossible;
  read per-slot (`Inventory[i].id` / `.count`, stop at "Found no elements").
  `list` is ellipsized the same way: at ~26 players online the tail names
  vanish, so any is-player-online check that parses `list` reads online
  players as missing (cost three ctx sweep blocks on 2026-07-26). Probe per
  name instead: `execute if entity <name>` — "Test passed" iff online.
  And the player Inventory NBT is a DENSE list that reindexes whenever the
  player moves items, while each RCON command lands on a separate tick: a
  single per-slot pass can tear (missed stack → its reappearance books a
  phantom haul in delta-based counters). Scan twice, accept only two identical
  passes (`humanInventory.ts:fetchHumanInventoryStable`); a discarded cycle
  loses nothing because deltas compare against the last ACCEPTED scan.