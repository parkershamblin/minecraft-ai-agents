# Sprint 1 Demo — the walking skeleton, filmable run-through

Three AI villagers wake up on a live Minecraft server, think with a local LLM,
walk, talk, and remember — and every thought is a queryable event. This is the
Episode 0 b-roll script and the regression baseline for what "working" looks like.

## Prerequisites (once)

- Docker Desktop running (WSL2 backend)
- The local Minecraft 1.21.6 server running:
  `cd "../Minecraft 1.21.6 Server" && java -Xmx3G -jar server.jar nogui`
- Ollama running with `llama3.1:8b` and `nomic-embed-text` pulled
  (or set `OPENAI_API_KEY` in `.env` — the chain prefers it)

## The run

```sh
cp .env.example .env                # first time only
export VILLAGER_COUNT=3             # PowerShell: $env:VILLAGER_COUNT='3'
export TICK_INTERVAL_SECONDS=45
task up:all                         # infra + event-service + minecraft-service + agent-service, healthcheck-gated
task seed                           # villagers.json -> agent_db -> VillagerCreated -> spawn commands
npm run dev --workspace @civ/dashboard   # dashboard on :3000
```

Within ~60 seconds:

1. **In Minecraft** (join the server or spectate): Elara, Bram, and Wren are
   standing in the world. On their staggered ticks they walk toward each
   other and chat in character.
2. **Dashboard** (http://localhost:3000): three villager cards; the live feed
   streams `DecisionMade` (their reasoning, verbatim), `ActionRequested`,
   `ActionCompleted`, `VillagerMoved`, `VillagerTalked`, `MemoryFormed`.
3. **Grafana** (http://localhost:3001, admin/admin → "Civilization Overview"):
   event throughput, decision latency p95, LLM tokens/min + spend, memory
   retrieval p95, Kafka lag, ticks/min, live bot count.
4. **Redpanda console** (http://localhost:8085): the topics themselves.

## The money shots

**A villager's train of thought, reconstructed from the ledger** — take any
correlationId from the dashboard feed:

```sh
curl "http://localhost:8081/events?correlation-id=<id>"
# DecisionMade -> ActionRequested -> ActionCompleted -> MemoryFormed,
# every event citing its cause
```

**The same id across every service's logs** (the distributed-tracing story):

```sh
docker compose -f infrastructure/docker/docker-compose.yml logs | grep <id>
```

**A villager's memories** (semantic, GPU-embedded):

```sh
docker exec ai-civilization-engine-postgres-1 \
  psql -U civ -d memory_db -c "SELECT importance_score, content FROM memories ORDER BY created_at DESC LIMIT 5"
# look for '(Earlier, my move completed.)' — the feedback loop closing
```

**Idempotency under fire** — replay any command envelope twice via
`node scripts/produce-cmd.mjs`; the executor skips the duplicate, the ledger
stores exactly one outcome.

## Teardown

```sh
task down        # containers stop, volumes survive
task nuke        # fresh world (deletes volumes)
```
