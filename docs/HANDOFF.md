# Session Handoff — resume at Sprint 4 (M1)

> Written at the Sprint 3 → Sprint 4 boundary (2026-07-07). A fresh session
> should be able to start Sprint 4 from this file + `docs/architecture/07-m1-plan.md`
> without asking questions.

## Project status

- **Sprint 3 complete** (commit `M1 Sprint 3: villagers learn to hear…`, pushed).
  **59 agent-service tests green locally, all six CI pipelines green**, clean
  shutdown afterward.
- Test totals: 59 py-agent, 19 py-memory, 29 ts-minecraft, 8 java-event,
  14 contract fixtures. Coverage gate is still report-only (turns ON in M1-10).
- Machine state at handoff: infra + memory-service + minecraft-service +
  event-service containers **running**; agent-service container **stopped**
  (no idle GPU burn); Minecraft server **stopped**; all villagers despawned.
- Sprint 3 live proof achieved: Bram said "Elara, still on about the pantry?"
  in-game (multi-day characterization via memory), Elara's reply tick fired
  `trigger=reactive`, relationships formed from interactions
  (Elara→Bram 0→3→11 via the +8 direct-address boost), all as
  RelationshipChanged ledger events.

## Sprint 4 plan (next work — "The village is visible", M+M+S+M ≈ 20–26h)

Full acceptance criteria in `docs/architecture/07-m1-plan.md`. Summary:

| ID | Title | Core AC |
|---|---|---|
| M1-4 | Relationship read path + feelings in prompts | migrations_agent **0002**: `last_reason text, last_reason_at timestamptz` on relationships (written on upsert — RelationshipRepo.apply_update must start persisting the reason it already receives); repo gains `edges_for(villager_id, target_ids)` / `list_edges(villager_id)`; **`GET /villagers/{id}/relationships`** on agent-service (port 8001); new `TickDeps.relationships`-read seam so prompts render nearby villagers' edges: "Bram (affinity +11, trust 56 — heard Bram say: …)"; no-edge renders neutral; snapshot tests |
| M1-5 | Relationships graph page | Force graph in apps/dashboard, bootstrapped from the new GET endpoint, live-updated from **the existing event-service SSE stream** (`/api/events/events/stream` via Next rewrites) filtered to RelationshipChanged — NO BFF, NO Zustand (deferred to M2 by review); edge color = affinity sign, width = \|affinity\| |
| M1-6 | Leaderboard (interim) | `GET /leaderboard?metric=popular\|hated` on **agent-service** = SQL aggregate over relationships (`idx_relationships_target` exists); dashboard panel; analytics-service takes this over in M2 |
| M1-7 | 20 personas | `services/agent-service/seed/villagers.json` → 20 distinct voices (traits/values/speechStyle/quirks/backstory); keep the 3 existing UUIDs stable; seed idempotence test at 20; read-aloud taste pass |

Sprint 5 after that: PaperMC container migration (spike first), reflections in
memory-service (own budget breaker — designated slip candidate), coverage gate
ON, the 20-villager filming run. Deferred to M2 by review: dashboard-service
BFF, analytics-service, Loki, k6.

## Key decisions & gotchas from Sprint 3 (all shipped, all tested)

- **Percept freshness guard**: percepts older than **10 minutes** (by envelope
  `occurredAt`) are dropped in `kafka/percepts.py` — committed consumer-group
  offsets survive redeploys and would otherwise replay days-old chat as fresh
  percepts (observed live). Regression test: `test_stale_events_never_become_percepts`.
- **Tolerant-reader normalization** (`llm/contract.py::_normalize_params`):
  llama3.1 reliably drifts — `params.villagerId` instead of `targetVillagerId`
  (chat/follow alias table) and decision-level keys (`importance`, `sentiment`…)
  duplicated inside params (stripped). Counted by **`civ_llm_normalized_total`**;
  genuinely unknown params still hard-reject. Cut malformed-decision rate from
  ~50% to ~25%; every remaining failure degrades to idle + `error=true`.
- **`ChatParams` gained optional `targetVillagerId`** (additive v1) — models
  naturally emit "who I'm addressing"; the executor ignores it.
- **Affinity mechanics**: LLM path = `relationshipUpdates` (REQUIRED-NULLABLE
  in DECISION_SCHEMA — OpenAI strict mode rejects optional properties; max 3
  items, deltas ±20). Heuristic fallback (only when LLM sends null) = the
  HEARER's own `decision.sentiment` moves the edge: **±3 ambient, ±8 when the
  hearer is named in the message**; trust moves at half the affinity delta.
  Every change → `RelationshipChanged` ledger event (both dims, prev+new,
  reason, `source: deliberation|heuristic`, causation = the DecisionMade).
- **Conversation identity thread**: chat percepts carry the source envelope's
  `sourceEventId` + `correlationId`; a reactive tick passes the heard eventId
  into `run_tick(cause=…)` → DecisionMade causation. Chain:
  ChatObserved → DecisionMade → ActionRequested(chat)/VillagerTalked → next ChatObserved.
- **Reactive tick guards** (scheduler): cooldown 15s, cap 3 per 5 min,
  imminence suppression <10s; a reactive tick counts as the tick (next
  scheduled = +interval). `civ_ticks_total` now has a `trigger` label.
  Depth-decay deliberately deferred (risk register says so).

## How to resume work (commands)

```powershell
# stack (from repo root; env vars are the demo preset)
$env:VILLAGER_COUNT='2'; $env:TICK_INTERVAL_SECONDS='60'
docker compose -f infrastructure/docker/docker-compose.yml --env-file .env `
  --profile infra --profile app up -d --wait
# Minecraft server (its own window; type 'stop' to save+exit)
cd "..\Minecraft 1.21.6 Server"; java -Xmx3G -jar server.jar nogui
# seed + watch
curl -X POST http://localhost:8001/internal/seed
docker logs ai-civilization-engine-agent-service-1 -f | findstr "tick complete"
# hand-publish any command (dev tool)
node scripts/produce-cmd.mjs <villagerId> <action> '<paramsJson>' [timeoutMs]
```

Tests: `task test` (all), or per service:
`uv run pytest` (in services/agent-service and services/memory-service),
`npx vitest run` + `npx tsc --noEmit` (services/minecraft-service),
`./gradlew test` (services/event-service),
`npm test --workspace @civ/events` + `npm run gen` (contracts + drift).

Villager UUIDs (stable, used everywhere incl. fixtures):
Elara `019f8e2a-0000-7000-8000-0000000e1a2a`,
Bram `019f8e2a-0000-7000-8000-0000000b2a44`,
Wren `019f8e2a-0000-7000-8000-0000000c3e55`.

Watch out: villager bot sessions live in the **minecraft-service container**
and auto-reconnect across MC-server restarts — a previous run's villagers can
walk back in (Wren did). Despawn via `produce-cmd` or restart that container
for a clean cast list.
