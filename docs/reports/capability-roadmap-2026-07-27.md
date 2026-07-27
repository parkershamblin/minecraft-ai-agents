# Beat-the-game capability roadmap (2026-07-27)

Deliverable of the deep research pass: 6 papers re-read in full (every prompt
template and mechanic — condensed extractions in
`docs/research/2026-07-27-deep-sweep/`), ~40 additional papers/sources scanned
across five clusters (long-horizon agents, multi-agent coordination,
reactive/hybrid architectures, small-model agent recipes, beat-the-game
requirements), plus a file-level audit of our current capabilities. Every
claim below carries its source; per-source detail lives in the research dir.

## 1. Headline findings

**1.1 Nobody has beaten the game.** No autonomous agent — LLM or RL — has a
published ender-dragon kill from a fresh survival world as of July 2026. The
Manifold "AI defeats Ender Dragon before 2026" market resolved NO
(2026-01-04); published SOTA stalls at the diamond plateau (GITM 67.5%
ObtainDiamond; JARVIS-1 12.5% diamond pickaxe @60min; Optimus-3 diamond group
15%). The Nether→End chain is essentially unbenchmarked — even 2025-26 agents
stop at diamond tier. **From diamond onward we would be extending published
SOTA, not chasing it.** The blockers are capability plumbing (block placement,
ranged combat, dimension travel) — which favors a trusted-executor
architecture over model scale. (scan-beat-the-game.md, scan-long-horizon.md)

**1.2 The field's convergent answer at small scale IS our architecture.**
Every system that goes deep into the tech tree with a small/cheap model moves
planning OUT of the LLM: GITM (GPT-3.5-class + handcrafted structured actions
→ 67.5% diamond, 100% Overworld tech tree, 32 CPU cores, no GPU); Plan4MC
(zero runtime LLM calls — pure graph search over skills); Optimus-1 (HDKG
dependency graph queried by code-side topological sort; the same memory
structures gave open MLLMs 2-6x uplift); **Odyssey (LoRA-tuned LLaMA-3-8B +
183 composed mineflayer skills: diamond 21.7%@5min → 92.5%@10min → 100%@15min
— proven AT our model class)**; DEPS (fine-tuned 13B planner 70-90% early
tech tree, beating prompted 70B). The consistent story: **8B + structure ≥
frontier + free-form.** Free-form LLM planning tops out at 0.59%
ObtainDiamond (DEPS/Codex) or requires GPT-4 (Voyager). (scan-long-horizon.md)

**1.3 Long-horizon capability = code-side goal DAG + persistent project
state. This is our single biggest architectural gap.** The audit found NO
standing goal object anywhere: no plan/subgoal stack, no todo, no project
representation across ticks; the only standing prompt state is the race
cache, civic cache, and (new) failure streaks — none villager-authored, all
in-memory (repo-audit.md §7). Meanwhile our own race machinery is the
in-house proof of the winning pattern: structured standing section +
pack-aware computed checks that emit THE one next move (brain/race.py,
prompts.py:393-437) carried an 8B through the T1 chain reliably. The
generalization of exactly that pattern into a "Project" system — stage DAG in
code, current assignment rendered per villager — is the field-convergent
long-horizon answer (GITM sub-goal trees, Optimus-1 HDKG, JARVIS-1
self-check). (repo-audit.md, scan-long-horizon.md)

**1.4 Reactivity can never come from the deliberation loop.** TickingCollab
(2606.15684): sync→real-time async success collapses 0.62→0.05 because ~20s
inference exceeds 25-44s time-to-failure windows. Design rules with evidence
(scan-reactive.md): fast path acts by default, LLM is an exception handler
(SwiftSage 84.68 vs ReAct 36.43 at 62% fewer tokens; SwarmBrain FSM micro,
76% vs Hard AI; even GPT-4V Cradle fell back to a scripted fight()); proven
LLM-wake triggers are PROGRESS-referenced (N-consecutive-failures, invalid
action, anomaly, critical decision, sub-goal boundary) — health-drop/new-
hostile belong to the reflex layer, never the LLM; oscillation is prevented
by commitment windows, not per-step voting; **resume beats replan-from-
scratch** (AdaPlanner refine-from-breakpoint; DEPS never interrupts a
sub-goal). Our stack already implements most of this (reflex layer + busy
arbitration + reactive wake with cooldowns + latest-intent-wins + failure
streaks); the gaps are combat reflexes (shield, ranged response,
enderman gaze-aversion), multi-action intents (TextSC2's K-action queue
pattern — fine-tuned Qwen-1.8B/7B nearly matched GPT-4-Turbo there), and
resumable long actions. (scan-reactive.md, repo-audit.md)

