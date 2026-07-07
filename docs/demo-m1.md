# M1 Demo — 20 AI villagers wake up, filmable run-through

Twenty LLM-driven villagers with distinct personalities live a full in-game
day on containerized PaperMC: they talk, react to each other mid-tick, form
friendships and grudges you can watch move on a live graph, and — when enough
has happened to them — reflect, distilling raw memories into insights. Every
thought, word, and feeling is a queryable event. This is the Episode 1 shot
script and the regression baseline for M1's Definition of Done.

## Prerequisites (once)

- Docker Desktop running (WSL2 backend)
- Ollama running with `llama3.1:8b` and `nomic-embed-text` pulled
- For filming: set `OPENAI_API_KEY` in `.env` (the chain prefers it;
  ~$1.00–1.20/hr at gpt-4o-mini). Ollama works free of charge — the M1-8
  soak and the M1-10 verification day both ran 20 villagers on it.

## The run

```sh
cp .env.example .env                     # first time only
# .env: VILLAGER_COUNT=20, MC_HOST=minecraft   (the fleet preset)
docker compose -f infrastructure/docker/docker-compose.yml --env-file .env `
  --profile infra --profile app --profile minecraft up -d --build --wait
task seed                                # 20 villagers -> agent_db -> spawn commands
npm run dev --workspace @civ/dashboard   # dashboard on :3000
```

Within ~3 minutes the full fleet is in-world (bots stagger in ~1/8s; after a
Paper restart they reconnect on their own — `connection-throttle: -1` is
already set in the world volume).

1. **In Minecraft** (join or spectate `localhost:25565`): twenty villagers
   walking, gathering, and talking in twenty distinct voices — Wren
   broadcasting rumors, Quill correcting them from his ledger, Vesper saying
   as little as possible.
2. **Dashboard** (http://localhost:3000): villager cards + live feed; the
   `/relationships` page shows the force graph moving as opinions form, with
   the popular/hated leaderboard beside it.
3. **Grafana** (http://localhost:3001, admin/admin → "Civilization Overview"):
   ticks/min by outcome AND by trigger (the reactive-ratio panel — reactive
   stays under the cap arithmetic), LLM spend **by service** (deliberation vs
   reflections — both breakers are per service), reflections by outcome,
   retrieval p95, live bot count.
4. **Redpanda console** (http://localhost:8085): `agent.events` now carries
   `ReflectionCreated` alongside `DecisionMade` — memory-service became a
   producer in M1-9.

## The money shots (Episode 1 shot list)

**Shot 1 — the wake-up.** OBS on the Minecraft window, spectator at spawn.
Run `task seed` on camera; twenty bots pour in over ~2½ minutes. B-roll the
staggered joins; the cast list is `docker exec ai-civilization-engine-minecraft-1 rcon-cli list`.

**Shot 2 — a conversation with a memory.** Dashboard live feed filtered to
`VillagerTalked`. Wait for a reply chain (reactive ticks answer within
seconds, not the 60s schedule). Take the `correlationId` of any reply and
pull its whole causal thread from the ledger:

```sh
curl "http://localhost:8081/events?correlation-id=<id>"
# ChatObserved -> DecisionMade(trigger=reactive) -> ActionRequested ->
# VillagerTalked -> the next hearer's ChatObserved — a conversation,
# reconstructed from an append-only ledger (DoD #2).
```

**Shot 3 — the first grudge.** `/relationships` on screen while villagers
argue: a red edge appears, thickens, and its tooltip explains itself in the
villager's own words (`last_reason`). The leaderboard's "most hated" fills
in live (DoD #3, #4).

**Shot 4 — a villager reflects.** When a villager's day has piled up enough
importance (sum > 30), memory-service distills it:

```sh
docker logs ai-civilization-engine-memory-service-1 --tail 50 | grep reflection
curl "http://localhost:8081/events?event-type=ReflectionCreated"
# or force one on camera:
curl -X POST http://localhost:8002/villagers/<villagerId>/reflections
```

Read the `summary` aloud — it is the villager concluding something about
their life that no single memory says (provenance in `sourceMemoryIds`).

**Shot 5 — the trace.** One correlationId, grep'd across every service's
logs — the distributed-tracing story without Loki (DoD #5):

```sh
docker compose -f infrastructure/docker/docker-compose.yml logs | grep <id>
```

**Shot 6 — the wallet.** Grafana's "LLM spend by service" stat while the
day runs: deliberation (agent-service) vs reflections (memory-service),
each with its own daily breaker. The episode's cost, on screen, in dollars.

## Health during filming

```sh
docker exec ai-civilization-engine-minecraft-1 rcon-cli mspt   # read the avg; <50 is the ceiling
docker exec ai-civilization-engine-minecraft-1 rcon-cli tps    # 20.0 flat on the M1-8 soak
docker exec ai-civilization-engine-minecraft-1 rcon-cli list   # 20/20 online
```

## Teardown

```sh
task down        # containers stop, volumes survive (the day's memories are canon)
task nuke        # fresh world — re-apply connection-throttle: -1 afterwards
```
