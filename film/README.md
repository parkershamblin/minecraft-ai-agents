# film/ — everything the cut needs

The ADR's artifact is a 2–3 minute captioned video (`docs/demo-rb.md` is
the shot script). Division of labor per the ADR: **Parker cuts, the
captions are provided**. This directory is the complete asset pack.

## The reference take (filmed live by Parker, 2026-07-18)

Attempt `019f744d-471a-70bd-819d-bb9eec22bd72`, label `flagship-take-1` —
Normal difficulty, hostiles on, won by **blue/Fen in 11:00.6**, honest-race
CLEAN, zero deaths. Receipt:

```sh
curl "localhost:8081/events?aggregate-type=Attempt&aggregate-id=019f744d-471a-70bd-819d-bb9eec22bd72"
```

## Assets

| File | What |
|---|---|
| `flagship-take-1.srt` | Caption track, timecoded to the RACE CLOCK (00:00 = the harness line "attempt … STARTED"). Sync Parker's OBS recording to that moment and the beats land on the ledger's real timestamps. |
| `rb-flagship-take-1-replay.mp4` | 144s ledger-rendered replay of the same attempt (intro → live team ladders → win card → honesty outro). B-roll / scoreboard layer / social cut. |
| `pov-grid.html` | Six-pane POV film rig — **DO NOT USE on MC 1.21.6** (prismarine-viewer 1.33.0 packet crash is fleet-lethal; see demo-rb.md). Kept for upstream catch-up. |

## Race-clock beat sheet (ledger-derived, this take)

| Race clock | Beat |
|---|---|
| 0:00 | Attempt started — both teams at forest posts, packs empty |
| 3:47 | red first_coal |
| 4:14 | blue first_coal |
| 7:41 | blue first_iron_ore |
| 8:46 | red first_iron_ore |
| 9:00 | blue furnace_placed |
| 10:45 | blue first_ingot + **iron_pickaxe — the win** (one craft) |
| 11:00 | AttemptEnded, honest `{0,0}` |

Alternate takes with receipts if the cut wants variety: Easy record
`019f7337` (6:00.4, red/Elara) · Normal mob-free `019f7352` (14:41,
red/Wren) · the guard-fleet take `019f76be` (14:01, blue/Fen, fights on
the ladder). One command reruns a fresh race: see `docs/demo-rb.md`.
