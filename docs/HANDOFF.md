# Session Handoff — Sprint 5 COMPLETE: M1-10 done, M1 DoD 6/6 (evidence in ledger)

> Started at the Sprint 3 → Sprint 4 boundary (2026-07-07). A fresh session
> should be able to continue from this file + `docs/architecture/07-m1-plan.md`
> without asking questions. **All M1 tickets complete (M1-1…M1-10). M1 DoD:
> all 6 items verified with evidence — the organic grudge closed on
> 2026-07-07 afternoon (Yara→Cassia peaked −54 in the clean window; see
> "Afternoon session" section) and Episode 1 footage is recorded (editing
> is Parker's post-production work, not an engine DoD item).**

## Project status

- **Sprint 3 complete** + **Sprint 4 complete** (commits `M1-4: relationship
  read path…`, `M1-5: live relationship graph page`, `M1-6: interim
  leaderboard…`, `M1-7: 20 villager personas — the full cast`), all on `main`.
- **78 agent-service tests green locally** (was 59; M1-4 added 10, M1-6
  added 2, M1-7 added 7). Dashboard typecheck clean (it has no test suite —
  CI runs typecheck). Other suites unchanged and green.
- Test totals: **78 py-agent**, **46 py-memory** (19 → 42 in M1-9, +4
  reflect-guard tests in M1-10), **30 ts-minecraft** (+1 stale-command),
  8 java-event, **15 contract fixtures**. Coverage gate is **ON since M1-10**
  (agent brain/llm 96.4%, memory service/scoring 98.0%, event ingest/read
  87.8% — all ≥80 enforced). `task test` runs all five suites.
- Machine state: **superseded — see "Machine state at session end" below**
  (M1-10 session brought the full stack up with `up --build`; it is RUNNING).
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
| ✅ M1-7 | 20 personas | **DONE** — see "What M1-7 shipped" below |

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

### What M1-7 shipped (commit `M1-7: 20 villager personas — the full cast`)

- **`seed/villagers.json` 3 → 20** fully-voiced personas (traits ×3, values
  ×3, speechStyle, quirks ×2, backstory each). Elara/Bram/Wren byte-identical,
  UUIDs stable, and **still the first three entries** — `seed_villagers`
  slices `[:VILLAGER_COUNT]`, so file order is contract (the demo preset
  `VILLAGER_COUNT=2` must keep meaning Elara+Bram). New ids follow the
  existing hand-readable pattern (`…-0000000d0004` through `…-0000000d0020`).
- **Cast design (the taste pass)**: every speechStyle is a distinct register
  (tested); the ensemble is a drama engine — an information economy (Wren
  broadcasts, Cassia the innkeeper trades, Vesper the night-watch hoards,
  Quill the chronicler corrects from his ledger), Tansy the forager as
  Elara's pantry rival, Nils the miller's grandson (quasi-family to Elara),
  Sable off the same caravan as Wren, and the old-village flood (already in
  Elara's backstory) threaded through six new backstories as shared trauma.
- **`tests/test_seed.py`**: six shape checks (exactly 20; founding-three ids
  AND order; unique valid UUIDs; unique MC-legal usernames `[A-Za-z0-9_]{3,16}`;
  fully voiced; no duplicate speechStyle) + **seed idempotence at 20** against
  real Postgres: second run creates 0 rows / 0 new `VillagerCreated`, spawn
  commands sent both passes (40) — re-embodiment after restart is by design.
- **`tests/conftest.py`**: the session-scoped testcontainers `database`
  fixture moved out of `test_relationships_repo.py` so both integration
  suites share one Postgres container.
- Not touched (deliberate): `brain/prompts.py` renders traits/values/
  speechStyle/backstory but **not quirks** — quirks ship in the data; wiring
  them into the system prompt is a candidate one-liner for Sprint 5's
  20-villager run.

## M1-8 spike result (PaperMC container migration — GATE PASSED)

**The spike is green: mineflayer 4.37.1 talks to containerized Paper 1.21.6
cleanly. The fleet + 30-min soak ran next session and PASSED — see "M1-8
fleet soak result" just below.**

- **Compose `minecraft` service is now enabled-ready** (`docker-compose.yml`):
  the pre-existing Paper stub had a **floating `java21` tag** — pinned to
  **`itzg/minecraft-server:2026.7.0-java21`** (full patch tag, per the same
  discipline as `MC_VERSION`; this build ships `paper-1.21.6-48`). Added
  `ENABLE_RCON`/`RCON_PASSWORD` (MSPT/TPS read path) and an `mc-health`
  healthcheck (`start_period: 90s`) so `up --wait` blocks until Paper accepts
  logins. Still `profiles: [minecraft]`, off by default. `ONLINE_MODE=FALSE`
  matches the bots' `auth:'offline'` (BotSession.ts:89).
- **`scripts/paper-spike.js`** — the committed spike artifact. Mirrors
  `scripts/smoke.js` (borrows the archived PoC's mineflayer 4.37.1, the exact
  shipped pin; connects `auth:'offline'` + `viewDistance:'tiny'` like the real
  BotSession) and **adds a walk leg + a clean-disconnect assertion**. Exits 0
  only if connect→spawn→walk→chat→disconnect all pass.
- **Spike run (1 bot, localhost:25565):** ✅ PASS, exit 0. Spawn handshake
  **982 ms**; walked 1.56 blocks (movement packets round-trip); chat OK; clean
  `end` on quit (no error/kick). **No protocol/offline/packet weirdness — the
  mineflayer pin did NOT need to move** (so no atomic pin-bump PR).
- **MSPT baseline (RCON `mspt`/`tps`):** empty server ~2.0 ms (1m avg);
  **1 bot idling ~4.0/4.5 ms (5s/10s avg)**, TPS a flat **20.0**. Against the
  M1-8 ceiling of **MSPT < 50**, that's huge headroom for 20 bots. (The 80–118 ms
  `max` values are the first-boot world-gen spike — read the avg, and let the
  1m window roll before trusting it.)

### M1-8 fleet soak result (2026-07-07 04:23–05:00 — ALL AC PASSED)

**The 20-bot fleet ran ≥30 min on containerized Paper with real Ollama
deliberation. M1-8 is COMPLETE.**

- **Run shape:** `.env` set to `MC_HOST=minecraft`, `VILLAGER_COUNT=20`;
  Paper up via `--profile minecraft up -d minecraft --wait` (fast boot, world
  volume pre-seeded); app stack via `--profile infra --profile app up -d
  --build --wait` (the `--build` matters — it baked the M1-7 20-villager
  seed into the agent-service image); then `task seed` → 17 seeded + 3
  existing = 20 villagers, bots staggered in ~1/8s, **full fleet at
  04:23:44**.
- **AC 1 — 20 bots ≥30 min: ✅** 20/20 online at every 60s sample from
  04:25:04 to 05:00:59 (~37 min, 32 samples; monitor script sampled RCON
  `list` + `mspt` + `tps` + container restart counts).
- **AC 2 — MSPT < 50: ✅** 5s-avg ranged **8.5–17.1 ms** across the whole
  soak (≈3–6× headroom); TPS a flat **20.0** (1m/5m/15m) on every sample.
  Three isolated single-tick spikes appeared only in the 1m-**max** column
  (61/152/171 ms — autosave/GC); per the documented rule, read the avg.
- **AC 3 — zero tick-loop crashes: ✅** 0 restarts on all five containers
  (minecraft, agent-, minecraft-, memory-, event-service); all `running` at
  soak end. All disconnect/ECONNRESET noise in minecraft-service logs ended
  at 04:23:33 — the staggered-join connect storm, **before** the soak window
  opened; zero disconnects in-window.
- **LLM path:** blank `OPENAI_API_KEY` walked the chain to **ollama
  (llama3.1:8b, warmed)** — 20 concurrent villagers doing real
  perceive→retrieve→deliberate→act ticks (~8–40s each), varied actions
  (chat/move/follow/gather), personality-consistent chatter. ~10 ticks
  degraded to idle via the tolerant-reader path (chat `message` too long /
  empty — the known llama3.1 drift, counted, non-fatal).
- **Post-soak:** Paper container restarted (user request), came back
  healthy; bots auto-reconnected via the executor's reconnect loop. Stack
  left running.

### What M1-9 shipped (commit `M1-9: reflections…`)

- **ReflectionCreated.v1** schema + fixture in `packages/events` (payload
  `villagerId/reflectionId/summary/sourceMemoryIds[]`; producer memory-service
  on `agent.events`, aggregateId = villagerId, per the 03-events catalog);
  types regenerated and committed. No registry edits needed — contract tests,
  TS barrel, and the Python package are all directory-scanned.
- **memory-service LLM port** (`llm.py`): openai → ollama chain mirroring
  agent-service's boot probe/warmup, with one deliberate divergence — **no
  fake fallback**. No real LLM ⇒ reflections stay OFF (fake insights would
  pollute narrative truth in memory_db). Explicit `LLM_PROVIDER=fake` still
  opts in for tests/dev sandboxes.
- **BudgetedSummarizer**: `REFLECTION_DAILY_TOKEN_BUDGET` (default 200k),
  UTC-day rollover; a trip RAISES `BudgetExhausted` → `reflect()` skips
  (outcome=skipped_budget) instead of flipping to fake — same reasoning.
  Own `civ_llm_*` metric family (names intentionally identical to
  agent-service's: budgets are per service, and the M1-10 Grafana spend
  panel sums both services' cost counters). New `civ_reflections_total`
  counter labeled by outcome (created/empty/skipped_cap/skipped_budget/
  malformed).
- **Trigger** (`reflection.py::villagers_due_for_reflection`): per villager,
  SUM(importance) of **non-reflection** memories created since the last
  reflection > 30 (`REFLECTION_IMPORTANCE_THRESHOLD`). Excluding reflections
  from the pressure is loop-proof — they floor at importance 7, so counting
  them would let reflections beget reflections. `ReflectionJob` polls every
  `REFLECTION_INTERVAL_SECONDS` (300); job errors are logged, never fatal.
- **Generation** (`MemoryService.reflect()` — the frozen contract, now real):
  ≤20 unreflected memories, numbered oldest-first → strict-JSON
  `{insights:[{insight, sourceIndices}]}` (all-required +
  additionalProperties:false — OpenAI strict-safe per the M1-3 ruling) →
  tolerant parse (out-of-range citations dropped, citation-less insights
  dropped whole — the provenance CHECK would reject them anyway) → stored as
  `memory_type=reflection` with `source_memory_ids` → one ReflectionCreated
  per insight, one correlationId per pass, causationId null (job runs are
  root events). Global `HourlyCap` (`REFLECTIONS_PER_HOUR_CAP`, 12/h fixed
  UTC-hour window) bounds GPU load on the Ollama path.
- **Kafka**: memory-service's first producer — `EventPublisher` + envelope
  builder copied from agent-service (`source: "memory-service"`). **The
  promised packages/shared-py extraction is now due** (a second copy exists);
  flagged, deliberately not done inside M1-9. Publisher + job only start when
  a real summarizer is armed; `REFLECTION_ENABLED=false` is the kill switch.
  A publish failure after store is a logged ledger gap (no outbox at this
  scale — accepted).
- **REST**: `POST /villagers/{id}/reflections` now real (was a 501 stub):
  forces one pass (budget/cap still apply), 503 when no LLM is armed,
  `{"data": [...]}` of created reflection records.
- **Wiring**: compose memory-service gains `KAFKA_BROKERS: redpanda:29092`,
  `depends_on: redpanda`, `LLM_PROVIDER`/`REFLECTION_*` env; `.env.example`
  documents the reflection block; `task test` gained the memory-service
  suite (it was missing). Dockerfile unchanged — envelope/payload validation
  is tests-only, so the service-dir build context still works.
- **Tests 19 → 42** in memory-service: LLM chain/transports/breaker offline;
  prompt/parse/cap/envelope-vs-contract offline; integration vs real pgvector
  (pressure trigger select/reset/no-self-feed; provenance + contract-valid
  emission with shared correlationId; and the AC test — **a fresh reflection
  outranks week-stale raw memories at default retrieval weights**).
  Integration fixtures moved to `tests/conftest.py` (shared, same move
  agent-service made in M1-7).
- **Also fixed in passing**: `test_percept_fanout.py` had hardcoded
  `occurredAt: 2026-07-07T10:00:0xZ` envelopes — a time bomb that expired
  this morning when the wall clock passed them and the 10-minute percept
  freshness guard started (correctly) dropping them as stale backlog. Now
  stamped `datetime.now(UTC)` at test time. Gotcha added to CLAUDE.md.
- **NOT live-verified end-to-end** (stack down all session; nothing running
  to disturb). First `up --build` should watch memory-service's ready log
  for `reflections=on` and expect ReflectionCreated events in the ledger
  once 20-villager chatter builds pressure — a natural first check for the
  M1-10 filming-run session.

### What M1-10 shipped (commit `M1-10: coverage gate + verified in-game day…`)

- **Coverage gate ON** (was report-only since M0): agent-service
  `--cov=agent_service.brain --cov=agent_service.llm --cov-fail-under=80`
  (actual 96.4%); memory-service `service`+`scoring` scoped (actual 98.0% —
  four reflect()-guard-path tests added to get there honestly); event-service
  jacoco `jacocoTestCoverageVerification` over adapter.in/application/
  persistence classes (actual 87.8%), wired `finalizedBy(test)` so CI's fixed
  `gradlew test bootJar` enforces it. Python gates live in the caller
  workflows' `coverage-args`.
- **Grafana**: 3 new panels (reactive tick ratio; LLM spend by service; 
  reflections by outcome) + fixed a pre-existing double-count: every service
  has TWO Prometheus targets (run_mode host|compose) that both scrape the
  same process when ports are published — absolute-sum panels now filter
  `{run_mode="compose"}` (ratios/quantiles are unaffected by uniform 2×).
- **docs/demo-m1.md** — the M1 demo run-through + Episode 1 shot list
  (6 money shots: wake-up, conversation-with-causation, first grudge,
  a villager reflects, the trace, the wallet).
- **THE BIG ONE — the verification day found two production bugs** (this is
  why the ticket says "filming run"; both fixed, tested, deployed):
  1. **Silent command-consumer death + stale replay**: during M1-8's connect
     storm the kafkajs consumer in minecraft-service crashed WITHOUT
     restarting — container looked healthy, bots stayed online, but no
     command executed in-game from ~08:45Z on, and committed offsets froze.
     Today's boot resumed at the frozen offset and REPLAYED ~3.5h of dead
     intents into the live world (bots reciting hours-old chat). Dedupe
     can't guard this (never-executed commands have no keys). Fix: freshness
     guard in the executor — commands older than `COMMAND_MAX_AGE_SECONDS`
     (600) drop with `ActionFailed{STALE_COMMAND}` (additive enum value,
     types regenerated), preserving exactly-one-outcome; consumer now
     `exit(1)`s on unrecoverable crash + `restart: on-failure` in compose
     (loud, visible in restart counts). Deployed live: chewed 747 stale
     commands in seconds, lag 0 since. Regression test added (30 ts tests).
  2. **Budget breaker trip on free Ollama → fake pollution**: the 2M daily
     token budget (sized for OpenAI dollars) lasts ~30 min at 20 villagers
     on Ollama; when it tripped (mid-soak in M1-8 too — reconciliation
     below), deliberation silently became the FakeProvider, whose scripted
     chat + relationshipUpdates POLLUTED narrative state: a manufactured
     +100 "friendship" toward Bram (the script's hardcoded target), 1,745
     scripted memories (53% of memory_db!), and greeting-driven heuristic
     inflation. **Repaired from the ledger** (the restore-point pattern):
     replayed every RelationshipChanged per edge excluding (a) fake-script
     deltas, (b) pre-clean-window greeting-heuristic nudges, (c) source
     ≠ agent-service (dev-tool test events — the replay initially
     resurrected an M1-5 synthetic −60 grudge; excluded). 306 edges
     repaired, 28 fake-only edges deleted, 1,745 scripted memories purged.
     `.env` now carries `LLM_DAILY_TOKEN_BUDGET=100000000` for Ollama runs
     (.env.example documents the sizing trap).
- **The verified in-game day (12:12:52Z + surrounding clean windows), all
  20 villagers on real llama3.1 deliberation — M1 DoD status:**
  1. ✅ 20 bots, 28×60s monitor samples all 20/20, MSPT avg 5.2–11.0 ms,
     zero container restarts; p95 tick 32.8s < interval (120s configured for
     the verification day; also < the old 60s bar).
  2. ✅ ≥3-turn conversation chain reconstructed from the ledger: reply
     DecisionMade.causationId → heard ChatObserved (the identity thread),
     consecutive turns joined on the utterance. NOTE: under load the gap
     between VillagerTalked (decision time) and ChatObserved (spoken) runs
     MINUTES (single-partition executor queue) — reconstruction windows
     must allow ~10 min, not 30s. 142 real llama lines heard in-game in the
     final 20 minutes; 76 reactive chat replies.
  3. ✅ (closed 2026-07-07 afternoon): friendship — Wren→Quill affinity
     +100 / trust 100, fully organic, survives all repair passes. Grudge
     |affinity|>40 — **Yara→Cassia peaked −54 at 13:08Z**, formed 0→−54
     entirely inside the verified clean window (12:11Z onward), all 49
     RelationshipChanged deltas `source: agent-service` / heuristic on
     real llama sentiment, zero fake fingerprints; still standing at −42
     live at 19:15Z. Quill→Wren independently touched −40 / trust 0 the
     same afternoon — the mechanic reproduces. (The "NOT YET / min −9"
     reading was stale: the late filming window kept running after that
     measurement.)
  4. ✅ Live graph verified in-browser during the day (345 clean edges,
     reasoned tooltips) + populated leaderboard.
  5. ✅ Coverage gate enforced; correlation trace: one id greps across
     agent-service logs + full ledger chain (Decision→ActionRequested→
     VillagerTalked→9×RelationshipChanged→MemoryFormed).
  6. ⬜ Episode-1 segment: Parker's filming session; demo-m1.md +
     shot list + a verified dress rehearsal are staged for it.
- **M1-9 live-verified during the day**: memory-service booted
  `reflections=on` (chain walked to warmed Ollama), the pressure trigger
  fired naturally on the first job pass (Elara pressure 1021!), 12
  reflections at exactly the hourly cap (+8 cap-skips, 0 malformed),
  provenance-linked rows, ReflectionCreated in the ledger end-to-end.
- **Paper `MAX_PLAYERS: "30"`** in compose (was 20 = bots filled every
  slot): Parker can now join and spectate; fleet auto-reconnected 20/20.

### M1-8 record reconciliation (honesty note)

The soak's three ACs (bots online / MSPT / zero restarts) genuinely passed —
but "real Ollama deliberation for the full 37 min" needs a correction: the
budget breaker tripped mid-soak (~2M tokens ≈ 30 min in), silently flipping
deliberation to fake, AND the command consumer died during the connect storm
(~08:45Z), so in-game actuation stopped partway through. Ledger-side
activity (VillagerTalked, DecisionMade) continued and is what the soak
evidence cited. The in-game chatter observed early in the soak was real.
Both failure modes are now fixed and loudly observable (M1-10 above).

## THE FILMING SESSION HAPPENED (2026-07-07 ~12:45–13:35Z) — M1 DoD #6 footage recorded

Parker joined in-game and recorded Episode 1 material on the Ollama filming
preset (60s ticks, reflections on, budget 100M). What the cameras caught,
all emergent: the plaza assembly (all 20 gathered via `spreadplayers` —
stage direction only; every word was llama's), the diamond rumor mutating
scoop→plan as it spread, Tansy's whisper campaign against Bram, Quill's
public fact-check of Wren, a 12-villager reflection wave (exactly the
hourly cap) incl. Wren's oblivious "the village is abuzz" while 7 neighbors
privately concluded she's unreliable, the storm arriving AFTER the village
had invented a storm forecast, three factions (records-accuracy bloc /
pragmatist food bloc / diamond dreamers), Yara openly recruiting to leave,
and the capstone: **Petra convened the village's first self-organized
meeting** ("calling a meeting by sundown... Wren and Bram agreeing to share
their thoughts") — proto-governance, one milestone early. All reconstructable
from the ledger (causation chains + reflection provenance) for edit overlays.

**A FOURTH bug was found and fixed live on camera** (commit `6a8ad3f`): the
executor wedge — `execute()` awaited an action promise that never settles
when a connection dies mid-move (any Paper restart), freezing eachMessage
and, with one partition, EVERY bot, with no crash event. Now `Promise.race`s
the watchdog; regression test added; CLAUDE.md corollary 3.

## Afternoon session (2026-07-07 ~19:10–20:00Z) — grudge DoD closed, gather diagnosis

- **Stack brought back up** (Paper + infra + app, all healthy first try; seed
  re-embodied 20/20 bots; agent on warmed llama3.1; reflections on; command
  executor lag 0 — the wedge fix holding).
- **DoD #3 grudge: CLOSED with ledger evidence** (see DoD list above). Key
  dynamics finding: **grudges mean-revert under ambient positive chatter** —
  a 40-min watch saw Yara→Cassia decay −45→−30 and Quill→Wren −40→−30;
  the ±3 hearer-sentiment heuristic oscillates toward zero without fresh
  conflict. Sustained grudges need negative-memory reinforcement or real
  conflict events → M2 design note.
- **"Bots don't move around / never gather" (Parker's observation) —
  diagnosed, three compounding causes, all M1-scope design, no bug:**
  1. System prompt line "Prefer small, concrete, social actions over grand
     plans" (`brain/prompts.py`) steers llama away from material action.
  2. The world snapshot carries NO environment info (only position, health,
     food, time, nearby villagers, inventory) — the only coordinates the
     LLM ever sees are villagers', so all move targets stay inside the
     plaza cluster. Bots DO move (positions verified matching move targets;
     267 moves since restart), just locally.
  3. All 3 gather attempts failed `RESOURCE_NOT_FOUND` — no wood within
     reach of the y≈120–130 plaza, and llama self-supplies `maxDistance:
     10` (executor default is 32, cap 64).
  Cheap M2 levers, in impact order: nearby-resources line in the snapshot
  (contract change: schema + fixture + `task gen`), soften the
  social-actions prompt line, prompt-doc `maxDistance: 48`. Minor: Ulric
  repeatedly TIMEOUTs on moves (unreachable target?) — retryable,
  non-fatal, worth a look if it persists.

## Machine state at session end (2026-07-07 ~13:40Z) — SUPERSEDED: stack is RUNNING (afternoon session brought it back up; Parker in-game, 21/30 players)

- **Stack fully DOWN** — clean shutdown after filming: world saved
  (`save-all flush`, Petra's meeting is canon), all profiles down,
  0 containers. All volumes intact.
- `.env` (uncommitted, as always): `VILLAGER_COUNT=20`, `MC_HOST=minecraft`,
  `TICK_INTERVAL_SECONDS=60`, `REFLECTION_ENABLED=true`,
  `LLM_DAILY_TOKEN_BUDGET=100000000` — this IS the working Ollama filming
  preset now; it ran the recorded session successfully.
- Paper: `MAX_PLAYERS=30`; ParkerShamblin op'd (offline UUID).
- agent_db + memory_db are narrative-clean and now carry the filming
  session's story (the meeting, the reflections, the factions) as canon.
- Next session candidates: M2 planning; episode-edit support (ledger pulls
  for overlays); the still-open organic grudge (Tansy's campaign against
  Bram is the live thread — his incoming edges were sliding all session).
- **M2 planning input ready (2026-07-07 evening):**
  `docs/research/emergent-garden-lessons.md` — deep study of Emergent
  Garden's five videos + the three canon papers (Generative Agents, Project
  Sid/PIANO, Mindcraft/MineCollab) cross-checked against our architecture.
  §7 has M2 backlog candidates in five tracks (A physical competence,
  B plans/reflection, C social dynamics, D government via Sid's
  constitutional loop, E ledger analytics) plus rulings-to-carry (no live
  codegen, no vision, single-call tick stays). Recommended M2 core set:
  A1–A3 + C1–C2 + D1–D2. The gather fix is Track A (composite verbs +
  prescriptive failures + nearbyResources percept — evidence-backed).

Deferred to M2 by review: dashboard-service BFF, analytics-service, Loki, k6.
New M2 candidates from this session: packages/shared-py (two envelope-builder
copies exist), per-provider LLM budgets (a $0 Ollama run shouldn't trip a
cost breaker into narrative-polluting fake), multi-partition commands.minecraft
(single partition serializes all bots' actions — the decision→speech gap),
and quirks into the system prompt (the M1-7 one-liner, still pending).

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
