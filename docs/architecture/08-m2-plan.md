# M2 Plan — "The Village Elects a Mayor" (P2: Government)

**Goal:** 20 villagers hold the village's first election — nominations,
campaign chatter, and votes all arising from real deliberation over memories
and relationships — while the bodies finally work (gather succeeds, bots
leave the plaza) and grudges persist long enough to matter politically.
The title episode: *"I Made 20 AI Villagers Form Their Own Government."*

**Duration:** 3 sprints × 2 weeks (Sprints 6–8). Capacity key unchanged from
M1: S = 2–4h, M = 6–8h, L = 10–14h, against ~22h per sprint. Arithmetic is
printed per sprint; each sprint names its slip valve.

**Planning inputs:** M1 wrap-up findings (docs/HANDOFF.md), the Emergent
Garden / Generative Agents / Project Sid / MineCollab cross-check
(`docs/research/emergent-garden-lessons.md`) — M2 core set **A1–A3 + C1–C2 +
D1–D2** as recommended there, mapped onto the roadmap's P2 scope.

## Where M1 left the system (measured, not assumed)

- 20 villagers ran a verified in-game day on llama3.1: p95 tick 32.8s,
  MSPT 5–11 ms, zero crashes. The Ollama filming preset
  (`LLM_DAILY_TOKEN_BUDGET=100000000`, 60s ticks) is proven; OpenAI
  gpt-4o-mini (~$1.00–1.20/hr) is the quality fallback.
- **Socially rich, physically inert:** gather failed 100%
  (`RESOURCE_NOT_FOUND` — llama self-supplied `maxDistance: 10`, no wood near
  the plaza, and the snapshot carries zero environment info, so the only
  coordinates the LLM ever sees are villagers'). Bots move constantly (267
  verified) but only inside the plaza cluster. Agents received the failure
  percepts and rationally stopped trying — learned helplessness by design gap.
- **Grudges mean-revert:** Yara→Cassia decayed −45→−30 in 40 min of ambient
  positive chatter; the ±3 hearer-sentiment heuristic oscillates toward zero
  without fresh conflict. Generative Agents documents the same
  instruction-tuned agreeableness (their fix: "future models"; ours: M2-5).
- **`commands.minecraft` is single-partition in practice** (auto-created by
  kafkajs with the broker default of 1; the design table says 6). Under load
  the decision→speech gap runs *minutes* — fatal for filming a debate.
- government-service: **zero code by design.** Schema designed
  (02-database), events cataloged (03), REST contract frozen (04), port 8082,
  `government_db` + role already created by the compose init script.
- Two Python envelope-builder copies exist (agent, memory); shared-py stays
  parked — M2 adds no third Python producer (government-service is Java).

## Mechanism rulings (decided now so tickets don't re-litigate)

