# Skill-chain benchmark — the ported library on the race course (2026-07-28)

**Method.** The T1 race course (spawn -> wood -> stone -> iron pickaxe) run by
the PORTED SKILLS ALONE through the assembled registry
(`scripts/skill-bench.ts`): cold start per run — fresh forest-area spot via
spreadplayers, EMPTY inventory, no staged materials, zero LLM calls, zero RCON
gifts mid-run. Two sweeps of N=3 (wood ask 3, then 4). A prospecting fallback
(exploreUntil with a find-predicate, then retry the miner) stood ready for the
iron tier. Raw data: `skill-bench-1785260578585.json`, `skill-bench-1785260789367.json`
(the first file, `...305019.json`, is 3 runs voided by a staging race — bot
benched before teleport landed; kept for the record, excluded from analysis).

**Result: 0/6 wins.** No run reached the iron tier. Deepest run: full wood +
stone gear (sweep 1 run 3), died walking to a cliff-top crafting table.

| Sweep.run | End | Detail |
|---|---|---|
| 1.1 | wpick:PATH_NOT_FOUND | craftPlanks mine-recovery couldn't path to remaining oak (canopy) |
| 1.2 | wood:RESOURCE_NOT_FOUND | spawn landed treeless (honest scan, all 10 species tried) |
| 1.3 | spick:PATH_NOT_FOUND | reused own earlier table at (-384,79,-220) — cliff, 20s walk budget burned |
| 2.1 | wood:PATH_NOT_FOUND | collected 1 of 4 oak — remaining canopy logs unreachable |
| 2.2 | wpick:PLACE_FAILED | default table cell (+x of bot) had no reference block — mid-air |
| 2.3 | wood:RESOURCE_NOT_FOUND | treeless spawn again |

**Failure taxonomy (the library's refinement queue, from data):**
1. **Wood-tier vertical pathing** (3/6 runs): mineBlock paths with
   GoalLookAtBlock only — no towering/scaffold behavior for canopy logs.
   Voyager leaned on its patched collectblock for exactly this. Fix: route log
   mining through mineflayer-collectblock (pinned, loaded, unused by the
   adapter) or scaffold-enabled Movements for log targets.
2. **Table placement/discovery** (2/6): craftWoodenPickaxe's default
   tablePosition (+x of bot) is unvalidated (mid-air PLACE_FAILED), and
   craftItem's findCraftingTable(32) is distance/reach-blind — it walked at a
   cliff-top table instead of placing a fresh one. Fix: ground-cell scan for
   the default position; prefer place-near over distant reuse (or a
   reachability probe before committing the 20s walk).
3. **Drop-loss vs reported count** (1/6): mineWoodLog reported collected 3
   while the pack held fewer — composed callers then fail downstream.
   Fix: inventory-delta verification in the outcome (assembly adapter note).
4. **Spawn terrain sensitivity** (2/6): a third of spreadplayers spots were
   treeless. Callers need a biome/tree precheck or a roam-first beat — or the
   deliberation layer simply picks where to stand (which is its job).

**Context.** The individual skills all proved live in the 11-demo gate; the
LLM-driven executor fleet wins this course in ~650-1180s (v7 model table).
The composed chain WITHOUT deliberation fails on navigation-heavy glue —
which is precisely the division of labor the architecture predicts: skills
execute, the deliberator picks where/when/what-order. The prospecting
fallback was never reached (wood-tier gate). Nothing was tuned to force a
win; the taxonomy above IS the artifact, and it feeds the unit-11/12 mastery
machinery directly (the bench emits SkillInvocationRecords via the registry).

**Zero API spend.** All local: mineflayer + Paper + the ported library.
