# Paper sweep synthesis — what to build next (2026-07-27)

Six papers in `papers/` read (one subagent per paper, full reports condensed
here), weighed against `docs/architecture/10-red-vs-blue.md` and the frozen
constraint set: local Ollama models (llama3.1:8b, gemma3:12b, gemma4:latest),
greedy decoding, 8192 num_ctx, 30s tick, one consumer GPU, inference-only
(no RL, no fine-tuning infra in the stack), fixed action verbs over a single
trusted executor.

## Where the papers converge

1. **Free-form NL negotiation/coordination is dead at 8B scale.** GovSim:
   Llama-3-8B survives 0% of commons scenarios unaided; emergent norms need
   frontier models (Table 1, p6). MINDcraft: llama3-8b scores 0.00 across the
   whole MineCollab suite (Table 3, p7); when an 8B-SFT agent must receive
   plans via chat, success collapses to zero (Table 5, p23) — the "−15%"
   headline is the *frontier* penalty; at 8B the honest reading is
   "plan-communication dependence is fatal." MineLand: chat response 2/10
   even with GPT-4V (Table 6, p9). Consequence for the 3v3 race: expect no
   chat-driven division of labor — coordination at our scale belongs in
   structured state (roles in the prompt, claimed targets as percepts).

2. **Oracle-computed hints injected as memory work at 8B — proven on our
   model class.** GovSim universalization: one environment-computed line
   ("if everyone takes more than f(t), the resource shrinks") moves
   Llama-3-8B from 1.0 to 8.0 months survival, temp 0, p<0.001 (Tables 7–12,
   pp26–28). The only finding in all six papers demonstrated on an 8B at
   greedy decoding. It is an oracle hint — the environment computes the
   threshold; the model merely obeys it.

3. **A closed outcome-feedback loop is the highest-ROI agent mechanism.**
   Voyager ablation: removing self-verification costs −73% of unique items,
   their single most load-bearing component (Fig 9, p9). Their critic is a
   GPT-4 JSON check over inventory; our ledger lets us do it rule-based for
   free. Their "stuck after 4 rounds → abandon and re-propose" policy is the
   goal-level fix for our dense-timeout → queue-saturation → mute chain
   (v7 fixed the queue level only).

4. **Model-as-spatial-reasoner is a dead end; code-as-spatial-truth is the
   fix.** VoT regresses on LLAMA3-8B (3/5 metrics worse, Table 3 p9; authors
   warn of "performance deterioration in less advanced language models",
   p10); even GPT-4's self-drawn spatial state is only 24–26% accurate
   (Table 2, p8). Their own counter-result (symbolic beats visualization on
   ring tasks, p8) endorses a deterministic executor-side gate for the
   hallucinated-move-target class of failure.

5. **Success-filtered SFT is the one proven route to frontier-ish 8B.**
   MINDcraft: llama3-8b 0.00 → 0.28 crafting (beats gpt-4o's 0.17) from
   behavior cloning on ~200 successful trajectories out of 2,000 attempts
   (Table 3, p7). Our event ledger already records labeled trajectories.

6. **Our architecture keeps getting independently validated.** MineLand's
   64-agent scaling trick is mineflayer-per-thread (already ours); their
   planner constrains plans to verb phrases (fixed verbs rediscovered);
   Voyager's ~8 hand-written control primitives (mineBlock, craftItem,
   smeltItem, killMob…) are nearly 1:1 our verb set — we already own their
   control layer, we lack the layer above (a plan/skill store).

## Ranked shortlist

1. **Close the loop: spatial-intent gate + abandon-and-repropose.**
   BUILT on branch `feedback-loop-close` (this commit) — see below.
   Cost: done, no GPU-hours. Backed by convergence points 3 and 4.

2. **Governance arc = universalization quota (GovSim operationalized).**
   The elected leader's policy IS the oracle hint: a commons quota computed
   server-side from ledger/world state, broadcast as a high-importance memory
   to all villagers; compliance/violations are ledger events chat can react
   to. The newcomer-perturbation episode format (settled community + greedy
   outsider, GovSim §3.3 p6) ships free. Cost: multi-session; needs a commons
   resource mechanic + a broadcast seam (contract addition — needs owner
   sign-off). This is the mothballed government-service revival that survives
   8B; hoping villagers negotiate norms themselves is contradicted by data.

