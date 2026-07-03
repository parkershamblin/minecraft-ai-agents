# AI Civilization Engine

Twenty autonomous LLM-driven villagers live inside Minecraft. They have
personalities, goals, memories, and relationships; they go on to elect leaders,
pass laws, form factions, and start rebellions. Every action is an immutable
event — the event stream is the integration seam between services, the source
of truth for analytics, and the raw material for the YouTube series.

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
apps/dashboard/        Next.js dashboard (CIV-9)
services/              the seven services (see docs/architecture/00-system-overview.md)
packages/events/       JSON Schema event contracts — single source of truth (CIV-2)
infrastructure/        docker compose, prometheus/grafana config
experiments/           archived PoCs — the empirically-proven mineflayer version pin
docs/architecture/     the full design package
scripts/               repo-level utilities (smoke canary)
```

## Status — Sprint 1 (walking skeleton)

- [x] CIV-0 environment bring-up
- [x] CIV-1 monorepo scaffold + Compose infra
- [x] CIV-2 event contracts + TS/Py codegen
- [x] CIV-3 event store ingest + read API + SSE (event-service)
- [x] CIV-4 bot host + world bridge (minecraft-service)
- [x] CIV-5 command executor
- [x] CIV-6 memory module (pgvector, in agent-service)
- [x] CIV-7 LLM provider chain + decision contract
- [ ] CIV-8 LangGraph tick loop + seed
- [ ] CIV-9 minimal dashboard
- [ ] CIV-10 observability + scale to 3
