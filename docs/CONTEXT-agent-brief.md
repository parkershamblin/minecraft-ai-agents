# minecraft-ai-agents — agent brief (as of 2026-07-28)

Ground truth for demo-sprint sessions. Numbers verified against the ledger,
`bench/results/RACE_REPORT.md`, and the 2026-07-28 repo audit. When this brief
conflicts with an older doc or handoff note, this brief wins.

## Repo state (do not rebuild)

Five core services (agent / minecraft / memory / event / government) + dashboard,
contract-first event ledger, generative-agents memory, elections, POV film rig,
audited benchmark harness, frontier-provider seam. T1 race benchmark: DONE and
merged (PR #93 v3–v6, PR #94 v7). Stack idles at GBs of RAM; every capability
crosses two languages plus a schema contract.

**DECISION: the platform is FROZEN.** No new services. No refactors of the six
existing ones. All new capability goes into the agent's tool layer — new
villager abilities are new tool definitions, not new services.

## Action interface (SETTLED — do not re-litigate)

Every villager decision has ALWAYS been one constrained JSON object. There has
never been a free-form text action path:

- Ollama: `format: DECISION_SCHEMA` decode grammar (test-pinned byte-identical).
- OpenAI/Anthropic: ONE forced strict function tool `decide` (`tool_choice`
  pinned, parallel off). Anthropic smoked green 2026-07-27 (claude-sonnet-5,
  9.9s, 3001/245 tokens). OpenAI smoke pending — no key.
- Closed verb enum: 7 LLM-selectable (move, gather, chat, follow, idle, craft,
  hunt); spawn/despawn platform-only; declare_candidacy/vote civic.

**Failure taxonomy (25,690 decisions in the committed bench windows,
`bench/results/sweep/slices/*.window.json` — reproducible offline, no
containers needed):** 3,351 malformed (13.0%) —
92.2% numeric-bounds violations (the Ollama grammar does not constrain bounds),
5.3% not-JSON, 2.5% params shape, **0 invalid verbs ever**. Per-model v7:
gemma4 0.00%, gemma3:12b 0.22%, llama3.1:8b 0.46%; tails lfm2.5 57.9%,
qwen3.5:4b 33.4%. Malformed decisions never reach the wire — agent-side
validation converts them to `DecisionMade{error:true}` + `civ_llm_malformed_total`.

Executor side (13,778 ActionFailed): INTERNAL 4,905 (~4,361 = one pathfinder-
timeout string — infrastructure, not model), RESOURCE_NOT_FOUND 3,133, TIMEOUT
2,251 (the accepted 60s-gather-trip-inside-30s-tick ceiling), TOOL_TIER_REQUIRED
1,618, TOOL_REQUIRED 1,070, plumbing 276 (2.0%). The canonical
plumbing-vs-substantive split lives in
`services/agent-service/src/agent_service/brain/awareness.py` — reuse it.

Stephen's failure-taxonomy question is ANSWERED by this corpus: format failures
are bounds-shaped and grammar-fixable for free; verb selection was never the
problem. Grammar-tightening precedes any GPU-hour on SFT.

## Cost evidence

- Frontier as always-on brain: Sonnet at 6 villagers × 30s tick ≈ **$13–14/hr**;
  a 4M-token budget died in 69 min (2026-07-28), then the breaker flipped to
  FakeProvider (pollution fingerprints: "A pleasant exchange in the morning
  sun.", "Good day! The weather holds…"). Nothing accumulated.
- Owner ceiling: **$1/hr** ≈ ~140 Haiku event-aligned decisions/hr.
- Local llama3.1:8b / gemma3:12b / gemma4 are free and race-proven. v7 table:
  gemma4 696.8±255.6s · llama3.1:8b 864.8±180.3 · gemma3:12b 944.9±296.3 —
  overlapping CIs: **reliability, not ranking**.

## Ranked direction

1. **Event-driven deliberation — mostly built.** Threat/hazard/chat wakes
   already ship in `brain/scheduler.py` (wakeups + guards). Missing: the
   ActionCompleted/ActionFailed wake (~small change) plus two design decisions
   — the wake predicate (unconditional firing is a documented GPU stampede)
   and a budget-derived guard cap. Clock tick becomes a ~300s heartbeat.
   Pacing caps ARE the enforced $-ceiling.
2. **Skill/tool layer = the accumulating asset.** Lives in git, readable,
   $0 beyond runs already happening, portable across every brain. SFT weights
   are locked to one model; a skill library isn't.
3. **Skill-mastery bookkeeping — cheap, no training.** Per-skill table logged
   every invocation: attempts, successes, trailing success rate, cost, context
   (biome/tools/mobs/time). Three rules over it: mastery gate (no new skills
   while a goal-path skill is below threshold), refinement queue ranked by
   frequency × (1 − success_rate), deprecation. **Superseded ≠ broken**:
   superseded drops out of retrieval priority, never out of the library
   (delete early-game skills and a respawned agent can't punch a tree).
   Mastered = succeeded N times across M distinct contexts, not N times in one
   forest. Escape hatch: a fixed, tunable fraction of cycles ignores the
   mastery gate and pursues novelty. Skill selection under uncertainty is a
   solved bandit problem — UCB/Thompson over the stats table, ~30 lines.
   Prerequisite: the ledger must log skill outcome + context granularity.
4. **SFT — demoted to #4, structurally.** It consumes the skill library and
   typed tool layer as inputs — you cannot train the composer before the
   things it composes exist. The taxonomy shows bounds violations dominate,
   which grammar fixes for free. If SFT returns: train the composer
   ("pick tool + fill arguments"), not a code-writer — LoRA on 8B, overnight,
   hundreds of examples. Skill *authoring/repair from error traces* stays
   frontier-or-human, offline, rarely. Risks: distribution collapse (train on
   curriculum decisions, keep LoRA thin, hold novelty signal outside the
   model); perpetual retraining as the tool surface grows. Small deep skill
   surface (≈30 tools) is learnable for an 8B; 300 is not. The T1 benchmark
   is the scoreboard — don't train until it's the number being moved.
5. **Frontier rental — last, bounded, terminates in artifacts on disk** (a
   dataset, a skill library), never vibes. Metered pilot (10 trajectories,
   measure, extrapolate) before committing spend.

## Skill sourcing

Mineflayer is an API, not a skill library — `bot.dig()` is mechanism. A skill
sits above: precondition checks, parameter binding, failure taxonomy, structured
return the LLM reasons about. Lift ~70%, design the last 30%:

- **Tier 1, vendor wholesale**: mineflayer-pathfinder (already wired, 2.4.5
  pinned), -collectblock, -tool, -pvp, -auto-eat, -armor-manager. Several are
  pure REFLEXES (eating at low hunger is not a decision) — wire them BELOW the
  deliberation layer so they never cost a token.
- **Tier 2, port**: Voyager's published `skill_library/` + JS primitives.
  Taxes: version drift (Voyager ~1.19, repo pins MC 1.21.6 — skills break
  silently), harness assumptions (their mineBlock/craftItem/killMob helpers +
  `bot` global), GPT-4 verbosity. Verify license before vendoring. Start with
  20–30 mapped to the race benchmark; let the benchmark surface drift as
  failures — it is the porting harness.
- **Tier 3, write yourself**: ~10–15. Race actions, village/social, film-rig.

**The part nobody hands us**: the tool schema layer — what the LLM sees,
parameter types/enums, and the failure vocabulary a skill returns. That
vocabulary is most of what separates competent from flailing. Stage-gate tool
namespaces by phase so tool-selection accuracy doesn't degrade.

Voyager's confirmed weaknesses justify the mastery design: novelty-maximizing
curriculum, skills frozen after one success, monotonic ever-growing library
("library bloat" in the 2026 literature) — the opposite of human play.

## Constraints & red lines

- `56823ad` (beat-the-game revert) stays reverted absent an explicit owner ask.
- No provider flip to paid without owner authorization. $0 in-demo.
- Benchmark table protected from configVersion churn — batch executor fixes
  behind one bump.
- Committed but undeployed: far-target move gate (MOVE_MAX_DISTANCE, default
  128; env not yet plumbed into compose) + abandon-and-repropose failure
  streaks (`c8a1c08`). Deploying is an owner call.
- RSG rules (if that arc returns): Java, no slowing game time, no human help,
  no seed reverse-engineering, no snapshots; Ninjabrain-style triangulation
  and F3 allowed; agent-written memory counts as memory.
- Operational gotchas live in CLAUDE.md — the deploy/env/RCON/ledger list is
  authoritative there. Highest-frequency: both compose profiles for
  single-service commands; `up -d --build --no-deps` + in-container marker
  check after merges; process env beats `--env-file`; ledger reads are always
  oldest-first (use `since=`); `task nuke` is interactive and volume-lethal.

## Open question (unanswered)

Focused mastery vs infinite shallow skills: can the agent deepen a few skills
and prune non-viable ones rather than hoarding? The bookkeeping design above is
the proposed answer; the tunable novelty fraction is the knob nobody has values
for yet.