**1.5 Collaboration = structured shared state + code-side dispatch; chat is
narrative flavor.** Evidence ranked (scan-multi-agent.md): (1) async
non-blocking execution — S-Agents 29.0→4.0 min (7x), model-free, half shipped
in our v7; (2) centralized dispatch — VillagerAgent 73.75% vs AgentVerse
29.75%, TeamCraft redundant-work 1% vs 15% — BUT every zero-shot instance
used GPT-4-class planners and MindAgent showed LLaMA-2-70B scoring 0.0 as
dispatcher → **the dispatcher must be code, not an LLM**; (3) gated minimal
communication — Gated Coordination +11-12.5 pts with 85% fewer messages,
non-LLM scoring dominant; CoBel-World −64-79% comm tokens; (4) NL negotiation
dead ≤13B (GovSim + MineCollab + MECoBench converge; MineCollab: plan
communication kills 8B-SFT to 0.00). Team size plateaus at 2-4 everywhere;
sparse-resource tasks are the exception where N=4 turns impossible-solo into
done (S-Agents iron). Sid/PIANO's transferable skeleton: concurrent modules
at different timescales sharing agent state, ONE compressed-state decision
broadcast downstream — its reflex/awareness modules are code, only
goal/social calls hit the LLM. (scan-multi-agent.md)

**1.6 SFT is the proven capability multiplier at 8B, and our ledger is a
ready-made dataset factory.** Refined recipe (scan-small-model.md):
500-2k success-filtered trajectories move a 7B (FireAct +77% rel; MINDcraft
0.00→0.28 from ~200 winning runs → 16k transitions); mix 20-50% general
instruct data or held-out ability collapses (AgentTuning); add hallucination
negatives (Agent-FLAN); step-filter by execution result (APIGen — our ledger
stores ActionFailed per decision, this is free); QLoRA rank 32, 2 epochs,
overnight on the 4090, GGUF → Ollama unchanged. Cold start solved — our 8B
already wins races, so AgentEvol/ETO-style self-improvement (explore →
success-filter → retrain; DPO on win-vs-DNF pairs) works with NO bigger
teacher: AgentEvol's Llama-2-7B surpassed GPT-4-Turbo on 3 benchmarks this
way. Constrained decoding: neutral-to-positive at 8B when the envelope is
constrained and reasoning stays free-text-first (dottxt replication;
JSONSchemaBench). Greedy stays (2402.05201: temp 0.0-1.0 no significant
difference). (scan-small-model.md)

**1.7 The End fight is the most team-parallelizable stage in the game** — 2
snipers on uncaged crystals + 1 climber for the 2 caged ones + 3 melee
rushing every perch — a genuine differentiator for a villager fleet vs every
published single-agent system. Existence proof at scale: Parallelized
Planning-Acting (2503.03505) reports Ender Dragon 91.7% SR in 5.2±1.5 min
with 10 agents in a staged boss fight — deterministic skill library executes,
LLM only schedules. Staged, not fresh-world — the fresh-world chain remains
open SOTA. (scan-beat-the-game.md, scan-multi-agent.md)

## 2. Target architecture (three layers + two spines)

All of it is composition of patterns proven at our scale; no component asks
the 8B to do anything the literature shows it can't.

- **Layer 0 — reflexes (ms-s, zero LLM).** Exists (hazard/threat/eat/guard/
  armor + busy arbitration). EXTEND: shield-block reflex, ranged-threat
  response (bow via hawkeye plugin), enderman gaze-aversion, phantom
  handling, blaze-fireball strafe. SwarmBrain/MINDcraft-"modes" pattern;
  TickingCollab proves this is the only place reactivity can live.
