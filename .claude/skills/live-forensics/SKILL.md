---
name: live-forensics
description: Use when interrogating the LIVE stack — sending RCON probes (data get, execute if entity/block, gamerule/difficulty read-backs, inventory reads), querying the ledger (GET /events on :8081, the /events/stream SSE live feed, attempt receipts, correlationId chains), auditing a budget-breaker trip for FakeProvider pollution, or verifying which LLM provider the fleet actually booted on. Delivers the probe and query grammar that returns truth instead of artifacts.
---

## When to use / when not

Use this skill whenever you read state out of the running system: RCON commands at the Paper container, `GET /events` against the ledger, provider/budget state in agent-service. Do NOT use it for: deploying or recovering services/fleet (see the deploy-service skill), resetting the world or building snapshots (see the race-sweep skill), rendering race films from a ledger slice (see the demo-filming skill), changing the probe code itself in minecraft-service (see the mineflayer-runtime skill), or writing the numbers you found into a report (see the bench-report skill). The governing doctrine everywhere below: the live system lies by omission — an RCON typo and a success look identical, ledger page 1 is the OLDEST data, and a tripped budget breaker keeps producing plausible-looking decisions. Every probe must read state back.

## 1. RCON probe grammar

Full 1.21.6 command surface, wiki-drift traps, and console-context rules: `docs/runbooks/minecraft-1.21.6-commands.md` (§5 reset toolkit, §6 RCON gotchas, §7 this server). The invocation on this machine:

```powershell
docker exec ai-civilization-engine-minecraft-1 rcon-cli "gamerule doDaylightCycle"
```

- The whole Minecraft command is ONE quoted argv element; `rcon-cli` reads `RCON_PORT`/`RCON_PASSWORD` from the container env — pass no connection flags. Port 25575 is not published to the host; `docker exec` is the only path. Scripts derive the container name via `containerName('minecraft')` (`scripts/lib/containers.mjs` — `COMPOSE_PROJECT_NAME` override).
- There is no way to detect an unknown command over RCON — verify by reading state back (`gamerule <name>`, `difficulty`, `time query daytime`), never by trusting a quiet reply.
- No `@s`, and `~` resolves at world spawn. Never `@a` — it is racers + POV cams + the operator (runbook §7.3).

### Presence: per-name `execute if entity`, never `list`

- [ ] Probe each roster name; accept only the literal `Test passed`:

```powershell
docker exec ai-civilization-engine-minecraft-1 rcon-cli "execute if entity Elara"
```

`list` is ellipsized server-side at ~26 players (online racers read as missing — cost three sweep blocks 2026-07-26), and POV cam bots satisfy any count-based gate. The executable model is the fleet gate in `bench/sweep_race.py` (`"Test passed" not in rcon(...)`, 300s deadline). Fleet re-embodiment tooling is the deploy-service skill's decision table.

### Block truth: `execute if block`

```powershell
docker exec ai-civilization-engine-minecraft-1 rcon-cli "execute if block -435 59 -247 minecraft:crafting_table"
```

- `Test passed` iff the block is really there — this is how the first live `place` was world-verified. Same probe answers "is this candidate post water?" (`… minecraft:water`); `data get block` answers only for block entities ("not a block entity" for everything else).

### Inventory of a human player: per-slot, two identical passes

- [ ] Never `data get entity <name> Inventory` — output is ellipsized past ~150 chars (literal `...` mid-SNBT).
- [ ] Read per slot, indices 0..40, stop at `Found no elements`; `No entity was found` means offline:

```powershell
docker exec ai-civilization-engine-minecraft-1 rcon-cli "data get entity ParkerShamblin Inventory[0].id"
docker exec ai-civilization-engine-minecraft-1 rcon-cli "data get entity ParkerShamblin Inventory[0].count"
```

