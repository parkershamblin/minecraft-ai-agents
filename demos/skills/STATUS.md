# Skill demo gate — status

Serialized OBS demo per merged unit. Owner reviews each clip and checks the
unit off; the next demo runs only after check-off. All 13 unit PRs (#96-#108)
are MERGED into demo-sprint; suite 719 green on the union.

| Unit | Demo | Status | Clip | Check-off |
|------|------|--------|------|-----------|
| U13 Tier 1 reflexes | auto-eat + armor on live world | **DEMO-READY** | u13-tier1-reflexes/out.mp4 (110s) | [ ] |
| U1 mineBlock | pending U13 check-off | QUEUED | — | [ ] |
| U2 craftItem+placeItem | | QUEUED | — | [ ] |
| U3 smeltItem+useChest | | QUEUED | — | [ ] |
| U4 killMob | | QUEUED | — | [ ] |
| U5 exploreUntil | | QUEUED | — | [ ] |
| U6 wood tier | | QUEUED | — | [ ] |
| U7 stone tier | | QUEUED | — | [ ] |
| U8 ore+smelt tier | | QUEUED | — | [ ] |
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
