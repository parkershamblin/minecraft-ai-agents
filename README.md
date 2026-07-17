# AI Civilization Engine

[![events-contracts](https://github.com/parkershamblin/ai-civilization-engine/actions/workflows/events-contracts.yml/badge.svg)](https://github.com/parkershamblin/ai-civilization-engine/actions/workflows/events-contracts.yml)
[![event-service](https://github.com/parkershamblin/ai-civilization-engine/actions/workflows/event-service.yml/badge.svg)](https://github.com/parkershamblin/ai-civilization-engine/actions/workflows/event-service.yml)
[![minecraft-service](https://github.com/parkershamblin/ai-civilization-engine/actions/workflows/minecraft-service.yml/badge.svg)](https://github.com/parkershamblin/ai-civilization-engine/actions/workflows/minecraft-service.yml)
[![agent-service](https://github.com/parkershamblin/ai-civilization-engine/actions/workflows/agent-service.yml/badge.svg)](https://github.com/parkershamblin/ai-civilization-engine/actions/workflows/agent-service.yml)
[![government-service](https://github.com/parkershamblin/ai-civilization-engine/actions/workflows/government-service.yml/badge.svg)](https://github.com/parkershamblin/ai-civilization-engine/actions/workflows/government-service.yml)
[![dashboard](https://github.com/parkershamblin/ai-civilization-engine/actions/workflows/dashboard.yml/badge.svg)](https://github.com/parkershamblin/ai-civilization-engine/actions/workflows/dashboard.yml)

Autonomous LLM-driven villagers live inside Minecraft. **Current arc: Red vs
Blue** ([ADR-10](docs/architecture/10-red-vs-blue.md)) — two teams of three
race, fully unattended, to the first crafted iron pickaxe: local llama
deliberates every 20 seconds, the body executes survival reflexes and tool
chains, and every milestone is judged from an append-only event ledger (the
win is a ledger event with a causation chain, not a screenshot). The earlier
civilization arc — personalities, memories, relationships, elections — is
intact and mothballed behind a compose profile. Every action is an immutable
event; the event stream is the integration seam between services, the source
of truth for analytics, and the raw material for the video series.
Live scoreboard: `http://localhost:3000/race`.

**The architecture package lives in [docs/architecture/](docs/architecture/00-system-overview.md)** —
system overview, DDD domain model, database DDL, Kafka/event design, API design,
repo/DevOps layout, and the milestone roadmap.

## Quickstart

Prerequisites:

- **Docker Desktop** (WSL2 backend) — the whole backbone runs in Compose
- **A local Minecraft 1.21.6 server** on `:25565` with `online-mode=false`
  (this repo assumes the host-run server in `../Minecraft 1.21.6 Server`;
  a containerized PaperMC profile exists as an alternative)
- **Node 22+**, **go-task** (`winget install Task.Task`)
- Optional: **Ollama** with `llama3.1:8b` + `nomic-embed-text` pulled
  (the LLM chain degrades openai → ollama → fake; blank API key is fine)

```sh
cp .env.example .env        # fill OPENAI_API_KEY or leave blank for Ollama
task up                     # infra: Postgres+pgvector, Redis, Redpanda, Prometheus, Grafana
task smoke                  # canary: one bot connects to the MC server and chats
```

Consoles once `task up` is green: Redpanda console `:8085`, Grafana `:3001`
(admin/admin), Prometheus `:9090`.

## Layout

```
apps/dashboard/        Next.js dashboard + live SSE feed
services/              the microservices (see docs/architecture/00-system-overview.md):
                         agent-service        Python/FastAPI — villager tick loop (LangGraph)
                         memory-service       Python/FastAPI — pgvector memory stream
                         minecraft-service    Node/TS — the single world executor (mineflayer)
                         event-service        Java/Spring — append-only event ledger + SSE
                         government-service   Java/Spring — elections & governments
packages/events/       JSON Schema event contracts — single source of truth
infrastructure/        docker compose, prometheus/grafana config
experiments/           archived PoCs — the empirically-proven mineflayer version pin
docs/architecture/     the full design package (00–09)
scripts/               repo-level utilities (smoke canary, fleet spawn/despawn)
```

## Status

**Milestone 1 (walking skeleton) — complete.** Event contracts + codegen,
event-service ledger with read API and SSE, minecraft-service bot host and
command executor, pgvector memory, the LLM provider chain, the LangGraph tick
loop, and the Next.js dashboard — a full perceive→deliberate→act→reflect loop
with observability ([demo](docs/demo-sprint-1.md), [M1 demo](docs/demo-m1.md)).

**Milestone 2 (governance) — complete and merged.** government-service owns the
clock-driven election state machine and idempotent ballot box; villagers
nominate, campaign, and vote through the ledger. Mayor Bram is seated and the
fleet is ticking ([M2 plan](docs/architecture/08-m2-plan.md),
[M2 demo](docs/demo-m2.md)).

**Survival cluster — in flight (not yet deployed).** Peaceful→easy survival:
eat/craft/hunt/cook, fight-or-flee, death awareness, staged training-wheel
removal. SV-1 (contract commit) and SV-2 (sustained gather sessions) are
merged; SV-3/SV-4 (the craft verb + crafting brain) are next. The filming
gate holds: Episode 2 must be filmed before the first Survival deploy
([survival plan](docs/architecture/09-survival-plan.md)).

See [docs/HANDOFF.md](docs/HANDOFF.md) for live session-to-session state.
