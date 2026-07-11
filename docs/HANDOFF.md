# Session Handoff — M2 COMPLETE · materials kit + ops fixes MERGED (main=origin=`16f6f45`, PRs #2–#4) · powder-snow reflex LIVE-VERIFIED (PR #5 open) · Episode 2 filming = Parker's session

> A fresh session should be able to continue from this file +
> `docs/architecture/08-m2-plan.md` without asking questions. **M1 complete
> (DoD 6/6, Episode 1 filmed). M2 COMPLETE and merged: the dress rehearsal
> ran a fully organic election on live llama deliberation — 20/20
> candidacies, 20/20 votes, 100% turnout, MAYOR BRAM seated. Since then:
> per-player materials/inventory observability (PR #2), the kafka-rejoin +
> null-param fixes (PR #3, live-verified), and a top-collectors panel on the
> overview (PR #4). DoD #6's episode segment is Parker's filming session
> (`docs/demo-m2.md`). THE FLEET IS TICKING — see machine state below.**

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
- **Deployed state**: minecraft-service + agent-service containers currently
  run THIS BRANCH's images (built from the worktree); other services on main
  images. After merging, rebuild from main to converge provenance.
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
