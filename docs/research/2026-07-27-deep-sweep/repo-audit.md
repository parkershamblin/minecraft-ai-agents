**1. VERBS (decision contract + executor)**

9 verbs, enum at `packages/events/schemas/commands/ActionRequested.v1.schema.json:19-29`; executor switch `services/minecraft-service/src/actions/executor.ts:376-516`.

- **spawn** `{minecraftUsername, spawnPosition?}` (schema:77-92); **despawn** `{}` — lifecycle, never superseded (`executor.ts:72`, `LIFECYCLE_ACTIONS`; regression from live Bram/Ansel bodiless incident, executor.ts:61-71).
- **move** `{to{x,y,z}, range≥0 def 1}` (schema:93-109). Far-target gate: horizontal distance > `MOVE_MAX_DISTANCE` (env, default 128, `config.ts:150`) fails fast `PATH_NOT_FOUND` with staging-waypoint prose (`executor.ts:394-411`).
- **follow** `{targetVillagerId, range def 2}` — one-shot walk to target's current position, not continuous shadowing (`executor.ts:414-427`).
- **chat** `{message 1-256, targetVillagerId?}` (schema:110-127; executor ignores target).
- **idle** `{}` — terminates immediately (`executor.ts:438-440`).
- **gather** `{resource: wood|stone|dirt|coal|iron_ore, maxDistance 4-64 def 48, count 1-8 def 1}` (schema:146-177). Executor re-clamps defensively (`executor.ts:453-458`). Count cap 8 is load-bearing for the 60s timeout ceiling.
- **craft** `{item}` — 12-item enum (schema:197-223): planks, sticks, crafting_table, wooden/stone axe/pickaxe/sword, furnace, iron_pickaxe, iron_sword.
- **hunt** `{animal: cow|pig|sheep|chicken|any, maxDistance 4-48 def 32}` (schema:178-196), clamped at `executor.ts:499-503`. Adults only.

**Timeouts** (per-verb table, agent-side): `services/agent-service/src/agent_service/brain/graph.py:45-57` — move/follow/hunt 30s, chat/idle 10s, gather/craft 60s; ceiling `TIMEOUT_TABLE_MAX_MS=60_000` clamped executor-side by `COMMAND_TIMEOUT_MAX_MS` (`config.ts:144`, `executor.ts:319`). Watchdog `Promise.race`s the action, exactly-one-outcome latch (`executor.ts:337-373`). Stale commands >600s dropped `STALE_COMMAND` (`executor.ts:256-269`); per-villager serial lanes with latest-intent-wins supersede of the WAITING command only (`executor.ts:147-227`).

**2. EXECUTOR SKILLS**

- **Gather families** `services/minecraft-service/src/world/resources.ts:9-28`: wood (8 log types), stone (stone/cobble/andesite/diorite/granite), dirt, coal (coal_ore+deepslate), iron_ore (+deepslate). That's ALL — no diamond, gold, redstone, obsidian, sand, gravel. Tool-tier gate via `planHarvest` canHarvest (resources.ts:62-85); ore prose table `ORE_TIER` (resources.ts:92-95) → `TOOL_TIER_REQUIRED` non-retryable. Session loop pick→dig→collect per block, partial hauls honest, per-block `ResourceGathered` (`world/gatherSession.ts:67-110`). Target selection: per-block + region blacklists with expiry (resources.ts:224-334); v6 relocation fallback — when all targets blacklisted, walk toward blacklisted ground and clear region marks on arrival (`bots/BotSession.ts:1070-1192`).
- **Craft chains** `world/crafting.ts`: 12 items (crafting.ts:17-30, tripwire-tested against schema). Planks/sticks are wood-abstract (most-carried log wins, crafting.ts:68-96). Full end-to-end: log→planks→sticks→table→wooden tools→stone tools→furnace→iron_pickaxe/iron_sword. Table acquire/place flow: finds standing table within 16 (crafting.ts:41), walks, else places carried one on scanned clear ground (pickTableSpot crafting.ts:354-378). Furnace same trio (runCraftFlow crafting.ts:435-533). **Smelting is in-craft chain-resolution only** (ADR-10): `SMELTABLES = {iron_ingot: raw_iron}` ONLY (crafting.ts:111-113); fuel ranking coal>planks>logs, sticks excluded (crafting.ts:119-142); fires only when the single unmet gap is smeltable and raw input carried (planSmeltStep crafting.ts:162-183). **Block placement exists ONLY for crafting_table and furnace inside the craft flow** — no other placement path.
- **Hunting** `world/hunting.ts`: 4 families + any (12-18), one adult per action, 5-min per-entity escapee blacklist (:45), chase deadline 20s (`config.ts:108`). Yields meat/leather/feather/wool (:22-27).
- **Movement**: mineflayer-pathfinder, two Movements per bot — action planner (digs allowed) and reflex planner canDig=false (`BotSession.ts:280-290`); powder snow in blocksToAvoid (`bots/hazard.ts:54-59`). Budgets: tickTimeout 10ms, thinkTimeout 10s, searchRadius 80 (`config.ts:112-121`); turn-scoped `physicsSimCache` (config.ts:126).