3. **Ledger-to-SFT pipeline.** Exporter from ledger trajectories
   (win/DNF-labeled) to a transition dataset; LoRA llama3.1:8b offline on the
   consumer GPU. Biggest proven capability jump (0.00→0.28), but they needed
   ~200 successes and we have ~25 kept wins — build the exporter early,
   train when volume or task variety exists.

4. **Verb-plan skill library (Voyager middle ground).** Skills = named JSON
   sequences of existing verbs, LLM-authored, schema-validated, committed
   only after ledger-verified success, stored/retrieved via pgvector.
   Evidence plans-not-code retains value: Voyager's library boosted even
   AutoGPT (plans-based) from 0/3 to 2/4 unseen tasks (Table 2, p8). Matters
   for long-tail civilization play, not short races. Untested hypothesis —
   the paper never ran a plan library.

5. **Cheap prompt-wins bundle.** Few-shot RAG exemplars of past successful
   decisions (MINDcraft Table 7 p22: removing them cost 36%→12% at 70B;
   pgvector exists) · Voyager warm-up schedule / staged prompt disclosure
   (Table A.1, p21) · verify hunger/health render as explicit numerics with
   critical thresholds flagged (MineLand App. K).

## Dead ends (the papers say don't build)

- **VoT prompting per tick** — regresses at 8B, and one multi-step trace
  adds 10–30s generation: over the tick budget by itself.
- **Chat-negotiated coordination/norms at 8B** — three papers agree.
- **LLM-generated JS skills** — Voyager's own GPT-3.5 ablation (5.7x fewer
  items) plus explicit "open-source LLMs cannot provide" (p10), plus our
  trusted-executor stance (generated code on the shared event loop is the
  exact starvation failure we profiled).
- **MineDojo sim + MineCLIP as agent tech** — needs pixels and RL infra.
  Salvage: the Wiki dump is real downloadable data (Zenodo
  10.5281/zenodo.6640448; CC BY-NC-SA — license question for monetized
  video; 2022 scrape vs 1.21.6). MineCLIP's one niche: offline text-query
  highlight scoring of POV footage for episode editing.
- **Per-tick VLM vision / per-interrupt LLM calls** — GPU budget.
- Already ours: MineLand's distance-gated chat (48-block earshot),
  goal-oriented memory summarization (reflections), fixed verbs.

## What was built on this branch (candidate 1)

Two halves of one loop, no schema/contract changes:

- **Far-target gate** (`minecraft-service`): a `move` destination farther
  than `MOVE_MAX_DISTANCE` (env, default 128 horizontal blocks) fails fast
  with existing `PATH_NOT_FOUND` before pathfinding — an LLM-hallucinated
  coordinate (the logged (-203.5, 65, -200) case, ~570 blocks) no longer
  burns a 60s trip watchdog plus event-loop A* discovering the obvious. The
  errorMessage teaches staging (waypoint within range). Gather (64) and hunt
  (48) already had contract clamps; move had none.
- **Abandon-and-repropose** (`agent-service`): `ActionAwareness` now keeps
  per-villager consecutive-failure streaks keyed by intent identity
  (gather→resource, move→rounded target, craft→item…), fed each tick from
  outcome percepts. Plumbing failures (SUPERSEDED, STALE_COMMAND,
  BODY_BUSY, BOT_DISCONNECTED…) never count. At 3 consecutive substantive
  refusals the prompt gains a standing "CHANGE COURSE" section (same decay
  rule as civics) until a success clears it or 10 quiet ticks expire it —
  expiry prevents a permanent ban on e.g. `gather iron_ore` from blocking a
  race win after circumstances change.

Tests: minecraft-service 379 (3 new) + tsc clean; agent-service 228 (9 new).
Not deployed; no live-stack touch. A/B under the race harness is a separate,
GPU-costing decision.

## Per-paper condensed findings

