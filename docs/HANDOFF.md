# Session Handoff — Sprint 4 (M1) in progress

> Started at the Sprint 3 → Sprint 4 boundary (2026-07-07). A fresh session
> should be able to continue Sprint 4 from this file + `docs/architecture/07-m1-plan.md`
> without asking questions. **M1-4 + M1-5 + M1-6 done; next up is M1-7
> (20 personas — the last Sprint 4 ticket).**

## Project status

- **Sprint 3 complete** + **M1-4, M1-5, M1-6 complete** (commits `M1-4:
  relationship read path…`, `M1-5: live relationship graph page`, `M1-6:
  interim leaderboard…`), all on `main`.
- **71 agent-service tests green locally** (was 59; M1-4 added 10, M1-6
  added 2). Dashboard typecheck clean (it has no test suite — CI runs
  typecheck). Other suites unchanged and green.
- Test totals: **71 py-agent**, 19 py-memory, 29 ts-minecraft, 8 java-event,
  14 contract fixtures. Coverage gate is still report-only (turns ON in M1-10).
- **Machine state (2026-07-07 ~3:00am):** infra containers (postgres, redis,
  redpanda, prometheus, grafana) **running**; all app-service containers
  **stopped**; Minecraft server **stopped**. `agent_db` at migration **0002
  (head)**. ⚠️ The stopped agent-service container was last created with
  `LLM_PROVIDER=fake, TICK_INTERVAL_SECONDS=3600` (M1-5 verification) — bring
  it back via `docker compose … up -d` (recomputes env from `.env`), NOT
  `docker start`, or it ticks with the fake provider. Its image was rebuilt
  this session and includes migration 0002.
- Sprint 3 live proof achieved: Bram said "Elara, still on about the pantry?"
  in-game (multi-day characterization via memory), Elara's reply tick fired
  `trigger=reactive`, relationships formed from interactions
  (Elara→Bram 0→3→11 via the +8 direct-address boost), all as
  RelationshipChanged ledger events.
- **agent_db is at exact Sprint 3 truth:** one edge, Elara→Bram, affinity 11 /
  trust 56 / 2 interactions, `last_reason` = `heard Bram say: "Elara, still on
  about the pantry?"` (recovered verbatim from the ledger after dev smokes had
  overwritten it — the ledger is the restore point for relationship state).
  One fake-tick memory was deleted from memory_db; the ledger keeps a few
  `llmProvider=fake` / `source=dev-tool` events from M1-5 verification
  (append-only by design, same practice as `scripts/produce-cmd.mjs`).

## Sprint 4 plan ("The village is visible", M+M+S+M ≈ 20–26h)

Full acceptance criteria in `docs/architecture/07-m1-plan.md`. Summary
(**✅ = done**):

| ID | Title | Core AC |
|---|---|---|
| ✅ M1-4 | Relationship read path + feelings in prompts | **DONE** — see "What M1-4 shipped" below |
| ✅ M1-5 | Relationships graph page | **DONE** — see "What M1-5 shipped" below |
| ✅ M1-6 | Leaderboard (interim) | **DONE** — see "What M1-6 shipped" below |
| M1-7 | 20 personas | `services/agent-service/seed/villagers.json` → 20 distinct voices (traits/values/speechStyle/quirks/backstory); keep the 3 existing UUIDs stable; seed idempotence test at 20; read-aloud taste pass |

### What M1-4 shipped (commit `M1-4: relationship read path + feelings…`)

- **Migration 0002** (`migrations_agent/versions/0002_relationship_reason.py`):
  `last_reason text`, `last_reason_at timestamptz` on `relationships`. Applied
  to live `agent_db` (now at 0002 head).
- **`RelationshipRepo`** (`villagers/relationships.py`): `apply_update` gained a
  trailing `reason: str | None = None` param — persists it on insert **and**
  update; a reasonless nudge (heuristic may pass `None`) does **not** erase a
  prior explained cause. New read methods `edges_for(villager_id, target_ids)`
  and `list_edges(villager_id)` (affinity DESC) return a session-detached
  `RelationshipEdge` dataclass (`.of(row)` classmethod).
- **`GET /villagers/{id}/relationships`** (`main.py`, wired via
  `app.state.relationships`): outgoing edges, strongest affinity first, JSON
  keys `targetId/affinity/trust/interactionCount/lastReason/lastReasonAt/
  lastInteractionAt/updatedAt`. **Ids only — no target names** (M1-5 maps
  ids→names from `GET /villagers`). This is the endpoint M1-5 bootstraps from.
