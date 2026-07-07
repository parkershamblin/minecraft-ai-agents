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
- Git Bash mangles `/paths` in `docker run -v` args — use PowerShell for
  Docker volume mounts.
- kafkajs has no built-in Snappy codec (rpk produces snappy by default) —
  minecraft-service registers `kafkajs-snappy`; keep that import first.
- OpenAI strict structured outputs reject optional schema properties — new
  decision-contract fields must be **required-nullable** (`type: ["x","null"]`).
- Postgres CHECK constraints pass on NULL (three-valued logic) — write
  NULL-proof constraints (see `memories_reflection_provenance`).
- Kafka consumer groups keep committed offsets across deploys: consumers that
  turn events into *time-sensitive* state need a freshness guard (see
  `agent_service/kafka/percepts.py`).
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