### GovSim (Piatti et al., NeurIPS 2024, arXiv:2404.16698)
Commons simulation (fishery/pasture/pollution), 5 agents, 12 months, greedy.
Baseline survival (Table 1, p6): GPT-4o 53.3%, Claude-3 Opus 46.7%,
**Llama-3-8B 0% (dies month 1, zero variance)** — small-model failure is a
cliff, not a slope. Communication ablation (§3.5 p7, Tables 16–18 p30, only
run on the 4 models >10% survival): removing chat raises over-usage +22%
(p<0.001) but survival −1 month (ns); in fishery no-chat agents actually
survived LONGER — the robust chat effect is on over-usage, not survival.
Chat that works is 54–62% negotiation of per-capita limits. Universalization
(§3.4, Tables 7–12): injected oracle line lifts Llama-3-8B fishery 1.0→8.0
months; Llama-2-7B/13B and Mistral-7B get nothing (capability floor).
Newcomer perturbation (p6): GPT-4o community drops 53.3→33.3% survival —
ready-made episode format. Sub-skill probes (pp8–9, 33–35): 150 offline Q&A
items predict in-sim survival (R²=0.92) — cheap model screen before GPU
sweeps. Transfers: universalization-as-policy (needs broadcast seam);
sub-skill probes; utterance taxonomy for ledger analytics. Conflicts:
their chat is a synchronous multi-turn town meeting, ours is async 30s-tick
percepts; harvest is an unconstrained integer, our verbs aren't.

### MINDcraft / MineCollab (White, Nottingham et al., UCSD)
(Not the 2021 theory-of-mind paper.) 47 parameterized tools over mineflayer,
pairwise conversation manager, tasks DESIGNED so no single agent can solve
them. Table 3 (p7): claude-3.5-sonnet 0.36–0.64, gpt-4o 0.17–0.40,
llama3.3-70b 0.16–0.36, **llama3-8b 0.00/0.01/0.00, llama3-8b-SFT
0.28/0.18/0.20** (SFT = 16k transitions from ~200 successes of 2,000
llama3.3-70b trials). Communication ablation (p8, Tables 4–5 p23): claude
−13 to −25 pts when plans must be communicated; 8B-SFT collapses to 0.00
when both agents need communicated recipes. Team size (Fig 3): ~0.85–0.9 at
2 agents → ≤0.3 at 5, all models (redundant work, resource contention).
Prompt ablation (Table 7, p22, 70B): no memory summarization 36%→12%, no
few-shot RAG 36%→12%, no communication →0% (tasks force it). Transfers:
success-filtered SFT (the designed fix for our exact gap); query verbs
(pull observations); few-shot RAG exemplars; forced-interdependence task
design if we ever measure coordination. Conflicts: message-paced loop vs
our tick; `!newAction` free-form JS violates our executor stance. Their
`!givePlayer` item-toss flake = our placeBlock ghost-dig family — any trade
verb needs verify-the-world.

### Mind's Eye of LLMs / VoT (Microsoft Research, NeurIPS 2024, arXiv:2404.03622)
Zero-shot suffix makes GPT-4 draw text-grids per reasoning step; helps GPT-4
on tiny 2D grids (route planning 10.28→14.72%, tiling 54.15→63.94%, Table 1
p7). Mechanism mostly broken even there: self-drawn grids 24–26% accurate
(Table 2, p8). **LLAMA3-8B: no significant gains, 3/5 metrics regress
(Table 3, p9)**; authors' own limitations section says it deteriorates below
frontier. Token cost: 0.5–1.5k extra output tokens per answer — 10–30s
generation at consumer-GPU speed, over the 30s tick alone. Grids max 9×7;
3D explicitly future work. Counter-result: ring tasks reducible to modular
arithmetic — plain CoT beats VoT (52.5 vs 49.5%) — don't ask the model to
imagine space you can compute. Transfers: executor-side reachability gate
(built); possibly a code-rendered ASCII local map as input (A/B-able,
~200 input tokens, but 8B was near-chance at grid READING too). Keep
spatial truth code-side.

