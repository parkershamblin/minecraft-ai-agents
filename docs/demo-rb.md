# Red vs Blue — demo shot script (RB-3)

The artifact: a **2–3 minute captioned video** of a 3v3 LLM-villager race to
the first crafted iron pickaxe. Every claim in the captions is backed by the
event ledger; the honest-race assertion (zero fake-provider decisions, budget
breaker never tripped) is recorded in `AttemptEnded.honestRace`, not asserted
in post.

## The one-command take

```powershell
node scripts/race-rb2.mjs --label flagship-take-N --difficulty easy   # or normal, per the soak
```

The harness executes and VERIFIES the whole checklist (gamerules, difficulty,
throttle, budget, tick, rosters, far forest posts, cleared packs, anchored
spawnpoints), stamps `AttemptStarted`, and narrates milestones as they land.
Exit 0 = won. Best-of-N is cheap: each take is one command and ends itself
(win or 75-minute stall watchdog). The watcher survives service hiccups and
retries the receipt (#47).

**The reference takes** (both 2026-07-18, honest `{0,0}`, zero intervention):

- **Easy, mob-free** — attempt `019f7337-977e-738e-8d5a-bf8e1db77439`,
  red/Elara, **360.4s**: coal 2m → blue coal 3m → iron ore 4m → furnace 5m
  → ingot + pickaxe 6m.
- **Normal, mob-free** — attempt `019f7352-03ae-716b-b4df-1da76bb8c9d8`,
  red/Wren, **881s**: BLUE led coal (1m53s) and iron ore (4m15s); red
  converted furnace 8m31s → 3 ingots + pickaxe 14m20s. The flagship
  difficulty, no fallback needed. Decision mix at the 10s race tick:
  zero hunt, 4 move, every gather count ≥3 (the #47-era discipline).

## Screens to capture (separate takes are fine — the ledger is the sync track)

1. **The scoreboard** — `http://localhost:3000/race`. Two team ladders, live
   milestone feed, win banner. This is the product shot; OBS-capture the tab.
2. **In-world POV** — spectate in the vanilla client (`/gamemode spectator`),
   shadowing whichever villager the feed says is moving. The milestone feed
   timestamps tell you exactly when/where the beats happened for the cut.
2b. **The POV grid** — `film/pov-grid.html` + `POV_VIEWER=1`: **DO NOT USE
   on MC 1.21.6.** Live-verified 2026-07-18: prismarine-viewer 1.33.0's
   bundled protocol data predates 1.21.6 ("partial packet: world_particles"
   on the `trail` particle) and the crash takes the whole minecraft-service
   process — fleet-lethal. The rig code stays (flag-off, tested) for when
   upstream catches up; film shot 2 with the vanilla spectator client.
3. **The ledger receipt** — terminal shot of the harness output ending in
   `RACE WON — honest-race assertion: CLEAN`, or:
   ```
   curl "localhost:8081/events?aggregate-type=Attempt&aggregate-id=<id>"
   ```

## Caption beats (map to ledger events)

| Beat | Evidence |
|---|---|
| "Six villagers, two teams, one goal — first crafted iron pickaxe wins" | `AttemptStarted` (roster + difficulty embedded) |
| "No scripts. Each villager thinks with a local LLM every 20 seconds" | `DecisionMade` stream; `civ_llm_latency_seconds` (ollama) |
| "The wood age: axes are free, ores are gated" | `TOOL_TIER_REQUIRED` failures teaching the ladder |
| "First coal / first iron" | `ProgressionMilestone{first_coal, first_iron_ore}` |
| "One craft: the body places the furnace, smelts, and finishes the pickaxe" | the winning `ActionCompleted{crafted:1, smelted:3}` — three milestones, one causationId |
| "Verified honest: zero scripted decisions, judged from an append-only ledger" | `AttemptEnded{honestRace: {0,0}, winningEventId}` |

## Numbers for the resume bullets (each with its reproducing command)

- End-to-end drill + race machinery: `node scripts/drill-rb1.mjs` (T1 ladder
  in the ledger, replayable by attemptId).
- Ollama throughput at race cadence: 6 bots × 20s tick, ~1.7s mean
  deliberation latency (`civ_llm_latency_seconds` sum/count), zero tick errors.
- Honest-race deltas: read from Prometheus by the harness, recorded in
  `AttemptEnded` — never asserted by hand.

## The ledger-rendered replay (exists today)

`film/rb-flagship-replay.mp4` — a 2m24s captioned film of the flagship win
(`rb2-normal-mobs-1`, blue/Petra, Normal + hostiles), rendered ENTIRELY from
the attempt's ledger slice: animated team ladders, the milestone feed with
real race-clock timestamps, the caption beats above, and the win card with
the receipt ids. No screen capture, no editing — regenerate for any attempt:

```sh
curl "localhost:8081/events?aggregate-type=Attempt&aggregate-id=<id>&limit=50" > slice.json
uv run --with pillow --with imageio --with imageio-ffmpeg --with numpy \
  python scripts/render-race-film.py slice.json film/out.mp4
```

## Post

The replay film IS the honest-race artifact. Parker's cinematic cut (OBS
scoreboard + spectator footage, captions from this table) layers on top when
wanted; practice takes on easy/peaceful knobs, flagship at Normal + mobs
(proven raceable, 3-for-3 on 2026-07-18).
