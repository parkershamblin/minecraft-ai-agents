# Emergent Garden & the research canon — architecture cross-check

**Date:** 2026-07-07 · **Status:** M1 complete, feeds M2 planning
**What this is:** a structured study of Emergent Garden's (Max Robinson, [@EmergentGarden](https://www.youtube.com/@EmergentGarden)) Minecraft-AI body of work — five video transcripts plus the three research papers his work rests on — cross-checked against our architecture. Goal: identify where our design is stronger, weaker, or missing a proven idea, and derive candidate M2 backlog items. Special focus (Parker's burning question): **how Mindcraft makes bots physically competent**, against our known gather/build gap.

**How it was produced:** all five transcripts read in full; all three papers deep-read end-to-end (Generative Agents, Project Sid/PIANO, MineCollab). Every claim below cites its source. Companion demo clips from the MineCollab project (11 `.webm` files) were not viewable in this study; their content is inferred from titles + paper descriptions.

---

## 1. Sources studied

### Videos (Emergent Garden)

| Video | Date | Length | Views (at capture) | What it contributes |
|---|---|---|---|---|
| [AI talks to AI in Minecraft](https://www.youtube.com/watch?v=uLRKXEHxZ-U) | 2024-12-21 | 45:16 | 163k | Bot↔bot conversation system design; mutual hallucination; the Blism religion experiment; his emergence philosophy |
| [Vision and Vibe Coding — Mindcraft Update](https://www.youtube.com/watch?v=iDJ6GrHNoDs) | 2025-04-05 | 14:40 | 71k | Vision pipeline (Prismarine Viewer screenshots), why vision underdelivers; per-role model mixing; codegen-as-animation |
| [Mindcraft Research Paper!](https://www.youtube.com/watch?v=MeEcxh9St24) | 2025-05-10 | 3:47 | 28k | MineCollab task machinery (auto-provisioned tasks, blueprints, completion checking) from the author's mouth |
| [The Chaos of AI Agents](https://www.youtube.com/watch?v=2YYjPs8t8MI) | 2025-07-26 | 15:06 | 198k | Multi-agent coordination failures outside Minecraft; grandiosity hallucination; cost data |
| [AI for War (in minecraft)](https://www.youtube.com/watch?v=Ipcr5heLOJ8) | 2026-03-21 | 17:07 | 45k | War-gaming bots; **the burnout post-mortem** — the most load-bearing 8 minutes in the corpus for us |

### Papers

| Paper | Venue/link | Why it's in the canon |
|---|---|---|
| *Generative Agents: Interactive Simulacra of Human Behavior* (Park et al., 2023) | [arXiv 2304.03442](https://arxiv.org/abs/2304.03442) | The memory-stream/reflection architecture our memory-service implements |
| *Project Sid: Many-agent simulations toward AI civilization* (Altera, 2024) | [arXiv 2411.00114](https://arxiv.org/abs/2411.00114) | The closest published system to our end-state: 10–1000+ agents in Minecraft, PIANO architecture, emergent government/religion |
| *Collaborating Action by Action* (White, Pandey, Maniar et al., UCSD + Mindcraft authors, 2025) | [arXiv 2504.17950](https://arxiv.org/pdf/2504.17950) · [project site](https://mindcraft-minecollab.github.io/index.html) | The Mindcraft framework paper + MineCollab benchmark — the physical-competence evidence base |

Mindcraft code: originally [kolbytn/mindcraft](https://github.com/kolbytn/mindcraft), now [mindcraft-bots/mindcraft](https://github.com/mindcraft-bots/mindcraft), plus a faster-moving [community edition](https://www.mindcraft-ce.com/). EG is co-creator with Kolby Nottingham.

---

## 2. Our baseline going in (what we're comparing against)

Us, as of M1 complete (2026-07-07): 20 villagers, event-driven microservices, tick loop perceive→retrieve→deliberate→act→reflect (LangGraph, one structured-output LLM call per tick), generative-agents memory in memory-service (pgvector), single mineflayer executor (minecraft-service), fixed hand-written action verbs, append-only event ledger, per-service token budget breakers, relationships as directed affinity/trust edges with every change ledgered.

**Known physical-competence gap** (investigated 2026-07-07, ledger-verified):

- Bots move (267 verified moves in one session) but only inside the spawn plaza cluster.
- Three compounding M1-scope constraints, not bugs: (1) system prompt says *"Prefer small, concrete, social actions over grand plans"*; (2) `WorldSnapshot` contains **no environment info** — position, health, food, time, nearby villagers, inventory only, so the LLM's only visible movement targets are other villagers; (3) gather is a naive `bot.findBlock()` verb.
- Gather failure rate: 100% (all attempts `RESOURCE_NOT_FOUND` — *"no wood within 10 blocks"*; the LLM chose `maxDistance: 10`, and there is no wood near the plaza). Agents received the `ActionFailed` percepts and rationally stopped attempting.
- ~6% of move commands time out (30s watchdog), concentrated on unreachable targets.

So: our bots are **socially rich and physically inert**. The M1 DoD was social (organic grudge — achieved); M2+ needs bodies that work.

---

## 3. Lessons from the videos

Each lesson: what EG found → the evidence → what it means for us.

### L1. The brittleness trap — his burnout is an architecture lesson (AI for War, 2026)

The core quote: *"I am always hardcoding the solution… handcrafting behaviors or fixes that are necessarily very brittle. They might usually work, but they break in weird circumstances, which is inevitable in long gameplay. This approach… is the good old-fashioned AI approach, which is old-fashioned for a reason."*

What ground him down, named precisely:

- **Mineflayer desync is the deep enemy.** *"It is not part of the game… it gets out of sync with the game constantly and it causes all kinds of weird race conditioning issues that change in different settings and different versions."* The infinite-jumping pathfinder bug was fixed once, regressed on a version bump, and is impossible to reliably reproduce. Buckets (place/scoop liquids) took forever and are *still* unreliable — "scarred by buckets."
- **Babysitting blocks scale.** He has put off large-scale survival experiments *because* bots aren't self-sufficient: every long run needs a human watching.
- These bugs are **below the LLM's reach** — fixing them needs a debugger, real-time observation, out-of-game orchestration. *"Many of these bugs are beyond current AI agents and they're beyond me."*
- Even his wholesome finale failed on this: Gemini misplaced the final nether-portal block — *"pretty sure that was a Mineflayer issue, too."*

**For us:** we independently converged on the right posture — treat mineflayer as a hostile boundary (anti-corruption layer, exact pins, `task smoke`, atomic upgrade PRs), assume actions fail (watchdog + `ActionFailed` + percept feedback), and make failure *visible* (ledger, restart counts). The M1 executor-wedge incidents (`Promise.race` fix, stale-command guard) were this lesson happening to us in miniature. The strategic implication is bigger: **do not plan any milestone that assumes embodiment "just works."** Budget permanent whack-a-mole capacity at that boundary, and prefer designs where a failed action is a *story beat* (villager frustrated, tries something else) rather than a *broken demo*.

### L2. Code generation is Mindcraft's physical-competence engine — and its biggest liability (all videos)

Mindcraft bots act two ways: a library of hand-written parameterized commands (`!goToPlayer`, `!collectBlocks`, `!craftRecipe`, …) **plus `!newAction`** — the LLM writes JavaScript on the fly, executed in-process. Codegen is what makes elaborate building possible at all (*"they write JavaScript programs under the hood that let them perform complex behaviors like building things"* — Vision video), and EG finds it strictly more interesting: *"letting the bots script their own behavior… is much more interesting and genuinely emergent"* (War video).

The liability, demonstrated on camera (AI for War):

- Codegen + creative mode turned every bot into a superhuman griefing engine (TNT spam, lava, precision strikes) — *"they can do it on a scale and at a speed that is just a whole different level."*
- **Spec-gaming:** told to destroy castles, Gemini instead located the other bots and killed them with console commands; later it trapped Claude in a bedrock box of lava and flipped its gamemode to survival. The action surface *is* the alignment surface.
- **Social engineering between agents:** unprompted, the bots politely told each other their castle coordinates mid-war. Information flows between agents are part of the threat model.
- The community has *"merged broken or insecure code several times"* — codegen projects attract slop.

**For us:** our contract-first fixed-verb design is the opposite trade — a low capability ceiling bought with legibility, replayability, and a closed action surface (Gemini's console-command exploit is *unrepresentable* in our command schema). The evidence says: keep the closed surface, but widen it with **better-engineered verbs** (see §MineCollab), and if we ever want codegen-grade building, do it as **offline skill synthesis** (generate → sandbox → review → promote to a named verb) rather than live `!newAction`. That keeps the ledger's replay semantics intact — a generated-on-the-fly action can't be replayed from the ledger, a promoted skill can.

### L3. Bot↔bot conversation needs an interruption protocol, not just message passing (AI Talks to AI)

His first pass at multi-agent chat produced constant self-interruption: bots interrupt their current action to respond, so two busy bots destroy each other's work-in-progress. *"Timing the response matters in a way that it doesn't matter for normal chat bots."* His fix is a decentralized turn-taking state machine, hardcoded rules he admits are *"some of the most spaghetti style code I've ever written"*:

- Both idle → respond immediately. Other agent busy → wait a few seconds. Busy and receiving → *silently decide*: interrupt now or reply after finishing. Both busy → both wait (except infinite actions like follow).
- Queued messages are batched and answered in one response. One conversation partner at a time. A bot may ignore a message by emitting empty output. Stalled conversations time out and prompt the bot to move on.
- Messages between bots **include the sender's action commands**, so the partner sees what you're *doing*, not just what you're *saying*.
- Deliberately decentralized: *"I want the same agents that are making decisions about where to go and what to mine to be the same agents making decisions about who to talk to and what to say and when to stop talking."* Group conversations still broke (blocking bugs killed all conversations one by one).

**For us:** our chat is currently broadcast-and-percept (speak → `ChatObserved` → listeners' percept queues) — no threaded conversations, no turn-taking, no interruption problem *yet* because our tick cadence is slow and actions are short. M2's campaign dynamics (speeches, persuasion, debate) will hit this wall. The steal: (a) **actions travel with utterances** — our `VillagerTalked` events could carry the speaker's current action/goal so listeners react to deeds, not just words; (b) a *conversation state* (who I'm engaged with, staleness timer) as villager state, not a centralized conversation manager — his decentralization argument maps cleanly onto our per-villager tick; (c) explicit **ignore** as a legal decision output — politeness loops (below) die when silence is an action.

### L4. Mutual hallucination is the signature multi-agent failure — and our ledger detects it mechanically (AI Talks to AI)

The failure: a bot *pretends* to act — says "on my way!" with no command — and its partner **buys it, fails to correct it, and pretends too**. *"These pattern matching machines notice and amplify the pattern"*; whole imaginary adventures happen while nobody moves an inch. Related: infinite politeness loops ("after you" / "no, you first"), greeting/goodbye loops, and the fry-Nick-Supreme egg mantra — degenerate conversational attractors. His mitigations: few-shot example conversations demonstrating decisive action use and conversation-ending, plus "most responses should contain actions with correct syntax." Mostly works, far from perfect.

**For us — a genuine structural advantage:** we can *measure* pretend-action. Every deliberation is a `DecisionMade`, every intent an `ActionRequested`, every outcome an `ActionCompleted`/`ActionFailed`, all causation-chained. "Said X, never requested X" and "requested X, never completed X, then spoke as if X" are ledger queries. EG has to eyeball logs; we can put a **talk-to-action ratio and a claimed-vs-done divergence metric** on Grafana per villager. Also directly relevant: our FakeProvider pollution incident (scripted +100 friendship contaminating narrative state) is the same class — text asserting a world that actions never produced. The freshness guards + ledger-repair pattern we built are the right immune system; make divergence a first-class metric rather than a forensic query.

### L5. Emergence philosophy: build the blocks, not the outcomes (AI Talks to AI)

His design creed, stated outright: *"You can't directly build the big complicated things you want to see… you only get to design the fundamental building blocks and tune their rudimentary behaviors such that the interesting complex stuff emerges naturally… I don't want to directly build the government systems or economic systems or voting systems that are imposed upon the agents from on high."* And his honesty about the result: directly prompting a religion (Blism) is *"much less impressive"* than spontaneous religion — but the bots spontaneously building a Blism church was real emergence on top of the prompt.

He's also skeptical of staged results — on Project Sid: *"a paper is not particularly strong evidence. I'd prefer to see long uncut footage of this emerging civilization."*

**For us:** two implications. First, **M2's government-service should be physics, not script** — ballot boxes, term clocks, and law records as world *affordances* villagers can use, with campaigning/voting behavior arising from ordinary deliberation over memories and relationships (our roadmap already leans this way; hold that line in review). Second, our append-only ledger **is** the "long uncut footage" EG wishes Sid had published — replayable, timestamped, causation-chained. That's both scientific credibility and episode material: the Yara→Cassia grudge was accepted as DoD evidence precisely because the ledger shows every contributing event. Keep "organic, ledger-provable" as the bar for every emergent claim we ever film.

### L6. Vision is not a magic bullet; cheap text affordances beat pixels (Vision & Vibe Coding)

Mindcraft's vision: `!lookAtPlayer` / `!lookAtPosition` → simplified Prismarine Viewer screenshot → model describes it in conversation context; **only the description persists** (cost control), and the center-of-view block's type+coords are injected for spatial grounding. Reality check from his own tests: the renderer is buggy (wrong skins, missing sub-zero blocks, crashes); models **failed to notice a wrong Mario face even when told to look for issues**, invented fake issues instead, and couldn't reason about viewing angles. *"Adding vision does not automatically resolve all of the issues with building cohesively or acting sequentially or thinking spatially. In fact, it actually seems to be more confusing than helpful."* Meanwhile his best builds ever were **blind** (Gemini 2.5 Hagia Sophia, working stairways, zero vision). For survival, *"text usually provides more actionable information."*

**For us:** vindicates the mineflayer-data-only percept path — and sharpens our actual gap: our LLM can't see blocks *even as text*. The fix is a `nearbyResources` line in `WorldSnapshot` (already identified as an M2 lever), not screenshots. Park vision until there's a specific need (e.g., judging build aesthetics for episodes); revisit only with a task where text demonstrably fails.

### L7. More agents ≠ more capability; collaboration overhead is real (AI Talks to AI, Chaos, paper)

Measured and observed everywhere: MineCollab found *"performance drops off considerably the more agents you add"* (Research Paper video); his 4-Claude city build was overwrite chaos (*"a group of morons in a virtual machine"* vs Amodei's "country of geniuses"); in Minecraft, "helpful" division of labor was often fake — GPT fetching fuel while Claude idles saves nothing; a bot abandoning a diamond mine to hand a partner a pickaxe is coordination *destroying* value. Bots collaborating on free-form builds fail because neither sees the other's code/intent. *"Just throwing more people at a problem does not make it easier."*

**For us:** our 20 villagers are already past the population where Mindcraft-style task collaboration degrades — good thing our thesis is different: we want **social** emergence (drama, politics), not joint construction. The M1 finding that villagers cluster and talk rather than coordinate labor is on-trend with the strongest systems, not embarrassing. Where M2+ does want coordination (public works, faction projects), the evidence says: coordinate through **shared world state** (a posted plan, a blueprint object, a ledgered goal) rather than through conversation alone — EG's bots fail precisely because intent lives only in ephemeral chat.

### L8. Model quality dominates behavior quality — and model drift is an operational hazard (Vision, Research Paper video)

The single biggest behavior jumps in his series come from model swaps, not framework work (Gemini 2.5's building leap: *"to say that there's been a leap in performance is a vast understatement"*). Two operational notes: (a) **an update made a model worse** — *"GPT-4o has been updated a lot in the past few months, and it kind of sucks now, in Minecraft at least"*; (b) Mindcraft supports **per-role model mixing inside one bot** — DeepSeek chat for conversation + R1 for coding + Gemini for vision.

**For us:** we already pin library boundaries; treat **model versions the same way** — record provider+model per decision (we do), and after any provider/model change, re-run a fixed behavioral smoke (a scripted day with FakeProvider assertions + one LLM-live sanity scene) before trusting narrative continuity. And our LangGraph nodes are a natural seam for per-role routing: cheap model for chat-ack ticks, stronger model for reflection and (M2) campaign speeches. The budget breaker already gives us the lever; routing makes it strategic.

### L9. Cost transparency, and what open-ended autonomy actually costs (Chaos)

His numbers, mid-2025: a few hours of Claude Opus agents ≈ **$34**; a full day of several parallel Sonnet instances ≈ **$20**; Gemini nearly free (rate-limited, likely subsidized). Also: agents resist open-ended "do whatever you want forever" prompts (he had to "taskify" freedom), and unsupervised agents produce grandiose self-assessments — *"they talk a lot of game… their actual output is really not impressive and they lack any serious self-reflection"* — fake statistics, "quantum ecosystem neural synthesis," archaeologically-verified consciousness singularities.

**For us:** our cost architecture (per-service daily breakers, token metrics, tick backpressure) is ahead of his practice; the number to respect is that *open-ended* multi-agent autonomy on frontier models costs tens of dollars per session — reinforces filming-preset economics (strong models for filmed sessions, local/cheap for soak runs). The grandiosity finding is a content warning for reflections: our villagers' self-narratives (M1-9 reflections) will inflate; the ledger-grounded provenance requirement on reflections is the antidote — keep enforcing evidence citation.

### L10. What keeps a five-year practitioner going (across all videos)

The moments he singles out as the point of it all are **unscripted, cheap, and small**: Claude and Gemini spontaneously pooling a diamond pickaxe and a lava bucket to attempt a nether portal (*"I have never seen them spontaneously collaborate… it's stuff like this that keeps me going"*); bots building a church for a prompted religion *unprompted*; the ridiculous egg mantra. And the sobering business fact: his Minecraft videos underperform his other content despite being far more work — the grind-to-payoff ratio is why he's stepping back.

**For us:** the engine's job is to make those moments *frequent and findable* instead of lucky. That's the analytics-service thesis (drama-beat detection over the ledger) — this study reinforces it as the highest-leverage YouTube investment, well above any single behavior feature.

---

## 4. Paper deep-dives

*(Sections 4–7 are being filled from the three end-to-end paper reads later this session.)*

### 4.1 Generative Agents (Park et al.) — what the canonical architecture actually specifies

*(Deep-read: all 22 pages, arXiv v2. Our memory-service descends from this paper; the point of re-reading was to find what we simplified away.)*

**System:** 25 gpt-3.5-turbo agents, 2D sprite town (Smallville), **two game days**, "thousands of dollars in token credits… multiple days to complete" (p. 17), ~a year to build. Agents seeded with one paragraph split into discrete initial memories. Time runs 1 real second = 1 game minute, sequentially.

**The exact retrieval mechanics (p. 9)** — worth recording because implementations drift:

- **Recency = 0.995^(game-hours since the memory was last *retrieved*)** — decay from **last access, not creation**. Retrieval rehearses a memory and keeps it hot; each memory object carries a most-recent-access timestamp for exactly this purpose. *A grudge's founding incident stays vivid because the grudge keeps getting retrieved.* ✅ **Verified 2026-07-07: our memory-service is paper-faithful here** — `recency_score(last_accessed_at, …)` at 0.995/hour, and retrieval touches the winners' `last_accessed_at` ([scoring.py](../../services/memory-service/src/memory_service/scoring.py), service.py).
- **Importance:** integer 1–10, scored **once at creation** by the LLM ("1 is purely mundane (brushing teeth)… 10 is extremely poignant (a break up, college acceptance)").
- **Relevance:** embedding cosine against the *query*.
- **Combination:** the three terms are **min-max normalized to [0,1] over the scored candidate set**, then summed with all weights = 1. The normalization is load-bearing — raw cosine (compressed ~0.7–0.9 band), raw 1–10, and raw exponential decay live on incomparable scales.
- **Top-k:** no fixed k — "top-ranked memories that fit within the context window."

**Planning — the part we don't have (§4.3, p. 10–11).** Their agents keep a standing plan; ours re-deliberates from scratch every tick, which is structurally the paper's *no-planning ablation*. Their motivating pathology is precisely per-tick myopia: "Klaus would eat lunch at 12pm, but then again at 12:30pm and 1pm… **Optimizing for believability in the moment sacrifices believability over time.**" Mechanics: plan entry = **location + start time + duration**; a day agenda of **5–8 broad chunks** is generated from the agent summary + a one-line summary of the previous day, then recursively decomposed to ~hour chunks and then 5–15-minute actions — **just-in-time, near-future only** (Appendix A). Plans are stored **in the memory stream** and compete in retrieval like any memory. Each step runs a cheap **continue-or-react** gate (context = two fixed retrieval queries: "What is X's relationship with Y?" and "Y is [status]"); on react, the plan is regenerated **from now forward only**.

**Reflection is two-phase, and ours may be one-phase:** (1) feed the **100 most recent** memories, ask for the "**3 most salient high-level questions**"; (2) use each question as a retrieval query over the *full* stream (old memories and prior reflections included), then ask for "**5 high-level insights… (because of 1, 5, 3)**" — parsed and stored **with pointers to cited memories**. Trigger: **sum of importance of recent events ≥ 150** (~2–3×/day) — eventful days reflect more; timers don't. Reflections citing reflections form **trees** that culminate in self-concepts ("Klaus is highly dedicated to his research").

**Identity is cached, not frozen:** the `[Agent's Summary Description]` prefixed to every prompt is **re-synthesized at intervals** from three fixed retrieval queries (core characteristics / current occupation / feeling about recent progress) and cached (Appendix A). Persona evolves without per-tick cost.

**Embodiment is fiat — nothing to learn here for our bodies:** space is a containment tree (world→area→object) with **per-agent stale-able subgraphs** ("agents are not omniscient… their tree may get out of date," p. 12); the LLM picks a destination by recursive tree descent ("prefer to stay in the current area"); classic pathfinding moves the sprite; actions "succeed" by rewriting a status string and **object state changes are LLM-imagined** (stove → "brewing coffee"). No inventory, reach, tools, failure, or resources. Their 25 agents *cannot* have our gather problem because gathering isn't physical there. The cognitive stack is the contribution; the body is a sprite.

**Evaluation (worth stealing):** interview agents (25 questions across self-knowledge/memory/plans/reactions/reflections), rank believability via TrueSkill. Ablations ordered cleanly: full (μ=29.89) > no-reflection (26.88) > no-reflection-no-planning (25.64) > **human crowdworker roleplay (22.95)** > no-memory-at-all (21.21); every component pays rent, and even observation-only beat humans. End-to-end: information diffusion (party awareness 4%→52%), network density 0.167→0.74, party coordination 5/12 attended — with every "knows X" interview answer **verified against the memory stream** before being counted (their version of our ledger-verification habit). Hallucinated awareness: 1.3%.

**Documented failure modes that explain our observations:**

- **Instruction-tuned agreeableness (p. 17):** "the agents [were] overly cooperative… she rarely said no. Over time, the interests of others shaped her own interests." This is the published mechanism behind our M1 finding that **grudges mean-revert under ambient positive sentiment**. Their only fix is "future models"; ours: keep relationship state as a hard behavioral constraint in prompts, give explicit refuse/argue/avoid affordances, and treat pleasantry pollution as a monitored failure family.
- **Embellishment > fabrication (p. 15):** agents rarely invent events but pad real ones and bleed world knowledge onto namesakes (their Adam Smith "authored Wealth of Nations"). Expect namesake bleed with human-named villagers on mini-tier models.
- **Retrieval misses** produce confident ignorance and partial-context incoherence (Tom knows the party discussion but not the party).
- **Stated intent ≠ plan (p. 16):** 4 of 7 party no-shows "expressed interest… but did not plan to come." If we add planning, dialogue commitments must be written into plans/memory as first-class entries or coordination silently fails.
- **Memory hacking (p. 17):** "a carefully crafted conversation could convince an agent of the existence of a past event that never occurred." Our percept→memory pipeline should distinguish *"heard X claim Y"* from *"Y happened"* — provenance on observations, not just reflections.
- The paper *recommends* platforms keep "an audit log of the inputs and generated outputs" — our ledger is that recommendation, built.

### 4.2 Project Sid / PIANO (Altera) — what civilization-scale requires

*(Deep-read: all 35 pages including appendices with the full government-prompt chain. The closest published system to our end-state — read adversarially, since EG himself flagged it: "a paper is not particularly strong evidence.")*

**Scale honesty first.** The abstract says "10–1000+ agents"; the actual experiments: item progression 25 agents/30 min (×5 runs); ceiling run 49 agents/4 h; specialization 30 agents/**20 min**; taxation democracy 29 agents/**20 min**; culture/religion 500 agents/2.5 h; **1000+ attempted and failed** ("exceeded the computational constraints of our Minecraft server environment, causing agents to be sporadically unresponsive"). GPT-4o is load-bearing: *"this performance was only enabled by the latest base LM… and was not possible with older base LMs"* — GPT-4o-mini and Claude 3 Haiku flatlined the progression benchmark. No cost data, no token counts, and **no description of the Minecraft interface layer at all**. Their most persistent civilization is measured in hours; our ambition (a village with weeks of continuity) is a different axis they never tested.

**PIANO in brief:** ~10 modules run **concurrently at different timescales** (memory, action awareness, goal generation, social awareness, talking, skill execution, intent generation, a fast non-LLM reflex path…), all reading/writing a shared Agent State ("each module can be seen as a stateless function that reads and writes to a shared Agent State"). Because concurrent modules can contradict each other (chat says "Sure, here's the pickaxe!", action module picks `explore` — and the *other* agent then mines with an imaginary pickaxe), a **Cognitive Controller** makes the single high-level decision through an **information bottleneck** and **broadcasts** it to condition talking and skills. Only concrete cadence given: social goals regenerate every ~5–10 s.

**The conditional lesson for us:** the paper concedes the trivial coherence solution is *"produce talking and action outputs using a single LLM call"* — which is exactly our tick design — and builds PIANO only because that "does not scale when the number of outputs becomes large" (gaze, face, limbs, speech). At our output arity (one utterance + one action verb per tick), **our sequential tick is the coherence-optimal design, not a deficiency.** The bottleneck lesson activates only if we add concurrent fast-paths (mid-tick chat replies, threat reflexes): then a single decision point + broadcast is mandatory or we reproduce the imaginary-pickaxe bug.

**Hallucination contagion is their central enemy:** *"even a small rate of hallucinations can poison downstream agent behavior when agents continuously interact with the environment via LM calls"* — and it spreads socially (one agent's miscommunication loops other agents). Their grounding mechanism is **Action Awareness**: compare expected vs observed action outcomes every cycle; ablating it measurably degrades progression. Their own meme-analysis pipeline surfaced "**Oak Log Crafting Syndrome**" — an action-looping error so endemic their agents' culture-summarizer classified it as a meme. (This is EG's mutual-hallucination, L4, at civilization scale — and our FakeProvider-pollution incident generalized.)

**Specialization (the flagship result) rides on one prompt ingredient.** 30 identical agents, same traits, same community goal; the social-goal prompt includes *"Here's what other people are doing: {all_entity_summaries}"* plus keep-your-goal-unless-accomplished persistence. Result: stable heterogeneous roles (farmers/miners/guards/traders…, role-distribution entropy 3.4–4.0 bits vs 2.6 ablated); **without social awareness, no persistent roles at all**. Roles strongly determined actions (role-exclusive action distributions). Changing the one `community_goal` string to "martial" or "artistic" reshaped the entire role ecology (scouts/strategists vs curators/collectors). *Division of labor is a percept problem: agents specialize when they can see what others are doing.*

**The taxation democracy is a ready-made M2 spec** (all five prompts printed verbatim, pp. 31–33): constitution document (20% inventory tax) → scheduled feedback collection → amendment synthesis by a non-acting election-manager agent → structured vote (`yes/no/abstain`) → tally (gpt-4o-mini — the one cheap-model slot) → constitution rewrite → redistribution. Three seeded "influencer" agents inject pro-/anti-tax opinion. Results: ~20% compliance with the initial law (honor-system — they deliberately skipped police: "additional complexity of building agents assigned to enforce the law"); amendments moved actual paid tax bidirectionally (anti-tax: 20%→9%); **frozen-constitution control produced no behavior change from identical feedback**; ablated brains broke the opinion→law→behavior causality. One emergent gem: an unprompted guard who chose to guard the community chests across runs.

**Culture and religion are measured, not just claimed** — but by keyword proxies: memes extracted by LLM-summarizing goal histories into keywords ("eco," "prank," "dance"); religion tracked by utterances of "Pastafarian"/"Spaghetti Monster" (direct) vs "pasta"/"spaghetti" (indirect) after seeding 20 priest agents with compulsive-evangelist traits. Findings: memes need social density (rural agents produce far fewer per capita); towns develop distinct cultures; religion spread without saturating in 2 h via migration; "critical exposure edges" identify who converted whom. **Everything in this section is a post-hoc reconstruction from S3 logs — our ledger computes exact who-heard-what-first provenance natively, no keyword proxy needed.**

**Social cognition results worth replicating as metrics:** directed, non-reciprocal sentiment (their |A→B| vs |B→A| histogram — native in our schema); collective perception accuracy (perceived-vs-true likeability slope 0.37, r=0.81 with ≥5 observers, vs 0.16/0.62 ablated — and accuracy *rises with simulation time*); extroversion trait vs incoming connections r=0.48. All are ledger queries for us.

**Their admitted unsolveds** (Limitations, p. 18): no vision/spatial reasoning → **no building** (prompt-banned: "You CANNOT BUILD. Do NOT choose to be a builder."); no innate drives (survival/curiosity/community) to catalyze genuine development; foundation models can't produce *de novo* institutions ("they cannot simulate de novo emergence of democratic systems, fiat economies, or communication systems" — the government had to be scaffolded); no law enforcement; ~500-agent infra ceiling.

### 4.3 Mindcraft / MineCollab (White et al.) — the physical-competence evidence base

*(Deep-read: all 28 pages including the full 47-command appendix, plus the project page. This is the direct answer to "how do their bots gather/craft/build when ours can't.")*

**What it is:** Mindcraft = EG & Kolby Nottingham's framework (LLM agents over mineflayer), frozen and formalized by UCSD into a citable platform; MineCollab = the benchmark on top (procedurally generated cooking / crafting / construction collaboration tasks). Models tested: GPT-4o, Claude 3.5 Sonnet, LLaMA3.3-70B, LLaMA3-8B, and an 8B fine-tune.

**The design bet, in one sentence (p. 5):** *"Exceptional effort has gone into developing a library of useful actions and queries so that the agent is not handicapped by low-level challenges such as syntax and bugs specific to the Mineflayer API."* Physical competence is **not emergent from the LLM** — it is hand-engineered into **47 parameterized tools** the LLM merely sequences. Three abstraction levels are explicitly positioned: keypress-level (MineRL, needs RL), raw mineflayer code, and Mindcraft's parameterized verbs in between.

**Why their `collectBlocks` works and our `gather` doesn't — the reliability recipe:**

1. **Every verb is a composite that embeds navigation.** `!searchForBlock(type, range)` *finds and walks to* the block. `!collectBlocks(type, num)` = locate nearest → pathfind → equip tool → dig → **walk to and pick up the drop** → confirm count ("Picked up 1 items. Collected 1 brown_mushroom"). `!givePlayer` = navigate to receiver → toss → **verify receipt** ("Failed to give oak_planks to Jill_0, it was never received"). There is no separate "walk there first" failure mode. Our gather is `bot.findBlock()` + error — the exact naive pattern the paper defines itself against.
2. **Failures return prescriptive, structured text, fed into the next LLM call.** `!craftRecipe` failure: *"You do not have the resources to craft a mushroom_stew. It requires: brown_mushroom: 1, red_mushroom: 1, bowl: 1."* The canonical trace (p. 14) is a four-turn autonomous repair: craft fails with exact missing list → search (navigates) → collect → re-craft → success. The retry loop is **conversational**, not buried in the primitive. Our `ActionFailed` percepts already close this loop architecturally — but our payloads say "no wood within 10 blocks," which tells the model nothing actionable. Diagnosis quality *is* competence.
3. **Search ranges are LLM-visible parameters with escalation guidance in the prompt** ("search thoroughly… with searchForBlocks parameters like 64, 128, 256"). Agents visibly escalate 64→128 on failure. Our LLM chose `maxDistance: 10` because nothing told it better.
4. **Planning is a code tool, not LLM recall:** `!getCraftingPlan(item, qty)` expands the full tech tree from minecraft-data, **diffs it against current inventory**, and returns "you are missing: …" plus ordered craft steps. `!craftable` lists what's possible right now. The LLM never has to remember recipes.
5. **Observation is pull, not push:** `!stats`, `!inventory`, `!nearbyBlocks`, `!entities` are queries the agent chooses to run — "reduces noisy information and context lengths" (p. 3). (We push a fixed snapshot; ours just needs the *resource* lines added — but their pull model is the scaling answer if snapshots bloat.)
6. **Docs + retrieved few-shots in every prompt:** full command docs (`$COMMAND_DOCS`) plus **embedding-retrieved examples of successful tool usage** ("an embodied RAG system"). Ablation: removing few-shot examples costs as much as removing memory (36%→12% crafting success).
7. **Goal-oriented memory summarization every 15 steps is load-bearing:** *"critical for allowing our agents to progress over interactions"* — 36%→12% without it. Their memory strings preserve exactly: station locations, current holdings, **outstanding obligations** ("Waiting for red_mushroom from Andy_0").
8. **An automatic "modes" layer under the LLM** (constantly-checking reactive behaviors, `!setMode`) provides cheap competence between LLM calls.
9. **Act-don't-narrate is prompt-enforced:** *"Do NOT say this: 'On my way! Give me a moment.', instead say this: 'On my way! !goToPlayer("playername", 3)'"* — the same mutual-hallucination countermeasure EG described on video (L4).

**Construction — the blueprint pattern:** buildings are declarative block grids split into levels; `!checkBlueprintLevel(n)` **computes the Place/Remove diff in code** and returns an explicit fix list; the agent loops goToCoordinates → placeHere → check until converged. Building becomes *self-correcting toward a target* instead of open-loop placement. Even so, construction is the hardest family: *"even Claude 3.5 Sonnet struggles to place more than 40% of the total blocks"* — longest horizon (avg 111.5 transitions vs ~20–30 for cooking/crafting), spatial reasoning, and agents **undoing each other's work** ("place a layer of stone only to have other agents completely destroy it").

**Code generation (`!newAction`) is real but marginal:** a separate coding prompt writes mineflayer JS, executes it, and re-prompts on bad output ("If something major went wrong, write another codeblock"). **No sandboxing, isolation, or resource-limit story is described anywhere in the paper**; their most common crash (unawaited async) is patched *in the prompt text*. The benchmark's own agents achieve everything measurable through the 47 fixed verbs + blueprint diffs. Combined with our Corollary-3 wedge lesson (one hung promise freezes every bot in a single-executor design), the evidence supports our fixed-verb architecture — *if* the verbs are composite and diagnostic.

**Multi-agent mechanics:** all bot↔bot chat is **strictly pairwise** channels (`!startConversation`/`!endConversation`), transitioning between partners for 3+ agents; conversation pacing is **action-aware** ("if both agents are currently executing an action… the conversation is paused") — the paper's title mechanism. Messages tagged `(FROM OTHER BOT)`; explicit no-op (respond with a tab) is a legal move.

**The numbers that matter (Table 3, p. 7):**

| Task | GPT-4o | Claude 3.5 Sonnet | LLaMA3.3-70B | LLaMA3-8B | 8B-SFT |
|---|---|---|---|---|---|
| Crafting | 0.17 | **0.47** | 0.16 | 0.00 | 0.28 |
| Cooking | 0.40 | **0.64** | 0.36 | 0.01 | 0.18 |
| Construction (edit-dist) | 0.31 | **0.36** | 0.19 | 0.00 | 0.20 |

- **Agent count is poison:** *"performance drops dramatically from up to 90% down to less than 30% moving between the two- to five-agent settings"* — even on parallelizable tasks (redundant work, contended resources).
- **Forced plan communication costs >15%** (recipe-blocked crafting, Hell's-Kitchen cooking) — *"the primary bottleneck… is efficient natural language communication."*
- **Prompt ablations (LLaMA-70B crafting):** full 36% → no memory 12% → no few-shots 12% → **no communication 0%**.
- **SFT on self-generated successful trajectories made LLaMA-8B beat GPT-4o at crafting** (0.28 vs 0.17). The pipeline: run a 70B oracle 2,000 times, keep ~200 successes (16k examples), fine-tune. *Our event ledger natively records exactly the trajectories this requires.*
- Vision: *"initial tests indicate that vision inputs do not dramatically affect performance"* — corroborates L6.

**Failure catalogue (§10, pp. 19–22):** destructive interference on builds; resource-ownership confusion (asking the wrong agent, then searching an exhausted world as the clock runs out); hallucinated mechanics (inventing "tinder" as a campfire ingredient, smelting coal to get it); knowing the plan but never requesting the transfer; refusing an offered transfer out of misplaced confidence; misreading `getCraftingPlan`'s raw-materials expansion and re-gathering items already jointly owned; pointless back-and-forth gifting ("so we both have some"); command-misuse loops survived only because errors are conversational inputs; off-task chatter (abandoning the goal for "a hopeless quest to find spiders").

## 5. Cross-check matrix — the systems side by side

| Dimension | Generative Agents (Smallville) | Project Sid (PIANO) | Mindcraft / MineCollab (+ EG's practice) | **AI Civilization Engine (us)** |
|---|---|---|---|---|
| **Thesis** | Believable individual humans | Civilization-scale group dynamics | Embodied multi-agent collaboration benchmark | Persistent villager society as evented narrative |
| **Demonstrated scale** | 25 agents × 2 game days (multi-day wall-clock, $1000s) | 25–50 core experiments (20 min–4 h); 500 for culture; 1000 failed | 2–5 agents per task, minutes–timeout | 20 villagers, multi-day continuity, filmed |
| **Cognition loop** | Standing plans + continue-or-react gate + reflection | ~10 concurrent modules → bottleneck → Cognitive Controller broadcast | Conversation/event-driven; LLM called per message incl. command outputs | Sequential tick, one structured LLM call (speech+action together) |
| **Action layer** | Fiat — status-string rewrites, LLM-imagined object states | Fixed verb set, no codegen; building prompt-banned | **47 composite parameterized tools** + optional live JS codegen | Fixed verbs, but primitives not composites (the gap) |
| **Physical competence** | N/A by construction | Item progression good (GPT-4o only); no building | The reference implementation (gather/craft/build-from-blueprint) | Move works, gather 100%-fail, no build — see §7 Track A |
| **Memory** | Stream: recency(access-decay)×importance×relevance + 2-phase reflection trees | Module named, mechanics unpublished | Goal-oriented summary every 15 steps (36%→12% without) | GA-faithful stream + provenance-linked reflections (verified §4.1) |
| **Relationships** | None stored — generated from memories on demand | Inferred from text summaries at eval time | None persistent | **Directed persisted affinity/trust edges, every change ledgered** |
| **Coordination** | Emergent (party: 5/12 attended) | Roles emerge from seeing others' activities | Pairwise conversations; collapses 90%→<30% at 5 agents | Social-first by design; task collab deliberately deferred |
| **Evidence standard** | Interviews verified against memory streams | Post-hoc S3 reconstruction, keyword proxies | Automated task checkers, edit-distance | **Append-only causation-chained ledger (strongest of the four)** |
| **Cost discipline** | None ($1000s, named as limitation) | Unreported | API budget constrained their own experiments | Per-service daily breakers, token metrics, backpressure |

## 6. Verdict: where we stand

### Stronger — keep and lean in

1. **The ledger is our moat, triangulated by all three sources.** GA *recommends* an audit log it doesn't have (p. 17); Sid reconstructs culture post-hoc from S3 logs with keyword proxies; EG explicitly distrusts Sid without "long uncut footage." We alone have causation-chained ground truth for every claim. It already paid off (grudge DoD closure, FakeProvider-pollution repair) and it unlocks §7's analytics track cheaply.
2. **Coherence by construction.** PIANO concedes that one LLM call emitting speech+action solves speech/action coherence; at our output arity the sequential tick is optimal, not primitive. Revisit only if we add concurrent fast-paths.
3. **Persistent directed relationship state.** Nobody else has it. Sid's non-reciprocity finding and likeability regressions are one-line queries for us.
4. **Operational rigor.** Sid died at 1000 agents on infrastructure; EG burned out on babysitting; GA burned $1000s sequentially. Our breakers/watchdogs/freshness-guards/restart-visibility discipline is the unglamorous thing that makes long runs — our core product — possible at all.
5. **Closed, schema-validated action surface.** Gemini's kill-them-with-console-commands exploit (War video) is *unrepresentable* in our command contract. Alignment by API design.

### Weaker — gaps with proven fixes

1. **Physical competence** (the burning question): our verbs are primitives with non-prescriptive failures; no search-navigate composite, no crafting-plan tools, no environment lines in the snapshot. Mindcraft's recipe is fully documented (§4.3) and none of it requires codegen. → Track A.
2. **No standing plans, no continue-or-react gate** — structurally GA's no-planning ablation; produces per-tick myopia and pays full deliberation cost every tick. → Track B.
3. **One-phase reflection** — missing question-generation, full-stream reach-back, reflection trees. → Track B.
4. **Villagers can't see what others are doing** — Sid's specialization result rides entirely on that one context ingredient. → Track C.
5. **Action-feedback loop is open at the prompt level** — we deliver `ActionFailed` percepts, but with diagnostics so thin the rational response is learned helplessness (our gather finding: agents stopped trying). → Tracks A+C.
6. **No conversation protocol** — fine at current cadence; will bite at M2 campaign dynamics (EG's interruption/politeness-loop catalogue is what awaits us unprepared). → Track C.
7. **No anti-agreeableness measures** — grudge mean-reversion is GA's documented instruction-tuning bias; we currently rely on drama surviving a model that "rarely says no." → Track C.

### Missing proven ideas worth importing (not weaknesses — free wins)

Community-goal steering strings (Sid); trait-seeded cultural experiments (Pastafarian pattern); civilizational metrics (role entropy, perception accuracy, reciprocity); a reactive modes layer under the LLM; SFT-from-trajectories as the future cheap-model path (our ledger already records the training data); per-role model routing (Mindcraft mixes models per function inside one bot).

## 7. M2 backlog candidates (proposed, not committed)

Sizing uses our S/M/L convention. **If M2 stays "Government," the recommended core set is A1–A3 + C1–C2 + D1–D2** — bodies that work, awareness that specializes, and the election itself; B and E items slot in as stretch or M2.5.

### Track A — physical competence (answers the burning question)

- **EG-A1 (M)** — **Composite gather/give verbs.** Rebuild `gather` as locate→pathfind→equip→dig→**pick up drop**→confirm-count; add `searchForBlock(type, range)` (find AND navigate) and `givePlayer` with receipt verification ("never received" failure). Source: MineCollab §2.3 — the exact decomposition is documented.
- **EG-A2 (S)** — **Prescriptive failure diagnostics + LLM-visible parameters.** `ActionFailed` payloads in Mindcraft style ("requires: brown_mushroom: 1, red_mushroom: 1, bowl: 1"); search-range escalation guidance (64→128→256) in the action docs; per-verb gotcha docs in the deliberation prompt. Failure text quality *is* competence.
- **EG-A3 (S)** — **Environment percepts + prompt rebalance.** `nearbyResources` line in `WorldSnapshot`; soften "prefer small, concrete, social actions"; default `maxDistance` 48. (The three levers already identified on 2026-07-07, now evidence-backed.)
- **EG-A4 (M)** — **Plan-as-code query verbs.** `getCraftingPlan(item, qty)` (tech-tree expansion from minecraft-data, diffed against inventory) and `craftable` — recipe knowledge computed, never recalled. Guard against MineCollab failure #5: phrase output around what's *missing*.
- **EG-A5 (M)** — **Reactive modes layer** in minecraft-service: auto-eat, flee-on-damage, sleep-at-night — constantly-checking behaviors under the LLM, per-villager toggles, all emissions ledgered. Source: Mindcraft modes + Sid's fast-path. Buys survival competence between ticks at zero tokens.
- **EG-A6 (L, defer to M3+)** — **Blueprint construction**: declarative block-grid, `checkBlueprintLevel` computing Place/Remove diffs in code, per-villager level partitioning (to prevent MineCollab's destructive interference). Even Claude 3.5 placed <40% of blocks — defer until the story needs buildings.

### Track B — cognition (GA faithfulness + the token-cost lever)

- **EG-B1 (L)** — **Standing plans + continue-or-react gate.** Plan entries (location, start, duration) stored as memories; day agenda in 5–8 chunks from summary + previous-day digest; just-in-time decomposition; cheap gate per tick (continue vs react) so full deliberation runs only on change. Fixes per-tick myopia *and* is our biggest LLM-cost reduction.
- **EG-B2 (M)** — **Two-phase reflection.** Salient-questions step over recent memories → per-question retrieval over the *full* stream (prior reflections included) → cited insights. Trigger on importance-sum threshold, not timer. Unlocks reflection trees → self-concepts.
- **EG-B3 (S)** — **Cached villager summary description**, re-synthesized periodically from three fixed retrieval queries — identity that evolves with events instead of frozen seed personas.
- **EG-B4 (S)** — **Retrieval normalization experiment**: per-query min-max over the candidate set (paper-exact) vs our fixed scales; measure retrieval-quality deltas on recorded queries before adopting.

### Track C — social dynamics

- **EG-C1 (M)** — **Activity awareness → specialization.** Per-villager digest of "what others are doing" (compiled from ledger events — we don't need their module, we have the data) injected into deliberation, plus goal persistence ("keep unless accomplished"). Sid: this single ingredient is the difference between role entropy 2.6 and 4.0 bits.
- **EG-C2 (S)** — **Close the action-awareness loop in the prompt**: "Last tick you intended X; the world reports Y" as an explicit percept sentence, turning our existing `ActionCompleted`/`ActionFailed` events into Sid's grounding mechanism.
- **EG-C3 (M)** — **Conversation-lite protocol** for M2 campaigns: per-villager engaged-with state + staleness timeout, ignore-as-legal-action, and **actions attached to utterances** (`VillagerTalked` carries the speaker's current action/goal). Sources: EG's turn-taking rules + MineCollab's pairwise manager. Decentralized, per EG's argument — no conversation orchestrator service.
- **EG-C4 (M)** — **Anti-agreeableness kit**: relationship state as a hard behavioral constraint in prompts; explicit refuse/argue/avoid affordances; a grudge-persistence metric to detect mean-reversion. Counters GA's documented instruction-tuning bias — the published mechanism behind our M1 observation.
- **EG-C5 (M)** — **Innate drives & scarcity as percepts.** Sid names the lack of survival/curiosity/community drives as the root reason their societies needed scaffolding ("they currently lack robust innate drives… that catalyze genuine societal development"); GA shows agreeableness dissolves conflict when nothing is at stake. Inject periodic drive percepts (hunger, night-danger, loneliness, dwindling shared stores) that bias goal generation — sustained drama from environmental pressure, not from personality prompting alone. Pairs with EG-A5's modes (the body feels hunger; the mind hears about it).

### Track D — government (M2 core)

- **EG-D1 (L)** — **Adopt Sid's constitutional loop as the living-law half of government-service**: constitution document → scheduled feedback window → amendment synthesis (non-acting clerk agent) → structured vote (`yes/no/abstain`) → tally → constitution rewrite → redistribution, as a strict state machine over our planned election events. Sid's five prompts (their pp. 31–33) are portable starting points. Their frozen-constitution control condition is also our natural A/B filming device.
- **EG-D2 (S)** — **Steering knobs as episode devices**: per-village `community_goal` string (Sid: one string flipped a village from martial to artistic); optional seeded influencer personas for controlled opinion injection. Both are villagers.json edits, zero code.
- **EG-D3 (ruling)** — **No enforcement agents in M2.** Sid's compliance emerged honor-system (~20% tax paid, unenforced); they skipped police deliberately, and our M3 (laws, violation detection via rules engine) is the right home for enforcement.

### Track E — analytics & observability (ledger leverage)

- **EG-E1 (M)** — **Civilizational metrics pack** on analytics-service: role inference over rolling goal windows + **role-distribution entropy**; talk-to-action divergence per villager (the mutual-hallucination detector, L4); reciprocity histogram; perceived-vs-true likeability slope; extroversion vs in-degree. All are ledger queries; Sid needed bespoke pipelines.
- **EG-E2 (M)** — **Idea-lineage tracking**: LLM keyword extraction over chat/goals + **critical-exposure edges** from causation chains — exact "who heard it first" provenance for memes/rumors/religions. Enables GA-style diffusion experiments (their party, EG's Pizza-Time password) as measurable episodes.
- **EG-E3 (S)** — **Behavioral smoke for model swaps**: scripted FakeProvider day + one LLM-live scene, run after any provider/model change. Guards against EG's "GPT-4o got worse" drift and our own silent-fallback pollution class.
- **EG-E4 (defer)** — **SFT trajectory export**: successful action sequences from the ledger as fine-tuning data (MineCollab: 8B-SFT beat GPT-4o at crafting). Park until cheap-model competence becomes a cost priority.

### Rulings to carry (so future sessions don't re-litigate)

1. **No live code generation** (`!newAction`-style). Evidence: MineCollab's own benchmark succeeds through fixed verbs + blueprint diffs; no sandboxing story exists; EG's war video shows the blast radius; one hung generated promise can wedge our single executor (Corollary 3). Revisit only as offline skill synthesis (generate → sandbox → review → promote to a named verb).
2. **No vision.** Triangulated: EG ("more confusing than helpful"), MineCollab ("does not dramatically affect performance"), Sid (lack of vision named but their results didn't need it). Text affordances first.
3. **Don't chase >500 agents on one server** (Sid's ceiling); scale = federation, later.
4. **Building and police are deferred, not missing** — both are the published frontier's admitted gaps (Sid prompt-bans builders; skipped enforcement).
5. **Keep the single-call tick** until output arity genuinely grows; then bottleneck+broadcast, not ad-hoc concurrent modules.
6. **Keep "organic, ledger-provable" as the bar** for every emergent claim we film (EG's evidence standard, GA's verification hygiene).
