# Survival Plan — "The Village Learns to Survive" (Survival cluster)

**Goal:** the 20-villager fleet survives the peaceful→easy flip — hunger noticed,
food hunted/cooked/eaten, threats fought or fled, deaths perceived and remembered —
wheels off, zero deaths, on camera. Working title: *"I Turned On Survival Mode and
My 20 AI Villagers Had to Learn to Eat."*

**Duration:** 4 sprints (Sprints 9–12) + one named stretch ticket. Capacity key
unchanged from M1/M2: S = 2–4h, M = 6–8h, L = 10–14h against ~22h per sprint;
arithmetic printed per sprint, slip valve(s) named.

**Ticket prefix:** SV-x. Survival is a GitHub Milestone ("Survival") in the same
repo — the M3 "living law" cluster keeps the M3-x namespace for later. `main` is
tagged `pre-survival` before the first survival merge.

**Planning inputs:** docs/HANDOFF.md (PR #5 — the powder-snow reflex — is the
architectural template and the parallel-worktree merge pattern), 08-m2-plan.md
(format), a five-lane code/ops/web recon, four design judge panels on the
genuinely open questions, and an adversarial review of this document against the
actual code (57 findings raised, 52 confirmed and integrated — notable: the
"restart reverts difficulty" failsafe was unsound, DoD 2 was unprovable as first
written, and the baby-animal exclusion mechanism had to change).

## Where M2 left the system (measured, not assumed)

- Fleet 20/20 ticking on llama3.1:8b; Mayor Bram seated. Gather works but harvests
  exactly ONE block per action (~1 block/min at 60s ticks) — the structural cause
  of "villagers collect a block or two." Shipped levers: per-target blacklist,
  drop-chase, world-visible announcements, maxDistance default 48, prescriptive
  RESOURCE_NOT_FOUND / TOOL_REQUIRED / all-blacklisted prose. The watchdog TIMEOUT
  message is still the bare `no outcome within {timeoutMs}ms` (executor.ts) —
  upgrading it to prescriptive prose lands with SV-2/SV-8, where counted
  gathers/hunts will hit it.
