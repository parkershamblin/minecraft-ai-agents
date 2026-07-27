# ADR 11 — Beat the game: long-horizon collaborative play as the north star

Status: ACCEPTED (owner, 2026-07-27 — "implement all 4"). Supersedes the
post-T1 roadmap ambiguity in ADR 10 (T1 race shipped and audited; this arc is
what comes after). Evidence base: `docs/reports/capability-roadmap-2026-07-27.md`
and the 12 extractions in `docs/research/2026-07-27-deep-sweep/` — every design
call below cites that research; this ADR records the decisions.

## Decision core

1. **North star: a villager team beats the game** (fresh survival world →
   ender dragon dead), while staying reactive to fast danger and remaining
   honest (ledger-verified milestones, no creative/cheat shortcuts). No
   published agent has done this; SOTA stalls at diamond tier and the
   blockers are capability plumbing, which favors our trusted-executor
   architecture (scan-beat-the-game.md §1).
2. **Three-layer capability architecture**, all patterns proven at ≤13B:
   - Layer 0 reflexes (ms, zero LLM): existing hazard/threat/eat/guard/armor
     cluster, extended with combat reflexes (shield, ranged response,
     enderman gaze-aversion). Reactivity NEVER comes from the deliberation
     loop (TickingCollab 0.62→0.05; SwiftSage/SwarmBrain design rules).
   - Layer 1 executor skills (deterministic, verb-addressable): the verb
     ladder below. Skills are hand-written; the LLM never writes code
     (Voyager GPT-3.5 ablation, house stance).
   - Layer 2 deliberation (30s, LLM picks one verb — later: one plan-slice):
     unchanged shape; gains standing Project section (phase B) and
     multi-step intents (TextSC2 amortization pattern).
3. **Verb ladder, dependency-ordered** (each is an additive contract bump +
   executor skill + drill): place_block → use_bucket → use_item_on_block /
   enter_portal → equip / use_shield → toss → bow_ranged → sleep_bed →
   throw_eye; plus container I/O (deposit/withdraw) and give (the #1
   collaboration primitive in MINDcraft's 47-command vocabulary).
4. **Project system (phase B): persistent code-side goal DAG** — the race.py
   checklist pattern generalized. Stage graph in code, claims as ledger
   events, dispatch in code (NEVER an LLM dispatcher — MindAgent: 70B scored
   0.0 at that job), prompt renders your claim + team state + computed next
   move. Restart-safe via ledger rehydration (RaceState precedent).
5. **Coordination carrier is structured state, not chat** (GovSim +
   MineCollab + MECoBench convergence; chat stays social/narrative).
6. **SFT flywheel runs alongside** (owner decision 4): ledger/capture →
   success-filtered transitions → QLoRA overnight on the consumer GPU →
   GGUF → Ollama → A/B under the race harness. Self-improving via
   win-vs-DNF pairs; no bigger teacher required (AgentEvol precedent).

## Phases and exit gates

- **A — body extension** (contract bump 1: place_block, use_bucket, equip,
  give, deposit, withdraw, toss, consume; craft enum += chest, shield,
  bucket). Exit: scripted drills — bucket-cast obsidian on a test world,
  chest logistics round-trip, give-chain across two bots.
- **B — Project system.** Exit: 6 villagers reach iron age unattended on a
  fresh world with measurably less duplicated work (ledger metric:
  concurrent same-resource-same-region gathers).
- **C — Nether** (bump 2: use_item_on_block, enter_portal, bow_ranged,
  sleep_bed; dimension-aware sessions). Exit: blaze rods banked, unattended.
- **D — the End** (throw_eye + code-side triangulation; End-fight
  orchestration as Project stage with role claims). Exit: dragon dead from
  a fresh world — past published SOTA.

## Explicitly rejected (evidence-ranked dead ends)

LLM-generated code skills · NL negotiation / plan relay as coordination ·
LLM centralized dispatcher · VoT / per-tick spatial visualization ·
per-tick vision-VLM · stimulus-referenced LLM wake triggers (reflexes own
stimuli; the LLM wakes on progress events only).

## Debt / risks registered

- minecrafthawkeye (bow) is community-maintained: exact-pin + live smoke on
  1.21.6 gates any phase-C/D dependency (owner decision 3 adopts it now at
  import-pin level only).
- Dimension assumptions (BotSession, reflexes, physicsSimCache, chat
  earshot) audited before phase C.
- Contract churn: one bump per phase, never per verb (owner's batching
  rule).
- keepInventory death fiction (ADR 10 debt) becomes acute at the dragon —
  repay at phase D planning.