1. **Rulings carried from the research study, verbatim:** no live codegen
   (`!newAction`-class), no vision, single-call tick stays (speech + action
   from one LLM call is PIANO's coherence solution at our output arity),
   building and police stay deferred (M3+), and **"organic, ledger-provable"
   remains the bar** for every emergent claim we film.
2. **Government is physics, not script** (EG's emergence creed, held in
   review): government-service provides *affordances* — an election clock, a
   ballot box, a tally — as a strict state machine
   `scheduled → nominating → voting → decided` (+`annulled`). Candidacy,
   speeches, and votes arise from ordinary deliberation. Campaign speeches
   are plain `chat` colored by civic context; there is no speech-writer
   module. The *institution* is seeded (operator opens the election — every
   successful system in the literature seeds institutions); the *politics*
   must be organic.
3. **Governance is a second command plane, symmetric with the world.** New
   topic `commands.government`; agent-service publishes
   `GovernanceRequested` (actions `declare_candidacy` | `vote`);
   government-service is the **single governance executor** — it validates
   against the state machine and natural keys, then emits the fact
   (`CandidateNominated`, `VoteCast`) or a `GovernanceRejected` with a
   machine-readable errorCode. Every request terminates in exactly one
   outcome (the World invariant, ported). Rejections flow back as percepts —
   the same action-awareness loop that teaches gather also teaches civics.
4. **The decision contract grows one required-nullable field**
   (`governanceAction`), exactly the M1-3 `relationshipUpdates` precedent
   (OpenAI strict mode rejects optional properties). Its params validate
   against the `GovernanceRequested` `$defs` in packages/events before a
   command is ever published — same seam discipline as ActionRequested.
   The affordance is prompt-gated: the field is described to the model only
   while a nomination/voting window is open.
5. **Vote idempotency is schema-enforced**, not dedupe-key-enforced:
   `UNIQUE(election_id, voter_villager_id)` (and one candidacy per villager
   per election). A redelivered or re-decided vote is a silent no-op
   returning the existing fact — the at-least-once story the architecture
   docs promised (04-api-design).
6. **No Java codegen yet, still.** government-service deserializes five
   flat fields; it hand-maps records EnvelopeMapper-style (the event-service
   precedent: schema-agnostic by design). jsonschema2pojo earns its place
   when a *second* typed Java consumer exists. Recorded as debt, not scope.
7. **Every new consumer gets the freshness guard on day one.** The
   perception consumer's government.events leg and government-service's
   commands.government consumer both drop stale messages (CLAUDE.md
   corollaries 1–2 are now a checklist item, not a lesson to relearn).
8. **Deferred again, with reasons** (enforced in PR review): dashboard-service
   BFF (one viewer; SSE relay suffices), analytics-service (tally/approval are
   one SQL aggregate served by the owning service — the M1-6 pattern),
   OpenSearch (Postgres FTS idle at current volume), Loki/k6 (grep works;
   no perf unknown being probed), conversation protocol C3 (no observed
   interrupt storms at 60s cadence — it waits for evidence), laws (M3),
   factions (M4), per-provider LLM budgets (.env sizing workaround holds).

## Sprint 6 — "Bodies that work" (M+S+S+S +M valve = 14–20h, 20–28h with valve)

| ID | Title | AC highlights | Est |
|---|---|---|---|
| M2-1 | Composite gather + prescriptive failures (A1+A2) | Executor/BotSession: equip best tool before dig; failure text becomes prescriptive ("searched r=10 around (x,y,z) — try maxDistance 48, up to 64" — diagnosis quality *is* competence); default `maxDistance` 32→48 (schema default + executor fallback; clamp 4..64 unchanged); executor + resources tests updated | M |
| M2-2 | `nearbyResources` in WorldSnapshot (A3) | Additive optional field `[{family, nearestDistance, count}]`; count-capped `findBlocks` scan every ~5s (NOT every 1s snapshot — MSPT impact measured in AC); schema + fixture + `task gen` committed; snapshot test validates | S |
| M2-3 | Prompt rebalance + expected-vs-observed (A3+C2) | Soften "prefer small, concrete, social actions"; render "Resources in sight" from M2-2; new "Your last decision: X → outcome Y" line (in-memory last-tick state — Sid's Action Awareness, their #1 progression lever); **quirks finally into the system prompt** (the M1-7 one-liner); prompt snapshot tests | S |
| M2-4 | `commands.minecraft` + `commands.government` → 6 partitions | Explicit topic provisioning (rpk via Taskfile target) replaces auto-creation-at-default-1; documented drain→recreate→offset-reset runbook; per-villager ordering preserved (key unchanged); `partitionsConsumedConcurrently` 3→6 | S |
| M2-5 | Grudge persistence kit (C4) — **slip valve → Sprint 8** | Feelings prompt section gains a behavioral directive (grudges constrain tone/choices — refuse/avoid/argue are legitimate); heuristic asymmetry: *ambient* positive deltas halved onto edges with affinity ≤ −20 (deliberation-sourced deltas untouched — a real apology still works); regression tests; grudge half-life measured from the ledger before/after and recorded in HANDOFF | M |

**Filmable beat:** a villager walks out of the plaza, fells a tree, and walks
back with the logs — the village's first working economy b-roll. A grudge is
still warm two hours after it formed.

## Sprint 7 — "The campaign machine" (L+M = 16–22h)

| ID | Title | AC highlights | Est |
|---|---|---|---|
| M2-6 | government-service walking skeleton + election state machine | Spring Boot, hexagonal (event-service layout); Flyway V1: `elections`, `candidates`, `votes`, `governments` (laws/factions tables NOT created — designed ≠ built); state machine with configurable window durations (filmable timescales: nominating ~10 min, voting ~15 min) driven by a scheduled clock; `POST /elections` (operator — the story lever) + `GET /elections/{id}` (candidates, live tally, `include=votes`); emits `ElectionStarted`/`ElectionDecided`; `ElectionDecided` seats a `governments` row (the mayor); compose entry (first real feature = first compose appearance) + healthcheck + Prometheus scrape job + CI caller workflow (java, image, **its own file in `paths:`** — the M1 Actions gotcha); Testcontainers integration test | L |
| M2-7 | Governance command plane + contracts (D1 substrate) | Schemas + fixtures + committed codegen: `commands/GovernanceRequested.v1` (action enum, per-action `$defs`, one invalid fixture), `government/ElectionStarted.v1`, `CandidateNominated.v1`, `VoteCast.v1` (carries `reason` — episode gold), `ElectionDecided.v1`, `GovernanceRejected.v1` (errorCode enum: `WINDOW_CLOSED`, `ALREADY_VOTED`, `NOT_A_CANDIDATE`, `UNKNOWN_ELECTION`, `STALE_COMMAND`…); DECISION_SCHEMA gains required-nullable `governanceAction` with params validated against the real `$defs` (M1-3 pattern); agent-service publishes to `commands.government` with causation = DecisionMade; government-service consumes with freshness guard + natural-key idempotency, emits exactly one outcome; event-service archives both new topics (CIV_TOPICS default + compose updated); **week-one live smoke: one real llama3.1 decision and one OpenAI strict-mode decision each emit a valid `governanceAction`** (the M1-3 de-risking ritual — this is the sprint's go/no-go signal) | M |

**Filmable beat (machinery, filmed later):** a hand-published
`GovernanceRequested{vote}` walks the whole chain — rejected while
`scheduled`, accepted during `voting`, duplicate silently no-ops — all
visible in the ledger.

## Sprint 8 — "Election night" (M+M+M = 18–24h)

| ID | Title | AC highlights | Est |
|---|---|---|---|
| M2-8 | Civic perception + campaign affordances | Perception consumer adds `government.events` (freshness-guarded, ruling 7); election events **broadcast-fan-out** to all alive villagers' percept queues (new: fanout needs the villager roster, injected like the scheduler hook); in-memory civic-state cache (phase, candidates, deadline) rendered as a standing "Village affairs" prompt section (percepts alone decay — an ongoing election must not); `governanceAction` affordance text appears only while a window is open; mixed-queue regression test (unknown percept types skipped — M1-1 discipline) | M |
| M2-9 | Dashboard `/government` page | Election card (phase + window clock), candidate list, live tally (bootstrap `GET /elections/{id}` + SSE filtered to `VoteCast`/`ElectionDecided` — the M1-5 pattern, no BFF); vote-reasons feed (the campaign's receipts, live); rewrite `/api/government/*`; nav links both ways; typecheck-only CI (unchanged ruling) | M |
| M2-10 | Election day: filming run + coverage + demo | Full arc on the filming preset: operator opens the election on camera (institution seeded, ruling 2), nominations/campaign/votes fully organic; DoD evidence pulled from the ledger (per-vote causation chains); jacoco gate extended to government-service (≥80 on adapter/application classes, `finalizedBy(test)` — the M1-10 pattern); `docs/demo-m2.md` + Episode 2 shot list; D2 steering knobs staged as filming levers (`COMMUNITY_GOAL` env → one system-prompt line; optional influencer personas are villagers.json edits, zero code); HANDOFF | M |

**Filmable beat:** the episode — election night, live tally, a mayor seated,
and the first mayoral address (a `chat`, colored by a "you are the mayor"
prompt line — physics, not script).

## M2 Definition of Done

1. One election completes `scheduled → nominating → voting → decided`
   with **≥2 organic candidacies and ≥10/20 organic votes**, every candidacy
   and vote produced by real LLM deliberation (operator input limited to
   opening the election).
2. Any vote reconstructs from the ledger:
   `VoteCast ← GovernanceRequested ← DecisionMade`, with the feelings/
   memories context that motivated it — the "why did Yara vote against Bram"
   replay.
3. Duplicate vote requests provably no-op (idempotency test + one live
   duplicate on camera-day data).
4. Gather works: **≥80% success** within 48 blocks of a resourced area;
   `ResourceGathered` events with nonzero `collected`; bots visibly leave
   the plaza.
5. A grudge (affinity ≤ −30) **persists ≥2 in-game hours** under ambient
   chatter without fresh conflict (M2-5, measured from the ledger).
6. `/government` page live during the arc; Episode 2 segment recorded.
7. Coverage gates green including government-service; `task test` runs six
   suites.

## Top risks (register matches tickets — no phantom mitigations)

| Risk | Mitigation (ticket-owned) |
|---|---|
| llama3.1 fails to emit `governanceAction` reliably | Affordance-gated prompting (M2-8) + rejection percepts teach; **week-one smoke in M2-7 is the go/no-go**; fallback is the OpenAI filming preset (~$1/hr, budgeted) — never a scripted vote |
| Decision→action lag (single partition) wrecks debate pacing | M2-4 partitions=6 + election windows measured in minutes, not seconds |
| Nobody runs / everybody-votes-instantly (flat drama) | Windows sized to ≥10 deliberations per villager; civic context names the stakes; D2 knobs (community_goal, influencer personas) are staged steering levers, used only if the arc stalls (M2-10) |
| `findBlocks` scans lag the server at 20 bots | Count-capped, ~5s cadence, MSPT measured before/after in M2-2's AC |
| Grudge damping overshoots (village turns permanently sour) | Asymmetry applies to *ambient* positives only, deliberation deltas untouched; half-life measured before/after (M2-5) |
| government-service scope creep toward laws/factions | Flyway V1 creates election tables only; non-goals enforced in review (ruling 8) |
| Two new consumers replay stale history | Freshness guards are day-one ACs on both (ruling 7) |

## Explicit non-goals (the scope gate)

No laws or enforcement (M3 — Sid skipped police deliberately and so do we);
no factions (M4); no constitutional-amendment loop yet (D1's full
feedback→amendment→vote cycle is the M3 "living law" centerpiece — M2 builds
its substrate: the command plane, the ballot box, the seated government); no
BFF / analytics-service / OpenSearch / Loki / k6 (ruling 8); no conversation
protocol (C3 waits for observed failures); no building; no vision; no live
codegen; no multi-civilization anything.