- **Read seam** (`brain/graph.py::_nearby_feelings`): in `deliberate`, reads
  edges for the snapshot's nearby villagers and passes a `{villagerId: edge}`
  dict into `user_prompt(...)`. Guarded on `deps.relationships is None`
  (feature-off → `None` → section omitted). Non-UUID/player ids skipped.
- **Prompt** (`brain/prompts.py`): new 4th arg `feelings` to `user_prompt`.
  Renders "How you feel about those nearby:" — `- Bram (affinity +11, trust 56
  — <last_reason>)`; no reason → drops the em-dash clause; nearby villager with
  no edge → `- Bram: no strong feelings yet`. `feelings=None` (default) omits
  the whole section, so all pre-M1-4 callers/tests are unaffected.
- **Tests:** `test_prompts.py` +5 snapshot cases; `test_relationships_repo.py`
  new testcontainers suite (real Postgres, migration 0002 included) covering
  reason persistence, reasonless non-erasure, `edges_for` filtering,
  `list_edges` ordering, clamping; `FakeRelationships` updated for the new
  signature + read methods.

### What M1-5 shipped (commit `M1-5: live relationship graph page`)

- **`/relationships` page** (`apps/dashboard/app/relationships/page.tsx`) +
  nav links both ways with the overview page (which lost its stale "Sprint 1 ·
  walking skeleton" tag to make room).
- **`components/RelationshipGraph.tsx`** — hand-rolled **d3-force@3.0.0
  (exact-pinned) + SVG**, deliberately no react-force-graph wrapper (React 19
  interop risk, opaque live-update path). Simulation + node/link arrays live
  in refs (d3 mutates positions; repaint via a tick-counter state bump; d3
  stops ticking at alphaMin so no idle re-render). Bootstrap = react-query:
  `GET /villagers` then per-villager `GET /villagers/{id}/relationships`
  (N+1 is fine at ≤20), every alive villager a node, isolated nodes included.
- **Live path**: the existing SSE relay (`/api/events/events/stream`),
  filtered client-side to `RelationshipChanged`; upsert by directed key
  `villagerId->targetId`, then `alpha(0.3).restart()`. Unknown node id →
  react-query invalidate (re-bootstrap; covers villagers seeded after page
  load). No BFF, no Zustand, per the review cut.
- **Visual AC**: edge color = affinity sign (emerald/red/zinc-0), width =
  `1 + |affinity|·5/100` px; A→B and B→A drawn as parallel strands offset to
  their own left; arrowhead at the rim of the target ("arrows point at whom
  it's felt"); `<title>` tooltip = names + affinity/trust + `last_reason`.
- **Verified live in a browser** (preview server + real stack): bootstrap
  rendered the real Elara→Bram edge; two hand-published RelationshipChanged
  events over Kafka (`rpk topic produce social.events`, envelope mirroring
  `packages/events/fixtures/RelationshipChanged.v1.json`, `source: dev-tool`)
  appeared live — first as a NEW red edge, then as an in-place width/tooltip
  update with no duplicate; reload drops SSE-only state (by design — the DB
  is truth). Arrowhead geometry checked computationally, not by eyeball.
- Dashboard still has no test runner (CI = typecheck) — unchanged by review
  ruling; the graph's logic seams (upsert, color/width fns) are small and
  pure if we add vitest later.

### What M1-6 shipped (commit `M1-6: interim leaderboard…`)

- **`RelationshipRepo.leaderboard(metric, limit=10)`** — one SQL aggregate:
  SUM of incoming affinity per target (served by `idx_relationships_target`),
  joined to `villagers.name`, ordered DESC (popular) / ASC (hated). **Sum,
  not average** (breadth should count). No incoming edges → doesn't chart.
  Returns frozen `LeaderboardRow(villager_id, name, score, edge_count)`.
- **`GET /leaderboard?metric=popular|hated`** on agent-service; `Literal`
  query param → invalid metric 422s. JSON: `villagerId/name/score/edgeCount`.
- **Dashboard `components/Leaderboard.tsx`** — "Standing" panel on
  `/relationships` (graph `lg:col-span-3`, panel 1 col): Most popular / Most
  hated, top 5 each, sign-colored scores, edge counts, 10s refetch interval.
- **Verified live**: endpoint on real data; synthetic edges (deleted after)
  rendered both boards + red/green/absent states; zero-tick verification via
  **`VILLAGER_COUNT=0`** (scheduler starts no loops — the clean way to run
  agent-service read-only for dashboard work; no DB/ledger pollution at all).

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
