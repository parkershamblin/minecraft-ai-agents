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
(win or 45-minute stall watchdog).

## Screens to capture (separate takes are fine — the ledger is the sync track)

1. **The scoreboard** — `http://localhost:3000/race`. Two team ladders, live
   milestone feed, win banner. This is the product shot; OBS-capture the tab.
2. **In-world POV** — spectate in the vanilla client (`/gamemode spectator`),
   shadowing whichever villager the feed says is moving. The milestone feed
   timestamps tell you exactly when/where the beats happened for the cut.
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

## Post

Parker cuts; captions from this table. Practice takes on easy/peaceful knobs;
flagship at the ADR-pinned difficulty (or the pre-authorized fallback with
soak numbers cited).