- health/food are sensed end-to-end (1s snapshot → prompt "health {h}/20, food
  {f}/20") but MEANINGLESS — no directive, no eat verb, no reaction, no
  bot.on('health') handler. `food` is optional in the WorldSnapshot contract.
- Death is invisible: bot.on('death') only sets spawnReason='respawn'; the only
  Kafka signal is the post-facto VillagerSpawned{respawn}. VillagerDied /
  VillagerDamaged exist as 03-catalog rows, not schemas.
- No entity/mob perception anywhere; bot.entities is unused except gather's
  drop-chase.
- The busy seam (`BusyState = 'action'|'escape'|null`, hazard.ts) + HazardWatcher
  (PR #5) is the proven reflex-arbitration spine; wedge-safety (Promise.race,
  never await a mineflayer promise) is regression-tested; the 2-worktree
  body/brain fan-out against a contract-first commit merged PR #5 conflict-free.
- DIFFICULTY: peaceful is a hardcoded compose literal; level.dat overrides env for
  existing worlds. An unsaved RCON difficulty flip MAY be discarded by the 10s
  stop window, but Paper autosave (~5 min) and graceful stop both persist it —
  never rely on restart to revert a bounded window. No gamerule handling and no
  backup runbook exist anywhere in the repo.

## Mechanism rulings (decided now so tickets don't re-litigate)

1. **Recorded decisions honored** (pre-cluster ruling set): same repo; GitHub
   Milestone "Survival"; mineflayer-pvp approved pending spike-then-exact-pin;
   food arc before combat; training wheels (easy + keepInventory / doInsomnia
   false / mobGriefing false), one wheel removed per proven milestone, final flip
   = Parker's on-camera ceremony; single-call tick stands — reflexes NEVER call
   the LLM; the busy seam is extended, never duplicated; reactive wakes stay
   inside the existing caps (15s cooldown / 10s imminent-skip / 3 per 5min).
2. **Sustained gathering = early ticket (SV-2, Sprint 9), not a pre-cluster fix.**
   It rides the same contract-commit + 2-lane machinery; a standalone fix would
   add a deploy+reseed cycle before Episode 2 filming; crafting (same sprint) is
   its first consumer (tool chains need 3–5 logs). Mechanism: additive `count`
   param on GatherParams (1..8, default 1) + an executor session loop
   (pick→dig→collect per block, per-block blacklist marks, one announcement per
   haul); the brain advertises "gather up to N". The act node's hardcoded
   timeoutMs 30_000 becomes a per-verb timeout table (SV-4) with an explicit
   ceiling `TIMEOUT_TABLE_MAX_MS = 60_000`. The cap is load-bearing: every
   no-preemption safety argument in this cluster reads "a reflex is locked out
   ≤ max(per-verb timeout) = 60s", NOT "≤30s" — and the body enforces it
   itself: the executor watchdog clamps payload.timeoutMs to
   `COMMAND_TIMEOUT_MAX_MS` (default 60_000, matching the contract ceiling;
   executor.ts — fixed in PR #37, see
   docs/reports/bottleneck-report-2026-07-17.md), so an above-cap brain-table
   entry is silently clamped on the wire and cannot extend the lockout.
   Raising the executor ceiling itself (the cap, not a brain-table verb entry)
   triggers the PREEMPTED_BY_THREAT contingency review (risk register).
3. **Beds/sleep: DEFERRED cluster+1; doInsomnia=false is a standing rule, not a
   removable wheel.** Sleeping needs a wool economy + bed placement + fleet-wide
   sleep coordination (playersSleepingPercentage) — a full arc of its own. The
   DoD is surviving the night, not skipping it; skipping would cheat the combat
   drama. Wheels-off therefore = keepInventory→false + mobGriefing→true;
   doInsomnia stays false (restated in the ceremony definition).
4. **Skeleton-first: ADOPTED, cluster-wide.** Where an arc's body half wants >1
   lane, the orchestrator commits (with/right after the contract commit): stub
   modules (threat.ts AND combat.ts — interfaces + no-op impls; two modules so
   the two lanes never share a file), ALL BotSession.ts/executor.ts touch points
   (new BusyState literals, watcher wiring, the 'combat' row extending the
   BUSY_BOUNCE table SV-6 ships, verb cases delegating to session methods, the
   executor set_stance instant-verb case ordered before the busy bounce, the
   in-memory session stance store defaulting 'cautious', buildSnapshot
   pass-through for stance/nearbyHostiles, and the one-line eat.ts gate on the
   threat stub's episodeOpen getter — stub returns false until SV-12a makes it
   real), and test scaffolds. Lanes then fill only their own module + test
   files — BotSession.ts / executor.ts are never touched by two lanes. Corollary
   for single-body-lane arcs (Sprints 9–10): body tickets run SEQUENTIALLY in
   the one body lane (SV-2→SV-3; SV-6→SV-8); any fan-out beyond one body lane
   anywhere in the cluster triggers this ruling, not just Sprint 11.
5. **Strict-mode discipline unchanged:** new verbs add flat `$defs` param shapes
   (the GatherParams precedent); DECISION_SCHEMA additions are required-nullable;
   the recorded OpenAI free-form-params reshape stays a separate pre-OpenAI gate.
   This cluster runs Ollama; do NOT set an OpenAI key.
6. **Hunt emits ResourceGathered** (resourceType = the drop, e.g. 'beef') — the
   economy primitive the event ledger already carries (event-service persists
   every envelope); hunted drops still reach the materials dashboards via
   civ_materials_collected_total, the inventory-delta counter, regardless of
   which event is emitted — PLUS announcements. No new AnimalHunted event
   (confirmed by the hunt panel).
7. **Every new consumer/percept keeps the freshness guard + the occurredAt
   runtime-stamping test rule** (CLAUDE.md corollaries; a day-one checklist item,
   not a lesson to relearn).
8. **Deferred with reasons** (enforced in review): beds/sleep (ruling 3);
   iron/mining tier (no mining arc — tools cap at stone, armor at leather);
   ranged weapons (melee only, recorded decision); breeding/mob farms (ecology
   stays wild; breeding is the named next verb if the herds thin); per-provider
   LLM budgets (unchanged); OpenAI params reshape (pre-OpenAI gate, not
   survival).

## Design briefs (panel-settled; tickets reference these)

Each brief is the synthesis of a 3-design judge panel, reconciled where panels
overlapped, then adversarially reviewed against the code.

### Eat reflex (SV-6/SV-7)

- **Reflex-only; NO deliberate eat verb** (unanimous): a tick buys one world
  action — spend it on acquisition, which only the mind can do; an advertised eat
  verb invites llama over-persuasion (the 20/20-candidacy lesson); zero schema
  surface.
- `EatWatcher` in `bots/eat.ts`, a 4th sibling interval (EAT_CHECK_INTERVAL_MS=
  2000, 0-disables), mirroring HazardWatcher line for line. Never
  bot.on('health'): the event goes silent exactly at the food=0/hp=10 steady
  state, and the polled check gated on `busy === null` is the one arbitration
  shape. Per-pass cost: two scalar reads; inventory scan only when a threshold
  trips.
- Tiers: peckish food≤14 (EAT_FOOD_THRESHOLD) · hurt modifier health≤14
  (EAT_HURT_HEALTH_THRESHOLD, 0-disables) && food<18 (REGEN_FOOD_GATE, hardcoded
  game constant) · starving food≤6 (EAT_CRITICAL_FOOD — desperation foods
  unlock). One consume per claim (~2s: equip + consume), re-evaluated next pass.
- Selection: rank carried food by foodPoints desc (never saturation —
  minecraft-data's saturation values are non-vanilla scaled), name tie-break.
  EAT_BANNED_FOODS=pufferfish,spider_eye,poisonous_potato,chorus_fruit (damage /
  teleport-falsifies-position); EAT_DESPERATION_FOODS=rotten_flesh (starving tier
  only — "choked down rotten flesh" is the ledger color this cluster exists for);
  per-item 60s failure blacklist (gather discipline). No edible food carried →
  the reflex does NOTHING; the standing directive owns acquisition pressure.
- Busy seam: BusyState += `'eat'`. SV-6 claims only when busy===null AND no
  hazard episode is open (new `trapped` getter on HazardWatcher — closes the
  escape-retry-backoff window); the threat-episode gate arrives with SV-11.5's
  skeleton (stub getter returns false). NO preemption of a running 'action'
  (safe: lockout ≤ TIMEOUT_TABLE_MAX_MS 60s, easy starvation floors at 10 HP —
  argument flagged difficulty-coupled in a code comment).
- Executor bounce generalizes to a BUSY_BOUNCE table; eat bounces with NEW
  additive errorCode **BODY_BUSY** (retryable); escape keeps byte-identical
  HAZARD_ESCAPE_IN_PROGRESS.
- Facts: routine eats are log + metric only — no ledger noise, no percept-queue
  eviction. The CRISIS reuses **HazardEncountered with hazardType='starvation'**
  (free string by schema design): `trapped` emitted once when starving AND
  helpless (no food carried, or 3 consecutive consume failures) — this wakes the
  mind for free (percepts.py wakes on phase==trapped regardless of hazardType,
  verified) inside the existing caps; `escaped` on eat/recovery (food ≥
  EAT_RECOVER_FOOD=10 hysteresis); `escape_failed` never emitted for starvation.
  Death mid-episode → silent drop via the spawn-generation bump (no lying
  "recovered" emit).
- Metrics: civ_eat_reflex_total{outcome: ate|ate_desperate|no_effect|failed|
  timeout} — `no_effect` = post-consume food-delta ≤ 0, the ghost-dig honesty
  lesson applied to consume — plus a hazardType label added to
  civ_hazard_escapes_total (dashboard note rides the PR).
- Brain: starvation percept lines; **fix the type-blind hazard directive** (real
  pre-existing bug: prompts.py fires the powder-snow prose for ANY hazard
  percept); new standing `_survival_section` off snapshot food (≤10:
  urgent-acquisition prose; ≤6: STARVING + asking-for-help legitimizer — the
  in-voice distress cry stays emergent); reflect-fold branches with coords.
- Envs: EAT_CHECK_INTERVAL_MS=2000, EAT_FOOD_THRESHOLD=14, EAT_CRITICAL_FOOD=6,
  EAT_RECOVER_FOOD=10, EAT_HURT_HEALTH_THRESHOLD=14, EAT_TIMEOUT_MS=8000,
  EAT_RETRY_MS=10000; zod refine critical < recover <= threshold.

### Threat watcher + fight/flee (SV-11..SV-14)

- **Two modules** (so the two body lanes never share a file): `bots/threat.ts`
  owns the watcher, episode state machine, ThreatEncountered emission, the pure
  classification/decision tables, and an `episodeOpen` getter (consumed by
  eat.ts); `bots/combat.ts` owns the FightDriver implementation (fight + flee
  interiors) and the combat.ts-global fleet fight-cap counter. Watcher = 5th
  sibling loop, THREAT_WATCH_INTERVAL_MS=1000 (0-disables).
- **BusyState += `'combat'`** (one literal covers fight AND flee) paired with new
  additive errorCode **SELF_DEFENSE_IN_PROGRESS** (retryable) — the mind deserves
  to distinguish "terrain trapped me" from "something is attacking me".
- Detection: one filter over Object.values(bot.entities) on kind==='Hostile
  mobs', squared-distance math, THREAT_ALERT_RADIUS=24 / THREAT_DANGER_RADIUS=10
  with per-mob overrides {creeper:12, skeleton:16}; 2-pass debounce to open at
  alert range, INSTANT open inside a danger radius (a creeper fuse is ~1.5s);
  close = 3 clear passes + hysteresis +4. Classification: FLEE_ONLY={creeper},
  RANGED={skeleton,stray,bogged}, MELEE={zombie,husk,drowned,zombie_villager,
  spider} (explicit, so "unknown" means genuinely unmapped), IGNORED={enderman},
  unknown hostile → flee-class. Promotion rule: health drops while the nearest
  tracked hostile is IGNORED/unclassified → promote to flee-class and open the
  episode (covers aggroed endermen — the design's only damage-triggered path).
- **ThreatEncountered.v1 (new world event):** {villagerId, threatType (free
  string), phase: spotted|engaged|killed|escaped|overwhelmed, response:
  fight|flee|null, count, distance, position, detail (string|null)} — all
  required, additionalProperties:false. Edge-triggered on episode STATE: spotted
  once; engaged re-emitted only on response flip (monotonic none→fight→flee);
  killed/escaped close; overwhelmed rate-limited to once per 60s with the episode
  left open. A cornered terminal (no-progress detector + bounded flail —
  fire-and-forget swings within reach) folds into overwhelmed's detail. Worst
  siege night emits a bounded handful of percepts — the 20-cap queue is safe.
- Fanout: ALL phases victim-only; reactive wake on **spotted + overwhelmed** only
  (spotted = the one moment the mind can preempt; overwhelmed = the one moment
  only the mind can change the plan). Caps untouched — the GPU guard.
- Decision table (pure, priority-ordered, table-tested): creeper in danger radius
  → flee, always; health≤10 → flee; unarmed → flee; count>2 → flee;
  failedFights(target)≥2 → flee (the gather-blacklist mirror); skeleton: fight
  only ≤4 blocks AND armed; melee-class armed: stance brave→fight /
  cautious→flee; default flee.
- **survivalStance** (the personality payoff — a coward and a brave villager
  diverge): DECISION_SCHEMA += required-nullable flat `survivalStance:
  brave|cautious|null`; ActionRequested += `set_stance` verb (+ SetStanceParams
  $defs); the act-node rider is change-gated PLUS flip-hysteresis (≥N min between
  flips per villager — llama's observed failure mode is spurious-but-valid
  values, the 158-fictional-elections lesson; change-gating limits wire spam,
  not churn) + a stance-flips counter for soak + a stance-stability prompt test.
  The executor treats set_stance as a BODYLESS instant verb (handled BEFORE the
  busy bounce — usable mid-combat after an overwhelmed wake); all its
  minecraft-service wiring is SV-11.5 skeleton work — SV-13 owns only the
  brain-side rider. In-memory, default 'cautious', reported back via the
  snapshot `stance` field. Live-verify Ollama's grammar handles the
  enum-including-null shape.
- Maneuvers: hand-rolled default (**pvp NO-GO assumed and recommended by all
  three panels; see §spike**) behind a 3-method FightDriver seam so a spike GO
  swaps only the interior. Fight: equip best weapon (static tier table),
  GoalFollow(target,2) dynamic set ONCE (not awaited), 250ms poll re-fetching the
  entity by id each pass, lookAt fire-and-forget, attack() at ≥650ms spacing,
  THREAT_FIGHT_TIMEOUT_MS=15000. Flee: static GoalXZ away-vector ×24
  (FLEE_DISTANCE), repath gated (bearing >45° or target change, ≥2s apart),
  second-hostile deflection ±90°, buddy bias toward the nearest villager inside
  a 60° cone (FLEE_BUDDY_RADIUS=32, 0-disables — fleeing INTO the village is
  story; kiting is accepted emergent chaos with the cone as sole mitigation),
  sprint only when food>6 (a starving villager flees at a walk — kept, and
  narrated in the emit detail), THREAT_FLEE_TIMEOUT_MS=12000. THE HARD RULE,
  strengthened: maneuvers NEVER await pathfinder promises — setGoal is
  fire-and-forget; progress is verified by polling.
- **Fleet-wide fight cap: THREAT_MAX_CONCURRENT_FIGHTS=4** (0 = flee-only fleet
  = the staged-rollout stage-1 setting; overflow downgrades to flee, never
  queues — queues hide wedges); civ_threat_fights_active gauge makes a slot leak
  visible in one scrape.
- **Preemption: v1 = NONE.** A zombie arriving mid-gather waits for the watchdog
  window (≤60s cap). The pre-designed contingency — interruptAction()
  (stopMoving + stopDigging + a one-shot flag the executor maps to an honest
  PREEMPTED_BY_THREAT instead of INTERNAL) — is recorded, reserved, and gated on
  soak evidence (risk register + SV-18 soak checklist). Interim lever: lower
  per-verb timeouts.
- Canned combat chat: ≤1 bot.chat() per phase transition, stance-flavored
  templates ("A creeper! RUN!") → neighbors' ChatObserved percepts and wakes =
  village drama through already-sanctioned plumbing.
- Snapshot additive optional: nearbyHostiles [{type,count,nearestDistance}] (from
  the watcher's cached pass — zero extra scanning) + stance (string).
- Metrics: civ_threat_episodes_total{outcome: killed|escaped|aborted},
  civ_threat_responses_total{response,outcome}, civ_threat_fights_active.
- Brain: percept lines per phase (unknown phases skipped), a fire-once threat
  directive (names survivalStance + light/company/warn-in-chat as real choices),
  reflect folds with coords ("this place is dangerous at night" becomes
  retrievable memory), "Dangers in sight" snapshot section.
- Deploy order: minecraft-service first — the cautious default protects the
  fleet before any brain change ships.

### Hunt (SV-8/SV-10)

- Verb `hunt`, one animal per action (gather's one-block precedent; a wounded
  escapee keeps its damage — next tick's hunt finishes it). HuntParams $defs:
  {animal enum cow|pig|sheep|chicken|any (default any), maxDistance 4..48
  default 32 — a chase-budget choice, not a sight limit: the spike measured
  entity tracking reaching ≥64 blocks under our view settings}.
- New module `world/hunting.ts` (pure: HUNT_FAMILIES, HUNT_YIELD predicates,
  PRIMARY_MEAT, pickHuntTarget, planWeapon, failure prose, runKillLoop vs a
  HuntBot structural interface); BotSession gains a thin hunt() orchestrator +
  huntBlacklist (entity-id keyed, TTL 5min, mark-before-attempt, clear only on
  collected>0) + an activeHunt abandonment ctx; **stopMoving() gains one line**
  (abandon the active hunt) so the watchdog's existing cancel lever reaches the
  loop — on TIMEOUT the loop goes silent within one 250ms poll, no swings after
  the outcome settles.
- Kill loop: GoalFollow(entity,2) dynamic set once (not awaited), 250ms poll,
  lookAt fire-and-forget + attack() at ≥650ms spacing, leash maxDistance+16,
  HUNT_CHASE_TIMEOUT_MS=20000 (the only env; must stay < hunt's per-verb timeout
  table entry (30s) minus ~8s collection reserve). Kill detection = entity gone
  at lastKnownDistance≤12 with ≥1 swing (presumption kept honest by the
  inventory delta); spawn-generation guard against own-death false kills; drop
  collection = gather's drop-chase copied verbatim (~12 lines, flagged for a
  later simplify pass).
- Baby exclusion: the ageable-mob `baby` metadata flag (via
  bot.registry.entitiesByName[name].metadataKeys) — mineflayer 4.37.1 sets
  entity.height once from the registry ADULT value and never rescales it, so a
  height heuristic can never fire; the height check is defense-in-depth only.
  The spike already pinned it on Paper 1.21.6: metadataKeys index **16**
  (`baby`); calf metadata[16]===true, adult undefined, heights identical (1.4).
- Failure codes: reuse RESOURCE_NOT_FOUND (family-specific prescriptive prose;
  the all-blacklisted variant recruits the M2-3 relocation behavior) + ONE new
  additive **TARGET_ESCAPED** (retryable; prose teaches wounded-game persistence
  and the sword upgrade).
- Emissions: ResourceGathered per item type with positive delta (honest zero on
  an empty kill); ActionCompleted result = {animal, killed, collected, drops,
  position, chaseSeconds, note} — `note` teaches cooked-vs-raw economics.
  Announcements: start always (post fail-fast — an announced hunt is always
  attempted), success only when collected>0 (never announce a lie the village
  hears).
- Snapshot additive optional **nearbyAnimals** [{family,nearestDistance,count}]
  computed on every 1s snapshot pass — no scan gate (animals move while bots
  stand still; ~1000× cheaper than one findBlocks sweep; escape hatch = 5s
  survey cadence, zero schema change). Since PR #37 the pass dedupes the Redis
  write when the snapshot body is unchanged (forced refresh at TTL/2 keeps the
  key alive) — freshness holds here because animal movement changes the body.
  Prompt sibling `_animals_section`: "Game in sight (hunt can reach these): …"
  / honest-empty "none — the herds keep to open grass; hunting means walking
  first."
- Affordance line: param optional, raw-vs-cooked economics, "hunt when food runs
  low, not for sport: the herds are slow to return."
- Ecology: local extinction is accepted narrative ("the herds thinned") — zero
  hidden governors; the brakes are all diegetic (adult-only targeting, one kill
  per action, scarcity prose → relocation pressure, the affordance norm).
  civ_hunts_total{family, outcome: killed|empty|escaped|not_found|aborted} is
  the depletion curve and an on-camera decision point; breeding is the named
  future verb.

### Cross-cutting

- Final BusyState: `'action' | 'escape' | 'combat' | 'eat' | null`. Priority
  ladder: escape > combat > eat > action-commands. Enforcement: combat never
  opens an attempt while a hazard episode is open; eat gates on BOTH
  open-episode getters once SV-11.5 lands (hazard-only until then).
- ActionFailed errorCode additions (additive, one contract commit each):
  BODY_BUSY (commit B), SELF_DEFENSE_IN_PROGRESS (commit C), TARGET_ESCAPED
  (commit B). PREEMPTED_BY_THREAT is reserved/unshipped (contingency).
- WorldSnapshot additive optional fields: nearbyAnimals (commit B),
  nearbyHostiles + stance (commit C).
- mineflayer-pvp integration truth (carried from research + panels):
  bot.pvp.attack sets its GoalFollow ONCE, but its swing TaskQueue and target
  state persist until pvp.stop() — the watchdog's stopMoving() lever cannot
  fully silence it without a `bot.pvp?.stop()` extension. Either way the busy
  seam gates any combat implementation.

## Sprint plan

### Sprint 9 — "Boards and bread" (food substrate)

| ID | Title | AC highlights | Est |
|---|---|---|---|
| SV-1 | Contract commit A | GatherParams.count (additive, 1..8 default 1); craft verb + CraftParams $defs (item enum: planks, sticks, crafting_table, wooden_axe, wooden_pickaxe, wooden_sword, stone_* (valve), furnace); fixtures + invalid fixture; `task gen` committed; 03-catalog rows. NO eat verb — reflex-only ruling | S |
| SV-2 | Sustained gather sessions (body) | count loop (pick→dig→collect per block), per-block blacklist marks, one announcement per haul, prescriptive TIMEOUT prose, wedge-safe within the existing watchdog | M |
| SV-3 | Craft verb (body) | recipesFor/craft, crafting-table acquire/place flow, prescriptive failure prose (missing ingredients name the gap), ajv payload tripwire, tests. Valve: stone tier slips to Sprint 10 | L |
| SV-4 | Crafting brain | DELIBERATE_ACTIONS + params map + SYSTEM_TEMPLATE affordance (recipe-chain teaching prose); per-verb timeout table with TIMEOUT_TABLE_MAX_MS=60_000 ceiling (load-bearing — ruling 2); FakeProvider script; prompt tests; go/no-go llama smoke ("N real decisions emit valid craft") | S |

Body lane is single (ruling 4 corollary): SV-2 → SV-3 sequential.
**Arithmetic:** 2–4 + 6–8 + 10–14 + 2–4 = 20–30h; valve = stone tier out of SV-3
(→ 18–26h).
**Filmable beat:** a villager fells three logs in one trip, builds a crafting
table, and makes the village's first wooden sword.

### Sprint 10 — "The hunt" (hunger arc)

| ID | Title | AC highlights | Est |
|---|---|---|---|
| SV-5 | Contract commit B | hunt + cook verbs (HuntParams/CookParams $defs); errorCodes TARGET_ESCAPED + BODY_BUSY; WorldSnapshot.nearbyAnimals; HazardEncountered description += 'starvation' + starvation fixture; catalog rows; fixtures + invalid | S |
| SV-5b | Survival ops gate | AUTHOR the volume-backup + bounded-window runbooks (they gate this sprint's first window); execute the first backup (task down → PowerShell tar of minecraft-data + postgres-data + redpanda-data → up:all → task seed); death-event sanity drill on peaceful (RCON /kill one villager → verify death→respawn→generation-bump in logs; precondition for SV-15) | S |
| SV-6 | Eat reflex (body) | per the eat brief: EatWatcher, busy 'eat', BUSY_BOUNCE table, starvation episodes, civ_eat_reflex_total, wedge + seam + crisis-lifecycle regression tests | M |
| SV-7 | Hunger brain | starvation percept lines; type-blind hazard-directive fix; standing _survival_section; reflect folds; prompt tests | S/M |
| SV-8 | Hunt verb (body) | per the hunt brief: hunting.ts, huntBlacklist, stopMoving abandonment line, nearbyAnimals snapshot, civ_hunts_total, baby-flag live check | M |
| SV-10 | Hunt brain | DELIBERATE_ACTIONS + _PARAMS_DEF_BY_ACTION for hunt; SYSTEM_TEMPLATE affordance; _animals_section; failure percept prose; go/no-go llama smoke ("N real decisions emit valid hunt"; the eat side gates separately on civ_eat_reflex_total{outcome=ate}>0 during the smoke window) | S |

SV-9 (M, **STRETCH — outside the 4-sprint grid**): Cook via furnace, body+brain
TOGETHER (furnace place/fuel/input/collect flow, announcements, cook affordance/
params/percepts — the brain must never advertise a verb the executor lacks).
Default home: Sprint 12 if SV-15/16/18 land early; else post-cluster. DoD-safe:
DoD 2 conditionalizes cook; DoD 6 doesn't need it. If cook must be guaranteed
in-cluster, it honestly costs a fifth sprint.

Window gate: the first daytime easy window opens only after SV-6 (+SV-7) are
DEPLOYED and the SV-10 smoke passes; the backup gate (SV-5b) precedes it. Body
lane is single: SV-6 → SV-8 sequential.
**Arithmetic:** 2–4 + 2–4 + 6–8 + 3–6 + 6–8 + 2–4 = 21–34h; valves: (1) SV-7
trails to Sprint 11 (→ 18–28h; safe — eating is reflex-only, the hunger
directive is a cluster-level DoD), (2) in-sprint: SV-8's snapshot/prompt half
(nearbyAnimals + _animals_section) severs into SV-10.
**Filmable beat:** a hungry villager announces a hunt, chases down a cow, and
eats — the village's first meal it earned itself.

### Sprint 11 — "The night watch" (defense arc)

| ID | Title | AC highlights | Est |
|---|---|---|---|
| SV-11 | Contract commit C | ThreatEncountered.v1; set_stance verb + SetStanceParams; DECISION_SCHEMA survivalStance (required-nullable); SELF_DEFENSE_IN_PROGRESS; WorldSnapshot nearbyHostiles + stance; leather_helmet/chestplate/leggings/boots added to CraftParams enum (armor's only acquisition path rides a contract commit); catalog rows; fixtures. NOTE: spans packages/events AND agent-service (DECISION_SCHEMA lives in contract.py) — co-updates FakeProvider._SCRIPT ("survivalStance": null) and decision-JSON test fixtures in the SAME commit (the M2-7 governanceAction precedent) | S |
| SV-11.5 | Skeleton-first commit | both module interfaces (threat.ts + combat.ts), ALL BotSession/executor touch points incl. set_stance wiring + the eat.ts threat-gate line, test scaffolds. Orchestrator-owned (ruling 4) | S |
| SV-12a | Watcher/episodes lane (body) | threat.ts: watcher, episode state machine, classification/decision tables, ThreatEncountered emission, episodeOpen getter, civ_threat_episodes_total; wedge + seam-matrix + episode-honesty tests | M |
| SV-12b | Maneuvers lane (body) | combat.ts: FightDriver fight + flee interiors, fleet fight cap + civ_threat_fights_active, canned cries, civ_threat_responses_total; spike GO/NO-GO decides the fight interior only | M |
| SV-13 | Threat brain | percepts (victim-only; wakes on spotted+overwhelmed); threat directive; reflect folds; survivalStance rider (brain-side ONLY: change-gated + flip hysteresis); armor affordance prose; "Dangers in sight" section; prompt tests + stance-stability case; go/no-go llama smoke ("N real decisions emit valid set_stance / correct stance under threat percepts") | M |
| SV-14 | Gear | equip-best-gear logic (weapon tier table + leather armor auto-equip, hand-rolled; armor-manager only if spike lane B earns the dep). Depends on commit C's enum entries. **Partially landed 2026-07-18 (the guard arc, SV-14-lite): armor auto-equip reflex shipped hand-rolled (`bots/armor.ts`, all four slots, any tier the pack offers); the `guard` stance + post tether shipped alongside (`bots/guardTether.ts`). Still open: leather-armor CRAFT enum (commit C), per-villager stance (the SV-13 rider — today stance is fleet-wide env), a `set_post` verb / persisted anchors (today the anchor re-captures at every spawn).** | S/M |

Night bounded windows (keepInventory on): first night window only after
SV-12a/b + SV-13 are DEPLOYED (cautious-default body first, per the deploy-order
ruling).
**Arithmetic:** 2–4 + 2–4 + 6–8 + 6–8 + 6–8 + 3–6 = 25–38h — the widest sprint
(two parallel body lanes compress wall-clock, not effort-hours); valves,
pre-committed in order: (1) SV-14 slips to Sprint 12 (→ 22–32h; Sprint 12
absorbs +3–6h), (2) night-window verification slides to Sprint 12's opening.
**Filmable beat:** dusk falls during a bounded window; a brave villager stands
his ground over a zombie while a cautious one sprints for the plaza shouting a
warning.

### Sprint 12 — "Mortality and the ceremony"

| ID | Title | AC highlights | Est |
|---|---|---|---|
| SV-15 | Contract commit D + death emission (body) | VillagerDied.v1 {villagerId, cause: string\|null, killerId: uuid\|null, position} — cause-nullability is a DELIBERATE deviation from the 03 sketch; the catalog row is amended in the same commit. Full contract machinery (fixture + invalid + task gen + catalog row — validate.mjs fails CI on fixture-less schemas). Emitted from bot.on('death'); cause enriched from an open threat episode; operator drills stamp cause='operator_drill'. Precondition: SV-5b's sanity drill passed | S |
| SV-16 | Death brain | percept (victim reactive-wake + roster broadcast as village news — civic-fanout mirror); "you died" prompt rendering; memory fold ("I died at (x,y,z)…"); respawn continuity; NO villagers.status flip (auto-respawn in seconds; status is for permanent death — documented non-use) | M |
| SV-17 | Survival observability | civ-survival.json dashboard + overview stat reading the ALREADY-SHIPPED series (civ_eat_reflex_total, civ_hunts_total, civ_threat_episodes_total / civ_threat_responses_total / civ_threat_fights_active, civ_hazard_escapes_total{hazardType,outcome}); NEW instruments only: civ_villager_food + civ_villager_health gauges (snapshot loop — the health gauge makes DoD 3 verifiable) and civ_villager_deaths_total{cause} | S/M |
| SV-18 | Rollout & ceremony | runbook FINALIZATION (authored in SV-5b; gains the easy-by-default flip + the post-nuke re-apply checklist: training-wheel gamerules + save-all + verify, bukkit.yml connection-throttle −1, difficulty-vs-rollout-stage check); easy-by-default flip (RCON + save-all + compose env + verify after a deliberate restart); staged wheel removals (mobGriefing→true after the first clean night; ceremony = keepInventory→false + filmed full cycle); controlled death drill (on PEACEFUL — /kill needs no window; designated villager, cause='operator_drill', timestamp/correlationId in HANDOFF per the pollution-fingerprint pattern; proves SV-15/16 end-to-end); soak checklist (mid-action deaths during windows + soak — ≥1 blocked-reflex death OR raising the executor ceiling (COMMAND_TIMEOUT_MAX_MS / TIMEOUT_TABLE_MAX_MS) itself triggers the interruptAction()/PREEMPTED_BY_THREAT contingency; a per-verb raise alone is clamped body-side since PR #37); HANDOFF | M |

**Arithmetic:** 2–4 + 6–8 + 3–6 + 6–8 = 17–26h; +3–6h if SV-14 slips in
(→ 20–32h); SV-9 (stretch) lands here only if SV-15/16/18 run early. Valve (a
descope, not a deferral — this is the final sprint): SV-17 dashboard polish
beyond the DoD-minimum; SV-15/16, SV-18, and the SV-17 minimum cannot slip —
they carry DoD 5/6/7.
**Filmable beat:** THE CEREMONY — Parker, on camera, removes the last wheel; the
village survives its first true night, and in the morning a villager tells a
neighbor about the night it died last week.

## Rollout staging (runbooks authored in SV-5b, finalized in SV-18)

1. **Before the first easy window** (Sprint 10, gated by SV-5b): volume backup
   with the stack STOPPED — `task down` (a file-level tar of postgres-data is
   only restore-safe with the container stopped) → PowerShell
   `docker run --rm -v` tar of minecraft-data + postgres-data + redpanda-data
   (offsets stay consistent with the ledger; Git Bash mangles -v paths) →
   `task up:all` → `task seed` (bot sessions are in-memory; the recreate drops
   the fleet). Then gamerules, closed-loop: RCON set keepInventory true /
   doInsomnia false / mobGriefing false → `save-all` → deliberate
   minecraft-container restart → RCON verify all three. A silent keepInventory
   revert would run a window effectively wheels-off — the exact failure the
   wheels exist to prevent.
2. **Bounded windows:** open = RCON-verify all three gamerules, then RCON
   `difficulty easy`; close = RCON `difficulty peaceful` → `save-all` → RCON
   verify. There is NO restart-revert failsafe — Paper autosave (~5 min) and
   graceful stop both persist the in-memory difficulty to level.dat; after any
   unplanned restart/crash during the window era, RCON-verify difficulty before
   leaving the stack unattended. Daytime windows Sprint 10 (after SV-6/SV-7
   deploy + smoke); night windows Sprint 11 (after SV-12a/b + SV-13 deploy).
3. **Easy-by-default** (Sprint 12, after death awareness lands): RCON difficulty
   easy + `save-all` + compose DIFFICULTY env edit (future worlds) + verify
   after a deliberate restart. Any later `task nuke` runs SV-18's post-nuke
   re-apply checklist (gamerules + connection-throttle −1 + difficulty-stage
   check — a nuked world otherwise boots easy with DEFAULT gamerules and
   throttle 4000).
4. **Backup again before the ceremony** (same stopped-stack procedure).
   Ceremony (Parker, on camera): keepInventory→false, full night/day cycle,
   zero deaths. Never a session side effect.
5. **Episode 2 filming flag — WAIVED by Parker, 2026-07-17** (recorded in
   HANDOFF): Episode 2 filming is skipped; Survival deploys proceed unfilmed
   (SV-3 was the first). Original gate, kept for the record: film BEFORE
   Sprint 9's first deploy (every arc deploy restarts minecraft-service +
   reseeds the fleet; never deploy mid-election). Preconditions per HANDOFF:
   REMOVE the live COMMUNITY_GOAL line from .env + restart agent-service; the
   filmed election is a RE-ELECTION (Bram is seated) unless a nuke — with its
   re-apply checklist — precedes it.

## Cluster Definition of Done

1. Craft chain organic & ledger-provable: log→planks→table→tool→sword via real
   deliberation (causation chains, no operator commands).
2. Hunger noticed → acted on, proven per leg on one villager's timeline (a
   single correlation trail is impossible by design — each tick mints its own
   correlationId; routine eats are ledger-silent per the eat brief): (a) the
   hunger directive era active (civ_villager_food < 10, or a staged
   HazardEncountered{starvation, trapped} whose reactive-wake DecisionMade
   carries causationId = the hazard eventId); (b) a hunt DecisionMade →
   ActionRequested → ResourceGathered chain on its tick's correlation trail;
   (c) if SV-9 shipped, a cook ActionCompleted consuming the raw drop on its own
   trail; (d) the eat leg witnessed by a civ_eat_reflex_total{outcome=
   ate|ate_desperate} increment + food recovery in the next snapshots — or the
   starvation episode's HazardEncountered{phase:escaped} as ledger evidence.
   All legs, same villagerId, one bounded window.
3. Eat reflex: measured restoration events; zero starvation-floor incidents —
   no civ_villager_health sample ≤10 HP with concurrent civ_villager_food==0
   across the final verification cycle.
4. Threats: ≥1 fought-off and ≥1 fled episode in the ledger with percepts and
   memories formed (coords included).
5. Death awareness: the drill death (and any organic death) produces
   VillagerDied → percept → "I died" memory; the respawned villager keeps
   ticking.
6. THE CEREMONY: full night/day cycle on easy, wheels off (keepInventory false,
   mobGriefing true; doInsomnia false stands per ruling 3), ZERO deaths,
   live-verified + filmed.
7. All suites green including new tests; metrics/dashboards live; runbooks
   committed.

## Top risks (register matches tickets — no phantom mitigations)

| Risk | Mitigation (ticket-owned) |
|---|---|
| llama can't drive craft/hunt/stance | staged affordance prose (the 0/4→4/4 lesson); go/no-go smokes per arc: SV-4 (craft), SV-10 (hunt), SV-13 (set_stance); FakeProvider extended per contract commit |
| Event-loop pinning at 20 bots (pursuit/scan) | spike measurement FIRST; THREAT_MAX_CONCURRENT_FIGHTS=4 cap (0 = flee-only stage); watcher = one entities-map filter per pass, no sweeps |
| Reactive-cap starvation by threat wakes | caps unchanged; only spotted + overwhelmed wake; victim-only fanout |
| Mid-action deaths while busy='action' blocks reflexes | v1 no-preemption is deliberate; the executor watchdog clamps payload.timeoutMs to COMMAND_TIMEOUT_MAX_MS=60s (PR #37) so a brain-table raise alone cannot extend the lockout; SV-18 soak checklist tracks mid-action deaths; ≥1 blocked-reflex death OR raising the executor ceiling (COMMAND_TIMEOUT_MAX_MS / TIMEOUT_TABLE_MAX_MS) itself triggers the reserved interruptAction()/PREEMPTED_BY_THREAT contingency; interim lever = lower per-verb timeouts |
| Fleet churn breaks Episode 2 filming | film before Sprint 9 deploys (rollout §5, HANDOFF preconditions) |
| level.dat difficulty/gamerule surprise | closed-loop procedures (set → save-all → restart → RCON verify) in the SV-5b/SV-18 runbook; no restart-revert assumptions |
| Daytime windows still have cave mobs | accepted: keepInventory on, wheels on; windows gated on SV-6 deploy; deaths become story once SV-15/16 land |
| Passive-mob depletion by 20 hunters | diegetic brakes (adult-only via baby metadata flag, one kill per action, scarcity prose → relocation, affordance norm); civ_hunts_total is the depletion curve; breeding = named future verb |
| mineflayer-pvp unmaintained / dep smell | spike-then-exact-pin; hand-rolled FightDriver is the designed default; GO gate per §spike |
| OpenAI strict params still broken | unchanged scope; Ollama only; no key (recorded gate) |

## mineflayer-pvp spike (run at planning time; verdict below)

Throwaway branch `spike/mineflayer-pvp` (never merged). Ephemeral second Paper
container (itzg 2026.7.0-java21, temp volume, port 25566, DIFFICULTY easy) so
the canon world and ticking fleet are untouched. Protocol: (1) install
mineflayer-pvp@1.3.2 in the workspace — verify install cleanliness (the nested
mineflayer 2.x via dead mineflayer-utils; ESM/tsx load); (2) spike script: 20
bots connect; zombies spawned via RCON; perf_hooks monitorEventLoopDelay at
0/5/10/20 concurrent bot.pvp.attack pursuits (pathfinder GoalFollow active, our
tickTimeout=10); verify swings kill zombies on 1.21.6; verify stop() releases
the goal; demonstrate the goal-clobber. Lane B: armor-manager equip-on-pickup
check.

GO criteria (ALL must pass):
1. p99 event-loop delay < 50ms at 5 concurrent pursuits (measured at 0/10/20
   too);
2. after a forced watchdog-style stop (stopMoving + pvp.stop), the pathfinder
   goal reads null for ≥2 physics ticks — any re-assertion = automatic NO;
3. `npm ls mineflayer` shows exactly ONE mineflayer at the exact pin (the
   nested 2.x must be prunable via npm override) — else NO;
4. kills confirmed on 1.21.6 zombies; swing-cadence constant (~625–650ms)
   verified for the hand-roll either way;
5. hand-rolled loop kill-rate ≥70% of pvp's on a penned target → NO-GO stands
   regardless (the plugin then buys nothing worth a dep).

Opportunistic rides on the same ephemeral container: (a) difficulty-persistence
check — RCON `difficulty easy`, wait past one autosave (>5 min), graceful
restart, read back which difficulty boots (settles the rollout §2 model on THIS
stack); (b) nearest-entity distance logging from one bot (validates the
~48-block tracking-range assumption behind hunt maxDistance=32 and
THREAT_ALERT_RADIUS=24); (c) spawn a baby cow and log entity.metadata +
metadataKeys (pins the baby-flag index for SV-8).

### Spike results (2026-07-11) — **VERDICT: NO-GO. Hand-rolled FightDriver ships.**

Run on the ephemeral container (Paper 1.21.6, itzg 2026.7.0-java21, port 25566),
20 bots in one Node process, `tickTimeout=10` (production parity), stone swords,
AI zombies summoned server-relative (`execute at <bot> run summon …`), 20s
measurement windows via `perf_hooks.monitorEventLoopDelay` (10ms resolution —
the ~15ms idle mean is sampler floor; read the deltas and tails).

| Phase | mean | p99 | max | kills |
|---|---|---|---|---|
| 20 bots idle (baseline) | 15.8ms | 24.9ms | 55.7ms | — |
| 5 concurrent pursuits | 16.5ms | **38.8ms** | 79.7ms | 5/5 |
| 10 concurrent pursuits | 17.7ms | 47.1ms | 280.0ms | 10/10 |
| 20 concurrent pursuits | 19.3ms | **141.8ms** | 427.6ms | 20/20 |

GO-criteria scorecard:
1. **p99 < 50ms at 5 pursuits: PASS** (38.8ms) — but 20 concurrent at p99 142ms
   / max 428ms hard-validates THREAT_MAX_CONCURRENT_FIGHTS=4 regardless of
   implementation (the cost is pathfinder pursuit, not the plugin).
2. **Goal release: FAIL in spirit.** After `stopMoving()` alone (the executor
   watchdog's only cancel lever today), the pathfinder goal stays null — pvp
   does NOT re-assert it — but **pvp kept swinging (3 attacks in the next 2s)**;
   only `pvp.stop()` + setGoal(null) silences it fully. Adopting the plugin
   would require extending stopMoving() with `bot.pvp?.stop()` — a real seam
   cost the hand-roll doesn't have.
3. **Single mineflayer at the pin: FAIL — automatic NO.** As installed,
   mineflayer-utils@0.1.4 nests a duplicate mineflayer@2.41.0. The npm override
   (`{"mineflayer-utils": {"mineflayer": "4.37.1"}}`) either leaves the nested
   copy in place flagged `invalid` (existing lockfile) or, on a regenerated
   lockfile, drops mineflayer-utils entirely and **mineflayer-pvp then fails at
   require time** (`Cannot find module 'mineflayer-utils'` from lib/PVP.js).
   Not cleanly prunable.
4. **Kills on 1.21.6: PASS** (35/35 across the ladder; NoAI time-to-kill with a
   stone sword ~4–5s at 650ms swing spacing — consistent with full-charge
   damage, validating the hand-roll's SWING_INTERVAL_MS=650).
5. **Hand-roll ≥70% of pvp: PASS at ~101%** (NoAI penned-proxy TTK — pvp
   5009/5022/4042ms vs hand-rolled 3009/5299/5540ms) — the plugin buys nothing
   worth a dependency. **NO-GO stands on this criterion alone.**

Goal-clobber demonstrated: an executor-style GoalNear was replaced by pvp's
GoalFollow on attack() — the busy-seam gating requirement is real for ANY
combat implementation.

Opportunistic rides:
- **(a) Difficulty persistence:** RCON `difficulty peaceful` on an
  env-seeded-easy world, 6-min wait (past one autosave), graceful
  `docker restart` → the world booted **peaceful** — the runtime RCON change
  PERSISTED with no explicit save-all, AND it beat the container's still-set
  `DIFFICULTY=easy` env, confirming level.dat overrides env on boot for
  existing worlds. Confirms rollout §2 on this stack: there is NO
  restart-revert failsafe; explicit revert + save-all + verify is the only
  trustworthy window close.
- **(b) Entity tracking range:** zombies summoned at 16/32/48/64 blocks were
  ALL tracked in bot.entities under our view settings — tracking reaches ≥64,
  farther than the assumed ~48. Hunt maxDistance default 32 stands as a
  chase-budget choice (not a sight limit); THREAT_ALERT_RADIUS=24 has ample
  sensing headroom.
- **(c) Baby metadata:** minecraft-data 1.21.6 metadataKeys for cow includes
  `baby` at **index 16**; a summoned calf reads `entity.metadata[16] === true`,
  an adult undefined — while `entity.height` is **1.4 for BOTH** (never
  rescaled), empirically confirming the metadata flag as the only working baby
  exclusion (SV-8).
- **Lane B (armor-manager 2.0.1):** loads and `equipAll()` correctly equips a
  leather chestplate on 1.21.6 (torso slot verified). It works — but naive
  selection + one more dependency doesn't beat ~15 hand-rolled lines (SV-14
  ships hand-rolled; armor-manager stays a non-adopted known-good fallback).
- Entity classification double-check: summoned zombie reads `name='zombie'`,
  `type='hostile'`, `kind='Hostile mobs'` — the watcher's filter is confirmed
  on the wire.

Spike artifacts: branch `spike/mineflayer-pvp` (scripts/spike-pvp.mjs,
spike-pvp2.mjs, spike-pvp-debug.mjs + the dependency/lockfile changes). Never
merged; the branch exists for reproducibility.

## Explicit non-goals (the scope gate)

No beds/sleep (ruling 3 — cluster+1); no mining/iron tier (tools cap at stone,
armor at leather); no bows/ranged combat; no shields-first-class (a craft-cluster
follow-up); no breeding/farms (named future verb); no preemption of running
actions (reserved contingency, soak-gated); no new analytics/BFF services; no
OpenAI runs (strict-params reshape is a separate pre-OpenAI gate); no
conversation protocol; no building; no vision; no live codegen.
