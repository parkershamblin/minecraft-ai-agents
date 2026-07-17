# RB (streamlined): Red vs Blue T1 race → demo video

## Goal & requirements

Land a SWE job (apps out this fall). Artifact: **2–3 min captioned video** of a 3v3 LLM-bot race to first crafted iron pickaxe, live scoreboard, + quantified resume bullets. NFRs: zero human intervention post-spawn · milestone truth from the ledger (replayable) · race rerun cost < 30 min (best-of-N filming) · runs on one box · honest footage (no FakeProvider pollution). Full context/evidence: v2 plan, pasted into the ADR appendix unedited.

## Definition of victory (ADR-verbatim)

Filmed 3v3, fresh world, **Normal** difficulty, far team spawns, zero intervention. **Win = first `ActionCompleted{action:craft, item:iron_pickaxe}`** by any team member (`occurredAt`, UUIDv7 tiebreak) — an **existing event type**; the craft-event predicate structurally excludes looted tools. Pre-authorized fallback: if the RB-2 Normal soak shows race-breaking stall/death rates, flagship drops to Easy, soak numbers recorded. Everything past T1 (diamonds, dragon) is roadmap.

## System design (what changes, per service)

teams.json (villagerId→team)─┐
                             ▼
agent-service ── tick: perceive → retrieve → deliberate → act
  + tier-checklist prompt section, team-progress percepts
  + enum extensions only — NO new verbs (craft/gather proven in #33)
        │ ActionRequested{gather:iron_ore | craft:iron_pickaxe}
        ▼
minecraft-service ── the body
  + ore-mine (tool-tier gate, extends gather)
  + craft chain-resolution: missing ingots → furnace flow → smelt → craft
    (absorbs SV-9; auto-equip-best inside skills absorbs SV-14 — no verb)
  + milestone mapper: own outcome events → ProgressionMilestone{teamId}
  + Attempt lifecycle: AttemptStarted/Ended (Ended carries honest-race
    assertion: civ_llm_budget_tripped==0, zero fake-provider delta)
        │ world facts + milestones ──▶ Kafka ──▶ event-service ledger
        ▼                                            │ SSE
prismarine-viewer ×6 (exact-pin, POV_VIEWER off)     ▼
  → static pov-grid.html, 6 iframes      dashboard race page:
    FILM RIG, not a dashboard feature      team bars + milestone feed
                                           (team mapping client-side)

**Contract surface (one additive commit):** GatherParams families += iron_ore, coal · CraftParams items += iron_pickaxe (sword only if drills show combat need) · new events AttemptStarted / ProgressionMilestone / AttemptEnded · new errorCodes · fixtures + task gen + FakeProvider rows + timeout-table rows, same commit (house rule). Milestone set is fixed and small: first coal, first iron ore, furnace placed, first ingot, iron pickaxe (=win).

**Design calls carried unchanged (one line each, ADR records the rest):** one world/far spawns · no multi-brain — prompt section + percepts only · mineflayer 4.37.1 foundation, plugin verdicts per research bank · chat scoping = existing 48-block earshot (verified in code); convergence = diegetic espionage · keepInventory ON + per-bot /spawnpoint = lossless respawn · gov mothball executes in RB-1's compose commit · no vision/VLM.

## Phases

- **RB-0 (docs, this session):** ADR 10-red-vs-blue.md = decision core + debt register + research bank pasted verbatim, not polished; CLAUDE.md north-star + stale (00–07) pointer fix; README status line; HANDOFF entry; resume bullets in PR description (platform-only claims, each number with its reproducing command); PR from this worktree's existing branch; memory update. Proposes SV closures.

- **RB-1 (body):** SV-5b backup **first** (gate) → contract commit (above) → skills: ore-mine, furnace flow inside craft chain-resolution, auto-equip → milestone mapper + Attempt lifecycle → team seed (villagers.json team field, VILLAGER_COUNT=6 preset, team spawn script) + gov mothball rides this commit. **Exit:** scripted harness drill mines→smelts→crafts iron pickaxe end-to-end; milestones in the ledger.

- **RB-2 (race):** tier-checklist prompt + team-progress percepts + chat quick-levers; attempt harness script with the **enumerated checklist**: connection-throttle −1 · gamerules (keepInventory, doInsomnia off, mobGriefing off — protects furnaces) · difficulty + save-all + RCON verify · per-bot spawnpoints · LLM_DAILY_TOKEN_BUDGET=100000000 race preset · race tick + POV flags · far spawns · AttemptStarted stamp; go/no-go llama smoke (existing verbs, extended enums); record Normal soak numbers + Ollama latency at 6 bots × race tick. **Exit:** one unattended llama-driven 3v3 race to T1 with honest ledger evidence.

- **RB-3 (show):** dashboard race page (bars + feed off existing SSE); static POV grid file; measure viewer load ×6 (flag off = rollback); README hero + repo metadata; shot script docs/demo-rb.md; film best-of-N — practice on Easy/peaceful knobs, **flagship at Normal** (or fallback), POV grid and in-world shots as separate takes; Parker cuts, my captions. **Exit:** video exists; resume updated.

## SV disposition (unchanged from v2)

SV-4 mostly landed via #33, residuals ride RB-1/RB-2 · SV-6/7/8/10/11/11.5/12a/12b/13-lite close as landed · SV-5b/9/14/5 absorbed into RB-1 · SV-13/15/16/17/18 retire/roadmap/superseded.

## Cut from critical path → roadmap (re-add triggers named)

T2 diamonds + descend-mine skill + diamond enums (bonus film only if T1 lands early) · armor crafting · **deliberate smelt/equip verbs** (re-add when recipe chains branch enough that the brain must choose — dragon era) · dashboard-integrated POV proxy (becomes product work if the dashboard turns portfolio piece) · hawkeye, multi-brain/PIANO, two-server isolation, OpenAI params reshape, death awareness, T3+ ladder. Research bank preserved as pasted appendix.

## Debt register (in ADR)

1. Gov/social mothballed + dead contract fields — repay when social arc resumes; additive-only is the load-bearing rule.
2. OpenAI params strict-mode breakage — repay **before any OpenAI run**.
3. POV grid — dies with its flag if unmaintained.
4. keepInventory death fiction — repay at dragon era.
5. Craft chain-resolution hides smelt from the brain — repay per re-add trigger above.

## Trade-offs taken

**No new verbs** buys near-deletion of the llama-tuning risk at the cost of less visible per-step agency; the feed still shows furnace/smelt milestones, and the narration is the System-1/System-2 story the ADR already cites (brain sets goals, body executes chains). **T2 cut** buys ~2–4 days and a smaller contract at the cost of a weaker ceiling claim; roadmap framing covers it. **Static POV grid** buys ~a session of Next.js/proxy work at the cost of product polish; the dashboard race page is still the product shot.

## Timeline & risks

RB-1 2–3 sessions · RB-2 1–2 · RB-3 1–2 + filming weekend → **~1.5–2.5 weeks** (conservative 3.5; the tuning-day buffer stays even though the verb risk shrank). Risks: race stalls on camera (→ directive pressure, cheap best-of-N) · iron accessibility (→ curated seed, exposed iron near both spawns) · Normal survival unproven (→ RB-2 soak + pre-authorized fallback) · scope creep (→ ADR pins T1; roadmap holds the rest).

## Assumptions (explicit)

Fleet survives Normal well enough to race (soaked RB-2, fallback ready) · llama emits craft/gather with extended enums at shipped quality (smoke retained) · one box carries 6 bots + 6 viewers + OBS (measured; separate takes are the fallback) · world reset cycle is stable under the harness (backup gate first).

---

What I deliberately did **not** cut: the backup gate, the enumerated attempt checklist, and the honest-race assertion — that trio is the debt-prevention spine, it's cheap, and "verifiably honest race" is a differentiator worth keeping in the resume story. The one thing to sanity-check at RB-1 kickoff: whether stone-tier tools actually shipped in #33 (the SV-3 valve allowed slippage) — if not, the chain-resolution skill picks up stone as one more link, same pattern, half a session.