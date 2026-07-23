# Session Handoff — PERCEPTION HARDENED (PR #71) · race validated · film when ready

## Session 2026-07-22/23 (twelfth) — the snappy batch that blinded the fleet

**Parker's brief: fix the race-brain regression (zero-milestone races,
phantom `iron_pickaxe_race` elections) + the orphaned-attempt class.**
Root cause was never prompting: a Mission-Control test replayed old
attempt events onto `world.events` via `rpk produce` (snappy by
default); aiokafka had no snappy codec, so the percept consumer's
unsupervised `create_task` died with `UnsupportedCodecError` at
world.events p5@56640 — deterministically on every boot since ~18:40Z,
while the consumer object's heartbeats kept the group Stable. Frozen
offsets, zero logs, brains blind: no percepts, no race sections
(AttemptStarted for the evening races sat thousands of offsets past the
wedge), gather discipline collapsed (win window gather 62/craft 24 vs
fail window move 79/gather 4), and blind llama turned the
COMMUNITY_GOAL system-prompt line into 748 invented-election
governanceActions. Forensics: `rpk group describe` (Stable + frozen),
offset-vs-AttemptStarted position in the partition, then an
assign+seek aiokafka probe inside the container venv that reproduced
the exact exception.

- **PR #71 (merged, deployed):** codec deps
  (python-snappy/lz4/zstandard); done-callback that logs CRITICAL and
  exits(1) on consumer death + compose `restart: on-failure` (the
  M1-10 kafkajs rule, python edition); consumer starts AFTER
  roster/reactive hooks; RaceState boot rehydration from the
  event-service ledger (6h window, cursor-paged) so a restart
  mid-attempt no longer blinds prompts; system-prompt
  governanceAction-null guard; race mode mutes the COMMUNITY_GOAL line.
- **Validation:** throwaway `019f8c68` (easy, mob-free, guard stance)
  WON honest in 768.5s — coal +3m, iron +8m, furnace +10m,
  ingot/pickaxe +13m; decision mix gather 52/craft 46/idle 2; blue
  team live-routed to gemma3:12b (proves consumer→RaceState→TeamRouter
  end-to-end); 0 phantom elections; honest-race deltas 0/0.
- **Orphan class:** `019f8b48` (19:23Z, tracker restart amnesia) closed
  with an `operator-cleanup` AttemptEnded (rpk `-z none`,
  key=attemptId). Prevention chip filed (startup sweep in
  attemptTracker).
