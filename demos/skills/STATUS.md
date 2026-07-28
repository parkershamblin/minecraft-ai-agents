# Skill demo gate — status

Serialized OBS demo per merged unit. Owner reviews each clip and checks the
unit off; the next demo runs only after check-off. All 13 unit PRs (#96-#108)
are MERGED into demo-sprint; suite 719 green on the union.

| Unit | Demo | Status | Clip | Check-off |
|------|------|--------|------|-----------|
| U13 Tier 1 reflexes | auto-eat + armor on live world | APPROVED | u13-tier1-reflexes/out.mp4 (95s, take 3) | [x] 2026-07-28 |
| U1 mineBlock | real primitive mines 4 oak on live world | APPROVED | u1-mineBlock/out.mp4 (62s) | [x] 2026-07-28 |
| U2 craftItem+placeItem | logs->planks->table PLACED->sticks->pickaxe | APPROVED | u2-craft-place/out.mp4 (75s) | [x] 2026-07-28 |
| U3 smeltItem+useChest | stations placed, 3 iron smelted (polled), chest cycle + honest partial | APPROVED | u3-smelt-chest/out.mp4 (100s) | [x] 2026-07-28 |
| U4 killMob | 3/3 pig hunts via live bot.pvp, staged in cam foreground | APPROVED | u4-killMob/out.mp4 (74s) | [x] 2026-07-28 |
| U5 exploreUntil+giveback | re-shot: full arc, recovered:true | APPROVED | u5-explore-giveback/out.mp4 (62s) | [x] 2026-07-28 |
| U6 wood tier | composed skills over live primitives; live-gate bug found+fixed | APPROVED | u6-wood-tier/out.mp4 (85s) | [x] 2026-07-28 |
| U7 stone tier | tool-gated cobble mining, stone pickaxe+sword at the table | APPROVED | u7-stone-tier/out.mp4 (90s) | [x] 2026-07-28 |
| U8 ore+smelt tier | THE RACE CHAIN: iron mined->furnace self-built->3 smelted->iron pickaxe | **DEMO-READY** | u8-ore-smelt/out.mp4 (164s) | [ ] |
| U9 food+combat | | QUEUED | — | [ ] |
| U11 mastery stats | terminal demo over real ledger seed | QUEUED | — | [ ] |
| U12 mastery policy | terminal demo over U11 output | QUEUED | — | [ ] |
| U10 design doc | no demo (doc-only) | N/A | — | merged |

Notes:
- U13 auto-eat PROVEN on camera (threshold-exact trigger, five eat cycles,
  zero tokens). Armor-manager evidence inconclusive this take (null item names
  in the slot log) — re-take on request, or accept eat-only.
- Primitives/skills demos (U1-U9) need assembly deps wiring in
  scripts/skill-drill.mjs (real mineflayer implementations of each deps
  interface) — built incrementally per demo, next up after U13 check-off.
- Stack lock: demos/.stack.lock held during takes, released between.
