---
name: mineflayer-runtime
description: Use when writing or changing code in services/minecraft-service — BotSession.ts, actions/executor.ts, skills/{adapters,registry,names}.ts, world/{resources,skillVerbs,humanInventory}.ts, watchers/reflexes, plugin wiring, or adding/altering an action verb. Delivers the event-loop, watchdog, world-verify, naming, and failure-code doctrine with repo-verified symbols and a new-verb checklist.
---

## When to use / when not

Use for any code change inside `services/minecraft-service`: bot loops and
watchers, the command executor, skill adapters/registry, inventory or world
reads, plugins, or a new/changed action verb's BODY side. NOT for the
schema-side seams of a verb (schema, fixtures, contract.py, prompts — see the
contract-change skill), RCON probe grammar against the live world (see the
live-forensics skill), test-authoring doctrine (see the regression-test
skill), or deploying the result (see the deploy-service skill).

## 1. Event-loop cost doctrine

`findBlocks`/entity sweeps are CLIENT-side: they never cost Paper MSPT, they
cost the one Node thread that executes every bot's commands and Kafka
heartbeats (ungated 5s scans × 20 bots pinned a core, per CLAUDE.md).

- [ ] New periodic observation goes on its own `setInterval`, never inside the
      1s snapshot pass (`startResourceScan` in `src/bots/BotSession.ts` is the
      model).
- [ ] The interval is only the CHECK cadence — gate the expensive body behind
      `shouldRescan` (`src/world/resources.ts`): movement ≥
      `RESOURCE_SCAN_MOVE_BLOCKS` OR age ≥ `RESOURCE_SCAN_MAX_AGE_MS`, with the
      `RESOURCE_SCAN_MIN_SWEEP_MS` hard floor (all in `src/config.ts`).
- [ ] Busy gate: skip when `this.busy !== null || threatWatcher?.episodeOpen ||
      hazardWatcher?.trapped` — surveys exist FOR deliberation.
- [ ] Y-band every 3D sphere scan (`HOSTILE_Y_BAND` 8, `RESOURCE_SCAN_Y_BAND`
      16) — no line-of-sight check exists; the village sits over caves. The
      resource band is a POST-filter (`findBlocks` returns position-less
      palette hits): double the count cap, recompute `nearestDistance`.
- [ ] Watcher passes stay O(1): scalar reads or one `Object.values(bot.entities)`
      filter; expensive maneuvers run raced-with-deadline INSIDE the watcher.
- [ ] Wrap sweep bodies in try/catch (a mid-chunk-unload race kills the timer);
      first scan waits one interval after spawn (unloaded columns read empty).

Before touching pathfinder/physics hot paths, profile the LIVE container
(header of `scripts/profile/capture.cjs` carries the full flow):

```powershell
$CTR = "ai-civilization-engine-minecraft-service-1"
docker cp scripts/profile/capture.cjs ${CTR}:/tmp/capture.cjs
docker cp scripts/profile/analyze.cjs ${CTR}:/tmp/analyze.cjs
# PID 1 is npm — find the real node PID (tsx loader):
docker exec $CTR sh -c 'for p in /proc/[0-9]*; do c=$(tr "\0" " " < $p/cmdline 2>/dev/null); case "$c" in /usr/local/bin/node*) echo ${p#/proc/};; esac; done'
docker exec $CTR sh -c 'kill -USR1 <pid>'   # inspector on :9229, no restart
docker exec $CTR node /tmp/capture.cjs 75 /tmp/mc.cpuprofile
docker exec $CTR node /tmp/analyze.cjs /tmp/mc.cpuprofile   # 'detach' as 4th capture arg on the LAST capture
```

The ONLY sanctioned block cache is the turn-scoped one around
`bot.physics.simulatePlayer` (`src/bots/physicsSimCache.ts`, gated by
`PHYSICS_SIM_BLOCK_CACHE`, cleared by `setImmediate`). NEVER cache at
`bot.blockAt`: pathfinder's `movements.getBlock` mutates returned blocks with
query-relative fields — aliasing corrupts A*.

## 2. Watchdog doctrine

- Promise.race EVERY action against its watchdog; never `await` an action
  promise raw — a pathfinder promise never settles on a dead connection, and
  one pending promise freezes every bot behind the single-partition topic.
- The `settled` latch in `CommandExecutor` (`src/actions/executor.ts`)
  guarantees exactly one outcome; `busy` releases in `finally` even on
  timeout; the action closure handles BOTH outcomes so a late settle never
  becomes an unhandled rejection.
- `timeoutMs` is capped at `maxTimeoutMs` (`COMMAND_TIMEOUT_MAX_MS`, 60s) so
  one oversized ask cannot pin the lane. One layer down, every skill-adapter
  goto is `racedGoto` (`src/skills/adapters.ts`) with its own timeout.