### MineDojo (Fan et al., NeurIPS 2022 D&B, arXiv:2206.08853)
Sim suite (3,000+ tasks, Malmo-based), internet knowledge base, MineCLIP
(150M video-language reward model for PPO). Blunt verdict: the central
contribution is train-time (8×V100 PPO+self-imitation) — zero transfer to an
inference-only, text-only stack. Salvage: **Wiki dump is real content**
(6,735 pages, tables, images; Zenodo 10.5281/zenodo.6640448; CC BY-NC-SA;
~MC 1.18 scrape) — drop-in static-lore retrieval corpus for memory-service,
though the paper itself never used it in an agent. YouTube/Reddit releases
are IDs only (transcripts withheld). Task taxonomy + 64-task starter set =
free benchmark-design data. Vanilla CLIP scored 0.0 as Minecraft reward —
never use generic vision models on Minecraft's renderer. Their "agrees with
humans" eval claim rests on 4 of 1,560 creative tasks.

### MineLand (arXiv:2403.19267, Beijing Jiaotong)
Simulator: 64+ agents on one desktop via one-thread-per-client — literally
our mineflayer architecture; the LLM side is parallel paid API calls, so it
contributes nothing to our one-GPU bottleneck. No 64-agent LLM-driven
benchmark run exists in the paper; timings exclude decision time (the dodge
our wall-clock protocol refuses). Alex agent (gpt-4-vision-preview):
multitasking = priority event queue (hurt > chat) + Resume/New gates between
50–200ms code steps; ablation shows hurt response 8/10 vs 0/10, chat 2/10.
gpt-3.5 scores 0/3 on trivial tasks with their code-as-action space (= our
qwen/lfm2.5 sweeps). "Limited senses" = server view-distance + chat distance
threshold (already ours); "physical needs" win came purely from putting
numeric need state in the prompt (App. K). Transfers: priority event classes
+ scripted reflexes (reflex path first — per-event LLM calls are GPU-capped);
**resumable executor actions** (pause/resume instead of drop-on-supersede —
the principled successor to v7 and a real candidate against the accepted
60s-trip/30s-tick ceiling, if that ceiling is ever reopened).

### Voyager (Wang et al., arXiv:2305.16291)
GPT-4 agent: automatic curriculum + skill library of generated Mineflayer JS
+ iterative self-verification. Headlines: 63 unique items/160 iterations,
3.3x baselines, only method to reach diamond (Table 1, p7); skill library is
plug-and-play (boosts AutoGPT too, Table 2 p8). Ablations (Fig 9, p9):
self-verification −73% (largest), random curriculum −93%, GPT-3.5 codegen
5.7x fewer items — "open-source LLMs cannot provide" (p10). A skill =
`async function(bot)` over ~8 hand-written primitives ≈ our verb set;
retrieval = top-5 by embedded description, composed by in-context imitation,
not linking. Loop: max 4 codegen rounds per task, then abandon and
re-propose. Curriculum criterion 8: only inventory-verifiable tasks — same
insight as our ledger milestones. Transfers: outcome-fed-forward critique
(built: rule-based via ledger, no LLM critic needed); abandon-after-N
(built); curriculum/goal proposer with a trusted-code validity filter
(mcData whitelist) and completed/failed lists as the greedy loop-breaker;
warm-up schedule (Table A.1 p21, directly copyable); verb-plan library as
the honest middle ground (shortlist #4). Skip: 5–10 GPT-3.5 QA calls per
task (call budget), generated-code skills (three independent kills).

## Cross-cutting warnings the papers confirm from our own history

- Below a capability floor, results are zeros with zero variance, not
  degraded scores (GovSim Llama-8B row; MINDcraft 8B row; MineLand gpt-3.5
  row; our qwen3.5:4b / lfm2.5 0/5 sweeps). More runs measure nothing there.
- Unvalidated LLM proposals contaminate state — filter in trusted code
  (Voyager's hallucinated "copper sword" ≈ our phantom elections and
  FakeProvider pollution).
- Timing claims that exclude decision time, or eval claims resting on 4 of
  1,560 tasks, are the overreach class our traceability reviews exist for.