- [ ] Scan twice and accept only two identical passes — the Inventory NBT is a dense list that reindexes between commands, and a torn pass books phantom hauls into delta counters. The reference implementation (name-regex injection guard `^[A-Za-z0-9_]{1,16}$`, `MAX_SLOTS` 41) is `fetchHumanInventoryStable` in `services/minecraft-service/src/world/humanInventory.ts`; changing it is mineflayer-runtime territory.

### Settings that must survive: set → save-all → read back

```powershell
docker exec ai-civilization-engine-minecraft-1 rcon-cli "difficulty easy"
docker exec ai-civilization-engine-minecraft-1 rcon-cli "save-all"
docker exec ai-civilization-engine-minecraft-1 rcon-cli "difficulty"
```

Paper keeps difficulty in `level.dat` (overrides server.properties) and an RCON change is in-memory until a save — the container's 10s stop window can discard it. `scripts/race-rb2.mjs` is the model: it sets, saves, then parses the read-back and fails the preflight on mismatch, and does the same query-form read-back for every gamerule it cares about.

## 2. Ledger query grammar (`GET localhost:8081/events`)

Params (exact names from `EventsController`): `type` (repeatable), `aggregate-type`, `aggregate-id`, `correlation-id`, `since`, `until` (ISO date-time), `cursor`, `limit`.

| Rule | Why |
|---|---|
| Pages are ALWAYS oldest-first — keyset order `(occurred_at, event_id)` (`JdbcEventStore`). There is no `order` param; one gets silently ignored. | Reading page 1 as "newest" invented phantom outages (20 min lost 2026-07-18). |
| Any "recently" question MUST pass `since=<ISO>`. | Same incident. |
| `limit` is validated 1..100, default 25 (`EventFilter.MAX_LIMIT`); out-of-range → 400 problem-json. ALWAYS check the HTTP status before touching `page.data`. | A `limit=200` came back as a 400 that two drills parsed as a silent empty `{}` verb histogram (`verbHistogram` in `scripts/drill-rb2.mjs` is the corrected model). |
| Page forward with the response's `nextCursor` → `cursor=` param. | Keyset continuation over the same total order. |
| Anchor analysis windows on the ledger's own `AttemptStarted.occurredAt`, never on harness launch time. | The RB-2 preflight runs ~20 min of village-mode ticks that look exactly like a race regression (`docs/HANDOFF.md` diagnosis traps). |

```powershell
# Attempt receipts (the film/README.md receipt pattern) — Invoke-RestMethod throws on 400, which IS the res.ok check
$page = Invoke-RestMethod "http://localhost:8081/events?aggregate-type=Attempt&aggregate-id=$attemptId"
$page.data | ForEach-Object { "$($_.occurredAt) $($_.eventType)" }

# One villager's decisions in a window
$page = Invoke-RestMethod "http://localhost:8081/events?aggregate-type=Villager&aggregate-id=$villagerId&type=DecisionMade&since=2026-08-07T00:00:00Z&limit=100"

# Trace one tick across services
$page = Invoke-RestMethod "http://localhost:8081/events?correlation-id=$correlationId"

# Next page
$page2 = Invoke-RestMethod "http://localhost:8081/events?since=2026-08-07T00:00:00Z&limit=100&cursor=$($page.nextCursor)"
```

Name → villagerId mapping lives in `services/agent-service/seed/villagers.json` (`id` + `minecraftUsername`; racers are entries [0:6]). Live feed: `GET /events/stream` (SSE) — if it looks dead only in a browser, the dashboard's `compress: false` (`apps/dashboard/next.config.ts`) is the trap: gzip buffers SSE for browsers while curl streams fine.

## 3. Provider truth at boot

`build_llm_provider` (`services/agent-service/src/agent_service/llm/providers.py`) degrades SILENTLY by design — auto-walks openai → anthropic → ollama → fake with only warnings, so an unreachable Ollama or unpulled model means a fleet on fake brains that never crashes. After any deploy touching LLM config (procedure: deploy-service skill):

```powershell
docker logs ai-civilization-engine-agent-service-1 2>&1 | Select-String "llm provider"
```