**3. REFLEXES + ARBITRATION**

Busy seam `BusyState = 'action'|'escape'|'combat'|'eat'|null` (`bots/hazard.ts:20`); priority escape > combat > eat > commands, enforced by check-before-claim, never preemption (hazard.ts:15-19). Commands arriving while a reflex holds the body bounce retryable with named codes (`BUSY_BOUNCE` executor.ts:74-90: HAZARD_ESCAPE_IN_PROGRESS / BODY_BUSY / SELF_DEFENSE_IN_PROGRESS).

- **Hazard (powder snow)**: 1.5s poll (config.ts:51), 2 hits to open, digs out WITHOUT pathfinder, 12-block dig budget, 25s attempt deadline; emits `HazardEncountered` trapped/escaped/escape_failed (hazard.ts throughout).
- **Eat**: 2s poll; eats at food≤14, desperation (rotten_flesh) at ≤6, hurt modifier health≤14 & food<18; banned foods list; starvation CRISIS reuses HazardEncountered{starvation} (`bots/eat.ts:1-90`, thresholds config.ts:62-72). No eat verb by design.
- **Threat**: 1s poll, entity-map filter, alert radius 24, instant-open danger bubbles (creeper 12, skeleton 16) (`bots/threat.ts:30-46`). Pure fight-or-flee table (threat.ts:69-99): creeper always flee; flee if health≤10, unarmed, >2 hostiles, or 2 failed fights; ranged fought only at ≤4 (guard ≤8); melee fought only by brave/guard stance. Enderman ignored; unknown mobs flee. Stance is a fleet-wide env default `cautious` (config.ts:95) — **no per-villager or mind-controlled stance yet**.
- **Combat maneuvers** `bots/combat.ts`: melee only (650ms swing, reach 3.5, weapon tier table :63-74 — **no bow**); flee = 16-block hops with deflection + buddy-cone bias (:92+); fleet-wide fight cap 4 concurrent, overflow downgrades to flee (:39-60, config.ts:79).
- **Guard tether** `bots/guardTether.ts:45+`: guard stance walks back to spawn anchor when idle >12 blocks out; never claims busy, forfeits to any claimant.
- **Armor auto-equip** `bots/armor.ts`: best-carried per slot, 5s poll, one piece per pass.

**4. TICK + SCHEDULING**

Tick = LangGraph perceive→retrieve→deliberate→act→reflect (`brain/graph.py:92-436`). Scheduler is fixed-interval **plus reactive wake** (`brain/scheduler.py`): per-villager asyncio.Event; `request_reactive` (:56-77) grants an early tick gated by cooldown ≥15s since last tick, cap 3/5min per villager, imminence guard 10s; a reactive tick resets the cadence (:124-125). Reactive triggers wired in the percept consumer (`kafka/percepts.py`): chat percepts (:7), hazard `trapped` (:22-24), threat `spotted` (:207). Civic and race events deliberately never wake (GPU stampede, :15-16). **Interrupt-driven deliberation slots in at `request_reactive`** — any new percept type could call it; the guards already bound GPU duty (91% worst case at 20 villagers, docstring :5-8). Percept queues: Redis, cap 20, TTL 600s, 600s freshness guard (percepts.py:48-53).

**5. TEAM/COLLAB MACHINERY**

- **Race** (`brain/race.py`): in-memory RaceState fed by ledger events; 5-milestone T1 ladder (:18); RaceView = teammates + your/rival crossed milestones (:28-38); rehydrates from ledger at boot (race_rehydrate.py). Prompt renders a standing race section with checklist, pack-aware TOOL/STICKS/SMELT checks computing THE one next move, and RACE DISCIPLINE verb bans (`brain/prompts.py:393-437`, checks :213-390). These are heavily 8B-tuned (every check cites a measured llama/gemma failure loop) — this is the proven pattern: **structured state + computed directives, not NL negotiation, carries 8B coordination**.
- **COMMUNITY_GOAL**: one optional system-prompt line (`prompts.py:53-57`), muted during races (graph.py:144-145). It's the ONLY freeform standing goal, operator-set, not villager-set.
- **Relationships**: directed edges affinity −100..100 / trust 0..100 in agent_db; LLM deltas (≤3/tick) else hearer-sentiment heuristic (graph.py:256-313); rendered per nearby villager with grudge directive (`prompts.py:70-105`). Every change → `RelationshipChanged` event.
- **Chat earshot**: global MC chat → ChatRouter self-filter + 1.5s dedupe; heardByIds = sessions within `CHAT_EARSHOT_BLOCKS` (48, config.ts:129) of speaker (`world/chatRouter.ts:41-75`); fan-out one percept per hearer, ≤5 overheard lines per prompt (prompts.py:686-687).
- **Government-service as-built**: hexagonal Spring service, own DB. TODAY: operator-opened elections via REST (`ElectionService.java:73-114`), clock-driven scheduled→nominating→voting→decided (`ElectionClock.java`), two villager verbs `declare_candidacy`/`vote` (`GovernanceRequested.v1.schema.json:20-22`) consumed from `commands.government` with idempotent processed-commands dedupe; emits ElectionStarted/CandidateNominated/VoteCast/ElectionDecided/GovernanceRejected. governanceAction rides ALONGSIDE the world action in one tick (graph.py:205-226). **No laws, policies, taxes, or offices beyond mayor; villagers cannot open elections.** Civic prompt cache is in-memory, content-gated (`brain/civics.py:1-26`).