- **Deploy state:** main → agent-service + minecraft-service (#68 in).
  pov-rig container STOPPED: port pool 3100-3105 clashes with main's
  minecraft-service mapping, and **PR #70 is stranded** — merged into
  `fix/trail-particle-def` (its stacked base) after #68 had already
  squash-merged, so pov-rig never reached main. Re-land chip filed;
  POV cams offline until it runs. Fleet respawned to exactly the 6
  racers (`spawn-fleet.mjs` defaults to ALL entries — pass a count;
  `despawn-fleet.mjs 6` trims).
- **Diagnosis traps for next time:** (1) the RB-2 harness preflight
  runs ~20 minutes — decisions sampled between harness launch and the
  ledger's `AttemptStarted.occurredAt` are village-mode ticks that
  look exactly like the regression (no race section, all-llama
  routing); anchor every window on the ledger timestamp. (2) "fleet
  alive, brains dumb" → `rpk group describe agent-service.perception`
  FIRST. (3) Never `rpk produce` onto a topic a python service
  consumes without `-z none`.

## Session 2026-07-22 (eleventh) — the docs catch up to the code: architecture ↔ bottleneck reality

**Parker's brief: update docs/architecture to reflect the fixes described
in docs/reports.** The only report is `bottleneck-report-2026-07-17.md`,
which landed WITH its top-leverage fixes in PR #37 the same day. Method:
22-agent workflow — 5 code verifiers (one per service area, file:line
facts from the CURRENT tree, never the commit message) + 11 doc mappers
ran concurrently; per-doc editors were gated on the verified facts; an
adversarial diff-review pass then caught and fixed 3 editor overclaims
before commit. Both PRs docs-only (CI skipped by path filters), merged by
Parker.

- **#60 — five docs updated against verified reality:**
  - `01-domain-model`: governance context is implemented (REST-driven
    since M2-6, Kafka contracts from M2-7), no longer "P2+; schema now,
    code later"; Timeline glossary drops never-shipped OpenSearch and
    lists the real ledger indexes incl. `(aggregate_type, occurred_at)`;
    the vote-casting `FOR UPDATE` lock recorded as OPEN work.
  - `02-database`: reflection-scan index `(villager_id, memory_type,
    created_at)` added to the memory_db DDL; retrieval degradation
    reframed — the driver is TOTAL row count over time, not "100+
    villagers" — with the shipped per-query `hnsw.ef_search = max(40,
    candidates × 4)` sizing; event_db aggregate-type index; consumer
    described as the batch listener at concurrency 3 with multi-row
    `INSERT … ON CONFLICT DO NOTHING`.
  - `03-events-kafka`: scaling paragraph rewritten (per-villager dispatch
    lanes ended cross-bot head-of-line blocking; partitions only buy
    parallelism when consumers match); topic auto-create documented
    disabled broker- AND producer-side (fail-loud); the blanket
    "producers use acks=all" split per producer — minecraft-service
    world events run acks=1 as a deliberate durability/throughput trade.
  - `05-repository-devops`: Redpanda auto-create flag + `mem_limit:
    1536m`; Postgres command-flag tuning (`shared_buffers=512MB` etc. —
    flags, NOT a postgresql.conf mount) + `2g` cap; minecraft `4g`
    container cap vs the `3G` heap; `task topics` row (provisioning must
    precede any producer on a fresh cluster).
  - `09-survival-plan`: the executor-side `Math.min(payload.timeoutMs,
    COMMAND_TIMEOUT_MAX_MS)` clamp joins the timeout-cap safety argument
    (a brain-table raise alone can no longer breach the ceiling); the 1s
    snapshot pass documented as change-gated; risk-register trigger
    reworded to "raising the ceiling itself".
- **#61 — the flagged loose end:** SV-18's ticket AC still carried the
  pre-clamp trigger phrasing ("any per-verb timeout raised above
  TIMEOUT_TABLE_MAX_MS"); aligned with the risk-register wording.

**Verified-absent list (documented as OPEN — never re-document as
shipped):** memory decay/archival job (only read-side recency scoring
exists); `commands.minecraft` partition raise beyond 6 (dispatch lanes
make it non-urgent); government vote-lock removal (service is mothballed
on the `gov` profile anyway); mem limits beyond
postgres/redpanda/minecraft; ledger range-partitioning.

**Provenance gotcha worth keeping:** PR #37's commit message claims
`lingerMs` on the minecraft-service producer — its diff never added it
(`git log -S lingerMs` returns nothing). The docs correctly omit it.
When writing docs from a PR, trust the diff, not the commit message.

**Docs verified CLEAN against the report (no edits needed):** 00, 04,
06, 07, 08, 10.

**Next:** unchanged — Parker films per `docs/demo-rb.md`; guard-arc
follow-ups live in the SV-14 row.

# Prior handoff — GUARD ARC SHIPPED (stance+tether+armor+iron_sword, 4 PRs, regression-raced) · film when ready

## Session 2026-07-18 (tenth) — the guard arc: Parker's redirect, shipped end-to-end in one session

**Parker's brief: instead of first_diamond, make the bots defend themselves
against mobs (mineflayer "guard" behavior), keep crafting iron tools, keep
hunting.** First_diamond WIP found uncommitted in the tree was parked
verbatim on `rb-t2-diamond-wip` (not for merge; resume there when T2
reopens). The arc shipped as four PRs, each CI-green and self-merged with
Parker's per-arc authorization, plan-mode approved up front:

- **#53 contract** — CraftParams += `iron_sword` (rides the existing
  generic SMELTABLES chain-resolution: 2 in-craft-smelted ingots + 1 stick
  at a table; body cost was the enum entry). Fixture, gen, FakeProvider
  row, prompt prose.
- **#54 body** — `Stance` += `guard` (mineflayer-pvp stays NO-GO; built on
  FightDriver): MELEE fights under guard, RANGED engages ≤8 (named consts,
  brave stays ≤4), every safety floor untouched. `guardTether.ts`:
  return-to-post riding the threat interval, never claims busy, forfeits
  ownership without clearGoal (pathfinder single-goal arbitration), anchor
  re-captured at every 'spawn'. `armor.ts` (SV-14-lite): pure
  planArmorUpgrade + EatWatcher-pattern reflex, one piece per 5s pass,
  equip raced vs timeout, 60s blacklist, `civ_armor_equips_total`.
- **#55 brain** — SYSTEM_TEMPLATE body-autonomy line (armor, walk-back,
  iron_sword nudge), deploy-ordered AFTER the body. SV-14 row updated.
- **#56 the drill's lesson** — armor now dresses THROUGH sieges: the
  threatOpen gate had held the reflex closed for a 17-minute siege while
  Elara stood at 1 HP with a helmet in her bag (busy-gate only now;
  maneuvers hold busy='combat' so no race with the fight's hand-equip).
  Plus: the reflex's silent catch now WARNS (invisible dead reflex
  otherwise), boot breadcrumb, tether 'walking home' log.

**Live drill, all beats green:** zombie engaged{fight}→killed 6s · skeleton
6→fight / 12→flee (window respected) · creeper always-flee · floors held
(pack>2, unarmed, witch/unknown) · full armor set equipped one-piece-per-
pass · tether: tp'd 25 out → walked home to post · iron_sword one-command
chain `{crafted:1, smelted:2, tablePlaced, furnacePlaced}` (Bram).

**Regression race PASSED — the guard fleet still races.** Attempt
`019f76be-ab8a-71ed-8049-13a14619efb4` (label `guard-regression-1`, Normal
+ hostiles, stance=guard fleet-wide): **blue/Fen in 841.5s**, honest
`{0,0}`, **zero deaths**, 163 threat episodes, fights 3 killed / 1 lost
(the predicted skeleton-kiting bleed, bounded by the failedFights
blacklist). ~80s guard tax vs the pre-guard mob takes (760.8s) — the
fleet fights its way up the ladder now instead of pure fleeing.

**Drill-day operational lessons:**
- `/give` to a FULL pack silently drops items at the bot's feet — hours of
  peacetime hoarding (401 logs!) ate two armor gives before diagnosis.
  Clear packs before staged drills (the RB-1 rig lesson, re-learned).
- An idle fleet + doMobSpawning true + Normal accumulates a SIEGE (206
  hostiles purged in one sweep — 60 zombies / 62 skeletons / 69 creepers /
  15 spiders). Mute spawning between takes; race preflights re-decide it.
- The env-name gotcha class again: my drill kill-list omitted `witch` —
  one surviving witch held Elara's threat episode (and therefore the old
  armor gate) open for 17 minutes of "mystery."
- Harness note: backgrounded shells IGNORE the Bash timeout param — bound
  polls INSIDE the script (`for i in $(seq 1 N)`), never bare until-loops.

**Stance state:** `.env` has `THREAT_DEFAULT_STANCE=guard` (fleet-wide).
Revert to `cautious` for pure-speed record attempts; the ~80s tax is the
price of the fleet fighting back. Open follow-ups live in the SV-14 row:
leather-armor craft enum, per-villager stance, `set_post`/persisted
anchors.

**Next:** filming unchanged (`docs/demo-rb.md`); the guard fleet is
arguably the better film — fights on the ladder instead of pure flight.

# Prior handoff — NORMAL BEATEN (881s, no fallback) · RB-3 artifacts landed

## Session 2026-07-18 (ninth, overnight autonomous) — Normal falls, RB-3 ships its artifacts

Parker slept 8h with merge-own-PRs authorization; the night ran on the
between-takes loop: race → ledger-analyze → fix → PR → CI → merge →
rebuild-with-marker-grep → next take.

**NORMAL DIFFICULTY WON — the ADR's flagship tier, no fallback needed.**
Attempt `019f7352-03ae-716b-b4df-1da76bb8c9d8` (label `rb2-normal-1`):
**red/Wren in 881s**, honest `{0,0}`, zero intervention. Blue led the first
two rungs (coal 1m53s, iron ore 4m15s); red converted furnace 8m31s →
3 ingots + **iron_pickaxe 14m20s**. Decision mix at the 10s tick: zero
hunt, 4 move, every gather count ≥3 — the gather-discipline + count
teaching working live at Normal.

**PRs merged tonight (all CI-green, authorized merges):**
- **#47** — race watcher outlives service hiccups (per-poll try/catch +
  retried end-phase; both exit-night watchers had died on one transient
  fetch) + governance riders muted in race mode (schema description +
  RACE DISCIPLINE line; riders now fire only in the pre-attempt seeding
  window, zero during races).
- **#48** — POV film rig: flag-gated prismarine-viewer per racer (fixed
  port pool 3100-3105, lazy import, `canvas` stubbed via noop2 —
  allow-scripts blocks native postinstalls), `film/pov-grid.html` grid,
  3 new tests, OFF by default.
- **#49** — README hero (both wins, receipt command) + demo-rb.md
  reference takes with real attempt ids + the POV verdict.

**POV verdict (live-verified, negative): prismarine-viewer 1.33.0 cannot
speak MC 1.21.6** — "partial packet: world_particles" on the 1.21.2+
`trail` particle, and the crash killed the whole minecraft-service process
(fleet-lethal). Flag stays OFF; rig code stays for upstream catch-up; film
the in-world shot with the vanilla spectator client. Do NOT set
POV_VIEWER=1 on 1.21.6.

**Ops lessons of the night:**
- A minecraft-service RECREATE (vs restart) leaves the command consumer
  group member lingering up to sessionTimeout (60s) — the "hung" boot
  self-heals; don't panic-restart inside the window. Also: the consumer
  group is `minecraft-service.command-executor`, NOT `minecraft-service` —
  `rpk group describe` on the wrong name shows STATE Dead and cost 20
  minutes of phantom debugging (the verify-frame-facts lesson, again).
- The dashboard `/race` scoreboard verified live against the Normal take
  (teams, feed, live badge) — the product shot is film-ready.

**THE FLAGSHIP CONFIG WON TOO — Normal + hostiles, and it's the best
story of the night.** Attempt `019f7366-cbb4-71cd-a225-c758df66aa0e`
(label `rb2-normal-mobs-1`): **blue/Petra in 760.8s** — blue's first win,
come-from-behind (red led 4/5 at 7m; blue swept iron ore 9m → furnace 11m
→ ingots + pickaxe 13m), honest `{0,0}`. FASTER than the mob-free Normal
take despite 105 threat episodes (48 zombie / 25 creeper / 22 skeleton /
10 spider), only 36 SELF_DEFENSE_IN_PROGRESS stalls (attempt-4's mob
experiment: 254 in 32m), and **zero deaths** — the survival-reflex stack
(SV-6/8/12) carried a full race under fire. Soak line for the film call:
3-for-3 wins tonight across Easy / Normal / Normal+mobs, zero stalls,
zero deaths, every receipt honest.

**Next:** Parker films per `docs/demo-rb.md` (scoreboard + spectator
takes; best-of-N at Normal, mobs on for realism — proven raceable).
Roadmap beyond T1 unchanged (ADR 10).

## Session 2026-07-18 (eighth) — RB-2 EXIT PASSED: the 3v3 race WON in 6 minutes (take 2)

**The exit criterion is MET, on pure-main provenance.** Attempt
`019f7337-977e-738e-8d5a-bf8e1db77439` (label `rb2-exit-2`): **WON by red in
360.4s** — Elara crafted the iron pickaxe (win event `019f733d-14dd`), zero
human intervention after attempt start, honest-race deltas CLEAN
(budgetTripped 0, fakeProvider 0), full receipt under the Attempt aggregate.
Ladder: red first_coal 2m → blue first_coal 3m → red first_iron_ore 4m →
furnace_placed 5m → first_ingot (3 ingots) + **iron_pickaxe 6m**. The first
brain-driven 3v3 ladder completion in the project; blue reached first_coal.
The winning image was built from clean main at b3b0b3b (#43) — proven by
grepping marker symbols in the container, see below.

**Take 1 (rb2-exit-1) face-planted on the stale-image trap — 15m, ZERO
rungs.** Cold-start `task up:all` reused an agent-service image built at
23:42Z, two hours OLDER than #43's merge (01:47Z): the racing brain had #40's
`_race_tool_check` but NO `_race_sticks_check` (container grep: 0 hits).
Ledger autopsy of the 15 minutes: 163 logs gathered, 29 plank crafts vs
**1 stick + 1 wooden pickaxe fleet-wide**, 232 TOOL_TIER_REQUIRED bare-hand
ore gathers, Ansel bare-hand stone-tunneling for zero drops the whole take —
the №1 chain-as-prose defect, resurrected by deployment, not regression.
Aborted cleanly (attempt `019f7325`, outcome aborted), rebuilt with
`up -d --build --no-deps agent-service`, verified BOTH check symbols in the
container, re-ran. CLAUDE.md gotcha extended: after any merge touching a
service, `--build` + grep a marker symbol of the new code IN the container
before an attempt.

**A concurrent session tuned the prompts from take-1's ledger — landed in
#45's squash (its commit `2283226`), NOT in the winning image:** bootstrap-
first rung hint (coal talk had outshouted the chain step — 267 pickaxe-less
`gather coal`), tool check speaking on tooled packs, an ore-ban line,
count-3 wood trips + count discipline, the furnace-rung cobble walk. Tests
184→190, verified green in this session. Container grep proves the WIN
predates these edits (pure #43). Resolution of the SV-2 two-sessions risk,
benign this time: the concurrent session pushed onto this session's PR
branch pre-merge instead of opening its own — the squash carries both.
agent-service REBUILT from merged main immediately post-#45 (the new gotcha
applied), so the deployed brain includes the tuning for the next attempt.

**Ops notes:** cold-start `up:all` hit a transient memory-service crash-loop
(DNS to postgres before infra was healthy) — the `--wait` retry cleared it,
nothing to fix. Detached-race pattern (Start-Process + persistent log-tail
monitor relaying milestones) worked twice; take 2's monitor caught the win
live. The stray 0-byte `llm/prompts.py` is gone (deleted upstream).

**Next:** RB-3 — the flagship filming pass (`docs/demo-rb.md` shot script;
POV grid flag stays OFF mid-race), README hero, demo-shot pulls from attempt
`019f7337`'s ledger slice. Then the difficulty ladder per
`docs/architecture/10-red-vs-blue.md` (Easy is beaten; Normal next). Land
the concurrent session's prompt tuning first if its PR appears.

## Session 2026-07-18 (seventh) — fast cycle smoked live; it caught and fixed a real brain defect

**All three tiers ran live and the loop already paid for itself.** Drill №1
(`task race:drill`, bot Elara) STALLED at 0/5 in 8m — and the diagnosis is the
whole story of why the kit exists:

- **The defect (brain, not body):** with coal tool-gated and 6 logs' worth of
  wood in the pack, the brain crafted `planks` FOUR times (16 carried!) and
  never chained to sticks → crafting_table → wooden_pickaxe. The prompt's
  chain hint ("gather wood → craft planks → sticks → …") reads as prose;
  llama3.1:8b replays the first step it recognizes instead of diffing the
  chain against the pack. Meanwhile the body was blameless: `findBlocks` saw
  every staged log (mc-service `gather target found` lines), the partial haul
  (5/8, `stoppedEarly`) was honest, and TOOL_TIER_REQUIRED even spelled the
  recipe out.
- **Reproduced offline in ~90s:** new replay rung `chain`
  (pack: 16 oak_planks + 2 oak_log, next: first_coal) — 12/12 `gather`, zero
  craft, against the old prompt. The failing live state is now a permanent
  seconds-fast regression case.
- **The fix (`_race_tool_check` in `brain/prompts.py`):** compute the ONE next
  craft from pack arithmetic (planks needed = table 4 + sticks 2 + pickaxe 3)
  and name only it — "You carry 16 planks… Your ONE next move: craft sticks",
  plus a do-not-gather guard once wood suffices. When the tool check fires it
  now REPLACES the generic chain hint (one voice at a time). Sweep regression
  caught by the sweep itself: at the `furnace` rung the new check buried the
  craft-furnace hint under `gather wood` (6/6) — gated: tool check stays
  silent at `furnace_placed` when cobblestone ≥ 8.
- **Post-fix sweep (all offline, minutes):** bare 6/6 gather wood · chain 6/6
  craft sticks · coal 6/6 gather coal · iron 6/6 gather iron_ore · furnace 8/8
  craft furnace · ingot 4/6 craft iron_pickaxe · win 6/6 craft iron_pickaxe.

**The drill ladder then peeled the NEXT two defects the same way (each drill
reached one rung further):**
- **Drill №2** (chain fix live): full wooden bootstrap in 97s — wood → planks
  → sticks → crafting_table → wooden_pickaxe — and `first_coal` at 2m (№1
  crossed nothing). Then STALLED at `first_iron_ore`: wooden pick in hand,
  iron tool-gated, and the brain crafted a stone_AXE and looped gather-stone /
  fail-iron for 8 minutes. Root cause: ANY pickaxe silenced `_race_tool_check`.
  Fixed tier-aware (gold ≠ stone tier): at `first_iron_ore` a wooden/gold pick
  now walks the pack to `stone_pickaxe` one computed step at a time, with the
  explicit "gathering iron_ore NOW yields NOTHING" ban. Replay rung
  `stonechain` froze the state: 4/8 correct before the wording pass, **9/10
  after** (the ban line was worth +50 points).
- **Drill №3** (tier fix live): `first_coal` 2m → `first_iron_ore` 3m →
  `furnace_placed` 4m — one rung per minute — then beached at the smelt rung:
  both pickaxe crafts had spent all 4 sticks, the win craft needs 2, and the
  brain looped gather on an emptied pad while holding 7 planks. Two-sided fix:
  **`_race_sticks_check`** (new; at `first_ingot`/`iron_pickaxe` rungs, names
  `craft sticks` when the fix is one cheap craft away, silent on bare packs)
  — replay rung `smeltstuck`: 9/10 craft sticks — and **arena slack** in
  drill-rb2.mjs (10 logs / 4 coal / 4 iron, was 6/2/3): the exact-minimum pad
  left zero margin for one wasted craft (a second furnace), and slack keeps
  the drill measuring the BRAIN, not scavenging.
- Also fixed in drill-rb2.mjs: the decision histogram silently printed `{}` —
  the ledger caps `limit` at 100 and the 400 problem-json was swallowed.
- **Drill №4: WON — the full ladder in 8 minutes.** first_coal 3m →
  first_iron_ore 4m → furnace_placed 5m → first_ingot 8m → **iron_pickaxe 8m,
  WIN recorded** (attempt 019f72c6, win event 019f72cd-d8c2). The first
  brain-driven ladder completion in the project: wood → planks → sticks →
  table → wooden pick → coal → stone pick → iron ×3 → furnace → smelt → IRON
  PICKAXE, zero harness commands after attempt start, honest 0/5 checklist.
  Drill progression №1→№4: 0 rungs, 1, 3, **5 (WIN)** — one defect peeled per
  drill, each frozen as a replay rung.

**Hot-reload gotchas found live (both fixed in the dev override):**
- `tsx watch` NEVER reloads on Docker Desktop for Windows — host-side bind-
  mount edits emit no inotify events in the container. uvicorn survives only
  because StatReload POLLS. Fix shipped: `CHOKIDAR_USEPOLLING=1` +
  `CHOKIDAR_INTERVAL=1000` env on minecraft-service in
  `docker-compose.dev.yml` (tsx bundles chokidar, which honors them) —
  verified: touch on the host, tsx rerun in the container.
- **Never edit agent-service src MID-drill/attempt:** uvicorn reload restarts
  the worker, RaceState is in-memory, and the AttemptStarted offset is
  committed — the brain forgets the race while the attempt keeps running
  (documented limitation in `brain/race.py`). Edit between attempts only.

**Debugging lesson (cost ~20 min of phantom-outage chasing):** the ledger's
`GET /events` has NO `order` param — an `order=desc` query is silently ignored
and pages OLDEST-first. Filter with `since`/`until` and read forward; "the
newest AttemptStarted is from 15:50" was page-1-of-ascending, not reality.

**Leftovers for Parker:**
- `services/agent-service/src/agent_service/llm/prompts.py` — a 0-byte stray
  (created by an errant `touch`; deletion was classifier-blocked). Delete it;
  the real module is `brain/prompts.py`.
- PR #42 merged (thanks!) — this session's work (replay `chain` rung, prompt
  fix, dev-override chokidar fix, HANDOFF) is uncommitted on the now-stale
  local `rb2-race-lessons`; branch off fresh from main when committing.
- governanceAction riders still leak into race decisions (`vote`/
  `declare_candidacy` with junk electionIds, dropped harmless but noisy in
  every replay run) — cheap prompt cleanup, now verifiable in seconds.

## Session 2026-07-17 (sixth) — a MUCH faster RB-2 iteration loop (branch `rb2-race-lessons`)

**The problem:** the 3v3 race (`race-rb2.mjs`) takes 11–75 min to reach an
outcome (six brains bootstrap from scattered forests at a 10s Ollama tick with
long walks) — the WRONG feedback unit for tuning one prompt line or one rung.
Parker interrupted a live race (`race-rb2-exit-6.log`, stalled at furnace_placed
~11m in) and asked for a faster cycle. Built a three-tier loop, fastest first.

**The feedback ladder (pick the cheapest tier that answers your question):**

| Tier | Command | Wall time | What it measures | Docker? |
|---|---|---|---|---|
| **Replay** | `task race:replay RUNG=bare N=20` | seconds | pure brain: decision histogram at an EXACT rung vs real Ollama | none |
| **Hot-reload** | `task dev:up` (once) | ~1s per edit | removes the rebuild tax in front of every live test | reload, no rebuild |
| **Drill (live)** | `task race:drill` | single-digit min | honest full ladder, real brain+body, one isolated bot | live stack |
| Body drill | `node scripts/drill-rb1.mjs` | ~2 min | body/chain machinery (raw commands, brain OUT) — pre-existing | live stack |
| Flagship | `node scripts/race-rb2.mjs` | 11–75 min | the real 3v3 — unchanged, for the exit race only | live stack |

**What each new piece is:**
- **`services/agent-service/scripts/replay_race_brain.py`** — feeds the real
  `system_prompt`/`user_prompt` at a chosen rung (bare/coal/iron/furnace/ingot/
  win, each staged with a pack that CAN cross the next rung) to real Ollama N
  times and prints the verb histogram + params + reasoning samples. No Minecraft,
  no docker, no tick clock. This is where prompt tuning converges: if 15/20 `bare`
  decisions are `move`/`hunt` instead of a craft, RACE DISCIPLINE failed — known
  in 20s, not after a 45m wood age. `RUNG=all` sweeps every rung. Runs on the
  HOST (`ollama_base_url` defaults to `localhost:11434`; Settings init-kwargs
  override env, so no `.env` needed).
- **`infrastructure/docker/docker-compose.dev.yml`** + `task dev:up` — bind-mounts
  each service's `src` over the baked image and swaps the run command for a
  watcher (agent-service `uvicorn --reload`, minecraft-service `tsx watch`). Edit
  `prompts.py` or `attemptTracker.ts`, the service reloads in ~1s, NO `up --build`.
  **DEV LEVER, not a deploy path** — provenance is the mounted worktree; rebuild
  from main (`task up:all`) before any honest/filmed attempt.
- **`scripts/drill-rb2.mjs`** + `task race:drill` — the live analog of replay:
  despawns every OTHER racer (so only this bot's team crosses milestones AND its
  ticks don't queue behind five deliberations at the LLM), stages a calm flat
  pad with wood + coal + a stone slab + iron ALL within 8 blocks, starts a FRESH
  attempt (brain sees a true 0/5 checklist — honest), lets the real brain climb
  the whole ladder, and reports minutes-to-milestone + the bot's decision
  histogram (a stall reads "40 moves, 0 gathers" at a glance). Short stall
  watchdog (8m default). Leaves the fleet despawned — re-embody with
  `node scripts/spawn-fleet.mjs`.

**Why the drill can't do mid-ladder `--from`:** milestones cross ONLY from real
world events at the producer choke point (`attemptTracker.ts`) — there is no
milestone-injection endpoint, so a fresh attempt always shows the brain 0/5.
Mid-ladder brain context is therefore replay-only (offline, where the checklist
is trivially set); mid-ladder body/chain is `drill-rb1.mjs` (brain bypassed).
The live drill stays HONEST by running the full ladder from scratch and buying
its speed from isolation + density, not from faking state.

**Max-speed knob (optional):** the despawned bots' brains still tick (burning a
little Ollama). For the tightest drill loop, set `VILLAGER_COUNT=1` in `.env` and
recreate agent-service, so only the drill bot deliberates. Restore to 6 before
the flagship race.

Syntax-verified: `node --check` on both scripts, `py_compile` on the replay.
Not yet run against a live stack (the stack state at handoff is unknown — a race
was interrupted). First live use: `task dev:up`, then `task race:drill`.

## Session 2026-07-17 (fifth) — branch cleanup + the race-lessons consolidation (branch `rb2-race-lessons`)

## Session 2026-07-17 (fifth) — branch cleanup + the race-lessons consolidation (branch `rb2-race-lessons`)

**Repo housekeeping**: five stale branches deleted locally (all content
verified contained in main via in-memory merge-tree diffs — squash merges
hide containment): `rb-1-body` (#36), `claude/project-bottlenecks-rww3q8`
(#37, incl. the bench-harness commit), `mcp-minimal-profile` (#39),
`rb2-tool-check` (#40), `rb2-command-lanes` (#41). Remote deletes were
classifier-blocked — Parker: `git push origin --delete
claude/project-bottlenecks-rww3q8 rb-1-body rb2-command-lanes`.

**PR #38 (`rb2-defect-fixes`) was CONFLICTING and mostly superseded** —
parallel sessions re-implemented its lane fix and gear hint as #41
(executor dispatch lanes; better: age guard at dequeue + `civ_command_lane_depth`)
and #40 (`_race_tool_check`; material-aware). Its still-unique pieces —
carrying evidence from attempts 4–6 that main's HANDOFF never saw — are
consolidated on `rb2-race-lessons`:
- `scripts/race-rb2.mjs`: stall watchdog 45m→75m (attempt 3's wood age ran
  ~45m before the first milestone); mob-free race DEFAULT with `--mobs` to
  restore hostiles (attempt 4: 254 SELF_DEFENSE_IN_PROGRESS failures in
  32min — the threat tax drowned the ladder); post-respawn wanderer
  re-spread loop (a 10s-tick brain walks its bot off the post mid-verify —
  Wren drifted 54 blocks; spreadplayers retry, not abort); milestone
  printing diffs a seen-set (status.milestones is SORTED, not append —
  attempt 6 double-printed red:first_coal, swallowed blue:first_iron_ore).
- `attemptTracker.ts`: furnace_placed now crosses on ALL THREE honest
  routes — placed mid-craft, crafted-to-carry (attempt 5b live: three red
  furnaces crafted, zero rungs lit), or found-furnace reuse (else the
  ladder can never win 5/5 on that path).
- `prompts.py`: RACE DISCIPLINE re-tuned from attempt-4 data (HALF of 1060
  decisions were `move`, 86 `hunt`/71 empty — verbs now named and banned);
  race mode mutes mild hunger (>6 food) + game-in-sight sections (the
  hunt-bait); true starvation ≤6 still speaks. Kept main's
  `_race_tool_check` over #38's `_gear_check_line` (same defect, merged
  first, material-aware). Close #38 as superseded once `rb2-race-lessons`
  merges.

Tests: agent 184, mc 296, typecheck clean, race script node --check OK.

## Session 2026-07-17 (fourth, part 2) — RB-2 machinery + three attempts of tuning + the RB-3 scoreboard

**RB-2 built and battle-tested; the unattended won race is still owed.**
The race brain (tier-checklist prompt + team-progress percepts, the civics
pattern), the attempt harness (`scripts/race-rb2.mjs` — the ADR's enumerated
checklist executed AND verified, honest-race deltas read from Prometheus,
stall watchdog), and the RB-3 dashboard `/race` scoreboard (validated
palette, live SSE, verified against a running attempt in Chrome) all landed.
Race preset active in `.env`: VILLAGER_COUNT=6, TICK=20s. Soak numbers at
race cadence: ~1.7s mean Ollama deliberation, 6 bots, zero tick errors.

**Three attempts, each converting a real defect into a structural fix:**
1. 107 chats vs 1 gather — the "split the work out loud" line licensed a
   debate club → RACE DISCIPLINE directive (mix became 39 gather / 0 chat).
2. Both teams raced on the barren spawn mountain — blind ±N posts → posts
   auto-locate the nearest FOREST; stationing was silently broken: a
   mid-pathfind racer keeps its in-flight goal and walks home →
   spreadplayers + verify + spawnpoint-anchor + kill/respawn state reset;
   plus the posOf regex bug (`.match(/g)` keeps the trailing 'd' → NaN).
3. Attempt 3 (verified rig): wood age converted — a wooden pickaxe WAS
   crafted, coal ore located and targeted 3.4 blocks away — but the
   conversion broke: **Fen's pickaxe vanished from the pack** (death
   suspected despite keepInventory; unproven) and gather failures were
   processed in same-second BURSTS (command-plane backlog — an executor
   wedge signal at 6-bot race pace). Attempt ended by the 45m stall
   watchdog, honest deltas recorded.

**Open defects for the RB-2 exit (next session's first hour):**
- ~~The vanished wooden pickaxe~~ **SOLVED (2026-07-17): durability break,
  not death.** Ledger shows continuous movement through the 18:03:36→18:04:14
  vanish window (no respawn teleport, no threats); Paper ground-truth stats
  show `broken:wooden_pickaxe=2` for Fen. 59-use wooden pickaxe burned by 16
  evented digs + unevented pathfinder tunnel digs (action Movements has
  canDig on). Fix shipped: material-aware TOOL CHECK line in the race
  section (`_race_tool_check`, prompts.py) — fires on the mining rungs when
  the pack holds no pickaxe, teaches shortest re-craft path; silent at
  smelt/win rungs. Tests in test_race_brain.py.
- ~~Same-second command-failure bursts~~ **SOLVED (2026-07-17): the kafkajs
  fetch-cycle barrier.** `partitionsConsumedConcurrently: 6` parallelizes
  within a fetch round, but the next fetch waits for the slowest in-flight
  eachMessage — and the executor awaited the world inside the handler, so one
  60s-watchdog pathfind gated all six bots (measured 40–116s request→outcome
  lag; failures drained in same-second multi-bot bursts, 50 such seconds in
  attempt 3). Fix: `CommandExecutor.dispatch` per-villager lanes — the
  consumer enqueues and acks, never awaits; per-villager ordering preserved;
  age guard now runs at dequeue so lane wait counts against
  COMMAND_MAX_AGE_SECONDS; new gauge `civ_command_lane_depth` (idles 0,
  sustained >6 at race pace = world behind the brains). Crash loses queued
  intents by design (brains reissue; dead intents must never replay).
- Consider: longer stall window for the wood age (45m was nearly enough) —
  the inventory-conditional hint is now in (see above).
Then rerun `node scripts/race-rb2.mjs --label rb2-exit-N` — one command.

RB-3 remaining after the race: POV grid (prismarine-viewer, flag off —
NEVER deploy minecraft-service mid-race), README hero, filming
(docs/demo-rb.md has the shot script + caption-to-ledger table).

> A fresh session should be able to continue from this file +
> `docs/architecture/10-red-vs-blue.md` (the ADR-pinned plan) without
> asking questions.

## Session 2026-07-17 (fourth) — RB-1, the whole body phase in one autonomous session (branch `rb-1-body`, PR pending)

**Exit criterion met and machine-verified**: `node scripts/drill-rb1.mjs`
drives Fen mine → smelt → craft iron_pickaxe end-to-end on the live stack;
the ledger holds the attempt slice (AttemptStarted, FIVE ProgressionMilestones,
AttemptEnded{won, 57.7s, honest-race zeros}), replayable by attemptId —
`GET :8081/events?aggregate-type=Attempt&aggregate-id=<id>`. One
chain-resolution craft crossed furnace_placed + first_ingot + iron_pickaxe
with causation pointing at the single ActionCompleted{crafted:1, smelted:3}.

In ADR order: **SV-5b gate** (first volume backup executed + verified,
`docs/runbooks/volume-backup.md`, backups in
`D:\backups\ai-civilization-engine\2026-07-17\`) → **contract commit**
(gather += coal/iron_ore · craft += iron_pickaxe · errorCodes +=
TOOL_TIER_REQUIRED/SMELT_FAILED · AttemptStarted/ProgressionMilestone/
AttemptEnded · fixtures/gen/FakeProvider rows/timeout rows, craft → 60s
ceiling) → **body skills** (ore tier gate teaching the pickaxe ladder;
smelt-inside-craft: find-or-place furnace, fuel ranking coal>planks>logs,
honest short-yield; auto-equip verified already in skills) → **milestone
mapper + attempt lifecycle** (producer choke-point observer, per-team
dedupe, win = craft-completions only, `/internal/attempt` control surface)
→ **team seed + gov mothball** (villagers.json team fields red/blue,
VILLAGER_COUNT=6 preset, spawn-teams.mjs, government-service → `gov`
profile) → **exit drill**.

Drill iterations flushed four real bugs (each cost a run): Paper
spawn-protection ghost-digs near world spawn (now 0), placeBlock's flaky
blockUpdate wait (world-verify instead of trusting the throw), interactive
blocks as placement ground (furnace stacked onto the table opens it
instead), and rig lessons (thick pad, cleared inventory — scavenged ingots
once let the pickaxe craft with zero smelts). All in CLAUDE.md gotchas.

**Next session (RB-2)**: tier-checklist prompt + team-progress percepts +
the enumerated attempt checklist + llama go/no-go smoke + Normal soak.
The old M2/Survival handoff below is history.
> **M1 + M2 complete and merged (Mayor Bram seated, fleet ticking). The
> Survival cluster is in flight: SV-1 (`1915e6d`), SV-2 (`38bc223`) and
> SV-3 + survival reflexes (PR #33, squash `d9d16bd`) merged. The LIVE
> minecraft-service runs the perf branch's image (PR #34 — the CPU
> follow-up; rebuild from main post-merge). The Episode 2 filming gate was
> WAIVED by Parker on 2026-07-17 — Survival deploys no longer wait on
> filming (recorded in 09-survival-plan rollout §5). Sprint 9's single
> body lane continues at SV-4 (crafting brain + the per-verb timeout table
> with TIMEOUT_TABLE_MAX_MS=60s).**

## Session 2026-07-17 (third) — the CPU follow-up, closed: profiled first, then three measured fixes (perf PR #34)

**The tracked follow-up from the survival session, done exactly as handed
off: profile before tuning.** Attached the V8 sampling profiler to the live
pinned process (SIGUSR1 → inspector on :9229 — no restart, fleet untouched),
captured 75s night and day profiles, fixed the three measured burners,
redeployed (worktree build), re-profiled the same in-game phase for the A/B.
Health stayed green throughout; zero deaths; PATHFINDER_TICK_TIMEOUT_MS
untouched at 10ms.

- **What the profile actually showed** (shares of the sampled core):
  - The 10ms-A*-slice duty-cycle theory was half the story. Night: A* 44%
    inclusive — but per-NODE cost was the killer, not node count: every
    neighbor is priced for digging (digTime + bestHarvestTool looping the
    whole inventory per candidate ≈ 8% self) and every block read builds a
    fresh prismarine Block (fromStateId 15% self on its own).
  - **The daytime mystery was monitorMovement's sprint gating**: while ANY
    bot walks a path, mineflayer-pathfinder re-decides sprint/walk/jump
    EVERY physics tick with full player simulations — canStraightLine
    budgets 200 simulated ticks toward the next node, the jump fallbacks
    add up to 7×20 more, and every simulated tick re-reads the same ~12
    blocks through full Block construction. **~40% of the daytime core,
    ~21% at night.** Day pinned bursty: 100–107% while a few bots walked
    trips, ~45% in lulls.
  - The "gated" resource scan still burned 14% (night) / 6% (day): a
    WALKING bot re-trips the 8-block movement gate on every 5s check —
    fleeing bots kept re-surveying ground they were running across.
  - Innocent: our own code (0.7% self), bot physics (~6%), packet parsing
    (~7%), kafka (~0.1%). Event-loop lag p99 sat at ~0.5µs the whole time —
    the saturation was millions of micro-tasks, not long slices, which is
    why heartbeats and watchdogs never starved.
- **The three fixes** (all minecraft-service, all env-tunable):
  1. **`bots/physicsSimCache.ts`** — turn-scoped block cache patched over
     `bot.physics.simulatePlayer`, the public seam BOTH the real 20Hz tick
     and every pathfinder gate simulation route through. World mutations
     only arrive in packet turns, so within one synchronous turn the cache
     is semantically invisible; setImmediate clears it before the next
     timer phase can simulate. Deliberately NOT applied to bot.blockAt:
     pathfinder's movements.getBlock mutates returned blocks with
     query-relative fields — aliasing would corrupt A*.
     `PHYSICS_SIM_BLOCK_CACHE=0` is the one-env rollback lever.
  2. **Reflex movements (canDig=false)** for flee/fight/hunt-chase paths —
     a villager running for its life no longer prices mining through walls,
     and the A* frontier shrinks with it. Actions keep the digging planner;
     every maneuver clearGoal (and stopMoving) restores it.
  3. **Frontier bound + scan spacing**: `PATHFINDER_SEARCH_RADIUS=80` — an
     unreachable goal (cornered flee hop, target across a ravine) now
     concedes with the SAME best-effort partial path instead of touring the
     loaded world for the full 10s think budget; `RESOURCE_SCAN_MIN_SWEEP_MS
     =15000` hard floor between sweeps, plus no sweeps while the body is
     busy / threatened / trapped (the survey exists for deliberation).
- **Measured A/B (same 20-bot fleet, same in-game phases, 75s captures)**:
  day idle 24.9% → **57.5%**; tickPhysics-inclusive 61% → 28%;
  prismarine-block self 23% → 8%; day CPU sustained 100–107% →
  **~67% mean** (brief bursts subside). Deep-night (same mid-night phase
  as the baseline capture): idle 0.7% → **62.1%**; prismarine-block self
  30% → 6.6%; pathfinder self 16% → 4.6%; CPU **~55% mean / ~52 median**
  (one 105% blip) vs 100.8% pinned. Night mob pressure varies run to run
  — but the flee outcome distribution was IDENTICAL both nights
  (cornered:escaped 2.7:1, 361 maneuvers logged post-fix), so the reflexes
  did the same work for roughly half the core.
- **mc tests 255** (turn-cache suite + shouldRescan floor cases), typecheck
  clean. **Profiling tooling committed**: `scripts/profile/capture.cjs` +
  `analyze.cjs` (attach → sample → aggregate against the live container;
  full usage in capture.cjs's header — future perf sessions start there).
- **Residual, known and accepted**: day A* ~20% inclusive is REAL work
  (gather trips); PlayerState re-resolves minecraft-data Version per tick
  (~3%, dep-internal); packet framing ~5%. Next levers if ever needed:
  upstream-grade patch caching monitorMovement's gate DECISION per path
  node, or shrink RESOURCE_SCAN_DISTANCE.

## Session 2026-07-17 (later) — SURVIVAL REFLEXES: eat + threat + hunt shipped and DEPLOYED (rides PR #33)

**Parker's brief: "Update the AI bots so they are able to survive on
difficulty easy on their own. The goal is that the AI bots are not slain,
and do not starve to death."** Shipped the survival capability cluster in
one arc (SV-4 + SV-6/7 + SV-8/10 + SV-12a/b + SV-13-lite + the contracts
they need), body-before-mind, all on the PR #33 branch.

- **Contracts (additive)**: ThreatEncountered.v1 (edge-triggered episodes,
  victim-only); ActionRequested += `hunt` (+ flat HuntParams — one animal
  per action); ActionFailed errorCodes += BODY_BUSY /
  SELF_DEFENSE_IN_PROGRESS / TARGET_ESCAPED; WorldSnapshot += nearbyAnimals
  + nearbyHostiles; HazardEncountered description records the starvation
  reuse. Fixtures + invalid + catalog rows + `task gen` committed.
- **Body (minecraft-service)**: `bots/eat.ts` (SV-6 brief verbatim: tiers
  14/6/10 + hurt modifier, foodPoints ranking, banned/desperation foods,
  per-item 60s blacklist, raced consume, starvation crisis via
  HazardEncountered{starvation}, generation-bump honesty);
  `bots/threat.ts` (classification + pure decision table — flee is every
  default, cautious flees melee; 2-pass debounce + instant danger radii
  {creeper 12, skeleton 16}; edge-triggered emission, overwhelmed ≤1/60s;
  canned cries); `bots/combat.ts` (hand-rolled FightDriver per the NO-GO
  spike: 650ms full-charge swings, fire-and-forget goals ONLY; flee with
  ±90° deflection + 60° buddy-bias cone + starving-walks + cornered flail;
  FLEET-wide FightSlots cap, overflow downgrades to flee);
  `world/hunting.ts` + BotSession.hunt (kill loop, baby exclusion via
  metadata index 16, entity blacklist, leash, honest yield deltas,
  ResourceGathered per drop type — ruling 6, wired after the live verify
  caught the miss); executor BUSY_BOUNCE table; busy seam grows
  'combat'|'eat' (priority escape > combat > eat > commands, no
  preemption); snapshot senses; metrics civ_eat_reflex_total /
  civ_threat_{episodes,responses,fights_active} / civ_hunts_total.
  mc tests 168→244.
- **Brain (agent-service)**: DELIBERATE_ACTIONS += craft, hunt (validated
  against the real $defs); **the per-verb timeout table** (SV-4,
  TIMEOUT_TABLE_MAX_MS=60s ceiling, gather 60s — count is now advertised);
  craft/hunt affordances with recipe-chain + herds-are-slow norms; the
  "your body looks after itself" teaching; standing hunger section (≤10
  urgent, ≤6 STARVING + ask-for-help legitimizer); Game-in-sight +
  DANGERS-in-sight sections; ThreatEncountered percept lines per phase;
  **the SV-7 type-blind hazard-directive FIX** (starvation no longer told
  to "get off the deep snow"); percepts: ThreatEncountered victim-only,
  wakes on spotted+overwhelmed only; reflect folds for threats +
  starvation. agent tests 143→167. All six suites green; zero malformed in
  the live window post-deploy.
- **Ops levers** (compose pass-throughs): THREAT_MAX_CONCURRENT_FIGHTS
  (default 4; 0 = flee-only fleet) and THREAT_DEFAULT_STANCE (cautious;
  brave = armed villagers fight melee). Everything else runs code defaults.
- **LIVE-VERIFIED on the easy world, same hour**:
  - **Organic creeper episode 60s after deploy** (before any drill):
    spotted 4.9 blocks → engaged{flee} → overwhelmed (cornered on the
    mountainside) → **escaped after ~47s, zero deaths** — the reflex saved
    a villager from a live creeper on its first outing.
  - **Ansel's starvation arc, organic-then-assisted**: his crisis opened
    HONESTLY (food 0, empty pantry — trapped in the ledger) the moment the
    watcher booted; an operator /give played the sharing neighbor; the
    reflex ate 0→8→16→20 (hurt-modifier top-up), crisis
    escaped-at-hysteresis in the ledger, health regenerating. Plus 4 fully
    organic eats fleet-wide in the first minutes.
  - **Drill zombie** (helmeted, daylight): 8+ villagers spotted it,
    engaged{flee} across the board (cautious default), all episodes closed
    escaped. Cleanup `kill @e[type=zombie]` removed **67 cave zombies** —
    the underground had been breeding since the easy flip; expect busy
    nights.
  - **Hunt end-to-end**: drill cow killed in a 2s chase, 3 beef collected,
    honest RESOURCE_NOT_FOUND prose when the earlier herd had wandered
    (fail-fast worked), ResourceGathered emission verified after the fix.
- **First-night finding, fixed same session (`071e1cf`)**: the flee
  no-progress window (3s) was TIGHTER than the pathfinder think budget
  (10s) — the cornered verdict fired before tickTimeout-starved A* even
  started the body moving, the goal got cleared, and the fleet jittered in
  place spamming overwhelmed{cornered} (distance also emitted as a
  hardcoded 0). Widened to 7s + real distance/count in the emit;
  redeployed mid-night. Zero deaths throughout either way (wheels +
  10-HP easy floor held). Also of note: a `creaking` (1.21.4 pale-garden
  mob) hit the unknown-hostile flee-class default correctly.
- **Second night finding, fixed same session (`06fa495`)**: 20 perpetual
  concurrent flees at 24-block A* hops pinned the minecraft-service event
  loop at **99.9% CPU** (caught via docker stats before any cascade — zero
  kafka rejoins, commands still completing; the recorded pursuit-pinning
  risk realized through FLEE, which the fight cap can't reach). Fix = the
  hazard escapeRetryMs pattern applied to maneuvers
  (`THREAT_MANEUVER_COOLDOWN_MS=5000`, first maneuver immediate, failed
  ones back off) + flee hops 24→16 (A* cost is super-linear on rough
  terrain; the loop re-hops anyway). Night-flee outcome ratio pre-fix was
  120 cornered : 1 escaped per minute — perpetual running that WORKED
  (fleet health 19×20/20 + one 17 regenerating, ZERO deaths all night),
  just hot.
- **Third finding — the ROOT cause, fixed same session (`e15b13b`)**: dawn
  CPU stayed pinned because the alert radius is a 3D sphere with NO
  line-of-sight — **the inhabited caves under the village kept every
  surface villager in a permanent phantom episode** against mobs 12 blocks
  below solid rock (this, not night sieges, drove both the CPU burn and
  the inverted cornered:escaped ratio). Fix at the single source:
  `trackedHostiles` applies an 8-block vertical band (the resource-scan
  yBand precedent) — watcher, maneuvers, and the snapshot's nearbyHostiles
  all stop seeing ghosts; **damage promotion** is the safety net (a real
  hit opens an episode instantly against the best-named suspect from the
  unbanded view — cliff snipers, aggroed endermen, anything unmapped;
  regen never promotes). Tests 247. The fleet survived the WHOLE first
  night either way: **zero deaths across every sample.**
- **Watch-fors**: organic hunt/craft decisions need hunger pressure (fleet
  was 17–20 food at session end — the survival section fires ≤10); llama
  go/no-go on hunt/craft emission still pending organic evidence; hunt's
  ResourceGathered emission is unit-covered but its live ledger proof
  still pending (drill cows kept wandering off / recreates interrupted);
  SV-5b backup STILL not taken. **CPU follow-up (tracked, not urgent)**:
  minecraft-service settles at ~100% of one core even in daytime with the
  band + cooldown in (episode behavior fixed: 23 closes, 33:73
  escaped:cornered vs the original 1:120) — every health signal is green
  (0 kafka rejoins, ~0 command timeouts, MSPT ~16, 0 deaths), consistent
  with the 10ms-sliced pathfinder duty cycle staying responsive while
  saturated; profile before tuning (candidates: PATHFINDER_TICK_TIMEOUT,
  scan caching, flee-hop cost) rather than guessing further.
- **NEXT**: watch the first night; Parker merges PR #33 (single click —
  the whole survival arc rides it); then SV-9 (cook), SV-14 (gear/armor),
  SV-15/16 (death awareness) per the plan; stance rider (SV-13 full) when
  personality-driven bravery is wanted.

## Session 2026-07-17 — SV-3 shipped + DEPLOYED (craft verb body, PR #33) · filming gate waived · stack recovered

**Parker's brief: "skip episode 2 filming, and begin developing and deploying
SV-3."** The filming gate is waived (recorded in 09-survival-plan rollout §5);
this session made the first Survival deploy.

- **What shipped** (`SV-3: craft verb (body)`, branch `claude/sv-3-craft-verb`,
  commits `d794234` + `2ef058a`, **PR #33 — OPEN, awaiting Parker's merge
  click** (the session's permission mode blocked `gh pr merge`; CI green,
  MERGEABLE)), all minecraft-service:
  - **`world/crafting.ts` (new pure module)** — wood-family resolution
    (planks → the most-carried log's planks; sticks → stick), the
    table-acquire decision tree, missing-ingredient prose with recipe-chain
    hints (`cheapestGaps` picks the recipe variant to teach: fewest missing →
    pack affinity → known materials), the placement scan (`pickTableSpot`:
    solid ground + 2 air, never the bot's own cell, ±1 step for hillsides),
    and `runCraftFlow` — one craft = ONE recipe application (the chain is the
    mind's multi-tick project, which is the arc's point). Every world touch
    injected (the SV-2 pattern) — the decision tree is unit-tested botless.
  - **`BotSession.craft`** = adapter only: recipesFor/recipesAll/craft,
    findBlock for a standing table (16-block search), placeBlock for a
    carried one with post-place verification (the ghost-dig lesson in
    reverse), honest inventory-delta results, Vec3s minted from the entity
    position (the hazardBot no-new-dep precedent).
  - **Executor**: craft case passes coded prescriptive failures through
    verbatim on EXISTING errorCodes (missing ingredients →
    RESOURCE_NOT_FOUND, no table → TOOL_REQUIRED, no placement ground →
    PATH_NOT_FOUND retryable, off-enum → INVALID_PARAMS — no contract
    change needed); craft-specific TIMEOUT prose names the table-walk lever.
  - **Wedge/zombie safety, zero new machinery**: the busy seam doubles as
    the cancellation signal — an abandoned flow never crafts or speaks after
    the watchdog settles (tested, incl. the announce-suppressed-but-honest-
    result case).
  - **Contract tripwire (ajv)**: `CRAFTABLE_ITEMS` pinned to the committed
    CraftParams enum BOTH directions — SV-11's leather-armor contract commit
    fails loud in this suite until the body handles it.
  - **Stone tier rode along** (same generic recipe path — the Sprint 10
    valve wasn't needed). Deploy-safe by construction: nothing advertises
    craft to the LLM until SV-4.
  - Tests **134→168** (tripwire, resolution, gap selection, prose, placement
    scan, decision tree, executor cases), typecheck clean, **all six suites
    green** (`task test`, jacoco gates passing), CI green on the PR.
- **Stack recovery first** (machine had restarted ~1h before the session;
  containers auto-restarted with the engine): 11 containers up BUT the Paper
  container was GONE entirely and the fleet 0/20 — minds ticking into a dead
  world, every command an honest BOT_DISCONNECTED. World volume intact.
  Paper restarted from the MAIN repo (`--profile minecraft up -d --wait`):
  connection-throttle −1 HELD, difficulty peaceful, canon world loaded.
- **Deploy** (body-only; agent-service untouched all session — no brain
  changes in SV-3): minecraft-service rebuilt from the worktree branch and
  deployed (`up -d --build --no-deps`, the PR #5 worktree-image precedent;
  **rebuild from main after the merge to restore deployed-provenance=main** —
  content is identical to the squash). Fleet re-embodied via
  `spawn-fleet.mjs`, **20/20 in <1 min, twice** (once per image deploy).
- **LIVE-VERIFIED: the whole Sprint 9 filmable beat ran on Maren** (operator
  plane, causationId-null dev practice; she carried 343 dark oak logs):
  planks → **4 dark oak planks** (most-carried-log resolution, ledger
  `ActionCompleted{crafted:4, itemName:"dark_oak_planks"}`, 8ms) →
  crafting_table (52ms) → wooden_sword **failed prescriptively as designed**
  (no planks left: "…you carry no dark oak planks; craft planks from your
  logs first…") → planks → sticks → **wooden_sword crafted 1,
  {tableUsed:true, tablePlaced:true}, 1049ms** — she placed her own table
  and made the village's first wooden sword at it. Table verified standing
  at (-132, 92, 17) (RCON execute-if-block); **all five announcements landed
  in world chat and were heard as ChatObserved percepts** ("Set up a
  crafting table at (-132, 92, 17).", "Crafted a wooden sword!"). MSPT ~7.8
  avg after; 12 containers healthy; fleet ticking.
- **Live wart found and fixed same session**: the deliberate sword failure
  first taught "2 CHERRY planks" — an equal-shortfall recipe-variant tie
  llama would chase literally. `cheapestGaps` now tie-breaks by pack
  affinity (ingredient carried, or its log/planks precursor carried);
  regression test cites the live case (`2ef058a`, redeployed before the
  sword run above).
- **DIFFICULTY ERA FLIP (same session, Parker's call: "flip difficulty to
  easy and deploy")** — the world is now on **EASY with the training wheels
  ON**, via the plan's closed-loop procedure: gamerules first
  (keepInventory→true, doInsomnia→false, mobGriefing→false), RCON
  `difficulty easy`, `save-all flush`, **deliberate Paper restart, then all
  four RCON-verified on the rebooted world** (level.dat persistence proven,
  not assumed). Fleet auto-reconnected after the restart. compose
  `DIFFICULTY: easy` now seeds future worlds (comment carries the post-nuke
  re-apply warning — a nuked world boots easy with DEFAULT gamerules).
  **Known exposure, accepted with the call**: no eat reflex until SV-6 —
  food drains and pins (easy starvation floors at 10 HP; no starvation
  deaths, but regen stops below 18 food); no threat
  perception/combat/flee until Sprint 11 — night mobs WILL kill villagers;
  deaths are material-lossless (keepInventory) and bodies auto-respawn, but
  minds cannot perceive death until SV-15/16 lands (ghost deaths, no
  memories formed). **No stack-down volume backup was taken (SV-5b's gate)**
  — run it before leaving the stack unattended for long, and REQUIRED before
  the Sprint 12 ceremony. The ceremony still removes the wheels on camera —
  never flip keepInventory off as a session side effect.
- **NEXT: Parker merges PR #33** (then optionally `up -d --build --no-deps
  minecraft-service` from main + `spawn-fleet.mjs` for provenance), then
  **SV-4 — crafting brain**: DELIBERATE_ACTIONS + `_PARAMS_DEF_BY_ACTION`
  for craft, SYSTEM_TEMPLATE recipe-chain affordance prose, the per-verb
  timeout table with `TIMEOUT_TABLE_MAX_MS=60_000` (load-bearing, ruling 2),
  FakeProvider co-update, prompt tests, llama go/no-go smoke ("N real
  decisions emit valid craft"). Strong candidates to pull forward given the
  easy era: SV-5b (backup + runbooks) and SV-6/SV-7 (eat reflex + hunger
  brain) — the fleet is hungry NOW.

## Session 2026-07-16 — docs-only: README refresh (PR #31 merged)

Docs housekeeping, no code or deploy. The root README had drifted to the
Sprint 1 walking-skeleton checklist; refreshed it to reality — M1 complete,
M2 governance merged (Mayor Bram seated), Survival cluster in flight
(SV-1/SV-2 merged, SV-3/SV-4 next, filming gate noted). Layout now lists the
five real services; added the government-service CI badge (verified the
workflow exists); pointer to this file for live state. Merged as PR #31
(squash `a1e7002` on main). Survival status is unchanged — next code session
is still SV-3 (craft verb, body).

## Session 2026-07-12 (later) — PR #28 merged · SV-2 shipped (sustained gather sessions, PR #29)

Second Survival code session, continuing straight from the SV-1 handoff.
**Deploy-free again** — the live stack was untouched all session; the
filming gate holds.

- **PR #28 merged first** (squash `1915e6d`, CI green, branch deleted
  remote-side; the local branch lives on in the powder-snow worktree and
  refused deletion — harmless). The SV-1 session's HANDOFF + CLAUDE.md
  edits rode that squash, so main's docs were already current.
- **What shipped** (`SV-2: sustained gather sessions (body)`, branch
  `claude/sv-2-sustained-gather`, commit `864c155`, PR #29, closes #8), all
  minecraft-service:
  - **`runGatherSession` (new `world/gatherSession.ts`)** — the count loop
    as pure orchestration (every world touch injected, so partial hauls /
    first-block failure / watchdog abandonment are unit-tested botless):
    pick→dig→collect per block up to GatherParams.count (executor clamps
    1..8 mirroring the contract; the cap is ruling 2's load-bearing
    ceiling). A FIRST-block failure fails the command with the coded
    prescriptive error exactly as before; a LATER failure ends the trip as
    an honest partial-haul completion with `stoppedEarly` carrying the why
    ("I brought back 3 of 5" is a completion, not an error). **One
    ResourceGathered per attempted block** — mid-session timeout loses no
    ledger facts; zero-collect ghost blocks stay in the record.
  - **Wedge-safety with zero new machinery**: the executor's busy seam
    doubles as the session's cancellation signal — when the watchdog clears
    `busy='action'`, the abandoned zombie loop stops at the next block
    boundary and goes SILENT (no post-TIMEOUT haul announcements — the mind
    already heard the failure). Zombie exposure stays ≤ the in-flight
    block, identical to the single-block gather.
  - **One announcement per haul**: departure line once per trip ("…first of
    up to 5."), `haulAnnouncement` aggregates by block type ("Gathered 3
    spruce logs and 1 oak log!") and replaces the per-dig
    `gatherAnnouncement`. Per-block blacklist semantics unchanged
    (mark-before-attempt, clear only on that block's own collected>0).
  - **Prescriptive TIMEOUT prose** (`timeoutMessage` in executor.ts): the
    bare `no outcome within Nms` is gone — gather timeouts name the
    count/maxDistance levers, move/follow teach nearer destinations, every
    verb gets teaching prose. The gather result now reports
    `{collected, blocksDug, attempts, byType, stoppedEarly, requested, …}`
    (prompts render the JSON verbatim — no agent-service change needed).
  - **Deploy-safe by construction**: nothing advertises `count>1` to the
    LLM until SV-4's brain commit; default 1 reproduces today's behavior.
  - Tests **117→134** (9-test session-loop suite incl. zombie-abandonment;
    announcement + executor coverage extended), typecheck clean, **all six
    suites green** (`task test`, jacoco gates passing).
- **War story (machine, new gotcha in CLAUDE.md): the Claude-harness pruned
  this session's own worktree TWICE mid-session.** First right after a
  branch checkout — working dir emptied AND deregistered (recovered:
  `git worktree add` again; the branch survived). Second time only
  `.git\worktrees\<name>` (the metadata dir) was deleted while every
  working file survived (recovered: recreate `HEAD`/`commondir`/`gitdir` by
  hand, then `git reset` to rebuild the missing index — status showed
  exactly the expected 7 files). Commit + push PROMPTLY in worktree
  sessions; the working files are the only unrecoverable part.
- **NEXT: SV-3 — craft verb (body)**, the sprint's L ticket:
  recipesFor/craft flow, crafting-table acquire/place, prescriptive failure
  prose (missing ingredients name the gap), ajv payload tripwire, tests;
  pre-committed valve = stone tier slips to Sprint 10. Then SV-4 (crafting
  brain + per-verb timeout table with TIMEOUT_TABLE_MAX_MS=60s + FakeProvider
  co-update + llama go/no-go smoke). Episode 2 filming still precedes the
  first Survival DEPLOY.

## Session 2026-07-12 — SV-1 shipped (Survival contract commit A, PR #28) + reboot recovery

First Survival code session. **Deploy-free by design** — nothing new runs in
the fleet; the filming gate is untouched.

- **What shipped** (`SV-1: contract commit A — craft verb + sustained-gather
  count`, branch `claude/sv-1-contract-commit-a`, commit `907873c`, PR #28,
  closes #7):
  - **ActionRequested.v1 (all additive)**: action enum += `craft` (the enum
    description now records the NO-eat-verb ruling in the contract itself);
    new flat `$defs.CraftParams` (ruling 5 strict-mode shape) — `item` enum
    planks|sticks|crafting_table|wooden_axe|wooden_pickaxe|wooden_sword|
    stone_axe|stone_pickaxe|stone_sword|furnace, required,
    additionalProperties:false. planks/sticks are wood-type-abstract families
    (the GatherParams resource-family precedent); the stone tier rides the
    contract NOW even if SV-3's valve slips its body implementation; leather
    armor joins the enum with commit C (SV-11). **GatherParams.count**
    (integer 1..8, default 1) — SV-2's sustained-session lever; its
    description carries the load-bearing cap rationale (a full session must
    fit inside TIMEOUT_TABLE_MAX_MS = 60s, ruling 2).
  - **Fixtures thread the Sprint 9 filmable beat** on Elara's story
    correlation: gather{wood, count:3} → craft{crafting_table}, with fresh
    unfixtured DecisionMade causation ids (a decision never double-books two
    world actions — the governance fixture's a002 reuse is legit only
    because a civic rider shares its tick). Invalid fixture =
    craft{item:"diamond_sword"} (the deferred iron+ tier, pointedly).
  - **validate.mjs now validates command fixtures' params against the
    canonical per-action $defs.** Wire params stay free-form by design (the
    seam validates pre-publish) — this harness check is what makes a
    params-level invalid fixture possible at all. Maps mirror agent-service's
    `_PARAMS_DEF_BY_ACTION`/`_GOVERNANCE_DEF_BY_ACTION`; despawn/idle enforce
    `{}`; and a valid-enum action MISSING from the map fails LOUD — contract
    commits B/C/D cannot forget to wire hunt/cook/set_stance shapes in.
    Bonus: the pre-existing move + vote fixtures are now provably
    $defs-conformant (they were unchecked before).
  - `task gen` output committed (TS union += craft; py models += CraftParams/
    Item + count; the CRLF-only churn datamodel-codegen writes on Windows
    normalizes away at git add — only real diffs staged). 03-catalog
    ActionRequested row updated. Executor pre-verified safe: run()'s default
    case answers a premature craft with honest UNKNOWN_ACTION; nothing
    advertises craft until SV-4.
  - **Tests: all six suites green** — contracts 26 fixtures (3 new), mc 117
    + typecheck clean, agent 143, memory 46, event + government gradle
    (jacoco gate passing).
- **The machine had REBOOTED between sessions** (all 12 containers Exited
  (255) simultaneously — the recorded engine-death fingerprint; 2026-07-11's
  "stack RUNNING" didn't survive the night). Docker Desktop then wedged on
  relaunch — **new variant, added to CLAUDE.md**: NO socket-bind error in
  the backend log this time; the tells were the docker-desktop WSL distro
  stuck Stopped, a com.docker.diagnose process, and the GUI polling
  ErrorReportAPI /diagnostics/status in a loop. The standard ritual (kill
  sweep → rename BOTH dirs → verify gone → relaunch) recovered it first try,
  no zombie race; engine 29.6.1 up ~90s later.
- **Stack recovered to the recorded steady state, body-before-mind, from the
  MAIN repo** (a worktree compose attaches to the same project — recovery
  must not deploy worktree code; plain `up -d` reuses the main-built images,
  so deployed provenance stays main): `task up` (infra healthy, topic map
  converged) → Paper `--profile minecraft up -d --wait` (world volume
  intact; connection-throttle −1 held — **20/20 bots back in <1 min** after
  `node scripts/spawn-fleet.mjs`) → app minus agent-service → minds last.
  **Verified: 12/12 containers healthy, fleet 20/20, ticks landing on warmed
  Ollama (Maren chat tick 3.2s, memories 201-Created), election canon
  intact (GET /elections returns the decided mayoralty), MSPT avg ~18 ms
  minutes after world-load (max 150 = the boot spike; read the avg).**
  Ollama itself survived the reboot (Windows autostart).
- **Still down (deliberately)**: the Next.js dashboard host process (port
  3000) — dies with every reboot; restart is
  `npm run dev --workspace @civ/dashboard` (or launch.json `dashboard`).
  The 2026-07-11 mayor-line amnesia note stands (in-memory civic cache
  empty until the next ElectionDecided; government_db canon intact).
- **NEXT: SV-2 — sustained gather sessions (body)**: count loop
  (pick→dig→collect per block), per-block blacklist marks, one announcement
  per haul, prescriptive TIMEOUT prose, wedge-safe within the existing
  watchdog. Then SV-3 (craft body, valve: stone tier → Sprint 10) → SV-4
  (crafting brain + the per-verb timeout table with TIMEOUT_TABLE_MAX_MS).
  Sprint 9's body lane is SINGLE — SV-2 and SV-3 run sequentially. Episode 2
  filming still precedes the first Survival DEPLOY.

## Session 2026-07-11 (later) — Survival cluster planning (ultracode): plan doc, Milestone + issues, pvp spike NO-GO

Planning-only session (per Parker's brief; pre-recorded decisions honored, not
re-litigated). Docs on branch `claude/survival-plan-architecture-975240`;
spike artifacts on `spike/mineflayer-pvp` (throwaway, never merged).

- **The plan: `docs/architecture/09-survival-plan.md`** — 4 sprints (9–12) + a
  named stretch ticket (SV-9 cook), 21 tickets SV-1…SV-18 (incl. SV-5b ops
  gate, SV-11.5 skeleton commit, SV-12a/b two-module body split), honest
  arithmetic + pre-committed valves per sprint, rollout staging with
  closed-loop difficulty/gamerule procedures, cluster DoD (ceremony = full
  night/day cycle, wheels off, zero deaths, filmed), risk register. Built
  ultracode-style: 5-lane recon → 4 design judge panels (3 lenses each) on the
  genuinely open questions (eat thresholds/priority, threat-watcher
  architecture, flee heuristics, hunt targeting) → adversarial review vs the
  actual code: **57 findings → 52 confirmed and integrated.** Biggest: the
  "restart-reverts-difficulty" failsafe was UNSOUND (autosave persists it);
  DoD 2 was unprovable as first written (per-tick correlationIds; reflex eats
  are deliberately ledger-silent); FakeProvider must be co-updated with any
  new required DECISION_SCHEMA key (the governanceAction precedent); baby
  exclusion by entity.height can never fire (mineflayer never rescales it).
- **Panel headlines** (full briefs in the plan doc): eat is REFLEX-ONLY (no
  eat verb — a tick buys one world action; acquisition is the mind's job);
  the starvation crisis reuses HazardEncountered{hazardType:'starvation'} so
  trapped-wake/directive/memory-fold plumbing is free; BusyState grows to
  'action'|'escape'|'combat'|'eat', priority escape > combat > eat > commands,
  BUSY_BOUNCE table (new errorCodes BODY_BUSY, SELF_DEFENSE_IN_PROGRESS,
  TARGET_ESCAPED); ThreatEncountered.v1 (spotted|engaged|killed|escaped|
  overwhelmed, victim-only, wakes on spotted+overwhelmed only); fight/flee =
  pure decision table + LLM-settable survivalStance (brave|cautious,
  required-nullable rider, change-gated + flip-hysteresis); fleet fight cap 4
  (0 = flee-only rollout stage); hunt = one animal per action, ResourceGathered
  reused, herd depletion = accepted narrative with diegetic brakes only.
- **mineflayer-pvp spike: NO-GO** (ephemeral Paper 1.21.6 container, 20 bots,
  tickTimeout=10; full table in plan §spike): hand-rolled kill loop ≈ **101%**
  of pvp's TTK (criterion 5 alone decides); the nested duplicate
  mineflayer@2.41.0 is NOT cleanly prunable (override leaves it `invalid`, or
  on a fresh lockfile drops mineflayer-utils and pvp fails at require);
  stopMoving() alone leaves pvp swinging (3 swings/2s — the watchdog cancel
  lever can't reach it). Keeper numbers regardless of implementation: pursuit
  event-loop p99 38.8ms @5 concurrent but **141.8ms @20** →
  THREAT_MAX_CONCURRENT_FIGHTS=4 validated. armor-manager works on 1.21.6 but
  loses to ~15 hand-rolled lines (non-adopted known-good fallback).
- **Spike rides (future tickets de-risked):** an RCON difficulty change
  PERSISTED across a graceful restart after one autosave interval, no
  save-all — bounded windows close ONLY by explicit revert + save-all +
  verify; entity tracking reaches ≥64 blocks (hunt maxDistance 32 = chase
  budget, not sight); baby flag = metadataKeys index 16 on 1.21.6 (calf and
  adult heights identical at 1.4); summoned zombie reads kind='Hostile mobs'.
- **GitHub:** Milestone **"Survival"** (#1) created; `pre-survival` tag pushed
  at `812ee6e`; 21 issues SV-1…SV-18 created under the milestone (condensed
  ACs + pointer to the plan doc).
- **Machine state:** the live stack was untouched all session (12 containers
  healthy, fleet ticking; the spike ran against a separate `civ-spike-paper`
  container + `civ-spike-mc-data` volume — both removed at session end).
  Worktree node_modules were installed for the spike; the plan branch carries
  ONLY docs (package.json/lockfile spike changes live on the spike branch).
- **NEXT: Parker approves the plan**, then implementation begins at SV-1
  (contract commit A). Before ANY Survival deploy: **film Episode 2**
  (docs/demo-m2.md; remove the live COMMUNITY_GOAL line from .env + restart
  agent-service; the filmed election is a re-election unless a nuke — with the
  re-apply checklist — precedes it).

## Session 2026-07-11 — powder-snow escape reflex + hazard awareness (PR #5, branch `claude/villagers-snow-stuck-e20104`)

Villagers were sinking into powder_snow on the frozen peaks and freezing
forever (peaceful regen outpaces freeze damage; pathfinder can't model the
block — `boundingBox: 'empty'` in minecraft-data, and `blocksToAvoid` is the
only lever, previously unset). Fix = reflex in the body + awareness in the
brain, built by **two parallel Claude instances in separate worktrees**
against a shared contract commit, merged at `9819cd8`:

- **Contract `ccb58a2`**: `HazardEncountered.v1` on world.events
  (`phase: trapped|escaped|escape_failed`, hazardType, position, detail) +
  `HAZARD_ESCAPE_IN_PROGRESS` added to the ActionFailed errorCode enum.
- **Body `80c8f5a` (minecraft-service)**: `hardenMovements` puts powder_snow
  in pathfinder blocksToAvoid; per-bot `HazardWatcher` (env
  `HAZARD_WATCH_INTERVAL_MS=1500`, 0 disables; O(1) feet/head reads, 2-pass
  debounce, single-flight) runs trap **episodes**: `trapped` emitted once,
  escape = dig own head/feet → tunnel to a solid-floored neighbor →
  raw control-walk (NEVER pathfinder mid-trap), Promise.race'd
  (`HAZARD_ESCAPE_TIMEOUT_MS=25000`), `HAZARD_DIG_BUDGET=12`, 15s retry
  backoff. New `busy` seam on SessionActions: executor claims
  `busy='action'` around its watchdog race; commands arriving mid-escape
  bounce fast with HAZARD_ESCAPE_IN_PROGRESS (retryable, never blocks
  eachMessage). `civ_hazard_escapes_total{outcome}`.
- **Brain `808db95` (agent-service)**: freshness-guarded percepts to the
  victim only; `trapped` also fires the reactive-tick hook; prompt gets
  phase lines + a grudge-style survival directive; reflect node folds the
  episode with coords into the tick memory (else it'd never reach pgvector).
- **Tests**: 306 green across all six suites (mc 117 incl. 15-test hazard
  suite with ajv payload-vs-schema validation + wedge safety; agent 143).
- **LIVE-VERIFIED** (deployed worktree images body-before-mind, `task seed`,
  fleet 20/20, Parker in-world): Maren respawned naturally sunk at
  (-30,133,44) → dug 1 block, free in <1s → next tick reasoned "a matter of
  survival and safety", moved away, memory formed with coords. Quill ×2
  natural rim traps closed via the incidental-freedom path ("came free
  without digging"). Ledger: 6 HazardEncountered, 3 clean trapped→escaped
  pairs, 0 dangling, 0 escape_failed. Vertical self-dig kept winning because
  it IS optimal for those geometries; the lateral tunnel remains unit-proven
  only — fine, escape_failed+retry converges regardless.
- **Deployed state**: MERGED as squash `f4e75cd` (branch-cited SHAs live on
  in the PR page); minecraft-service + agent-service rebuilt from main
  post-merge and the fleet re-seeded — deployed provenance = main.
- **Watch-fors**: falls/descents can still land a bot through powder snow
  (avoidance only shapes walked paths) — the reflex is the designed backstop.
  If filming shows tunnel walk-stalls, the `HAZARD_*` envs are the levers.
  Test artifacts left in-world (biome-plausible, inert): ~26 powder-snow
  blocks near (-21,147,20), ~8 near (-99,95,-72) — `fill … air replace
  powder_snow` removes them if unwanted.

## Sessions 2026-07-09 night → 2026-07-11 — materials & inventory kit, rejoin/null-param fixes, three crash recoveries (PRs #2–#4)

One arc across several crash-separated sessions. All merged; `main =
origin/main = 16f6f45`; CI green throughout.

- **Materials & inventory kit (PR #2 → `0d46994`)**, built while Parker
  played live: minecraft-service grew one process-wide `InventoryPoller`
  (15s; `INVENTORY_POLL_INTERVAL_MS`, 0 disables) — bots are free in-memory
  `bot.inventory.items()` reads; **human players are read over RCON**
  (hand-rolled ~150-line Source-RCON client in `src/rcon/rcon.ts`, no new
  dep; compose-internal `minecraft:25575`, password default `civ_rcon`, env
  `RCON_HOST/PORT/PASSWORD` on minecraft-service; unreachable RCON degrades
  to bots-only). New metrics: `civ_player_inventory_items{player,item,kind}`
  (gauge, stale series removed), `civ_materials_collected_total` (counter =
  positive deltas), `civ_players_tracked{kind}`, `civ_inventory_polls_total`.
  **Honesty invariants in `InventoryTracker`** (the FakeProvider lesson,
  applied to metrics): process-global per-SPAWN generation (bumps on
  reconnect AND death-respawn — mineflayer re-emits 'spawn' on the same
  connection; a persistent handler, not the once()) re-baselines, and the
  first TWO observations of a generation never count (post-spawn inventory
  sync would otherwise book the whole inventory as a haul). Two RCON
  gotchas measured live and now in CLAUDE.md: `data get` output is
  ELLIPSIZED server-side past ~150 chars (per-slot `Inventory[i].id/.count`
  probes are the only reliable read), and the Inventory NBT is a DENSE list
  that reindexes mid-scan → single passes tear → **scan twice, accept only
  two identical passes** (`fetchHumanInventoryStable`; discarded cycles
  lose nothing — deltas compare against the last ACCEPTED scan). Dashboards:
  `civ-materials` ("Materials & Inventory": leaderboards, rates, live
  per-player inventory tables, `player` template var) + a full-width
  top-collectors bargauge on `civ-overview` (PR #4 → `16f6f45`). An
  ultracode adversarial review (4 lenses × 2 skeptics) caught **3 real
  majors pre-deploy**: torn-scan phantom hauls, the death-respawn
  re-baseline bypass, an RCON socket leak on auth timeout. 27 new ts tests.
  Accepted caveats: ≤2 polls blind per spawn; re-collected death drops
  count again. Known undercount: none — but "collected" includes crafting
  outputs and pickups, not just digs (by design; ResourceGathered still
  ledgers gather hauls separately).
- **`.env` pins `LLM_PROVIDER=ollama`** (was `openai` + empty key, silently
  falling back): closes the footgun where dropping an OPENAI_API_KEY into
  `.env` would activate the strict-mode-broken params path (M2-7 finding —
  reshape before any OpenAI run remains an M3 gate).
- **Kafka rejoins + llama null-params fixed (PR #3 → `f05a41d`)**: the 8×
  "coordinator is not aware of this member" per session were pathfinder A*
  slices (synchronous, 40ms/physics-tick default, ×20 bots) starving
  kafkajs heartbeats. Consumer now runs `sessionTimeout: 60s` /
  `rebalanceTimeout: 90s`, and pathfinder budgets are config
  (`PATHFINDER_TICK_TIMEOUT_MS=10`, `PATHFINDER_THINK_TIMEOUT_MS=10000` —
  same total compute, loop breathes). llama's `"maxDistance": null` (~7% of
  ticks → idle fallbacks) is fixed at the tolerant-reader seam: null-valued
  params are stripped pre-validation (required-nulls still fail, as
  "required"); the gather affordance stops advertising maxDistance (the
  recorded lever — executor defaults to 48). **Live-verified in a 15-min
  window: 0 rejoins, 0 `params invalid for gather`**; collection pace
  visibly up post-fix (Bram 62 items in ~35 min vs Petra's chart-topping 21
  in 45 min the day before). Residual malformed (~5/window) is other llama
  drift, safely idle-falling.
- **Ops war stories (all documented, all recovered):**
  - Docker engine restarted itself mid-demo-startup (fresh uptimes across
    all containers) — silently disembodied the fleet (in-memory sessions);
    `task seed` re-embodied. The replaced minecraft-service container had
    quietly accumulated RestartCount=5 during the blip era.
  - Parker's PC hard-crashed: `.git/config` truncated to 492 NUL bytes
    (rebuilt by hand — core+origin+branch sections suffice; fsck clean) and
    Docker Desktop needed the CLAUDE.md socket-rename ritual INCLUDING the
    recorded zombie-recreation race (`docker-secrets-engine` reappeared
    after the first rename; second kill-sweep + re-rename cleared it).
  - **New machine gotcha:** a Claude session can hand background bash
    scripts a raw un-converted Windows PATH (semicolons, `C:\...`) — curl/
    docker/sleep all silently fail and the resulting monitor false-alarm
    storm looks EXACTLY like a stack outage (burned ~20 min chasing ghost
    anomalies while the stack was healthy). Every monitor script now starts
    with `export PATH="/usr/bin:/mingw64/bin:/c/Program Files/Docker/Docker/resources/bin:$PATH"`.
  - The Next.js dashboard (port 3000) is a HOST process, not a container —
    it does not survive reboots and nobody notices until
    ERR_CONNECTION_REFUSED. Restart: `npm run dev --workspace @civ/dashboard`
    (or `.claude/launch.json` name `dashboard`). Local Grafana (3001) is
    `admin`/`admin` — NOT Parker's grafana.com Google account (bit once,
    now answered here).
- **Story color for Episode 2 pulls:** Mayor Bram leads the current
  woodpile drive from the front (62 items; 25 dark oak logs); Fen owns the
  24h board (76, nearly all dark oak); the COMMUNITY_GOAL woodpile line is
  visibly working (130+ dark oak logs across five villagers); Ansel and
  Hollis have identical 48-clay-ball hauls — same riverbank, digging side
  by side. Petra's day-one dirt dynasty (14 dirt) did not survive the era.
- **Machine state (2026-07-11, session end): stack RUNNING** — 12/12
  containers healthy, fleet 20/20 ticking on warmed llama3.1:8b
  (`LLM_PROVIDER=ollama` now explicit), reflections on, election canon
  verified intact after every restart (GET /elections still returns Mayor
  Bram's full 20-candidate record), both Grafana dashboards live, Next.js
  dashboard dev server running. Health watchdogs are session-bound Monitor
  tasks — they DIE with the Claude session; re-arm on resume (PATH export
  first, see gotcha above).

- **The merge (morning-after housekeeping):** local ff-merge of the M2 branch
  met Parker's own GitHub-side PR #1 merge (`3d5c166`, tree bit-identical to
  the tested `5c11ba3`) — local main ff'd onto it, no rebase, all cited SHAs
  intact; `main = origin/main = 3d5c166`; **all 7 CI workflows green** on the
  merge (government-service's first Linux CI run passed — the gradlew exec
  bit held). Prometheus restarted post-merge → the M2-6-deferred
  government-service scrape job is LIVE (11/11 targets up). Branch + its
  `.claude/worktrees` worktree deleted local+remote (worktree was clean).
- **The stack had died silently ~15:00 EDT** (every container Exited 255
  simultaneously = Docker engine/machine event, hours after the rehearsal —
  the fleet had ticked unattended all day; canon safe in volumes). Rebuilt in
  body-before-mind order: infra → topics → Paper (`connection-throttle: -1`
  survived) → app minus agent-service → `spawn-fleet` → minds last. The
  M1-10 STALE_COMMAND guard correctly ate 11 pre-crash commands (~12.7h old)
  on reboot. Reflections drained the day's backlog at exactly the 12-runs/hr
  global cap (35 insight events = 12 runs — the cap bounds LLM runs, not
  insights; verified 12 distinct villagers).
- **Parker watched in-game; report was "they just talk, no gathering" — the
  ledger disagreed** (gathers were happening on the NW slope, away from the
  plaza chat cluster). Root causes found and fixed as the **gather kit**
  (all in minecraft-service; ts tests 53→64, typecheck clean, all six suites
  green at this commit):
  - **Gather announcements** (`gatherStartAnnouncement` / `gatherAnnouncement`
    in `world/resources.ts`, spoken in `BotSession.gather`): "Heading to
    gather wood — spruce log at (x, y, z)." on commit (AFTER the fail-fast
    checks — an announced dig is always attempted), "Gathered 2 spruce
    logs!" on a real haul (silent on zero). Parker's flow: see chat →
    `/tp <name>` → spectate. Announcements are world-visible chat → other
    villagers hear them as percepts (hauls became social information).
  - **Per-bot gather-target blacklist** (`pickGatherTarget`/`targetKey`;
    findBlock → findBlocks(16) + post-filter): mark-before-attempt,
    **cleared only on collected>0**, 10-min TTL. Kills the deterministic
    re-pick loop (measured live: one unpathable slope spruce ate 5+
    watchdogs across 3 villagers, drawn from up to 27 blocks; Maren picked
    the identical block 3 ticks running; post-fix Nils visibly skipped his
    marked block, and Ulric — 4 straight timeouts — completed a dig on his
    next attempt). When every candidate is marked:
    `allTargetsBlacklistedMessage` = honest "the wood in sight keeps
    defeating you from this spot — move somewhere new" (recruits the M2-3
    relocation behavior; llama took the hint live).
  - **Drop-chase collect**: if inventory delta is 0 after the dig+wait, find
    the nearest `item` entity within 8 blocks and walk to it (try/caught —
    a failed chase still ends as an honest completion). Slopes were rolling
    ~40% of drops away from the dig spot.
  - **GHOST-BLOCK FINDING (the night's discovery, M3 ticket):** RCON proved
    `(-16, 144, -16)` is STILL spruce_log after THREE "successful" qty-0
    digs by different villagers — **Paper silently rejects some cliff-face
    digs** (client thinks it broke, server disagrees, no drop ever exists).
    That's why the collected>0 condition on blacklist-clear matters: a
    zero-collect completion keeps the mark, so a ghost block taxes each bot
    once per TTL instead of forever. M3 candidates: post-dig `blockAt`
    verify (the server sends a correction packet), tree-column blacklist
    marks (per-block granularity pays one watchdog per log of a bad tree),
    collect-step upgrades.
  - **D2 lever pulled: `COMMUNITY_GOAL`** ("laying in a great winter
    woodpile - every able hand gathering logs between errands") **is now in
    `.env`** — gather attempts jumped fleet-wide. **REMOVE the line +
    restart agent-service before filming organic politics.**
- **Live result:** ~25 logs banked organically in ~75 min (Elara 5, Bram 5,
  Juniper 4, Ansel 3 dark-oak ranging 120 blocks east, Cassia/Tansy/Maren…),
  announcements streaming in chat, depletion→relocate and
  blacklist→move-on loops both observed end-to-end. Four
  minecraft-service deploys tonight (each = fleet respawn via spawn-fleet;
  minds paused during each — the body-before-mind choreography).
- **Machine state: FLEET TICKING on the full kit** — 12 containers healthy,
  minds on ollama (warmed) w/ 20 tick loops + COMMUNITY_GOAL, budget 100M.
  **Mayor-line amnesia**: the crash+restarts wiped the in-memory civic
  cache, so "The village mayor is Bram" is absent from prompts until the
  next ElectionDecided (memories of the campaign persist; government_db
  canon intact). Election/relationship canon untouched all session.
- **Next: Episode 2 filming (Parker)** — remember: remove COMMUNITY_GOAL
  first, filmed election is a re-election (or `task nuke` + re-apply
  connection-throttle). Then **M3 planning** (living law + the recorded
  prompt levers + tonight's gather-robustness list).

## Session 2026-07-09 ~02:05–03:55 EDT — M2-10 shipped: the dress rehearsal elected a mayor

- **What shipped** (`M2-10: election day — gate, steering lever, demo, and
  the rehearsal`):
  - **jacoco gate ON for government-service** (M1-10 pattern): one aggregate
    LINE ratio ≥0.80 over adapter.in/** + application/** +
    adapter.out.persistence/** (measured **92.3%** at gate time), wired
    `finalizedBy(test)` so CI's fixed `gradlew test bootJar` enforces it;
    the Kafka out-adapter stays measured-but-ungated (the SSE-relay analog,
    same scoping call as event-service). `task test` = six suites, all
    gates green — **M2 DoD #7 ✅**.
  - **D2 steering lever staged**: `COMMUNITY_GOAL` env → one system-prompt
    line ("The village talk lately keeps returning to one shared aim: …"),
    OFF by default, plumbed settings→TickDeps→system_prompt→compose
    (+prompt test, agent tests 129→130). Influencer personas documented as
    villagers.json edits (zero code). Both levers are in demo-m2.md with
    the warning: pull BEFORE opening an election, never during (the
    restart-forgets rule).
  - **`docs/demo-m2.md`** — the Episode 2 shot script: 7 money shots
    (the announcement, someone steps forward, campaign chatter, the
    receipts, the double vote that wasn't, election night + the mayoral
    address, the why-did-she-vote replay), health commands, teardown, and
    the DO-NOT-SET-OPENAI_API_KEY warning (strict-mode params bug).
- **THE DRESS REHEARSAL — the arc ran itself, organically, first try:**
  - Deploy: `up --build agent-service` ended the four-milestone image gap;
    boot chain `ollama (warmed)` (the .env's `LLM_PROVIDER=openai` + blank
    key degraded correctly — NOTE: do NOT add a key before the params
    reshape), 20 tick loops, civic consumer subscribed. Warmup action mix
    over the first fleet round: 16 move / 2 gather / 2 chat / 1 idle — the
    M2-3 rebalance visible in the wild.
  - **One seeded act**: `POST /elections {}` (defaults 600s/900s) at
    07:20:24Z. Everything after was the villagers'.
  - **Nominations**: ALL TWENTY villagers declared candidacy via the
    command plane, each with a platform in their own voice — Vesper the
    night-watch ("I have observed and learned from many of you"), Gideon
    inventing credentials ("my experience as a close advisor to Elara"),
    Tansy running on food access. Juniper told her bees the news; Vesper
    campaigned in watch-idiom. **A 20/20 field is the affordance being TOO
    persuasive** (llama agreeableness, the 0/4→4/4 sensitivity in the
    other direction) — filming tune: soften to "if the office calls to
    you…" or shorten nominations; recorded as the M3 prompt lever.
  - **Voting**: 20/20 organic votes in the 15-minute window — **Bram won
    10 of 20** in a twenty-way field (absolute majority), on the M1 canon:
    his platform claimed "experience with the miller's family," and
    Elara's vote reason echoed the line back — **the campaign message
    propagated through the village and won the election.** Four self-votes;
    Ines and Wren took 2 each. Zero operator input after the open.
    **M2 DoD #1 ✅ (20≥2 candidacies, 20≥10 votes).**
  - **The clock decided at 07:45:24Z**: Mayor Bram, governments row seated
    (`governmentId=019f45d6-…`), ElectionDecided broadcast to every mind;
    "You are the mayor of the village." now stands in Bram's every prompt.
  - **DoD #2 ✅ — the replay**: ONE correlationId returns Elara's entire
    civic tick from the ledger: DecisionMade (mid-storm-plot reasoning) →
    ActionRequested + **GovernanceRequested** + VillagerTalked (the
    single-call multi-plane tick, live) → VoteCast with her stated reason
    ("Bram's dedication… and his experience with the miller's family") →
    3× RelationshipChanged → MemoryFormed → ActionCompleted. Chain:
    VoteCast ← GovernanceRequested ← DecisionMade, exactly as designed.
  - **DoD #3 ✅ — the double vote that wasn't**: zero organic ALREADY_VOTED
    during the window (nobody re-voted!); demo Shot 5 forced one on
    rehearsal data — tally 20 before AND after, `GovernanceRejected
    {ALREADY_VOTED}` in the ledger ("the first vote stands").
  - **DoD #6 (page half) ✅**: `/government` live through the whole arc —
    nominating countdown with the growing candidate roll, live tally,
    receipts feed, decided banner (screenshots taken mid-arc + at the
    decide). The episode-segment half is Parker's filming session.
  - **Health across the ~45-min deliberation run**: MSPT avg 7.0–7.5 ms
    (7× headroom), 21 players online throughout (Parker in-game), zero
    container restarts, 565 ticks (265 scheduled + **300 reactive** — the
    election chatter drove conversation; caps held), malformed ~7%.
  - **The top drift stat (M3 tuning target): `civ_llm_governance_dropped_
    total = 158`** — all arc long, llama kept inventing civic acts for
    FICTIONAL elections ('storm_preparations_election',
    'diamond-claims-dispute-election' — its own M1 storm/diamond plots!).
    The M2-7 validation seam ate every single one (only ~5 uuid-shaped
    misses reached the executor, earning honest UNKNOWN_ELECTION percepts).
    Zero invalid commands on the wire. The defense works; the prompt
    should still teach the exact id harder.
- **DoD #4 (gather ≥80%) and #5 (grudge ≥2h)**: mechanics shipped and
  measured in M2-1/M2-5 (gather live-proven; grudge cleared 3–5× in ledger
  projection); the camera-day numbers ride Parker's filming run alongside
  #6's segment.
- **Machine state: THE FLEET IS TICKING — the zero-pollution era is over
  by design.** 12 containers healthy; agent-service on the full M2 image
  (M2-3 prompts + M2-7 schema + M2-8 civics + M2-10 lever),
  `villager_count=20`, 60s ticks, reflections on, Ollama, budget 100M.
  The rehearsal's election is CANON: government_db holds the village's
  first government (Mayor Bram); agent_db/memory_db carry the campaign's
  memories and relationship moves. To pause the village:
  `docker stop ai-civilization-engine-agent-service-1` (bots stay
  embodied; restart resumes ticks — but a restart forgets any MID-FLIGHT
  election, so never pause during one). Ledger keeps everything.
- **Next: Episode 2 filming (Parker)** — `docs/demo-m2.md` start to
  finish; the world already has a sitting mayor, so the filmed election is
  a RE-ELECTION (Bram defends his office — arguably better drama; or
  `task nuke` for a fresh world at the cost of all canon, re-apply
  connection-throttle -1 after). After filming: M3 planning (laws/living
  law is the centerpiece; the M3 prompt levers recorded above: candidacy
  affordance softening, election-id emphasis vs the 158 drops,
  per-provider budgets, the OpenAI strict-mode params reshape).

## Session 2026-07-09 ~01:15–02:00 EDT — M2-9 shipped (dashboard /government page)

- **What shipped** (`M2-9: dashboard /government page`):
  - **government-service** (small, additive): `GET /elections?limit=`
    (newest first, tallies included, votes omitted) — the dashboard's
    bootstrap; the deliberate M2-6 "no list endpoint" cut ended here, 04
    table updated. `CandidateDto` gains `platform` (plain prose, unwrapped
    from the jsonb string scalar) — the REST plane now shows the campaign
    promises the wire events already carried. Tests 28→29 (newest-first +
    votes-omitted assertions); container rebuilt live.
  - **dashboard**: `/government` page + `components/Government.tsx` in the
    M1-5 house style, plus one refinement: **SSE is the poke, react-query
    is the truth** — civic events (ElectionStarted/CandidateNominated/
    VoteCast/ElectionDecided) trigger a DEBOUNCED (800ms) query
    invalidation instead of hand-merged state, so a vote burst is one
    refetch and the tally can never drift from government-service (the
    graph hand-merges only because force layouts hate refetch resets);
    10s `refetchInterval` is the belt under the SSE suspenders (phase
    flips nominating→voting emit NO event by design — polling + the
    client countdown carry those). One EventSource per page (mounted by
    ElectionPanel), queries deduped across panels by react-query.
    Election card: phase chip, boundary countdown ("ballot box closes
    in 0:12"), window times, total votes; candidate rows with platform
    quotes, vote bars, "★ mayor?" leader marker during voting hardening
    to "★ mayor" + the emerald winner banner at decide; annulled banner
    with reason. **Vote-reasons feed** ("The receipts — why they voted"):
    newest-first, voter → candidate names resolved from the agent-service
    roster, reason verbatim, relative time. `/api/government/:path*`
    rewrite (`GOVERNMENT_SERVICE_URL`, default localhost:8082); nav links
    Overview ↔ Government ↔ Relationships; empty state explains the
    operator lever. Typecheck-only CI unchanged (dashboard caller already
    covers the paths).
- **Live-verified in a real browser** (preview server + live stack): page
  bootstrapped to the honest empty state ("No election has ever been
  called"), then — WITHOUT A RELOAD — followed a real contested arc driven
  through the command plane: candidacies appeared with platforms, phase
  chip flipped to voting with the countdown ticking, three reasoned votes
  landed in the tally (2–1) and the receipts feed (one early snapshot
  raced the 800ms debounce and showed 0 — the very next look showed 3;
  the poll would have healed it regardless), then the decided banner:
  "The votes are counted — Bram is the new mayor of the village."
  Screenshot taken; the page is episode-ready. Roster-truth note: the
  page resolved `d0009`→Juniper and `d0004`→Ansel — my smoke script's
  comments had guessed Tansy; **the page renders whatever the roster
  says, which is the point**. Smoke rows wiped after (government_db
  0 rows); all six suites green at the boundary.
- **Machine state: stack UP, 12 containers healthy**; government-service
  on the M2-9 image (list endpoint + platform in DTO). **agent-service
  container UNCHANGED and now FOUR milestones stale — M2-10's filming
  run MUST `up --build` agent-service first** (that deploy also brings
  M2-7's schema + M2-8's civic consumer into the running fleet).
  Narrative DBs untouched all session; ledger keeps the smoke's
  governance events (append-only, causationId-null dev-tool practice).
- **Next: M2-10 — election day (the M2 finale).** Full arc on the filming
  preset: `up --build` agent-service (+ memory-service unchanged, but
  `up --build` is the standard image-bake rule), operator opens the
  election ON CAMERA with the filmable windows (600/900 via env or POST
  body), nominations/campaign/votes fully organic (DoD #1: ≥2 organic
  candidacies, ≥10/20 organic votes), DoD evidence pulled from the ledger
  (per-vote causation chains — DoD #2), one live duplicate vote on
  camera-day data (DoD #3), jacoco gate extended to government-service
  (≥80 on adapter/application classes, `finalizedBy(test)` — the M1-10
  pattern; current coverage is healthy but UNMEASURED against that scope
  — leave slack), `docs/demo-m2.md` + Episode 2 shot list, D2 steering
  knobs staged as filming levers (`COMMUNITY_GOAL` env → one system-prompt
  line; influencer personas = villagers.json edits, zero code), HANDOFF.
  Reminders for that session: budget 100M for Ollama; `task topics`
  already provisioned; spawn-fleet.mjs re-embodies bots if the
  minecraft-service container gets recreated; open elections only while
  agent-service is up (the M2-8 restart-forgets limitation).

## Session 2026-07-09 ~00:20–01:10 EDT — M2-8 shipped (civic perception + affordances)

- **What shipped** (`M2-8: civic perception + campaign affordances`), all
  agent-service except one government-service ordering fix:
  - **`brain/civics.py`** — the in-memory civic working memory (M2-3
    awareness precedent, deliberately not durable): one live
    `ElectionCampaign` (office, three boundaries, candidates with
    roster-resolved names + platforms, voter set) + the standing `Mayor`.
    **Content-gated ingestion**: percepts age by delivery (ruling 7's guard,
    unchanged) but institutions age by their own clocks — a late-delivered
    ElectionStarted is accepted if its `endsAt` is still in the future,
    an expired one is ignored. Phase math is advisory (server is the
    authority; a boundary race earns an honest GovernanceRejected percept).
    **No ElectionAnnulled event exists by design — silence IS the signal**:
    an undecided campaign is hidden at close and forgotten after a 300s
    grace. ElectionDecided seats the mayor even when the campaign is
    unknown (restart amnesia), so the standing line self-heals one
    election late. KNOWN LIMITATION (accepted, documented): an
    agent-service restart mid-election forgets it (committed offsets never
    replay the news) — open elections while agent-service is up.
  - **Percept consumer** (`kafka/percepts.py`) — subscribes
    `government.events` alongside world.events (same group; new topic
    partitions start at `latest`, so the eventual redeploy meets no backlog
    surprise). Civic branch: cache ingestion BEFORE the staleness gate
    (content decides), percept fanout behind it (ruling 7). **Fanout rules**
    (the scoping decisions): ElectionStarted / CandidateNominated /
    ElectionDecided **broadcast to the injected roster** (id→name dict,
    refreshed on seed — the "injected like the scheduler hook" AC);
    percepts are **personalized at fanout** (`you: true` — prompts have no
    self-id); GovernanceRejected goes ONLY to its actor (private teaching);
    **VoteCast is cache-only, deliberately** — 20 villagers × 20 votes
    would evict the chat drama from the 20-cap queues, and ballots should
    influence through results, not herd signals; **civic events never
    trigger reactive ticks** (an ElectionStarted waking 20 minds at once is
    a GPU stampede; the 60s cadence carries the news within a tick).
  - **Prompt** (`brain/prompts.py`) — the standing "Village affairs"
    section renders from the cache every tick (percepts decay; an ongoing
    election must not), in the M2-7 smoke's proven 0/4→4/4 shape: stakes +
    deadline named, no polite out, "rides along with whatever else you do
    this turn". Affordances are window-gated AND actor-gated:
    already-voted / already-declared villagers see status lines instead
    (no ALREADY_* rejection spam); nominating offers declare_candidacy,
    voting offers vote, wrong-window affordances never leak (tested).
    Standing mayor line after the arc ("The village mayor is Bram." /
    **"You are the mayor of the village."** — M2-10's address line, free).
    New percept renderers under "Village news since your last turn"
    (candidacies with platforms, YOU-are-elected second person, rejection
    messages verbatim — they're prescriptive prose from the executor);
    unknown percept types still skipped (mixed-queue regression kept).
  - Wiring: `TickDeps.civics` optional-by-default; deliberate() passes the
    per-villager view; main.py injects CivicState + roster into the
    consumer (boot + seed). Tests 105→129 (+10 civics, +6 fanout,
    +7 prompt snapshots, +1 graph seam).
- **THE HARNESS CAUGHT A REAL BUG LIVE** (and it's fixed + regression-
  tested): government-service's `open()` registered the seeded candidacy's
  after-commit send BEFORE the announcement's, so `CandidateNominated` hit
  the wire before `ElectionStarted`; the civic cache (which keys
  candidacies to a known election) dropped the seeded candidate — **the
  voting prompt listed only the organic candidate; a real llama run could
  never have voted for a seeded one**. Fix: emit ElectionStarted first
  (same-key events share a partition, so consumer order = emission order);
  new integration test `seededCandidaciesAreAnnouncedAfterTheElection`
  (government tests 27→28); container rebuilt; wire order re-verified live
  (offsets: ElectionStarted then CandidateNominated). The general lesson is
  in the code comments: **announce the aggregate before its dependents —
  after-commit synchronizations fire in registration order.**
- **Live verify, zero-pollution** (the running agent-service container is
  UNTOUCHABLE — stale image, tick-less, and its consumer group must not be
  joined): a host-side harness with a GROUP-LESS consumer on the real
  `government.events` fed the REAL PerceptConsumer + CivicState (in-memory
  fake Redis — the live queues belong to the fleet) while a real election
  ran: Elara's rendered prompt tracked every phase live — nominating
  affordance → Wren's candidacy appearing with platform → the 4/4 voting
  text → "You have cast your vote" suppression after her real VoteCast →
  section vanishing at close → "The village mayor is Bram." after the
  decide. Queues: rejection reached only Elara, zero VoteCast percepts,
  `bram.you_are_mayor=True`. Bonus live proof: the arc ended 1–1 and the
  **tie-break (earliest registered) decided it** — the domain rule on
  camera-day rails.
- **Machine state: stack UP, 12 containers healthy**; government-service
  rebuilt again this session (emission-order fix); **agent-service
  container is now FOUR milestones stale (pre-M2-3 image; M2-7 schema +
  M2-8 civics not deployed)** — still `villager_count=0`, harmless, but
  M2-9/M2-10's first deliberation run MUST `up --build` agent-service.
  government_db wiped to 0 rows; narrative DBs untouched all session;
  ledger keeps the smoke's governance events (append-only, accepted).
- **Next: M2-9** — dashboard `/government` page: election card (phase +
  window clock), candidate list, live tally (bootstrap `GET
  /elections/{id}` + SSE filtered to VoteCast/ElectionDecided — the M1-5
  pattern, no BFF), vote-reasons feed (the campaign's receipts), rewrite
  `/api/government/*`, nav links both ways, typecheck-only CI. Note for
  M2-9: government-service has no election LIST endpoint (deliberate M2-6
  cut) — the page needs either the SSE ElectionStarted to learn ids, or
  M2-9 adds `GET /elections?status=...` to government-service (small,
  04-compatible).

## Session 2026-07-08 ~23:25–00:15 EDT — M2-7 shipped, Sprint 7 closed, GO on the go/no-go

- **What shipped** (`M2-7: governance command plane + contracts`), all four
  code surfaces + contracts:
  - **packages/events**: six new v1 schemas + fixtures + one invalid —
    `commands/GovernanceRequested` (action enum declare_candidacy|vote,
    per-action `$defs` DeclareCandidacyParams/VoteParams; **no timeoutMs** —
    the governance plane has no watchdog, the clock + freshness guard bound
    liveness), `government/ElectionStarted` (gains `nominatingEndsAt` over
    the 03 sketch — consumers render deadlines without querying),
    `CandidateNominated` (+`villagerId`, platform nullable),
    `VoteCast` (+`candidateVillagerId`; emitted EXACTLY once per stored vote
    so tallies count events 1:1), `ElectionDecided` (winnerCandidateId +
    winnerVillagerId + villager-keyed zero-filled voteCounts + totalVotes;
    the sketched `turnout` DROPPED — government-service can't honestly know
    the electorate size), `GovernanceRejected` (errorCode enum WINDOW_CLOSED/
    ALREADY_VOTED/ALREADY_A_CANDIDATE/NOT_A_CANDIDATE/UNKNOWN_ELECTION/
    STALE_COMMAND/INVALID_PARAMS; aggregate = the acting VILLAGER — a
    rejection may have no valid election). Fixtures thread one story: the
    existing DecisionMade fixture causes GovernanceRequested{vote} causes
    VoteCast, on Elara's tick correlation. `task gen` output committed;
    03-events-kafka catalog rows updated to the shipped shapes.
  - **agent-service**: DECISION_SCHEMA gains required-nullable
    `governanceAction` — **deliberately FLAT** (action/electionId/
    candidateVillagerId/reason/platform all at one level, every field
    required-nullable): OpenAI-strict-safe by construction and kinder to
    small models than nesting. `_parse_governance` maps it to the
    GovernanceRequested wire params and validates against the REAL `$defs`
    (M1-3 seam discipline) + real `uuid.UUID` parses (JSON-Schema `format:
    uuid` is annotation-only — hallucinated ids must not become wire noise);
    **a bad civic add-on is DROPPED (logged + `civ_llm_governance_dropped_
    total`), never fails the world action** — semantic teaching is the
    executor's job via rejection percepts. The act node publishes
    GovernanceRequested to `commands.government` (key = villagerId,
    causation = DecisionMade — DoD #2's chain), and DecisionMade's decision
    string gains " + vote"/" + declare_candidacy". Missing governanceAction
    key = malformed (the strict relationshipUpdates precedent); FakeProvider
    script updated. Tests 95→105.
  - **government-service**: spring-kafka consumer on commands.government
    (`government-service.command-executor`, all 6 partitions) with **day-one
    freshness guard** (ruling 7; >600s → GovernanceRejected{STALE_COMMAND})
    and **transactional exactly-one-outcome**: Flyway V2 `processed_commands`
    — the commandId claim (INSERT..ON CONFLICT DO NOTHING) commits atomically
    with the state change, so a redelivery claims nothing and emits nothing
    (stronger than the world plane's Redis mark-before-execute).
    `GovernanceCommandService` = the single governance executor: vote
    (ALREADY_VOTED checked BEFORE window — truer teaching), candidacy
    (NOMINATING window, natural key → ALREADY_A_CANDIDATE), rejections in
    prescriptive prose (the M2-1 diagnosis-quality lesson). Emission:
    `KafkaGovernmentEvents` replaces the logging adapter behind the SAME
    port (the M2-6 seam paid off — zero domain surgery), sends deferred to
    **after-commit** (no ghost facts from rolled-back transactions; the
    crash-between-commit-and-send residue = logged ledger gap, M1-9
    precedent); `GovernmentEnvelopeFactory` is the hand-rolled Java envelope
    builder (UuidV7 reuse, unit-tested field-for-field). REST vote/open/seed
    paths now emit the same facts (causation null = operator plane).
    Off-enum actions (propose_law, the M3 temptation) are PARKED at the
    mapper, not rejected — GovernanceRejected.action couldn't carry them
    validly. `civ.governance.kafka-enabled=false` runs the M2-6 broker-less
    shape (the lifecycle test uses it). Tests 21→27 incl. the command-plane
    Testcontainers scenario (Redpanda + Postgres): 8 commands → 2 facts +
    6 rejections + redelivery-emits-nothing, claims accounted exactly.
  - **event-service**: CIV_TOPICS default + explicit compose env now
    archive `government.events` + `commands.government` (verified live:
    the consumer holds all 30 partitions across 6 topics).
  - **scripts/produce-gov-cmd.mjs**: the governance twin of produce-cmd.mjs
    (the M2-7 filmable beat is literally this tool); `occurredAt` override
    for staleness drills. Gotcha fixed in-tool: `||` not `??` for optional
    positional args — `''` must mean "generate".
- **Live end-to-end on the running stack** (both services rebuilt from the
  worktree, `--no-deps`; bots + Paper untouched — Parker was in-game
  throughout): a CONTESTED election with organic candidacies —
  Bram and Tansy both declared via hand-published commands (platforms
  verbatim in CandidateNominated), Bram's re-file → ALREADY_A_CANDIDATE,
  3 votes with reasons → 3 VoteCast (causation = each command), Elara's
  re-vote → ALREADY_VOTED, a 2h-old vote → STALE_COMMAND ("7200s old,
  limit 600s"), and the clock decided **Bram 2–1** with villager-keyed
  voteCounts. The ledger archived ALL of it (8 GovernanceRequested + 10
  outcomes/facts; one `correlation-id=` query returns the command→VoteCast
  pair — the DoD #2 replay works). Bonus: an accidentally-empty commandId
  proved the poison-message path live (parked by BOTH consumers, zero
  retries). government_db wiped to 0 rows after (smoke hygiene; ledger
  keeps the events — append-only, causationId-null = dev-tool fingerprint).
- **THE GO/NO-GO: GO.** llama3.1:8b against the new schema with a synthetic
  "Village affairs" prompt: first draft (polite "if you would rather wait,
  set null" + no stakes) went **0/4** — all valid decisions, all declined to
  vote. Rewritten affordance (deadline named, "a vote not cast is a voice
  lost", NO polite out, "the vote rides along with whatever else you do")
  went **4/4 contract-valid**: exact electionId + candidateVillagerId every
  time, memory-grounded choice (Bram — the shared bread), in-character
  reasons quoting his platform, and the single-call multi-plane tick worked
  (chat+vote ×2, move+vote ×2; 2.7–3.8s). **That 0/4→4/4 flip is M2-8's
  design brief**: the civic section must name stakes + deadline, must not
  offer an out, and must say the vote rides along with the world action.
- **OpenAI half of the smoke: BLOCKED on key (blank by design) + a REAL
  pre-existing finding.** The offline strict-mode structural audit shows the
  world `params` free-form object (`{type: object}`, no properties) violates
  strict-mode rules — **the OpenAI provider path 400s today, latent since
  M1-3** (every live run has been Ollama; the "OpenAI filming fallback" was
  never actually exercised). governanceAction was built flat/strict-safe for
  exactly this reason and audits clean. Fix (reshape `params` to a
  superset-with-nullables, then re-verify llama against the changed schema)
  is a follow-up ticket BEFORE any OpenAI run — in CLAUDE.md as a gotcha
  corollary. Parker's call whether to fund a key smoke sooner.
- **Machine state: stack UP, 12 containers healthy**; event-service +
  government-service run worktree-built images (rebuild from main after
  merge is a no-op content-wise); agent-service container now THREE
  milestones stale (pre-M2-3) and still `villager_count=0` — the next
  deliberation run needs `up --build` (it also picks up the new
  DECISION_SCHEMA). 20 bots + Parker online throughout; narrative DBs
  untouched all session; government_db 0 rows; the ledger gained the smoke's
  governance events (accepted practice).
- **Next: M2-8** (Sprint 8 opener) — civic perception + campaign
  affordances: perception consumer adds government.events (freshness-guarded
  ruling 7), election events broadcast-fan-out to all alive villagers'
  percept queues (roster injection like the scheduler hook), in-memory
  civic-state cache rendered as a standing "Village affairs" prompt section
  (percepts decay; an ongoing election must not), `governanceAction`
  affordance text only while a window is open — **using the 4/4 prompt
  shape from this session's smoke**, mixed-queue regression test.

## Session 2026-07-08 ~22:45–23:20 EDT — M2-6 shipped, Sprint 7 opened

- **What shipped** (`M2-6: government-service walking skeleton — election
  state machine`): new `services/government-service` — Java 21 / Spring Boot
  3.5.6 / Gradle 9.2, hexagonal mirroring event-service (adapter.in.rest +
  adapter.in.scheduling / adapter.out.persistence + adapter.out.log /
  application ports+service / domain records, hand-mapped — no Java codegen,
  ruling 6). **Flyway V1 creates `elections`/`candidates`/`votes`/
  `governments` ONLY** (laws/factions deliberately absent — ruling 8, header
  comment says so for review). State machine scheduled → nominating → voting
  → decided (+annulled) as a pure domain decision (`Election.duePhase`,
  inclusive boundaries, one phase per step — a late clock cascades, never
  skips), applied by a 5s scheduled clock through
  `AdvanceElectionsUseCase.advance(now)` (explicit `now` ⇒ deterministic
  tests). Windows configurable: defaults 600s/900s (the filmable
  timescales), per-election overrides in the POST body, `ELECTION_*` env
  levers in compose. REST per the frozen 04 contract: `POST /elections`
  (operator lever; optional operator-seeded candidates, deduped),
  `GET /elections/{id}` (candidates + live tally; `include=votes` adds
  per-vote reasons — episode gold), and `POST /elections/{id}/votes`
  (pulled in from 04 so the skeleton is drivable end-to-end:
  **natural-key idempotent** per ruling 5 — 201 new / 200 existing even
  after close, never re-counts, never switches candidate; problem+json
  errorCodes `WINDOW_CLOSED`/`NOT_A_CANDIDATE`/`UNKNOWN_ELECTION`
  pre-echo M2-7's GovernanceRejected vocabulary). Decide rule: plurality;
  tie → earliest registered → id (total order); zero votes →
  annulled(no_votes); no candidates at voting open → annulled(no_candidates).
  `ElectionDecided` seats a `governments` row (mayoralty) **and dissolves the
  incumbent** — a village has one mayor; re-elections just work. Vote-vs-
  transition race closed with `SELECT FOR UPDATE` on the election row (the
  agent-service lock pattern); the advance loop runs one TransactionTemplate
  tx per election so a poisoned row can't wedge the clock. UUIDv7 row ids
  from a small in-house generator (bit layout unit-tested; Java has no
  built-in — M2-7's envelope builder will reuse it). Metrics:
  `civ_elections_opened_total`, `civ_election_transitions_total{to}`,
  `civ_votes_total{outcome}`. Wiring: compose entry on 8082 (+healthcheck;
  first real feature = first compose appearance), Prometheus scrape job, CI
  caller workflow (java + image, **its own file in `paths:`**, and
  packages/events pre-included so M2-7's fixture consumption can't be
  forgotten), `task test` now runs **six** suites.
- **THE SEQUENCING RULING** (the plan row says "emits ElectionStarted/
  ElectionDecided" but the government/* schemas are owned by M2-7):
  **chose (b) — no Kafka emission in M2-6.** The domain fires
  `GovernmentEventsPort.electionStarted/electionDecided` at exactly the
  right two moments; M2-6 wires a structured-logging adapter (lines say
  "log-only until M2-7 contracts"). Reasons: contract-first forbids
  schemaless wire events; M2-7 owns the six-schema package as one coherent
  review; nothing archives or consumes government.events until M2-7/M2-8
  (events emitted now would expire unread from a 7d topic); and
  government-service would have been the repo's FIRST Java Kafka producer —
  that envelope-builder work belongs with M2-7's command plane. Net:
  M2-7 swaps the adapter behind the port, zero domain surgery. Deliberately
  **no spring-kafka dependency at all** — the integration test needs only
  Postgres (no Redpanda container; ~3s suite).
- **Tests 0 → 21** (16 unit: phase boundaries incl. never-skips, tally
  tie-breaks, UUIDv7 bits; 5 Testcontainers integration against the real
  pgvector Postgres image: full lifecycle with stepped clock, idempotent
  re-vote — even for a different candidate, the first vote stands — all
  three errorCodes, both annul paths incl. the late-clock cascade,
  re-election dissolving the incumbent, validation 400s). Coverage is
  REPORTED, not gated — the ≥80 jacoco gate is M2-10's AC per plan.
- **Live-verified against the running stack** (image built from the
  worktree, `up -d --build --no-deps government-service` attached to the
  same compose project; the 11 running containers untouched): Flyway V1
  applied to virgin government_db; two real elections on the real 5s clock.
  Run 1 (15s/20s — tighter than hand-driven curl, and every "miss" returned
  the CORRECT semantics: 201 in-window, WINDOW_CLOSED after close, 200
  replay after close) decided **Elara mayor**; run 2 (8s/60s) recorded the
  incumbent governmentId at open, 409'd the early vote, took 3 votes + a
  200 duplicate, decided **Bram 2–1, dissolving Elara's government and
  seating Bram's at the same instant**. Both port log lines fired;
  `/actuator/prometheus` civ_ counters exactly right (2 opened, 2×3
  transitions, 4 accepted, 4 duplicate). Smoke rows then deleted —
  government_db back to 0 rows (mutable service state, not ledger; pristine
  for the M2-10 arc).
- **Worktree wrinkles found** (now CLAUDE.md gotchas): Git Bash mangles
  `cmd /c` (`/c` → `C:\`, MSYS path conversion) so gradlew must run from
  PowerShell there; worktrees don't carry `.env` (copy from the main repo
  before compose); compose from a worktree attaches to the SAME project
  (`name:` key) — `--no-deps` keeps live services untouched; bind-mounted
  configs (prometheus.yml) still resolve to the checkout each container was
  STARTED from, so the new scrape job goes live after merge + prometheus
  restart (the metrics endpoint itself was verified directly).
- **Machine state: stack UP, 12 containers** (11 unchanged + healthy
  government-service on 8082), 20 tick-less bots, agent-service still
  `villager_count=0` on the pre-M2-3 image, narrative DBs untouched all
  session (only government_db was written, then wiped).
- **Next: M2-7** — governance command plane + contracts: six schemas +
  fixtures + committed `task gen` (`GovernanceRequested.v1` with per-action
  `$defs` + invalid fixture; `ElectionStarted`/`CandidateNominated`/
  `VoteCast`/`ElectionDecided`/`GovernanceRejected` v1), DECISION_SCHEMA
  gains required-nullable `governanceAction` (M1-3 pattern), agent-service
  publishes `commands.government` (causation = DecisionMade),
  government-service consumes with **day-one freshness guard** (ruling 7)
  and swaps LoggingGovernmentEvents for the Kafka adapter, event-service
  archives both topics (CIV_TOPICS + compose), and the week-one
  llama + OpenAI `governanceAction` smoke is the sprint go/no-go.

## Session 2026-07-08 ~22:20–22:45 EDT — M2-5 shipped, Sprint 6 closed

- **What shipped** (`M2-5: grudge persistence kit`), agent-service only:
  `GRUDGE_AFFINITY_THRESHOLD = -20` in `villagers/relationships.py`;
  `apply_update` gains keyword-only `ambient: bool = False` — when ambient
  and `affinity_delta > 0` and the edge's current affinity ≤ −20, **both
  deltas are halved** (decided under the existing `FOR UPDATE` row lock, so
  the read-modify race can't skip damping; first-meeting rows default to 0
  so they never dampen). `graph.py` passes `ambient=(source == "heuristic")`
  — deliberation-sourced updates land whole (**a real apology still works**).
  The feelings prompt section appends a behavioral directive when a grudge
  edge is actually in sight ("refusing, avoiding, arguing, or cold words are
  all legitimate; do not perform warmth you do not feel") — keyed off nearby
  villagers, NOT every edge the dict holds (tested). Tests 87→95: +5 repo
  integration (halved at ≤−20, boundary −20 vs −19, negative undamped,
  deliberate undamped, first-meeting undamped), +3 prompt directive cases,
  +2 assertions in existing tick tests (heuristic→ambient=True,
  deliberation→False).
- **THE MEASUREMENT (ledger replay, before/after — the AC):** method:
  replay `RelationshipChanged` prev/new deltas per edge from the **verified
  clean window** (≥ 2026-07-07T12:11Z, `source='agent-service'`; 0 fake
  fingerprints in-window — the M1-10 repair exclusions), damping rule
  applied to heuristic positives at running affinity ≤ −20, mirroring the
  repo's round/clamp. Replays reconcile with canon exactly (Yara→Cassia
  peak −54 at 13:08Z).
  - **Yara→Cassia** (108 events): post-peak positive drift was **+195
    points, 100% heuristic, 0 deliberation** — ambient chatter alone
    carried −54 → **+90** by 23:14Z. That's the disease quantified: no
    apology, no arc, just pleasantry erosion flipping a filmed grudge into
    warm friendship. Before: half-life 6.30h, ≤−30 persistence 6.92h.
    After: 6.68h / 7.30h — the wall-clock crossing moves modestly because
    this edge's healing bunched into a dense evening chatter burst, but
    within the grudge band the ambient healing rate is exactly halved.
  - **Quill→Wren** (63 events): before — entered ≤−30, mean-reverted back
    above −30 after **6.66h** (the afternoon watch's documented bounce),
    then fresh conflict re-deepened it to −48 at data end. After — **never
    re-crosses −30: 10.42h at ≤−30, held to end of data**; end-state −84
    vs −48. The grudge that briefly dissolved now stays warm all evening.
  - **DoD #5 (grudge ≤−30 persists ≥2h under ambient chatter): cleared
    3–5× in projection.** Caveat stated: fixed-stream replay (live villagers
    would behave differently — directionally conservative, since the new
    directive adds cold behavior/fresh conflict on top of damping). Live
    confirmation rides the M2-10 filming run.
- **Machine state: stack UP** (unchanged), 20 tick-less bots, narrative DBs
  untouched — measurement was read-only ledger SQL + scratchpad replay.
  **Running agent-service image is now TWO prompt milestones stale**
  (pre-M2-3): the next real deliberation run needs `up --build`.
- **Sprint 6 closed without using the slip valve.** Next: **M2-6**
  (Sprint 7): government-service walking skeleton — Spring Boot hexagonal
  (event-service layout), Flyway V1 election tables only, election state
  machine with filmable window durations, `POST /elections` operator lever,
  `ElectionStarted`/`ElectionDecided`, compose entry + healthcheck +
  Prometheus scrape + its own CI caller workflow (paths: gotcha),
  Testcontainers integration test.

## Session 2026-07-08 ~21:25–21:50 EDT — M2-4 shipped

- **What shipped** (`M2-4: explicit 6-partition command topics`):
  `scripts/provision-topics.mjs` — the executable topic map (world 6 /
  agent 6 / social 3 / government 3 / commands.minecraft 6 /
  commands.government 6; retention 7d facts, 24h commands), idempotent:
  creates missing, converges `retention.ms` in place, **fails loud on a
  partition-count mismatch** pointing at the new runbook (counts can't
  change in place without rehashing keys = breaking per-villager ordering).
  New `task topics`; `up`/`up:all` now provision **after infra `--wait`,
  before the app profile starts** — explicit creation beats the producers'
  auto-create race on a fresh cluster (Redpanda dev-mode auto-create stays
  on as a net, and a race loser is caught as a mismatch). Consumer
  `partitionsConsumedConcurrently` 3→6 (commandConsumer.ts).
  `commands.government` + `government.events` provisioned **ahead of their
  first producer**, so M2-6/M2-7 meet correctly-shaped topics.
  `docs/runbooks/kafka-topic-migration.md` (drain→recreate→offset-reset) is
  the new runbook; 03-events-kafka.md gains the `commands.government` row +
  a "this table is provisioned, not aspirational" note. Also
  `scripts/spawn-fleet.mjs`: re-embody the fleet without ticks — on the
  zero-pollution preset (`villager_count=0`) `task seed` slices zero
  villagers, so every session since M2-2 hand-rolled spawn envelopes; now
  it's a one-liner (and the runbook's step 5).
- **The live migration ran — the runbook's first execution.** All four
  auto-created 1-partition topics migrated: drain verified (all 3 groups
  TOTAL-LAG 0), consumers + memory-service stopped (producer on
  agent.events — removes the auto-create race during the delete window),
  topics deleted, `task topics` recreated at map shape, groups deleted
  (**2 of 3 were already gone** — topic deletion strips a memberless
  group's offsets and it gets GC'd; `GROUP_ID_NOT_FOUND` is success, noted
  in the runbook), minecraft-service `up --build` (bakes 3→6), the rest
  `start` not `up` (containers keep their env — agent-service stayed
  `villager_count=0`, zero narrative pollution). Bonus finding: the doc's
  "24h retention" on commands had been aspirational — auto-created topics
  carry the cluster default (7d); it's real now.
- **Verification, all held:** the 20 respawn commands spread across **all
  six partitions** (rpk produce receipts); single consumer holds all 6,
  lag 0; per-villager ordering — Elara's spawn + 2 idle canaries all on
  partition 3 at offsets 0/2/3 in publication order; exactly-one-outcome —
  22 ActionRequested archived, 22 ActionCompleted, 20 VillagerSpawned in
  the ledger; fleet 20/20 online (~4-min gap; Parker was in-game the whole
  time — Paper itself was never touched, his session rode through). All
  five suites green (15 contracts / 53 ts / 87 py-agent / 46 py-memory /
  event suite), zero new tests (kafka glue stays integration-verified, per
  the coverage-gate scope).
- **Machine state: stack UP**, 20 tick-less bots online, narrative DBs
  untouched all session (canary + spawn commands are `causationId: null`
  dev-tool practice, M2-1 precedent).
- **Next: M2-5** — grudge persistence kit: behavioral directive in the
  feelings prompt section (grudges constrain tone/choices), heuristic
  asymmetry (*ambient* positive deltas halved onto edges with affinity
  ≤ −20; deliberation-sourced deltas untouched — a real apology still
  works), regression tests, grudge half-life measured from the ledger
  before/after. It's the sprint's slip valve (may slip to Sprint 8).

## Session 2026-07-08 ~21:10–21:25 EDT — M2-3 shipped (commit `65fe8d7`)

- **What shipped** (`M2-3: prompt rebalance — resources in sight, action
  awareness, quirks`), all in agent-service, prompt-side only (no contract,
  no schema): the M1 "prefer small, concrete, **social** actions" steer is
  rebalanced (material work — gathering, exploring, providing — named as
  equally legitimate); **"Resources in sight"** section renders from the
  M2-2 `nearbyResources` survey (absent field → no section, pre-M2-2
  compatible; scanned-empty → honest "this spot is bare" + points at
  moving); **action awareness** (Sid's #1 progression lever): new
  `brain/awareness.py` holds an in-memory `LastDecision` per villager —
  deliberate recalls it, act remembers it — and the prompt renders "Your
  last decision: X → outcome", where the matching ActionCompleted/Failed
  percept is CLAIMED (never renders twice: once as the pairing, not again
  under "Since your last turn"), or an honest "outcome not observed yet";
  **quirks** finally render in the system prompt (the M1-7 leftover
  one-liner). All seams optional-by-default (`awareness=None`,
  `last_decision=None`) — every pre-M2-3 caller/test unaffected.
- **Deliberately in-memory** awareness (a restart forgets): the ledger and
  memory stream are the durable record; this is working memory. Wired in
  `main.py` via `TickDeps.awareness=ActionAwareness()`.
- **Tests:** agent 78→87 (+6 prompt cases incl. claim-dedupe and
  scanned-empty-vs-absent, +1 graph round-trip, +2 system-prompt cases);
  all five suites green at the boundary. AC per plan (prompt snapshot
  tests) satisfied; no live tick this session — the running agent-service
  container is `villager_count=0` and still on the pre-M2-3 image, so the
  **next real run needs `up --build`** (standard image-bake rule).
- **PowerShell gotcha confirmed again:** PS 5.1 eats inner double quotes in
  here-string args to native exes (git this time, produce-cmd before) —
  write commit messages without embedded double quotes.
- **Machine state: stack UP** (unchanged from M2-2 session: 20 tick-less
  bots online, narrative DBs untouched).
- **Next: M2-4** — `commands.minecraft` + `commands.government` explicit
  6-partition provisioning (rpk via Taskfile), drain→recreate→offset-reset
  runbook, `partitionsConsumedConcurrently` 3→6.

## Session 2026-07-08 ~20:20–21:15 EDT — M2-2 shipped

- **What shipped** (`M2-2: nearbyResources in WorldSnapshot`): WorldSnapshot.v1
  gains additive optional `nearbyResources` `[{family, nearestDistance,
  count}]` (schema + fixture + TS/py types regenerated); minecraft-service
  surveys the RESOURCE_BLOCKS families (wood/stone/dirt) with per-family
  `findBlocks` sweeps — count-capped (32 reported, 2× headroom requested),
  **Y-banded ±16** (the M2-1 reachability finding: never advertise the
  cliff-face spruce; the band is a post-filter because findBlocks probes
  section palettes with position-less Blocks), merged into every 1s snapshot
  from a cache. Field semantics: **absent = no scan yet / disabled; `[]` =
  scanned, nothing in sight.** Config: `RESOURCE_SCAN_{INTERVAL_MS,DISTANCE,
  COUNT_CAP,Y_BAND,MOVE_BLOCKS,MAX_AGE_MS}`; `INTERVAL_MS=0` disables.
  ts tests 41→53; all five suites green.
- **THE MEASUREMENT (the AC — and it caught a real problem pre-commit):**
  ungated 5s scans across 20 bots **pinned a full CPU core** on
  minecraft-service (~175 ms per bot-scan) — and that core is the single
  Node event loop that executes every command. Paper never noticed:
  findBlocks is **client-side**; the risk register's "scans lag the server"
  worry aimed at the wrong victim. Fix shipped inside the ticket: a movement
  gate (`shouldRescan`, unit-tested) — the 5s interval is only the *check*
  cadence; the sweep runs only after ≥8 blocks of movement or a ≥60 s-old
  survey. Numbers (20 idle bots, 6×20 s samples per phase): CPU baseline
  scan-off **22–38%**, ungated **~100%**, gated **19–31%** (indistinguishable
  from off); Paper MSPT 5s-avg 5–8 ms in **all three** phases.
- **Live evidence:** Elara (mountainside, still holding her M2-1 loot) sees
  `wood@4.4 / stone@1.2 / dirt@0.6` (counts capped at 32); Vesper (plaza)
  sees `wood@33.7 count 25` — the M1 "no wood near the plaza" diagnosis made
  visible to the LLM, and inside the default-48 gather range. Scan-off run:
  field cleanly absent from a fresh snapshot. Zero `resource scan failed`
  warnings across all phases.
- **Smoke shape:** zero-pollution again — `VILLAGER_COUNT=0` via process env
  (`.env` untouched, still the filming preset), 20 bots hand-spawned through
  `produce-cmd` spawn commands. **Learned:** bot sessions do NOT survive a
  minecraft-service container recreate (in-memory; nothing re-embodies from
  the roster on boot) — re-publish spawns (or `task seed`) after any
  recreate of that container.
- **Machine state at session end: STACK UP** (all containers healthy), 20
  tick-less bots online (agent-service running `villager_count=0` — no
  deliberation, no narrative writes all session). Narrative DBs untouched.
- **Next: M2-3** (soften the social-actions prompt line; render "Resources
  in sight" from this field; "Your last decision → outcome" line; quirks
  into the system prompt).

## Session 2026-07-08 ~02:00–02:45 EDT — M2-1 shipped (commit `abf4ae6`)

- **What shipped** (`M2-1: composite gather — equip best tool, prescriptive
  failures, default 48`): GatherParams default 32→48 (schema + executor
  fallback, clamp 4..64 unchanged, types regenerated); `BotSession.gather` is
  the composite verb (find → plan tool → walk → **equip at the dig site** →
  dig → collect — the pathfinder re-equips while digging its own way en
  route, so pre-walk tool choices go stale); pure `planHarvest` +
  `gatherFailureMessage` in `world/resources.ts`; **TOOL_REQUIRED** additive
  ActionFailed enum value (stone dug bare-handed used to "complete" with
  collected: 0 — now an honest, non-retryable, prescriptive failure naming
  the missing tool class); observability lines `gather target found`
  (block/position/distance) and `gather equipping tool`. ts tests 30→41;
  all five suites green.
- **Live smoke evidence (all in the ledger, ~06:14–06:23Z):** prescriptive
  RESOURCE_NOT_FOUND at r=4 ("no wood within 4 blocks of (3, 121, 4) — try
  maxDistance 48 (the cap is 64), or move somewhere new first");
  `ResourceGathered{spruce_log, quantity: 2}` at distance 38 — **Elara left
  the plaza and climbed the mountainside** (findable only because default is
  48 now); TOOL_REQUIRED live on bare-hand stone; RCON-given stone_pickaxe →
  `gather equipping tool` → `ResourceGathered{stone, quantity: 1}` in 7.2s.
  Smoke ran with **VILLAGER_COUNT=0** + hand-published commands
  (`produce-cmd`) — zero ticks, zero narrative pollution; the smoke's
  command/outcome events sit in the ledger under Elara's id with
  `causationId: null` (no DecisionMade parent = distinguishable from real
  deliberation; append-only, accepted practice).
- **Finding for M2-2/M2-3 (measured):** `findBlock` picks the 3D-nearest
  match with **no reachability check**, and a pathfinder `goto` toward an
  unreachable goal **never settles** (no NoPath rejection observed — the
  watchdog is the only exit, 90s TIMEOUT with zero movement). First gather
  attempt hit exactly that (spruce 20 blocks up a rock face), the identical
  retry succeeded after world state shifted. So: TIMEOUT on gather ≠ broken —
  it's often "target was never a fair ask"; the `gather target found` log
  line now says which. `nearbyResources` (M2-2) should bias toward
  *reachable* surface resources, and relocation prompting (M2-3) is what
  gets bots off treeless mountaintops.
- **Docker Desktop wouldn't start (twice)** — the stale-socket gotcha, with
  a new wrinkle: the rename fix can RACE a crashed instance's own recovery,
  which puts a zombie sock back. Refined procedure now in CLAUDE.md (verify
  zero docker processes, rename, verify dirs gone, relaunch). Engine came up
  on the second, verified application.
- **Parker committed in parallel** (`69acb12`, 02:16 EDT — research addendum:
  second independent read, MineCollab PDF confirmed real). The untracked
  leftovers (`docs/research/emergent-garden-study.md`, `.claude/settings.json`)
  remain untracked — still Parker's call.
- **Machine state at session end: stack fully DOWN** (world saved via
  `save-all flush` before down; 0 containers; volumes intact — narrative DBs
  still carry filming canon untouched; Elara's PLAYER data in the world now
  holds 2 spruce logs + the pickaxe + 1 cobblestone from the smoke).
  Docker Desktop itself is RUNNING.
- **Next: M2-2** (`nearbyResources` in WorldSnapshot — additive optional
  field, count-capped findBlocks scan every ~5s, MSPT measured in AC).

## Session 2026-07-08 — M2 planning (docs only, no code/stack touched)

- **`docs/architecture/08-m2-plan.md` authored** — the M2 plan in the 07
  house style: Sprints 6–8 ("Bodies that work" → "The campaign machine" →
  "Election night"), printed arithmetic, named slip valves, DoD (7 items),
  ticket-owned risk register. Core set per the research study's
  recommendation: **A1–A3 + C1–C2 + D1–D2** mapped onto the roadmap's P2
  scope.
- **Key rulings made in the plan** (don't re-litigate): governance is a
  *second command plane* (`commands.government`, government-service the
  single governance executor, exactly-one-outcome ported); decision contract
  gains required-nullable `governanceAction` (M1-3 precedent); vote
  idempotency via natural keys; government = affordances not scripts
  (operator seeds the election, politics must be organic); **no Java codegen
  yet** (hand-mapped records, event-service precedent); freshness guards are
  day-one ACs on every new consumer; BFF/analytics/OpenSearch/Loki/k6/laws/
  factions all deferred again with reasons (plan ruling 8).
- **D1 scope note:** Sid's full constitutional-amendment loop is
  deliberately M3 ("living law"); M2 builds its substrate (command plane,
  ballot box, seated government).
- **Machine state:** stack fully DOWN this session (Docker Desktop not
  running) — supersedes the 2026-07-07 "RUNNING" note below. Volumes
  untouched; narrative DBs still carry the filming-day canon.
- **Untracked leftovers noted, not committed:**
  `docs/research/emergent-garden-study.md` (earlier partial study draft —
  superseded by the committed `emergent-garden-lessons.md` but contains the
  unique PDF-mislabeling warning; Parker to decide keep/commit/delete) and
  `.claude/settings.json` (local plugin config).
- **Next session: start M2-1** (composite gather + prescriptive failures) —
  stack bring-up needed first (`task up:all` + Paper profile per the resume
  commands at the bottom of this file).

## Project status

- **Sprint 3 complete** + **Sprint 4 complete** (commits `M1-4: relationship
  read path…`, `M1-5: live relationship graph page`, `M1-6: interim
  leaderboard…`, `M1-7: 20 villager personas — the full cast`), all on `main`.
- **78 agent-service tests green locally** (was 59; M1-4 added 10, M1-6
  added 2, M1-7 added 7). Dashboard typecheck clean (it has no test suite —
  CI runs typecheck). Other suites unchanged and green.
- Test totals: **87 py-agent** (78 → 87 in M2-3: prompt sections, awareness
  round-trip), **46 py-memory** (19 → 42 in M1-9, +4
  reflect-guard tests in M1-10), **53 ts-minecraft** (30 → 41 in M2-1, 41 → 53 in
  M2-2: scan, Y-band, rescan gate, snapshot merge),
  8 java-event, **15 contract fixtures**. Coverage gate is **ON since M1-10**
  (agent brain/llm 96.4%, memory service/scoring 98.0%, event ingest/read
  87.8% — all ≥80 enforced). `task test` runs all five suites.
- Machine state: **superseded — see "Machine state at session end" below**
  (M1-10 session brought the full stack up with `up --build`; it is RUNNING).
- Sprint 3 live proof achieved: Bram said "Elara, still on about the pantry?"
  in-game (multi-day characterization via memory), Elara's reply tick fired
  `trigger=reactive`, relationships formed from interactions
  (Elara→Bram 0→3→11 via the +8 direct-address boost), all as
  RelationshipChanged ledger events.
- **agent_db is at exact Sprint 3 truth:** one edge, Elara→Bram, affinity 11 /
  trust 56 / 2 interactions, `last_reason` = `heard Bram say: "Elara, still on
  about the pantry?"` (recovered verbatim from the ledger after dev smokes had
  overwritten it — the ledger is the restore point for relationship state).
  One fake-tick memory was deleted from memory_db; the ledger keeps a few
  `llmProvider=fake` / `source=dev-tool` events from M1-5 verification
  (append-only by design, same practice as `scripts/produce-cmd.mjs`).

## Sprint 4 plan ("The village is visible", M+M+S+M ≈ 20–26h)

Full acceptance criteria in `docs/architecture/07-m1-plan.md`. Summary
(**✅ = done**):

| ID | Title | Core AC |
|---|---|---|
| ✅ M1-4 | Relationship read path + feelings in prompts | **DONE** — see "What M1-4 shipped" below |
| ✅ M1-5 | Relationships graph page | **DONE** — see "What M1-5 shipped" below |
| ✅ M1-6 | Leaderboard (interim) | **DONE** — see "What M1-6 shipped" below |
| ✅ M1-7 | 20 personas | **DONE** — see "What M1-7 shipped" below |

### What M1-4 shipped (commit `M1-4: relationship read path + feelings…`)

- **Migration 0002** (`migrations_agent/versions/0002_relationship_reason.py`):
  `last_reason text`, `last_reason_at timestamptz` on `relationships`. Applied
  to live `agent_db` (now at 0002 head).
- **`RelationshipRepo`** (`villagers/relationships.py`): `apply_update` gained a
  trailing `reason: str | None = None` param — persists it on insert **and**
  update; a reasonless nudge (heuristic may pass `None`) does **not** erase a
  prior explained cause. New read methods `edges_for(villager_id, target_ids)`
  and `list_edges(villager_id)` (affinity DESC) return a session-detached
  `RelationshipEdge` dataclass (`.of(row)` classmethod).
- **`GET /villagers/{id}/relationships`** (`main.py`, wired via
  `app.state.relationships`): outgoing edges, strongest affinity first, JSON
  keys `targetId/affinity/trust/interactionCount/lastReason/lastReasonAt/
  lastInteractionAt/updatedAt`. **Ids only — no target names** (M1-5 maps
  ids→names from `GET /villagers`). This is the endpoint M1-5 bootstraps from.
- **Read seam** (`brain/graph.py::_nearby_feelings`): in `deliberate`, reads
  edges for the snapshot's nearby villagers and passes a `{villagerId: edge}`
  dict into `user_prompt(...)`. Guarded on `deps.relationships is None`
  (feature-off → `None` → section omitted). Non-UUID/player ids skipped.
- **Prompt** (`brain/prompts.py`): new 4th arg `feelings` to `user_prompt`.
  Renders "How you feel about those nearby:" — `- Bram (affinity +11, trust 56
  — <last_reason>)`; no reason → drops the em-dash clause; nearby villager with
  no edge → `- Bram: no strong feelings yet`. `feelings=None` (default) omits
  the whole section, so all pre-M1-4 callers/tests are unaffected.
- **Tests:** `test_prompts.py` +5 snapshot cases; `test_relationships_repo.py`
  new testcontainers suite (real Postgres, migration 0002 included) covering
  reason persistence, reasonless non-erasure, `edges_for` filtering,
  `list_edges` ordering, clamping; `FakeRelationships` updated for the new
  signature + read methods.

### What M1-5 shipped (commit `M1-5: live relationship graph page`)

- **`/relationships` page** (`apps/dashboard/app/relationships/page.tsx`) +
  nav links both ways with the overview page (which lost its stale "Sprint 1 ·
  walking skeleton" tag to make room).
- **`components/RelationshipGraph.tsx`** — hand-rolled **d3-force@3.0.0
  (exact-pinned) + SVG**, deliberately no react-force-graph wrapper (React 19
  interop risk, opaque live-update path). Simulation + node/link arrays live
  in refs (d3 mutates positions; repaint via a tick-counter state bump; d3
  stops ticking at alphaMin so no idle re-render). Bootstrap = react-query:
  `GET /villagers` then per-villager `GET /villagers/{id}/relationships`
  (N+1 is fine at ≤20), every alive villager a node, isolated nodes included.
- **Live path**: the existing SSE relay (`/api/events/events/stream`),
  filtered client-side to `RelationshipChanged`; upsert by directed key
  `villagerId->targetId`, then `alpha(0.3).restart()`. Unknown node id →
  react-query invalidate (re-bootstrap; covers villagers seeded after page
  load). No BFF, no Zustand, per the review cut.
- **Visual AC**: edge color = affinity sign (emerald/red/zinc-0), width =
  `1 + |affinity|·5/100` px; A→B and B→A drawn as parallel strands offset to
  their own left; arrowhead at the rim of the target ("arrows point at whom
  it's felt"); `<title>` tooltip = names + affinity/trust + `last_reason`.
- **Verified live in a browser** (preview server + real stack): bootstrap
  rendered the real Elara→Bram edge; two hand-published RelationshipChanged
  events over Kafka (`rpk topic produce social.events`, envelope mirroring
  `packages/events/fixtures/RelationshipChanged.v1.json`, `source: dev-tool`)
  appeared live — first as a NEW red edge, then as an in-place width/tooltip
  update with no duplicate; reload drops SSE-only state (by design — the DB
  is truth). Arrowhead geometry checked computationally, not by eyeball.
- Dashboard still has no test runner (CI = typecheck) — unchanged by review
  ruling; the graph's logic seams (upsert, color/width fns) are small and
  pure if we add vitest later.

### What M1-6 shipped (commit `M1-6: interim leaderboard…`)

- **`RelationshipRepo.leaderboard(metric, limit=10)`** — one SQL aggregate:
  SUM of incoming affinity per target (served by `idx_relationships_target`),
  joined to `villagers.name`, ordered DESC (popular) / ASC (hated). **Sum,
  not average** (breadth should count). No incoming edges → doesn't chart.
  Returns frozen `LeaderboardRow(villager_id, name, score, edge_count)`.
- **`GET /leaderboard?metric=popular|hated`** on agent-service; `Literal`
  query param → invalid metric 422s. JSON: `villagerId/name/score/edgeCount`.
- **Dashboard `components/Leaderboard.tsx`** — "Standing" panel on
  `/relationships` (graph `lg:col-span-3`, panel 1 col): Most popular / Most
  hated, top 5 each, sign-colored scores, edge counts, 10s refetch interval.
- **Verified live**: endpoint on real data; synthetic edges (deleted after)
  rendered both boards + red/green/absent states; zero-tick verification via
  **`VILLAGER_COUNT=0`** (scheduler starts no loops — the clean way to run
  agent-service read-only for dashboard work; no DB/ledger pollution at all).

### What M1-7 shipped (commit `M1-7: 20 villager personas — the full cast`)

- **`seed/villagers.json` 3 → 20** fully-voiced personas (traits ×3, values
  ×3, speechStyle, quirks ×2, backstory each). Elara/Bram/Wren byte-identical,
  UUIDs stable, and **still the first three entries** — `seed_villagers`
  slices `[:VILLAGER_COUNT]`, so file order is contract (the demo preset
  `VILLAGER_COUNT=2` must keep meaning Elara+Bram). New ids follow the
  existing hand-readable pattern (`…-0000000d0004` through `…-0000000d0020`).
- **Cast design (the taste pass)**: every speechStyle is a distinct register
  (tested); the ensemble is a drama engine — an information economy (Wren
  broadcasts, Cassia the innkeeper trades, Vesper the night-watch hoards,
  Quill the chronicler corrects from his ledger), Tansy the forager as
  Elara's pantry rival, Nils the miller's grandson (quasi-family to Elara),
  Sable off the same caravan as Wren, and the old-village flood (already in
  Elara's backstory) threaded through six new backstories as shared trauma.
- **`tests/test_seed.py`**: six shape checks (exactly 20; founding-three ids
  AND order; unique valid UUIDs; unique MC-legal usernames `[A-Za-z0-9_]{3,16}`;
  fully voiced; no duplicate speechStyle) + **seed idempotence at 20** against
  real Postgres: second run creates 0 rows / 0 new `VillagerCreated`, spawn
  commands sent both passes (40) — re-embodiment after restart is by design.
- **`tests/conftest.py`**: the session-scoped testcontainers `database`
  fixture moved out of `test_relationships_repo.py` so both integration
  suites share one Postgres container.
- Not touched (deliberate): `brain/prompts.py` renders traits/values/
  speechStyle/backstory but **not quirks** — quirks ship in the data; wiring
  them into the system prompt is a candidate one-liner for Sprint 5's
  20-villager run.

## M1-8 spike result (PaperMC container migration — GATE PASSED)

**The spike is green: mineflayer 4.37.1 talks to containerized Paper 1.21.6
cleanly. The fleet + 30-min soak ran next session and PASSED — see "M1-8
fleet soak result" just below.**

- **Compose `minecraft` service is now enabled-ready** (`docker-compose.yml`):
  the pre-existing Paper stub had a **floating `java21` tag** — pinned to
  **`itzg/minecraft-server:2026.7.0-java21`** (full patch tag, per the same
  discipline as `MC_VERSION`; this build ships `paper-1.21.6-48`). Added
  `ENABLE_RCON`/`RCON_PASSWORD` (MSPT/TPS read path) and an `mc-health`
  healthcheck (`start_period: 90s`) so `up --wait` blocks until Paper accepts
  logins. Still `profiles: [minecraft]`, off by default. `ONLINE_MODE=FALSE`
  matches the bots' `auth:'offline'` (BotSession.ts:89).
- **`scripts/paper-spike.js`** — the committed spike artifact. Mirrors
  `scripts/smoke.js` (borrows the archived PoC's mineflayer 4.37.1, the exact
  shipped pin; connects `auth:'offline'` + `viewDistance:'tiny'` like the real
  BotSession) and **adds a walk leg + a clean-disconnect assertion**. Exits 0
  only if connect→spawn→walk→chat→disconnect all pass.
- **Spike run (1 bot, localhost:25565):** ✅ PASS, exit 0. Spawn handshake
  **982 ms**; walked 1.56 blocks (movement packets round-trip); chat OK; clean
  `end` on quit (no error/kick). **No protocol/offline/packet weirdness — the
  mineflayer pin did NOT need to move** (so no atomic pin-bump PR).
- **MSPT baseline (RCON `mspt`/`tps`):** empty server ~2.0 ms (1m avg);
  **1 bot idling ~4.0/4.5 ms (5s/10s avg)**, TPS a flat **20.0**. Against the
  M1-8 ceiling of **MSPT < 50**, that's huge headroom for 20 bots. (The 80–118 ms
  `max` values are the first-boot world-gen spike — read the avg, and let the
  1m window roll before trusting it.)

### M1-8 fleet soak result (2026-07-07 04:23–05:00 — ALL AC PASSED)

**The 20-bot fleet ran ≥30 min on containerized Paper with real Ollama
deliberation. M1-8 is COMPLETE.**

- **Run shape:** `.env` set to `MC_HOST=minecraft`, `VILLAGER_COUNT=20`;
  Paper up via `--profile minecraft up -d minecraft --wait` (fast boot, world
  volume pre-seeded); app stack via `--profile infra --profile app up -d
  --build --wait` (the `--build` matters — it baked the M1-7 20-villager
  seed into the agent-service image); then `task seed` → 17 seeded + 3
  existing = 20 villagers, bots staggered in ~1/8s, **full fleet at
  04:23:44**.
- **AC 1 — 20 bots ≥30 min: ✅** 20/20 online at every 60s sample from
  04:25:04 to 05:00:59 (~37 min, 32 samples; monitor script sampled RCON
  `list` + `mspt` + `tps` + container restart counts).
- **AC 2 — MSPT < 50: ✅** 5s-avg ranged **8.5–17.1 ms** across the whole
  soak (≈3–6× headroom); TPS a flat **20.0** (1m/5m/15m) on every sample.
  Three isolated single-tick spikes appeared only in the 1m-**max** column
  (61/152/171 ms — autosave/GC); per the documented rule, read the avg.
- **AC 3 — zero tick-loop crashes: ✅** 0 restarts on all five containers
  (minecraft, agent-, minecraft-, memory-, event-service); all `running` at
  soak end. All disconnect/ECONNRESET noise in minecraft-service logs ended
  at 04:23:33 — the staggered-join connect storm, **before** the soak window
  opened; zero disconnects in-window.
- **LLM path:** blank `OPENAI_API_KEY` walked the chain to **ollama
  (llama3.1:8b, warmed)** — 20 concurrent villagers doing real
  perceive→retrieve→deliberate→act ticks (~8–40s each), varied actions
  (chat/move/follow/gather), personality-consistent chatter. ~10 ticks
  degraded to idle via the tolerant-reader path (chat `message` too long /
  empty — the known llama3.1 drift, counted, non-fatal).
- **Post-soak:** Paper container restarted (user request), came back
  healthy; bots auto-reconnected via the executor's reconnect loop. Stack
  left running.

### What M1-9 shipped (commit `M1-9: reflections…`)

- **ReflectionCreated.v1** schema + fixture in `packages/events` (payload
  `villagerId/reflectionId/summary/sourceMemoryIds[]`; producer memory-service
  on `agent.events`, aggregateId = villagerId, per the 03-events catalog);
  types regenerated and committed. No registry edits needed — contract tests,
  TS barrel, and the Python package are all directory-scanned.
- **memory-service LLM port** (`llm.py`): openai → ollama chain mirroring
  agent-service's boot probe/warmup, with one deliberate divergence — **no
  fake fallback**. No real LLM ⇒ reflections stay OFF (fake insights would
  pollute narrative truth in memory_db). Explicit `LLM_PROVIDER=fake` still
  opts in for tests/dev sandboxes.
- **BudgetedSummarizer**: `REFLECTION_DAILY_TOKEN_BUDGET` (default 200k),
  UTC-day rollover; a trip RAISES `BudgetExhausted` → `reflect()` skips
  (outcome=skipped_budget) instead of flipping to fake — same reasoning.
  Own `civ_llm_*` metric family (names intentionally identical to
  agent-service's: budgets are per service, and the M1-10 Grafana spend
  panel sums both services' cost counters). New `civ_reflections_total`
  counter labeled by outcome (created/empty/skipped_cap/skipped_budget/
  malformed).
- **Trigger** (`reflection.py::villagers_due_for_reflection`): per villager,
  SUM(importance) of **non-reflection** memories created since the last
  reflection > 30 (`REFLECTION_IMPORTANCE_THRESHOLD`). Excluding reflections
  from the pressure is loop-proof — they floor at importance 7, so counting
  them would let reflections beget reflections. `ReflectionJob` polls every
  `REFLECTION_INTERVAL_SECONDS` (300); job errors are logged, never fatal.
- **Generation** (`MemoryService.reflect()` — the frozen contract, now real):
  ≤20 unreflected memories, numbered oldest-first → strict-JSON
  `{insights:[{insight, sourceIndices}]}` (all-required +
  additionalProperties:false — OpenAI strict-safe per the M1-3 ruling) →
  tolerant parse (out-of-range citations dropped, citation-less insights
  dropped whole — the provenance CHECK would reject them anyway) → stored as
  `memory_type=reflection` with `source_memory_ids` → one ReflectionCreated
  per insight, one correlationId per pass, causationId null (job runs are
  root events). Global `HourlyCap` (`REFLECTIONS_PER_HOUR_CAP`, 12/h fixed
  UTC-hour window) bounds GPU load on the Ollama path.
- **Kafka**: memory-service's first producer — `EventPublisher` + envelope
  builder copied from agent-service (`source: "memory-service"`). **The
  promised packages/shared-py extraction is now due** (a second copy exists);
  flagged, deliberately not done inside M1-9. Publisher + job only start when
  a real summarizer is armed; `REFLECTION_ENABLED=false` is the kill switch.
  A publish failure after store is a logged ledger gap (no outbox at this
  scale — accepted).
- **REST**: `POST /villagers/{id}/reflections` now real (was a 501 stub):
  forces one pass (budget/cap still apply), 503 when no LLM is armed,
  `{"data": [...]}` of created reflection records.
- **Wiring**: compose memory-service gains `KAFKA_BROKERS: redpanda:29092`,
  `depends_on: redpanda`, `LLM_PROVIDER`/`REFLECTION_*` env; `.env.example`
  documents the reflection block; `task test` gained the memory-service
  suite (it was missing). Dockerfile unchanged — envelope/payload validation
  is tests-only, so the service-dir build context still works.
- **Tests 19 → 42** in memory-service: LLM chain/transports/breaker offline;
  prompt/parse/cap/envelope-vs-contract offline; integration vs real pgvector
  (pressure trigger select/reset/no-self-feed; provenance + contract-valid
  emission with shared correlationId; and the AC test — **a fresh reflection
  outranks week-stale raw memories at default retrieval weights**).
  Integration fixtures moved to `tests/conftest.py` (shared, same move
  agent-service made in M1-7).
- **Also fixed in passing**: `test_percept_fanout.py` had hardcoded
  `occurredAt: 2026-07-07T10:00:0xZ` envelopes — a time bomb that expired
  this morning when the wall clock passed them and the 10-minute percept
  freshness guard started (correctly) dropping them as stale backlog. Now
  stamped `datetime.now(UTC)` at test time. Gotcha added to CLAUDE.md.
- **NOT live-verified end-to-end** (stack down all session; nothing running
  to disturb). First `up --build` should watch memory-service's ready log
  for `reflections=on` and expect ReflectionCreated events in the ledger
  once 20-villager chatter builds pressure — a natural first check for the
  M1-10 filming-run session.

### What M1-10 shipped (commit `M1-10: coverage gate + verified in-game day…`)

- **Coverage gate ON** (was report-only since M0): agent-service
  `--cov=agent_service.brain --cov=agent_service.llm --cov-fail-under=80`
  (actual 96.4%); memory-service `service`+`scoring` scoped (actual 98.0% —
  four reflect()-guard-path tests added to get there honestly); event-service
  jacoco `jacocoTestCoverageVerification` over adapter.in/application/
  persistence classes (actual 87.8%), wired `finalizedBy(test)` so CI's fixed
  `gradlew test bootJar` enforces it. Python gates live in the caller
  workflows' `coverage-args`.
- **Grafana**: 3 new panels (reactive tick ratio; LLM spend by service; 
  reflections by outcome) + fixed a pre-existing double-count: every service
  has TWO Prometheus targets (run_mode host|compose) that both scrape the
  same process when ports are published — absolute-sum panels now filter
  `{run_mode="compose"}` (ratios/quantiles are unaffected by uniform 2×).
- **docs/demo-m1.md** — the M1 demo run-through + Episode 1 shot list
  (6 money shots: wake-up, conversation-with-causation, first grudge,
  a villager reflects, the trace, the wallet).
- **THE BIG ONE — the verification day found two production bugs** (this is
  why the ticket says "filming run"; both fixed, tested, deployed):
  1. **Silent command-consumer death + stale replay**: during M1-8's connect
     storm the kafkajs consumer in minecraft-service crashed WITHOUT
     restarting — container looked healthy, bots stayed online, but no
     command executed in-game from ~08:45Z on, and committed offsets froze.
     Today's boot resumed at the frozen offset and REPLAYED ~3.5h of dead
     intents into the live world (bots reciting hours-old chat). Dedupe
     can't guard this (never-executed commands have no keys). Fix: freshness
     guard in the executor — commands older than `COMMAND_MAX_AGE_SECONDS`
     (600) drop with `ActionFailed{STALE_COMMAND}` (additive enum value,
     types regenerated), preserving exactly-one-outcome; consumer now
     `exit(1)`s on unrecoverable crash + `restart: on-failure` in compose
     (loud, visible in restart counts). Deployed live: chewed 747 stale
     commands in seconds, lag 0 since. Regression test added (30 ts tests).
  2. **Budget breaker trip on free Ollama → fake pollution**: the 2M daily
     token budget (sized for OpenAI dollars) lasts ~30 min at 20 villagers
     on Ollama; when it tripped (mid-soak in M1-8 too — reconciliation
     below), deliberation silently became the FakeProvider, whose scripted
     chat + relationshipUpdates POLLUTED narrative state: a manufactured
     +100 "friendship" toward Bram (the script's hardcoded target), 1,745
     scripted memories (53% of memory_db!), and greeting-driven heuristic
     inflation. **Repaired from the ledger** (the restore-point pattern):
     replayed every RelationshipChanged per edge excluding (a) fake-script
     deltas, (b) pre-clean-window greeting-heuristic nudges, (c) source
     ≠ agent-service (dev-tool test events — the replay initially
     resurrected an M1-5 synthetic −60 grudge; excluded). 306 edges
     repaired, 28 fake-only edges deleted, 1,745 scripted memories purged.
     `.env` now carries `LLM_DAILY_TOKEN_BUDGET=100000000` for Ollama runs
     (.env.example documents the sizing trap).
- **The verified in-game day (12:12:52Z + surrounding clean windows), all
  20 villagers on real llama3.1 deliberation — M1 DoD status:**
  1. ✅ 20 bots, 28×60s monitor samples all 20/20, MSPT avg 5.2–11.0 ms,
     zero container restarts; p95 tick 32.8s < interval (120s configured for
     the verification day; also < the old 60s bar).
  2. ✅ ≥3-turn conversation chain reconstructed from the ledger: reply
     DecisionMade.causationId → heard ChatObserved (the identity thread),
     consecutive turns joined on the utterance. NOTE: under load the gap
     between VillagerTalked (decision time) and ChatObserved (spoken) runs
     MINUTES (single-partition executor queue) — reconstruction windows
     must allow ~10 min, not 30s. 142 real llama lines heard in-game in the
     final 20 minutes; 76 reactive chat replies.
  3. ✅ (closed 2026-07-07 afternoon): friendship — Wren→Quill affinity
     +100 / trust 100, fully organic, survives all repair passes. Grudge
     |affinity|>40 — **Yara→Cassia peaked −54 at 13:08Z**, formed 0→−54
     entirely inside the verified clean window (12:11Z onward), all 49
     RelationshipChanged deltas `source: agent-service` / heuristic on
     real llama sentiment, zero fake fingerprints; still standing at −42
     live at 19:15Z. Quill→Wren independently touched −40 / trust 0 the
     same afternoon — the mechanic reproduces. (The "NOT YET / min −9"
     reading was stale: the late filming window kept running after that
     measurement.)
  4. ✅ Live graph verified in-browser during the day (345 clean edges,
     reasoned tooltips) + populated leaderboard.
  5. ✅ Coverage gate enforced; correlation trace: one id greps across
     agent-service logs + full ledger chain (Decision→ActionRequested→
     VillagerTalked→9×RelationshipChanged→MemoryFormed).
  6. ⬜ Episode-1 segment: Parker's filming session; demo-m1.md +
     shot list + a verified dress rehearsal are staged for it.
- **M1-9 live-verified during the day**: memory-service booted
  `reflections=on` (chain walked to warmed Ollama), the pressure trigger
  fired naturally on the first job pass (Elara pressure 1021!), 12
  reflections at exactly the hourly cap (+8 cap-skips, 0 malformed),
  provenance-linked rows, ReflectionCreated in the ledger end-to-end.
- **Paper `MAX_PLAYERS: "30"`** in compose (was 20 = bots filled every
  slot): Parker can now join and spectate; fleet auto-reconnected 20/20.

### M1-8 record reconciliation (honesty note)

The soak's three ACs (bots online / MSPT / zero restarts) genuinely passed —
but "real Ollama deliberation for the full 37 min" needs a correction: the
budget breaker tripped mid-soak (~2M tokens ≈ 30 min in), silently flipping
deliberation to fake, AND the command consumer died during the connect storm
(~08:45Z), so in-game actuation stopped partway through. Ledger-side
activity (VillagerTalked, DecisionMade) continued and is what the soak
evidence cited. The in-game chatter observed early in the soak was real.
Both failure modes are now fixed and loudly observable (M1-10 above).

## THE FILMING SESSION HAPPENED (2026-07-07 ~12:45–13:35Z) — M1 DoD #6 footage recorded

Parker joined in-game and recorded Episode 1 material on the Ollama filming
preset (60s ticks, reflections on, budget 100M). What the cameras caught,
all emergent: the plaza assembly (all 20 gathered via `spreadplayers` —
stage direction only; every word was llama's), the diamond rumor mutating
scoop→plan as it spread, Tansy's whisper campaign against Bram, Quill's
public fact-check of Wren, a 12-villager reflection wave (exactly the
hourly cap) incl. Wren's oblivious "the village is abuzz" while 7 neighbors
privately concluded she's unreliable, the storm arriving AFTER the village
had invented a storm forecast, three factions (records-accuracy bloc /
pragmatist food bloc / diamond dreamers), Yara openly recruiting to leave,
and the capstone: **Petra convened the village's first self-organized
meeting** ("calling a meeting by sundown... Wren and Bram agreeing to share
their thoughts") — proto-governance, one milestone early. All reconstructable
from the ledger (causation chains + reflection provenance) for edit overlays.

**A FOURTH bug was found and fixed live on camera** (commit `6a8ad3f`): the
executor wedge — `execute()` awaited an action promise that never settles
when a connection dies mid-move (any Paper restart), freezing eachMessage
and, with one partition, EVERY bot, with no crash event. Now `Promise.race`s
the watchdog; regression test added; CLAUDE.md corollary 3.

## Afternoon session (2026-07-07 ~19:10–20:00Z) — grudge DoD closed, gather diagnosis

- **Stack brought back up** (Paper + infra + app, all healthy first try; seed
  re-embodied 20/20 bots; agent on warmed llama3.1; reflections on; command
  executor lag 0 — the wedge fix holding).
- **DoD #3 grudge: CLOSED with ledger evidence** (see DoD list above). Key
  dynamics finding: **grudges mean-revert under ambient positive chatter** —
  a 40-min watch saw Yara→Cassia decay −45→−30 and Quill→Wren −40→−30;
  the ±3 hearer-sentiment heuristic oscillates toward zero without fresh
  conflict. Sustained grudges need negative-memory reinforcement or real
  conflict events → M2 design note.
- **"Bots don't move around / never gather" (Parker's observation) —
  diagnosed, three compounding causes, all M1-scope design, no bug:**
  1. System prompt line "Prefer small, concrete, social actions over grand
     plans" (`brain/prompts.py`) steers llama away from material action.
  2. The world snapshot carries NO environment info (only position, health,
     food, time, nearby villagers, inventory) — the only coordinates the
     LLM ever sees are villagers', so all move targets stay inside the
     plaza cluster. Bots DO move (positions verified matching move targets;
     267 moves since restart), just locally.
  3. All 3 gather attempts failed `RESOURCE_NOT_FOUND` — no wood within
     reach of the y≈120–130 plaza, and llama self-supplies `maxDistance:
     10` (executor default is 32, cap 64).
  Cheap M2 levers, in impact order: nearby-resources line in the snapshot
  (contract change: schema + fixture + `task gen`), soften the
  social-actions prompt line, prompt-doc `maxDistance: 48`. Minor: Ulric
  repeatedly TIMEOUTs on moves (unreachable target?) — retryable,
  non-fatal, worth a look if it persists.

## Machine state at session end (2026-07-07 ~13:40Z) — SUPERSEDED: stack is RUNNING (afternoon session brought it back up; Parker in-game, 21/30 players)

- **Stack fully DOWN** — clean shutdown after filming: world saved
  (`save-all flush`, Petra's meeting is canon), all profiles down,
  0 containers. All volumes intact.
- `.env` (uncommitted, as always): `VILLAGER_COUNT=20`, `MC_HOST=minecraft`,
  `TICK_INTERVAL_SECONDS=60`, `REFLECTION_ENABLED=true`,
  `LLM_DAILY_TOKEN_BUDGET=100000000` — this IS the working Ollama filming
  preset now; it ran the recorded session successfully.
- Paper: `MAX_PLAYERS=30`; ParkerShamblin op'd (offline UUID).
- agent_db + memory_db are narrative-clean and now carry the filming
  session's story (the meeting, the reflections, the factions) as canon.
- Next session candidates: M2 planning; episode-edit support (ledger pulls
  for overlays); the still-open organic grudge (Tansy's campaign against
  Bram is the live thread — his incoming edges were sliding all session).
- **M2 planning input ready (2026-07-07 evening):**
  `docs/research/emergent-garden-lessons.md` — deep study of Emergent
  Garden's five videos + the three canon papers (Generative Agents, Project
  Sid/PIANO, Mindcraft/MineCollab) cross-checked against our architecture.
  §7 has M2 backlog candidates in five tracks (A physical competence,
  B plans/reflection, C social dynamics, D government via Sid's
  constitutional loop, E ledger analytics) plus rulings-to-carry (no live
  codegen, no vision, single-call tick stays). Recommended M2 core set:
  A1–A3 + C1–C2 + D1–D2. The gather fix is Track A (composite verbs +
  prescriptive failures + nearbyResources percept — evidence-backed).

Deferred to M2 by review: dashboard-service BFF, analytics-service, Loki, k6.
New M2 candidates from this session: packages/shared-py (two envelope-builder
copies exist), per-provider LLM budgets (a $0 Ollama run shouldn't trip a
cost breaker into narrative-polluting fake), multi-partition commands.minecraft
(single partition serializes all bots' actions — the decision→speech gap),
and quirks into the system prompt (the M1-7 one-liner, still pending).

## Key decisions & gotchas from Sprint 3 (all shipped, all tested)

- **Percept freshness guard**: percepts older than **10 minutes** (by envelope
  `occurredAt`) are dropped in `kafka/percepts.py` — committed consumer-group
  offsets survive redeploys and would otherwise replay days-old chat as fresh
  percepts (observed live). Regression test: `test_stale_events_never_become_percepts`.
- **Tolerant-reader normalization** (`llm/contract.py::_normalize_params`):
  llama3.1 reliably drifts — `params.villagerId` instead of `targetVillagerId`
  (chat/follow alias table) and decision-level keys (`importance`, `sentiment`…)
  duplicated inside params (stripped). Counted by **`civ_llm_normalized_total`**;
  genuinely unknown params still hard-reject. Cut malformed-decision rate from
  ~50% to ~25%; every remaining failure degrades to idle + `error=true`.
- **`ChatParams` gained optional `targetVillagerId`** (additive v1) — models
  naturally emit "who I'm addressing"; the executor ignores it.
- **Affinity mechanics**: LLM path = `relationshipUpdates` (REQUIRED-NULLABLE
  in DECISION_SCHEMA — OpenAI strict mode rejects optional properties; max 3
  items, deltas ±20). Heuristic fallback (only when LLM sends null) = the
  HEARER's own `decision.sentiment` moves the edge: **±3 ambient, ±8 when the
  hearer is named in the message**; trust moves at half the affinity delta.
  Every change → `RelationshipChanged` ledger event (both dims, prev+new,
  reason, `source: deliberation|heuristic`, causation = the DecisionMade).
- **Conversation identity thread**: chat percepts carry the source envelope's
  `sourceEventId` + `correlationId`; a reactive tick passes the heard eventId
  into `run_tick(cause=…)` → DecisionMade causation. Chain:
  ChatObserved → DecisionMade → ActionRequested(chat)/VillagerTalked → next ChatObserved.
- **Reactive tick guards** (scheduler): cooldown 15s, cap 3 per 5 min,
  imminence suppression <10s; a reactive tick counts as the tick (next
  scheduled = +interval). `civ_ticks_total` now has a `trigger` label.
  Depth-decay deliberately deferred (risk register says so).

## How to resume work (commands)

```powershell
# stack (from repo root; env vars are the demo preset)
$env:VILLAGER_COUNT='2'; $env:TICK_INTERVAL_SECONDS='60'
docker compose -f infrastructure/docker/docker-compose.yml --env-file .env `
  --profile infra --profile app up -d --wait
# Minecraft server (its own window; type 'stop' to save+exit)
cd "..\Minecraft 1.21.6 Server"; java -Xmx3G -jar server.jar nogui
# seed + watch
curl -X POST http://localhost:8001/internal/seed
docker logs ai-civilization-engine-agent-service-1 -f | findstr "tick complete"
# hand-publish any command (dev tool). PowerShell eats inner double quotes on
# the way to node — escape them: '{\"resource\":\"wood\",\"maxDistance\":4}'
node scripts/produce-cmd.mjs <villagerId> <action> '<paramsJson>' [timeoutMs]
```

Tests: `task test` (all), or per service:
`uv run pytest` (in services/agent-service and services/memory-service),
`npx vitest run` + `npx tsc --noEmit` (services/minecraft-service),
`./gradlew test` (services/event-service),
`npm test --workspace @civ/events` + `npm run gen` (contracts + drift).

Villager UUIDs (stable, used everywhere incl. fixtures):
Elara `019f8e2a-0000-7000-8000-0000000e1a2a`,
Bram `019f8e2a-0000-7000-8000-0000000b2a44`,
Wren `019f8e2a-0000-7000-8000-0000000c3e55`.

Watch out: villager bot sessions live in the **minecraft-service container**
and auto-reconnect across MC-server restarts — a previous run's villagers can
walk back in (Wren did). Despawn via `produce-cmd` or restart that container
for a clean cast list.