- Code after an awaited walk is NOT guaranteed to run (the watchdog abandons
  the promise): persist must-survive state BEFORE the walk and read it at the
  START of the next attempt (`lastGatherAttempt` in BotSession).
- Long internal loops (smelt polling, gather sessions, craft flow) poll
  `bodyStillOurs` (`this.busy === 'action'`) as their abandonment signal so a
  zombie stops touching the world after timeout.
- Every long verb needs a cancel lever the watchdog can pull: `stopMoving`;
  hunt also flips `huntAbandon.abandoned`, polled by the kill loop.

## 3. World-verify and inventory truth

Never believe the client:

- **place**: `placeBlock` can throw ("blockUpdate did not fire") when the
  block DID land, and the server can silently reject. Pattern (`placeCarried`
  in BotSession): swallow the throw, wait ~1s, `blockAt`-verify the cell,
  fail only on the world's verdict. Interactive blocks (`INTERACTIVE_GROUND`
  set: crafting_table, furnace, chest, …) are OFF the placement-ground list —
  right-clicking one opens it.
- **dig/kill yield**: report the inventory DELTA against a pre-snapshot keyed
  to the dug block's real drop (`DROP_OF` map in adapters.ts: iron_ore →
  raw_iron), never a bare playerCollect counter (dirt counted as ore in the
  demo gate). Zero-delta completions are failures for bookkeeping — do NOT
  clear the blacklist mark.
- **post-craft**: sleep `CRAFT_SETTLE_MS` (600ms) before reading counts —
  inventory packets land async.
- **human inventory over RCON**: `fetchHumanInventoryStable`
  (`src/world/humanInventory.ts`) — two passes, accept only identical;
  validate the username against `/^[A-Za-z0-9_]{1,16}$/` first. Probe grammar
  details: see the live-forensics skill.
- **body swaps**: every spawn (connect AND death-respawn) bumps the
  process-global `spawnGeneration`; delta trackers re-baseline on it.
  `stopSnapshots` forgets everything positional on end (survey, watchers,
  `lastSnapshotWrite`) and despawn deletes the Redis snapshot key.
- `planHarvest`'s `canHarvest` gate runs BEFORE the walk (fail fast with
  `TOOL_REQUIRED`/`TOOL_TIER_REQUIRED`) and AGAIN at the dig site — the
  pathfinder re-equips en route.

## 4. Names come from bot.registry

All name→id resolution goes through `guardedItem`/`guardedBlock`
(`src/skills/names.ts`): throw-free, alias-aware (`NAME_ALIASES`), returns
`UNSUPPORTED_NAME` — Voyager-era bare `mcData.itemsByName[x].id` throws on
renamed keys. Resolve against `bot.registry` (the negotiated minecraft-data)
so body and skill library can never disagree. The skill registry is built
LAZILY in `requireSkills()` (registry is only populated after login) and set
to null in `connect()` — adapters close over the OLD bot, and keeping them
past a reconnect aims every skill at a dead connection.

Three name-family sources exist and are KNOWN to diverge: `RESOURCE_BLOCKS`
(`src/world/resources.ts`, wood = 8 logs ending at cherry_log), `WOOD_LOGS`
(`src/skills/names.ts`, 10 — adds pale_oak_log, bamboo_block), and
`STORAGE_FAMILIES` (`src/world/skillVerbs.ts`, derives from RESOURCE_BLOCKS
and inherits its gap). Touching any family: reconcile all three or state why
not; the food family does it right (resolves live against registry foods).

## 5. Failure codes, retryability, messages

- Codes come from the CLOSED `SkillFailureCode` union (`src/skills/types.ts`)
  — never invent strings outside it (silent-escape codes are how SUPERSEDED
  shipped onto the wire before the schema knew it).
- Retryability is ruled ONCE in `RETRYABLE_BY_CODE` (`src/world/skillVerbs.ts`)
  by one question: would the IDENTICAL command plausibly succeed later with
  the villager doing nothing differently? World-state gaps yes; pack/knowledge
  gaps no.
- The message is the villager's next percept, passed through UNTOUCHED
  (`runSkillVerb` in executor.ts): name what was searched, from where, and the
  concrete ask that could land differently — bare messages taught learned
  helplessness in M1.
- An UNCODED throw stays uncaught — wrapping it in a tidy code hides a real
  bug behind an honest-looking percept (pinned in executor.test.ts).
- New failure mode: add the code to `SkillFailureCode` AND the ActionFailed
  schema enum in the SAME PR (see the contract-change skill), plus its
  `RETRYABLE_BY_CODE` row and the `ALL_FAILURE_CODES` mirror in
  `src/skills/stats.ts` (exhaustiveness-checked).