- [ ] The line names the provider AND model (`llm provider: ollama (warmed)`, `llm provider: anthropic` …). No line, or the wrong provider, means do not trust the run.

## 4. Budget-breaker trip audit

The daily token breaker (`BudgetedProvider`, `services/agent-service/src/agent_service/llm/budget.py`) flips deliberation to FakeProvider until midnight UTC. The only tells are the `civ_llm_budget_tripped` gauge and one warning log line — the fleet keeps emitting plausible decisions. Budget sizing before a run is the deploy-service skill's job; this is the after-the-fact audit.

- [ ] **Detect the trip and get its timestamp:**

```powershell
curl.exe -s http://localhost:8001/metrics | Select-String civ_llm_budget_tripped
docker logs ai-civilization-engine-agent-service-1 2>&1 | Select-String "DAILY TOKEN BUDGET EXHAUSTED"
```

- [ ] **Bound the pollution window:** trip timestamp → fleet stop / provider restore / UTC midnight rollover (`llm budget reset — circuit breaker closed`), whichever came first.
- [ ] **Scan the window for fake decisions.** `DecisionMade` payloads carry `llmProvider`/`llmModel` — filter on `llmModel == "fake-scripted-1"` (unambiguous; the provider enum predates anthropic):

```powershell
$page = Invoke-RestMethod "http://localhost:8081/events?type=DecisionMade&since=$tripIso&limit=100"
$page.data | Where-Object { $_.payload.llmModel -eq 'fake-scripted-1' } |
  ForEach-Object { "$($_.occurredAt) $($_.aggregateId) $($_.payload.decision)" }
```

- [ ] **Scan for narrative pollution.** FakeProvider (`_SCRIPT` in providers.py, a 9-entry cycle) has exact fingerprints: chat `"Good day! The weather holds and the work is honest."`, relationship reason `"A pleasant exchange in the morning sun."`, scripted +3 affinity / +1 trust toward Bram (`villagerId 019f8e2a-0000-7000-8000-0000000b2a44`) — the string that manufactured a +100 friendship on 2026-07-07:

```powershell
$rel = Invoke-RestMethod "http://localhost:8081/events?type=RelationshipChanged&since=$tripIso&limit=100"
$rel.data | Where-Object { $_.payload.reason -eq 'A pleasant exchange in the morning sun.' }
```

- [ ] **Repair from the ledger.** Each polluted `RelationshipChanged` carries `previousAffinity`/`previousTrust` — reset the directed edge in agent_db (agent-service owns `villagers/relationships.py`) to the FIRST polluted event's previous values.
- [ ] **Record the audit** — window bounds, events found, repairs made — in the handoff (see the session-handoff skill). An unaudited window is itself a finding: the 2026-07-28 Claude run left one.

## Verification

Prove each critical step by its read-back:

```powershell
# RCON probes returned truth, not silence
docker exec ai-civilization-engine-minecraft-1 rcon-cli "gamerule doDaylightCycle"   # prints the value you set
docker exec ai-civilization-engine-minecraft-1 rcon-cli "difficulty"                 # "The difficulty is <what you set>"
docker exec ai-civilization-engine-minecraft-1 rcon-cli "execute if entity Elara"    # "Test passed" per roster name

# Ledger query was honest: status checked, window anchored
# (Invoke-RestMethod threw on nothing; $page.data's first row's occurredAt >= your since=)
$page.data[0].occurredAt

# Provider verified
docker logs ai-civilization-engine-agent-service-1 2>&1 | Select-String "llm provider"   # names the intended provider+model

# Breaker state known, not assumed
curl.exe -s http://localhost:8001/metrics | Select-String civ_llm_budget_tripped         # 0.0 (or your audit exists)
```

Inventory reads count as verified only when two consecutive passes were identical; a ledger recency claim counts only with `since=` in the URL; a pollution audit counts only when the window's `DecisionMade` scan and the fingerprint scan both ran and their counts are recorded.