**6. MEMORY**

- **Retrieval**: weighted sum recency+importance/10+clamped-cosine, weights all 1.0 (`memory-service/src/memory_service/scoring.py:72-87`); recency exp-decay 0.995/hr on last-ACCESS (:64-69). Cue is generic: "what is happening around me now; nearby: <names>", k=6 (graph.py:99-106) — **retrieval cue never includes the current goal/task**.
- **Writes**: one "action" memory per tick from reflect node — decision + reasoning + percept digest (graph.py:348-401, memory_type="action"); importance/sentiment come from the deliberation output itself (no separate scoring call); heuristic fallback with keyword floors (scoring.py:12-50).
- **Reflection**: background job; triggers when unreflected importance sum > 30 (`settings.py:50`, reflection.py:91); LLM distills 1-3 first-person insights with provenance citations (reflection.py:28-61), stored memory_type="reflection" (floor importance 7), global hourly cap (:64-80); publishes ReflectionCreated. Reflection LLM runs at compose-passed temperature (fixed in v3 protocol).

**7. GAP LIST (does not exist today)**

- **Free block placement**: none. Only crafting_table/furnace inside craft flow. No building, no torches (prompt tells villagers torchlight is "a choice only you can make" — prompts.py:154-157 — but **no verb can place a torch**), no bridging/pillaring, no digging as a verb (only inside gather/pathfinder).
- **Bucket / water-lava handling**: absent (no obsidian route without it).
- **Bed / sleep / spawn-setting**: absent (spawn anchor = spawnpoint only).
- **Ranged combat**: no bow use anywhere (WEAPON_TIERS is swords/axes only, combat.ts:63-74). Skeletons at range are flee-only; **ender dragon is unreachable with melee-only**.
- **Barter/trade/item transfer**: no give/drop/trade verb; no villager-NPC trading; no piglin barter. Item handoff between villagers is impossible except via kill drops. RACE DISCIPLINE even says "report a handoff" but no mechanism exists.
- **Container use**: no chest/barrel open-deposit-withdraw (the only mention is a don't-place-on-these set, BotSession.ts:1308). No shared storage economy.
- **Portals/dimensions**: zero Nether/End code; no obsidian, flint&steel, blaze, eye-of-ender concepts. Gather/craft enums stop at iron.
- **Enchanting/brewing/anvil**: absent (materials unobtainable anyway — no diamond family, no XP model).
- **Food beyond meat**: no farming, no cooking (SMELTABLES has no food), raw-meat eating only.
- **Standing goal state**: NO villager-authored persistent goal object. The only standing prompt state: race cache, civic cache, failure streaks (TTL 10 ticks, `awareness.py:36`), last-decision (1 deep, awareness.py:93-97) — all in-memory, all lost on restart, none writable by the villager. No plan/subgoal stack, no todo, no "project" representation across ticks except what memories happen to retrieve.
- **Task allocation**: none. No roles, no claim/assign mechanism, no division-of-labor state; teammates independently race the same checklist (duplication is unmanaged). Mayor confers zero powers.
- **Skill library / learned actions**: verbs are fixed; no Voyager-style skill accretion (the verb-plan skill library is shortlist item 4, not built).
- **Death/inventory-loss handling**: no item recovery plan; respawn re-anchors guard post only.
- **Y-band mining**: gather scans ±16 y-band (config.ts:22) from villager altitude — no strip-mining/descending behavior; iron depends on surface-adjacent exposure.

Everything inventoried above runs today on local 8B-12B greedy — the codebase's whole grain is: LLM picks one verb per 30s from computed, prescriptive text; all reliability lives in deterministic executor/reflex/prompt-check code. That grain (rule-based verification, structured standing sections, coded teaching failures) is the 8B-survivable substrate a beat-the-game roadmap must extend; the gaps in section 7 (placement, ranged, dimensions, item transfer, persistent goals, allocation) are contract+executor work, not model work.