## 6. Executor invariants

- **Latest-intent-wins**: a new command supersedes only a WAITING one (exactly
  one `ActionFailed{SUPERSEDED}` each), never a RUNNING one, never
  `LIFECYCLE_ACTIONS` (spawn/despawn — dropping a spawn left Bram and Ansel
  bodiless forever). Any new verb that creates/destroys the body joins
  `LIFECYCLE_ACTIONS` in the same PR.
- **Re-clamp every wire numeric** even when the schema enum already bounds it:
  `clampRange` 1..8, `clampStack` 1..16, gather maxDistance 4..64 / count
  1..8, hunt 4..48, far-move gate at `MOVE_MAX_DISTANCE`. The range clamp is
  physics knowledge: a pathfinder GoalNear already-within-range is satisfied
  instantly, so an oversized range CANCELS the walk and still reports success
  (the v8 no-op-move class).
- **Busy seam**: one `BusyState` field arbitrates the body. Executor claims
  `'action'` before any await, releases in `finally`; reflexes claim their own
  states and mid-reflex commands fast-fail via the `BUSY_BOUNCE` table with
  honest named codes. Below-deliberation plugin reflexes (auto-eat,
  armor-manager) never claim the seam.

## 7. Blacklist doctrine (gather targets)

Mark BEFORE the attempt, clear only on a REAL haul (delta > 0) — never on
mere completion (ghost digs). Failed standpoints blacklist the REGION
(`UNREACHABLE_REGION_RADIUS` 8 — per-block marks cannot escape a tree);
region marks are facts about a standpoint, so `clearRegionMarks` once the
body has actually moved, keeping per-block marks. Marks expire
(`GATHER_TARGET_BLACKLIST_MS` 10 min). Relocation is hard-capped
(`RELOCATE_TIMEOUT_MS` 20s, raced) and validated offline by replaying real
mute-run coordinates in `test/relocationReplay.test.ts` before spending GPU.

## 8. Plugin wiring and skill-adapter walk hygiene

- Routing DECISION lives in the pure, botless `resolveReflexRouting`
  (`src/bots/reflexRouting.ts`); `BotSession` only obeys the booleans and is
  the ONLY loadPlugin site. Each plugin gated by a `PLUGIN_*` flag (default
  1); 0 restores the hand-rolled watcher (EatWatcher/ArmorWatcher) unchanged.
  Configure plugins post-spawn (`autoEat.options.startAt`), not at wire time.
  Mineflayer plugins are CJS — default-import then destructure; the `plugin`
  shape varies per package. Keep `import './kafka/codecs.ts'` FIRST in
  index.ts (kafkajs has no built-in snappy).
- Adapter walks: short-circuit GoalLookAtBlock within `REACH_GUARD_DISTANCE`
  (4 — it wedges point-blank); bound per-drop walks at `DROP_WALK_TIMEOUT_MS`
  (8s); walk to the dug cell BEFORE sweeping for drops; `findCraftingTable`
  clamps to min(maxDistance, 12) and |dy| ≤ 4; retry a PLACE_FAILED once at a
  validated `findGroundCell` (LLM/default positions can be mid-air).

## 9. New-verb executor checklist (body side)

- [ ] Dispatch case with every numeric re-clamped (mirror the contract
      defaults in a comment, as gather/hunt do).
- [ ] Coded errors via `runSkillVerb` or the craft-catch shape; RETRYABLE row.
- [ ] `timeoutMessage()` case — prose that teaches the smaller retry.
- [ ] Cancel lever for the watchdog + `bodyStillOurs` polling in long loops.
- [ ] `LIFECYCLE_ACTIONS` membership decided explicitly.
- [ ] executor.test.ts cases copied from the nearest verb (clamp bounds,
      prescriptive-prose pass-through, timeout prose, busy bounce).
- [ ] Schema-side seams: see the contract-change skill (same PR).

## Verification

```powershell
npm test --workspace @civ/minecraft-service        # full suite (vitest)
npm run typecheck --workspace @civ/minecraft-service  # task test does NOT run tsc here
npm test --workspace @civ/minecraft-service -- test/executor.test.ts  # watchdog/supersede/clamp pins
task test                                          # cross-service gate before PR
task smoke                                         # only if the mineflayer pin moved
```

Prove the doctrine held: new loops show a skip gate + busy gate in the diff;
new verbs appear in `timeoutMessage`, `RETRYABLE_BY_CODE`, and executor.test.ts;
grep the diff for `blockAt(` after any place/dig (world-verify present); and
`git grep -n "itemsByName\[" -- src/skills` returns only names.ts plus the one
known throw-free hit in adapters.ts (the DROP_OF dropId lookup).