- **Layer 1 — executor skills (s-min, deterministic, verb-addressable).**
  Exists: gather sessions, craft chain-resolution, hunt. EXTEND with the
  dependency-ordered verb ladder from the requirements DAG:
  `place_block` → `use_bucket` → `use_item_on_block`/`enter_portal` →
  `equip`/`use_shield` → `toss` → `bow_ranged` → `sleep_bed` → `throw_eye`,
  plus container I/O (`deposit`/`withdraw`) and `give` (item transfer — the
  #1 collaboration primitive in MINDcraft's vocabulary). Everything
  mineflayer-supports today; bow needs one community plugin
  (minecrafthawkeye — smoke-test on 1.21.6 per exact-pin rule). Dimension-
  aware BotSession state is the one deep executor change (key state on
  bot.game.dimension; portal final step on raw controls, mineflayer #709).
- **Layer 2 — deliberation (30s, LLM picks ONE verb).** Unchanged shape.
  Gains: a standing PROJECT section (below) and multi-step intents (emit up
  to K sequential verbs per deliberation into the existing lane, consumed
  one per completion, superseded as today — TextSC2's amortization pattern;
  turns the 30s cadence from 1 action/tick into 1 plan-slice/tick).
- **Spine A — the Project system (persistent goal state).** Code-side stage
  DAG for beating the game (hand-authored, mcData-verified — the
  requirements table in scan-beat-the-game.md is the spec), stored in
  Postgres, advanced by ledger events (milestone mapper already exists for
  races). Per villager, the prompt renders: current project stage, YOUR
  claimed task, teammates' claims, computed next-move directive — the
  race.py pattern generalized. Claims are ledger events (villager asks,
  code-side dispatcher grants — never an LLM dispatcher, MindAgent's 70B=0.0
  kills that idea). Restart-safe by construction (rehydrate like RaceState).
- **Spine B — the flywheel (offline SFT).** Ledger→SFT exporter (transition
  format per MINDcraft §9: full prompt context → next decision; win-filtered,
  step-filtered by ActionFailed; hallucination negatives synthesized), QLoRA
  overnight, A/B under the existing race harness, iterate ETO-style with
  win-vs-DNF DPO pairs. Each new capability phase generates its own training
  data through the same pipeline.

## 3. Phased plan

Contract note: every phase-A/C/D verb is a schema change — per house rules
these are additive, fixture-backed, and (per the owner's batching decision)
should land in ONE contract bump per phase, not per verb.

- **Phase A — body extension (2-4 sessions).** Contract bump 1: place_block,
  equip, give, container I/O, toss, consume + errorCodes. Executor skills +
  reflex extensions (shield). Scripted-drill exit gate (the RB-1 pattern):
  bucket-cast obsidian + lit portal on a test world, chest logistics drill,
  give-chain drill. No LLM changes at all.
- **Phase B — Project system (2-3 sessions).** Stage DAG + claims + standing
  prompt section + computed directives; multi-step intents; resume-vs-replan
  policy on top of failure streaks (AdaPlanner breakpoint rule: revise the
  remainder, keep the done prefix). Exit: 6 villagers, fresh world, reach
  iron age unattended with measurably less duplicated work than today
  (ledger metric: same-resource-same-region concurrent gathers).
- **Phase C — Nether (2-4 sessions).** Contract bump 2: enter_portal,
  use_item_on_block, bow_ranged, sleep_bed. Dimension-aware sessions,
  bridging via pathfinder scaffolding blocks, gold/piglin barter fallback,
  fortress search pattern, blaze choke-fight skill. Exit: blaze rods banked
  by a team, unattended.
- **Phase D — the End (2-3 sessions).** throw_eye + code-side triangulation
  (spatial truth stays out of the LLM — VoT lesson), stronghold dig
  protocol, End-fight orchestration as a Project stage with role claims
  (snipers/climber/melee). Exit: dragon dead from a fresh world — past
  published SOTA, on camera.
- **Parallel track (any time, zero contract risk):** the exporter + first
  QLoRA run — it improves reliability of everything above and the recipe is
  fully specified (scan-small-model.md "Recipe we should run").

## 4. What we explicitly do NOT build (evidence says dead)

- LLM-generated code skills (Voyager 5.7x GPT-3.5 collapse; our executor
  stance) — skills are hand-written, verb-addressable.
- NL negotiation/plan-relay as coordination (GovSim, MineCollab —
  8B-SFT→0.00, MECoBench) — chat stays social/narrative.
- LLM centralized dispatcher (MindAgent: 70B scored 0.0) — dispatch is code.
- VoT/per-tick spatial visualization (regresses at 8B); grid percepts only
  as a measured A/B later if navigation stalls persist.
- Per-tick vision/VLM (MINDcraft: "thorough textual observations often
  outperform visual inputs"; GPU budget).
- Generic "world changed" LLM wake triggers (no paper found value; keep
  progress-referenced triggers + reflexes).

## 5. Risks and open questions

- **Plugin risk:** minecrafthawkeye / custom-pvp on 1.21.6 — exact-pin +
  `task smoke` gate before any phase-C/D dependency.
- **Dimension state:** BotSession, hazard reflexes, physicsSimCache,
  chatRouter earshot all assume one world; audit before phase C.
- **GPU duty cycle:** more standing sections = slightly longer prompts (our
  4096-fit result says headroom exists); multi-step intents REDUCE
  deliberations per action — net positive expected, measure anyway.
- **8B planning depth inside a stage:** stages are designed so the LLM only
  picks among 2-5 legal next tasks (computed by the DAG) — the exact regime
  DEPS/GITM/Odyssey prove; if a stage still stalls, that stage's directive
  gets the race.py hard-check treatment.
- **Owner decisions needed:** (1) adopt beat-the-game as the north-star arc
  (this doc → ADR 11); (2) contract bump 1 scope sign-off; (3) plugin
  adoption; (4) whether the SFT track runs before or alongside phase A.

## 6. Source map

`docs/research/2026-07-27-deep-sweep/`: repo-audit.md ·
scan-beat-the-game.md · scan-long-horizon.md · scan-multi-agent.md ·
scan-reactive.md · scan-small-model.md · voyager.md · mindcraft.md ·
mineland.md · govsim.md · vot.md · minedojo.md. First-pass synthesis:
`docs/reports/papers-synthesis-2026-07-27.md`.
