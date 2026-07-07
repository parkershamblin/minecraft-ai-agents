# M1 Plan — "20 AI Villagers Wake Up" (P1 complete)

**Goal:** 20 villagers with personalities, goals, and relationships that talk,
move, gather, and remember — a full in-game day, filmable, with friendships and
grudges forming *from interactions* and visible on a live relationship graph.

**Duration:** 3 sprints × 2 weeks. Capacity key (same as Sprint 1's):
S = 2–4h, M = 6–8h, L = 10–14h, against ~22h per sprint. **Every sprint's
arithmetic is printed below** — this plan was adversarially reviewed against
the codebase (19 findings, two blockers) and cut to fit before work started.

## Where Sprint 2 left the system (measured, not assumed)

- Tick latency **1.7s steady** (llama3.1:8b, 4090). 20 villagers @ 60s tick =
  20 decisions/min = **57% GPU duty**. With the reactive-tick cap below
  (3 per villager per 5 min), worst case is 32/min ≈ **91% duty** — feasible
  with zero headroom, so **reflections never run on local Ollama by default**
  and the filming preset is OpenAI.
- Filming cost (OpenAI gpt-4o-mini), conversation-heavy worst case:
  **~$1.00–1.20/hr** (the old $0.55 figure was scheduled-ticks-only).
- Villagers cannot hear each other yet (ChatObserved stops at the ledger);
  the `relationships` table is migrated and unused; `reflect()` raises by
  contract; **budget breakers are per-service** — memory-service has none
  until M1-13 ships one.

## Mechanism rulings (corrected by review)

1. **Hearing = percepts.** Perception consumer adds ChatObserved, fanning out
   one percept per hearer (speaker excluded). The percept **carries the source
   envelope's eventId + correlationId** — that identity thread is what makes
   conversation chains ledger-traceable (DoD #2 depends on it).
2. **Reactive ticks, capped to close the arithmetic.** Cooldown 15s,
   **MAX_REACTIVE_PER_5MIN=3**, imminent-tick suppression (<10s). The
   scheduler gains a real wakeup path: per-villager `asyncio.Event` bus,
   `wait_for(event, timeout=remaining)` with `next_scheduled_at` bookkeeping.
   A reactive tick threads the heard event's id as its DecisionMade causation.
   Depth-decay is **deliberately deferred** — cooldown + cap bound the loop;
   the risk register says so honestly.
3. **Relationships fold into deliberation.** DECISION_SCHEMA gains
   `relationshipUpdates` as **required, type ["array","null"]** — OpenAI
   strict mode rejects optional properties, so nullable-required it is (a
   review blocker). Items: villagerId, affinityDelta/trustDelta (−20..20),
   reason — all required, additionalProperties:false. Heuristic fallback: the
   **hearer's own decision.sentiment** nudges the edge (±3; ±8 when directly
   addressed) — no new plumbing, and it's the hearer's reaction that should
   move the hearer's edge. `RelationshipChanged.v1.schema.json` **does not
   exist yet** and is explicit ticket scope, as is migration 0002
   (`last_reason`, `last_reason_at` on relationships).
4. **Feelings enter the prompt** via a new `TickDeps.relationships` seam
   reading edges for nearby villagers ("Bram (affinity +42, trust 61 — he
   shared bread when you were hungry)" — reason from `last_reason`).
5. **Reflections live in memory-service** — with its **own budget breaker**
   (`REFLECTION_DAILY_TOKEN_BUDGET`), its own `civ_llm_*` metrics, a
   reflections-per-hour cap, its first Kafka producer (envelope builder copied
   from agent-service; shared-py extraction noted for later), and the
   `ReflectionCreated.v1` schema file it must create. Default provider for
   summarization: OpenAI-mini when a key exists, else strictly capped Ollama.
6. **Deferred to M2 (review cuts, ~25–35h saved):** dashboard-service BFF +
   WS/Zustand swap (the existing SSE already relays every topic including
   RelationshipChanged — one viewer needs no fan-out layer), analytics-service
   (the M1 leaderboard is one SQL aggregate over `relationships`, served from
   agent-service), Loki/Promtail, k6 baseline.

## Sprint 3 — "They hear each other" (M+M+M = 18–24h)

| ID | Title | AC highlights | Est |
|---|---|---|---|
| M1-1 | ChatObserved fanout + percept safety (+ prompts) | One percept per hearer w/ sourceEventId+correlationId; **prompts + reflect type-dispatch on percept type, unknown types skipped — mixed-queue regression test** (today's code KeyErrors on actionless percepts); "Recently overheard" prompt section (≤5 lines) ships in the same PR | M |
| M1-2 | Reactive ticks: wakeup bus + caps | Per-villager asyncio.Event injected into PerceptConsumer; wait_for + next_scheduled_at; cooldown/cap/imminence all config w/ fake-clock tests; reactive tick passes heard eventId → DecisionMade causation; `civ_ticks_total` gains `trigger` label (**Grafana panel updated — label change breaks existing queries**) | M |
| M1-3 | Relationship decision contract + emission | `relationshipUpdates` required-nullable per ruling 3; **RelationshipChanged.v1 schema + fixture + codegen + contract tests**; upsert w/ clamping via new repo methods; heuristic fallback (hearer sentiment, direct-address boost); **live smoke: one real OpenAI strict-mode decision AND one llama3.1 decision emit valid relationshipUpdates** | M |

**Filmable beat:** two villagers hold a ≥3-turn conversation, causation-chained
in the ledger; the first grudge lands as a RelationshipChanged with a readable
reason.

## Sprint 4 — "The village is visible" (M+M+S+M = 20–26h)

| ID | Title | AC highlights | Est |
|---|---|---|---|
| M1-4 | Relationship read path + feelings in prompts | Migration 0002 (last_reason/_at); repo `edges_for`/`list_edges`; `GET /villagers/{id}/relationships` on agent-service; `TickDeps.relationships` seam; feelings rendered for nearby villagers (snapshot tests; no-edge renders neutral) | M |
| M1-5 | Relationships graph page | Force graph bootstrapped from the new GET endpoint, live-updated from **the existing SSE stream** filtered to RelationshipChanged (no BFF, no Zustand — review cut); edge color by affinity sign, width by |affinity| | M |
| M1-6 | Leaderboard (agent-service, interim) | `GET /leaderboard?metric=popular\|hated` = SQL aggregate over relationships (idx_relationships_target exists); dashboard panel; *analytics-service takes this over in M2* | S |
| M1-7 | 20 personas | villagers.json → 20 distinct voices; seed idempotence test at 20; read-aloud taste pass | M |

**Filmable beat:** the graph moves while villagers socialize; "most popular
villager" renders; all 20 personas exist.

## Sprint 5 — "20 wake up" (M+L+M = 22–30h; reflections are the slip valve)

| ID | Title | AC highlights | Est |
|---|---|---|---|
| M1-8 | PaperMC container migration | Spike (1-bot smoke vs Paper 1.21.6) gates the fleet; 20 bots ≥30min, MSPT<50; vanilla host remains the documented fallback | M |
| M1-9 | Reflections | memory-service: provider chain + **own budget breaker + civ_llm_* metrics + reflections/hour cap**; importance-sum>30 trigger job; ReflectionCreated.v1 schema + first Kafka producer + compose env (KAFKA_BROKERS, budgets); retrieval test: reflection outranks stale raw memories. **Not on camera — the designated slip-to-M2 candidate if the sprint runs hot** | L |
| M1-10 | Coverage gate + filming run | Gate ON (agent brain/llm, memory service/scoring, event ingest/read); Grafana reactive-ratio + per-service $ panels (**summing both services' cost counters**); `docs/demo-m1.md`; the recorded in-game day + Episode 1 shot list | M |

**Filmable beat:** the episode itself.

## M1 Definition of Done

1. 20 villagers, one full in-game day (20 min), zero tick-loop crashes, p95
   tick < interval.
2. A ≥3-turn conversation chain **reconstructable via causationId** in the
   ledger (the identity thread from M1-1/M1-2).
3. ≥1 friendship and ≥1 grudge (|affinity| > 40) from interactions — reachable
   via LLM deltas (±20/tick) or the boosted direct-address heuristic.
4. Live relationship graph + populated popular/hated leaderboard.
5. Coverage gate enforced; correlation trace demo via compose-logs grep
   (Loki is M2).
6. Episode-1 segment recorded.

## Top risks (register matches tickets — no phantom mitigations)

| Risk | Mitigation (all ticket-owned) |
|---|---|
| Reply ping-pong loops | Cooldown 15s + cap 3/5min + imminence suppression (M1-2). Depth-decay deferred, consciously |
| GPU saturation at 20 | Cap arithmetic closes at 91% duty; reflections off-Ollama by default (M1-9); filming preset = OpenAI ~$1.00–1.20/hr (M1-10 panel makes spend visible per service) |
| llama3.1 fails to emit relationshipUpdates | Early Sprint-3 smoke (M1-3 AC); heuristic fallback keeps DoD #3 reachable regardless |
| Paper 1.21.6 × mineflayer quirks | Spike gates the fleet (M1-8); MC_HOST fallback documented |
| Prompt bloat | Overheard ≤5 lines, memories_k=6, feelings only for nearby; measured in M1-10 |
