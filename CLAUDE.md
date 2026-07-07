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
ledger with cursor-paged reads and an SSE live feed. Relationships are directed
edges (affinity −100..100, trust 0..100); every change is a
`RelationshipChanged` ledger event. Kafka = Redpanda locally. Contracts live in
`packages/events` (JSON Schema → generated TS/Python types; additive-only
within a version). `apps/dashboard` is Next.js reading via rewrites + SSE.

Ports: 3000 dashboard · 8001 agent · 8002 memory · 8003 minecraft ·
8080 BFF (M2) · 8081 event · 8082 government (P2) · 8083 analytics (M2) ·
3001 Grafana · 9090 Prometheus · 8085 Redpanda console · 25565 Minecraft.

## Start / stop the stack

```powershell
task up        # infra only (Postgres+pgvector, Redis, Redpanda, Prometheus, Grafana)
task up:all    # + the services (docker compose --profile infra --profile app)
task seed      # provision villagers.json (first VILLAGER_COUNT) + spawn bots
task test      # all test suites   ·   task gen  # regen contract types (committed!)
task down      # stop containers (volumes survive)  ·  task nuke  # fresh world
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
- Bare `python` on this box is a stale 3.8 — always `uv run` / `uvx` / `py`.
- New `gradlew` files need `git update-index --chmod=+x` (Windows can't store
  the exec bit; Linux CI fails without it).
- Agent/hardened shells set `NoDefaultCurrentDirectoryInExePath=1`, so cmd.exe
  won't resolve bare batch names from the CWD: `cmd /c gradlew.bat` fails with
  "not recognized" there while working fine in a normal terminal. Use the
  explicit form `cmd /c .\gradlew.bat` (the Taskfile does since M1-9).
- Git Bash mangles `/paths` in `docker run -v` args — use PowerShell for
  Docker volume mounts.
- kafkajs has no built-in Snappy codec (rpk produces snappy by default) —
  minecraft-service registers `kafkajs-snappy`; keep that import first.
- OpenAI strict structured outputs reject optional schema properties — new
  decision-contract fields must be **required-nullable** (`type: ["x","null"]`).
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
  "Can't locate revision" — restart that service with `up --build`.
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
- Paper's `bukkit.yml` `connection-throttle: 4000` (per-IP) chokes the bot
  fleet after any server restart: all 20 bots share the minecraft-service
  container IP and reconnect in a synchronized 60s-backoff herd, so the
  throttle admits **one bot per minute** (~20 min to full recovery). Set
  `connection-throttle: -1` in `/data/bukkit.yml` — done Jul 2026; survives
  restarts (volume) but NOT `task nuke`, so re-apply after a nuke.
- Paper persists difficulty per-world in `level.dat`, which overrides
  `server.properties` on boot for existing worlds. An RCON `difficulty` change
  is in-memory until a world save — run `save-all` after it, or the container's
  10s stop window can discard it. `DIFFICULTY` env in compose only seeds new
  worlds. Both servers run offline mode: op entries need the offline UUID
  (derived from the name), not the Mojang one.
