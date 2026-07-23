## HANDOFF (current session)

**Last checkpoint:** FRESH-INSTALL AUDIT SHIPPED (session thirteenth —
`docs/fresh-install-audit.md` is the full record). Tier-1 sim: fresh
clone + `COMPOSE_PROJECT_NAME=fresh-sim` isolation (fresh volumes, live
stack stopped first), README followed verbatim. The old Quickstart died
at step 3 of 3 (smoke required the gitignored PoC node_modules) and
ended before the product existed. 10 findings → 4 PRs MERGED: #74
`.env.example` sync (COMMUNITY_GOAL + THREAT_DEFAULT_STANCE now in the
template at code defaults), #75 smoke resolves mineflayer from the
workspace pin (root `npm install` is now a smoke prerequisite;
actionable failure if skipped), #76 README Quickstart rewrite
(containerized-Paper default path paired with `MC_HOST=minecraft`, then
up:all → seed → proof-of-life via rcon `list` + `/events/stream`), #80
the audit record. Issues filed: #77 nine scripts hardcode
`ai-civilization-engine-*` container names (REDPANDA_CONTAINER on
provision-topics is the only escape hatch), #78 dashboard run story
(not in compose, host-run only), #79 bake spawn-protection=0 +
connection-throttle=-1 into the minecraft profile (any fresh volume
reverts to Paper defaults). Sim verified end-to-end on empty volumes:
seed → Elara deliberating on real ollama (llama3.1:8b, 1.1–1.3s,
970–1469 tok), full causation chains, threat reflexes live. New traps:
ledger read envelope is `{data, nextCursor}` (not `items`);
`MC_HOST=host.docker.internal` reaches containerized Paper only via the
25565 publish loopback — an accident, use `MC_HOST=minecraft`. STACK
STATE: live stack was downed for the sim and restored from main
2026-07-23 (10/10 healthy; sim volumes deleted, live volumes verified
intact; the merges touch no service images — docs/template/host-script
only, no rebuild needed). minecraft-service was RECREATED → in-memory
fleet GONE (respawn commands required); host MC server STOPPED; paper
profile not running; government-service (mothballed) and pov-rig left
Exited as found — #72 landed the pov sidecar on main, verify the rig
before POV footage. `.env` unchanged: COMMUNITY_GOAL set (race mode
mutes it) and THREAT_DEFAULT_STANCE=guard (revert to cautious for speed
records; guard tax ≈80s). Records: Easy 360.4s (`019f7337`), Normal
881s (`019f7352`), Normal+mobs 660.6s (`019f744d`, filmed). Drill
hygiene unchanged: clear packs before staged gives; mute doMobSpawning
between takes; command group is `minecraft-service.command-executor`.

**Next session:** Parker films per `docs/demo-rb.md`. Pre-attempt
sequence: start the host MC server (currently stopped; or paper profile
+ `MC_HOST=minecraft`), respawn exactly 6 racers (spawn-fleet defaults
to ALL 20 — pass the count), verify pov-rig tiles. Open follow-ups:
SV-14 row (leather craft enum, per-villager stance, persisted posts)
and audit issues #77/#78/#79. Roadmap beyond T1 unchanged per
`docs/architecture/10-red-vs-blue.md`.

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
- RCON `data get` output is ELLIPSIZED server-side past ~150 chars (measured
  2026-07-09: a literal `...` mid-SNBT) — full-inventory reads are impossible;
  read per-slot (`Inventory[i].id` / `.count`, stop at "Found no elements").
  And the player Inventory NBT is a DENSE list that reindexes whenever the
  player moves items, while each RCON command lands on a separate tick: a
  single per-slot pass can tear (missed stack → its reappearance books a
  phantom haul in delta-based counters). Scan twice, accept only two identical
  passes (`humanInventory.ts:fetchHumanInventoryStable`); a discarded cycle
  loses nothing because deltas compare against the last ACCEPTED scan.

## Claude Code best practices (session discipline)

**Memory & handoff:**
- Update this file between sessions with new gotchas, conventions, or architectural shifts.
- Use `/rewind` at major checkpoints to compress conversation history and free context.
- Paste the relevant section of this file into the next session's opening prompt if context is tight.
- See: https://code.claude.com/docs/en/memory (CLAUDE.md scope and auto memory).

**Session structure:**
- Start with a clear `/goal` if the session has a measurable end state (e.g., "RB-1 exit: scripted harness drill mines→smelts→crafts iron pickaxe end-to-end").
- Use `/rewind` → "Summarize up to here" at green boundaries (passing tests, merged PRs, phase exits).
- Link to ADRs, runbooks, and architecture docs in CLAUDE.md so Claude finds them without asking.
- See: https://code.claude.com/docs/en/goal and https://code.claude.com/docs/en/checkpointing.

**Debugging & troubleshooting:**
- Paste exact error messages and stack traces verbatim—Claude Code can often spot the issue directly.
- For Docker/compose issues, include `docker compose logs <service>` output (last 50 lines).
- For Kafka/ledger issues, include the correlationId and the relevant ledger rows.
- See: https://code.claude.com/docs/en/troubleshoot-install for common setup problems.

**Code review & CI:**
- Enforce contract-first (schema + fixture before code) via CI gates, not just review.
- Pin exact versions at boundaries you don't control (mineflayer, compose images).
- Use `task gen` to regenerate types and COMMIT the output—CI drift-gates it.
- See: https://code.claude.com/docs/en/overview for Claude Code's agentic workflow.