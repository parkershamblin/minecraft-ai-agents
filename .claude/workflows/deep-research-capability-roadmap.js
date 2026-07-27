export const meta = {
  name: 'deep-research-capability-roadmap',
  description: 'Deep re-read of 6 papers (all prompts/code), field scan of references + SOTA, repo capability audit',
  phases: [
    { title: 'Deep read', detail: 'one agent per paper: every prompt template, code mechanic, appendix' },
    { title: 'Field scan', detail: 'references + 2024-26 SOTA across five topic clusters' },
    { title: 'Repo audit', detail: 'current capability inventory vs the beat-the-game tech tree' },
  ],
}

const NORTH_STAR = `NORTH STAR (extraction lens — read everything against these three axes):
We build LLM-driven Minecraft villagers: local Ollama models (llama3.1:8b, gemma3:12b, gemma4:latest), greedy decoding, 8192 num_ctx, 30-second deliberation tick, ONE consumer GPU serving all villagers sequentially, FIXED action verbs (spawn/despawn/move/follow/chat/idle/gather/craft/hunt) over a single trusted mineflayer executor (Node), event ledger (append-only Postgres), pgvector generative-agents memory, 6-20 villagers. The owner's goal: villagers that (a) work COLLABORATIVELY on LONG-HORIZON tasks, up to beating the ender dragon / finishing the game, (b) stay REACTIVE to fast danger (hostile mobs, hazards) despite the 30s tick, (c) collect resources and progress the tech tree reliably. Inference-only stack today (no RL loop), though offline LoRA SFT on the consumer GPU is on the table. For every technique you report, state whether it survives 8B-12B local greedy or depends on frontier models / training infrastructure.`

const READ_HOWTO = `HOW TO READ THE PDF:
- The Read tool renders PDF pages as images (pages param, e.g. pages: "17-20", max 20 pages/request). RENDER the appendix pages containing prompts, tables, and figures — text extraction mangles prompt formatting. Multiple Read calls are fine and expected; cover the WHOLE appendix.
- For bulk text skim (Bash tool, run from D:/Documents/GitHub/minecraft-ai-agents): PYTHONIOENCODING=utf-8 uv run --with pypdf python -c "from pypdf import PdfReader; r=PdfReader('papers/FILE'); print(len(r.pages))" — bare python on this machine is a stale 3.8, always uv run. The PYTHONIOENCODING=utf-8 is required.
- A first-pass summary of this paper already exists. Do NOT write another generic summary. Your value is the material the first pass skipped: appendices, prompt templates verbatim, code/architecture mechanics, bibliography.`

const PAPERS = [
  {
    key: 'voyager',
    file: 'voyager.pdf',
    mechanics: `- Full control-primitive API list WITH SIGNATURES (pp24-25) — we will diff it against our verb set.
- Curriculum mechanics in full: the warm-up schedule table (Table A.1 p21), the complete criteria list (p22), failed-task retry policy, how "exploration progress" is represented in the curriculum prompt.
- Skill library entry format: the description-generation prompt, the embedding key, one FULL example skill program end to end.
- Critic prompt + its few-shot examples (pp35-37) — quote the JSON output format exactly.
- How environment feedback and execution errors are textually formatted into the code-generation prompt (structure of one full codegen prompt, section by section, pp24-31).
- The QA self-ask pipeline prompts (pp22-24) and temperature settings per component.`,
  },
  {
    key: 'mindcraft',
    file: 'MINDcraft.pdf',
    mechanics: `- The FULL 47-command vocabulary (Table 8, pp26-28): every command name, its parameters, one-line semantics. Complete list, not a sample — we will diff it against our 9 verbs to find what a beat-the-game agent needs (placing blocks? chests? equipping? doors? towers?).
- System prompt and coding prompt structure (pp12-13), section by section; quote load-bearing phrases.
- Conversation manager protocol: startConversation/endConversation semantics, the pausing of conversation during actions, the 2-agent limit, message routing.
- Memory summarization: trigger cadence, the summarization prompt, output format.
- SFT dataset construction: the EXACT transition/example format — what is the input context, what is the target output, how multi-turn episodes become training rows. We plan a ledger-to-SFT exporter and need the precise shape.
- Task generation + train/test split mechanics; blueprint representation for construction tasks.`,
  },
  {
    key: 'mineland',
    file: 'MineLand.pdf',
    mechanics: `- Alex architecture in full (pp19-21): long-term planner prompt, short-term planner prompt (Fig 16 p32), code generator, critic, associative memory + memory library entry formats.
- Observation serialization (Fig 17 p33): the exact voxel/text format given to the planner — closest prior to our percept snapshot.
- Interrupt system mechanics: priority queue levels and their ordering, the New/Resume gate decision logic (what exactly decides interrupt vs defer vs resume), what state is saved and restored on a context switch, the 50-200ms code-step granularity.
- Multi-agent coordination in their experiments: how the 2-agent cooperation actually communicated and divided work.
- Physical-needs state format as surfaced to the LLM.`,
  },
  {
    key: 'govsim',
    file: 'GovSim.pdf',
    mechanics: `- Full prompt suite: the harvest decision prompt, discussion-phase orchestration (turn order, number of rounds, termination rule), reflection/insight prompts, the conversation-takeaway prompt that writes chat back into memory, and the EXACT universalization memory line + precisely where/how it is inserted into the agent's context.
- The public-reveal format: how agents are told everyone's harvest each month (we may build an elected-quota system with ledger-driven compliance visibility — the reveal format is the model).
- Sub-skill probe templates (pp33-35): the four probe types, one full example each.
- The utterance taxonomy definitions (all 8 subcategories) used for chat classification.`,
  },
  {
    key: 'vot',
    file: 'MindsEyeofLLMs.pdf',
    mechanics: `- Exact prompt wording of all four settings (p6; Figs 6-7 p17).
- GRID SERIALIZATION, precisely: how grids are rendered as text in the INPUT (emoji vs ascii, row/column labels, coordinate conventions, cell separators) and what the expected output visualization looks like. We are considering a code-rendered local-map percept for our villagers and their input format is the closest prior — the input-side format matters more to us than the VoT technique itself (which their own Table 3 shows regresses at 8B).
- Example trace structure (pp23-26): how reasoning steps and grids interleave.
- Anything in the appendix on prompt-phrasing sensitivity ("use ascii-art" +78.5% tracking) — exact phrasings tested.`,
  },
  {
    key: 'minedojo',
    file: 'MineDojo.pdf',
    mechanics: `- Task definition 5-tuple format with 2-3 concrete examples verbatim.
- The GPT-3 guidance-generation prompt (task hints) — exact structure.
- Creative-task mining pipeline mechanics.
- Wiki dump structure (Appendix D pp28-31): what fields/tables exist per page, enough to design a retrieval ingestion.
Keep this one to <=1200 words — the paper's RL core is unusable for us; prompts, task formats, and wiki structure only.`,
  },
]

function deepReadPrompt(p) {
  return `You are doing a SECOND, deeper pass over an academic paper for an engineering program.

Paper: D:/Documents/GitHub/minecraft-ai-agents/papers/${p.file}

${READ_HOWTO}

${NORTH_STAR}

RETURN (<=2000 words unless stated otherwise, tightly structured, page refs on everything):
1. PROMPTS — every prompt template in the paper: purpose, structure (sections in order), the load-bearing phrases worth copying VERBATIM (quote them), the output format demanded, few-shot example count. Where the wording IS the technique, quote it exactly.
2. MECHANICS the first pass under-specified:
${p.mechanics}
3. AXIS FINDINGS — anything on long-horizon goal management, collaboration protocols, or reactivity/interrupts that a first-pass summary would have missed, with numbers and page refs.
4. REFERENCES TO CHASE — the 3-8 bibliography entries most relevant to our three axes: title, venue/year, arxiv id if printed, one line on why it matters to us.

Your final message IS the deliverable — raw structured report, no preamble.`
}

const SCANS = [
  {
    key: 'long-horizon',
    prompt: `Research scout: LONG-HORIZON single-agent Minecraft LLM agents. Load web tools FIRST via ToolSearch query "select:WebSearch,WebFetch" (one call). Prefer arxiv abstract/HTML pages; cite arxiv ids/URLs for every claim; state the model + scale behind every number.

${NORTH_STAR}

Cover at minimum (search for each; skip only if genuinely unfindable): DEPS (arXiv:2302.01560), GITM / Ghost in the Minecraft (2305.17144), Plan4MC, JARVIS-1 (2311.05997), Optimus-1 (2408.03615) and any Optimus-2/Optimus-3 successors, ADAM, Odyssey (2407.15325), STEVE-1, MineDreamer, Cradle (2403.03186), and any 2025-2026 successors you find (search "Minecraft LLM agent 2025", "beat ender dragon agent", "Minecraft tech tree LLM").

QUESTIONS (answer each explicitly):
1. How does each represent long-horizon goals — LLM free-form planner, code-side task DAG/tech-tree, curriculum, plan memory? What fraction of the planning is trusted code vs LLM?
2. Replan-on-failure mechanics: what triggers a replan, what context the replanner sees.
3. SOTA per tech-tree milestone: diamond, diamond pickaxe, nether entry, blaze rods, ender pearls, stronghold, DRAGON KILL. Has ANY published agent beaten the ender dragon autonomously from a fresh survival world? Under what conditions (paused sim? human hints? creative shortcuts?)?
4. Anything demonstrated at <=13B or with open-weight models — numbers.
5. Memory of past plans/skills across episodes: formats that worked (JARVIS-1's multimodal memory, Optimus's knowledge graph, etc.).

RETURN <=1800 words: per-system one dense paragraph (goal representation, code/LLM split, headline results with conditions, model scale), then a milestone-SOTA table, then a frontier-gap verdict table (survives local 8B-12B greedy / needs frontier / needs training infra). Final message is the deliverable, no preamble.`,
  },
  {
    key: 'multi-agent',
    prompt: `Research scout: MULTI-AGENT embodied LLM collaboration, Minecraft first. Load web tools FIRST via ToolSearch query "select:WebSearch,WebFetch" (one call). Cite arxiv ids/URLs; state model + scale behind every number.

${NORTH_STAR}

Cover at minimum: Project Sid (arXiv:2411.00114) — go DEEP on the PIANO architecture (full module list, concurrency model, the bottleneck/social-awareness design, what ran per agent per unit time, model used, agent counts, civilizational benchmarks); VillagerAgent (2406.05720); TeamCraft (2412.05255); HAS / hierarchical auto-organizing multi-agent (2403.08282 or similar); S-Agents (2402.04578); MindAgent (2309.09971); CoELA / "Building Cooperative Embodied Agents with LLMs" (2307.02485); plus any 2025-2026 multi-agent Minecraft work you find.

QUESTIONS:
1. Which coordination mechanisms MEASURABLY beat solo/naive baselines: centralized planner-dispatcher, auction/contract-net, role assignment, shared scratchpad/blackboard, structured task queues? Numbers.
2. What actually carried coordination — structured messages/shared state vs natural-language chat? Any paper that ablated this directly (beyond MINDcraft/MineCollab which we have)?
3. Team-size scaling: where does it break and why (contention, redundant work, comms overhead)?
4. Model scale: does ANY multi-agent coordination result hold at <=13B open models?
5. PIANO specifics we can borrow for a 30s-tick, one-GPU stack: which concurrent modules are cheap (no LLM) vs LLM-bound; how they arbitrate.

RETURN <=1800 words: per-system dense paragraph, then "coordination mechanisms ranked by evidence" list, then frontier-gap verdict table. No preamble.`,
  },
  {
    key: 'reactive',
    prompt: `Research scout: REACTIVE + DELIBERATIVE hybrid LLM agent architectures (slow/fast, interrupts, event-driven replanning). Load web tools FIRST via ToolSearch query "select:WebSearch,WebFetch" (one call). Cite arxiv ids/URLs; state model + scale.

${NORTH_STAR}
Extra context: our executor already has non-LLM reflexes (hazard escape, self-defense, auto-eat) with a busy-state arbitration table, a 60s per-command watchdog, and latest-intent-wins queueing. The open question is the ARCHITECTURE above that: when the world changes fast (creeper, night raid, lava), the 30s tick + one serialized GPU means deliberation is always stale. What do proven systems do?

Cover at minimum: SwiftSage (2305.17390) — the slow/fast switch policy in detail; Talker-Reasoner (2410.08328); Cradle's reaction vs planning split (2403.03186); DEPS' event-triggered replanning; MineLand/Alex interrupts we already know (skip); robotics fast-slow stacks as background only (Inner Monologue, Code-as-Policies — one paragraph total); any real-time game LLM agents 2024-2026 (StarCraft II LLM agents e.g. TextSC2/SwarmBrain, CS/Dota attempts, "real-time LLM agent latency" work); LLM agent interrupt/preemption papers.

QUESTIONS:
1. Arbitration: when fast and slow layers disagree, who wins, and what prevents oscillation?
2. Proven TRIGGER SETS for off-cycle deliberation (health drop, new hostile, goal-blocking event, idle) — which triggers earned their cost.
3. Latency budgets reported for the fast path, and what runs in it (scripts? tiny model? cached policy?).
4. Plan persistence across interrupts: resume vs replan — evidence either way.
5. Anything on SERIALIZED/shared LLM backends (queueing multiple agents into one model server) and scheduling policies for that.

RETURN <=1800 words: per-system paragraph, then a "design rules extracted" list (each rule with its evidence), then frontier-gap verdicts. No preamble.`,
  },
  {
    key: 'small-model',
    prompt: `Research scout: making SMALL (<=13B) open models competent AGENTS — SFT recipes, constrained decoding, prompting patterns. Load web tools FIRST via ToolSearch query "select:WebSearch,WebFetch" (one call). Cite arxiv ids/URLs; state model + scale.

${NORTH_STAR}
Extra context: MINDcraft/MineCollab already showed llama3-8b 0.00 -> 0.28 via SFT on 16k transitions from ~200 successful llama3.3-70b trajectories. Our event ledger logs every decision with win/DNF labels. We run Ollama (supports GBNF-style grammars / JSON schema constrained decoding) and could LoRA an 8B on the consumer GPU offline.

Cover: AgentTuning (2310.12823), FireAct (2310.05915), Lumos (2311.05657), TinyAgent (2409.00608), xLAM / function-calling small models, Gorilla/NexusRaven lineage, agent distillation papers 2024-2026, STaR/ReST/RFT-style self-improvement from own successful rollouts applied to agents, AgentGen/AgentInstruct-style synthetic trajectory generation, and constrained/structured decoding evidence (outlines, xgrammar, llama.cpp grammars — does hard schema constraint help or hurt task performance at 8B?). Also: any evidence on greedy vs low-temperature sampling for agentic reliability.

QUESTIONS:
1. Proven SFT recipes: data size thresholds (how many trajectories/transitions before it works), format (full-context transitions vs trajectory summaries), success-filtering vs reward-weighting, cross-task generalization vs overfitting to the training task.
2. Self-improvement loops from the agent's OWN rollouts (no bigger teacher): does STaR-style filtering work for embodied/tool agents at 8B, or does it need a stronger teacher?
3. Constrained decoding: measured effect on downstream task success (not just parse rate) at small scale.
4. Prompting patterns that measurably help small models plan within ~8k ctx: plan-then-act scaffolds, few-shot exemplar retrieval, state summarization cadences.
5. LoRA practicalities: typical rank/epochs/GPU-hours for an 8B agent SFT on one consumer GPU (RTX 4090-class).

RETURN <=1800 words: findings per question with numbers, then a "recipe we should run" sketch (data volume needed, expected lift, cost), then verdict table. No preamble.`,
  },
  {
    key: 'beat-the-game',
    prompt: `Research scout: WHAT BEATING MINECRAFT ACTUALLY REQUIRES, and how close published agents have come. Load web tools FIRST via ToolSearch query "select:WebSearch,WebFetch" (one call). Use arxiv + Minecraft wiki + mineflayer GitHub docs/issues. Cite everything.

${NORTH_STAR}
Extra context: our bots are mineflayer-embodied (MC 1.21.6, Paper server). Current verbs: move/follow/chat/idle/gather(block families, incl. ores with tool-tier gate)/craft(with chain resolution: missing ingots -> furnace flow -> smelt -> craft)/hunt. Executor reflexes: hazard escape, self-defense, auto-eat. NO verbs today for: free block placement (only crafting-table/furnace placement inside craft flows), bucket use, bed use, ranged/bow combat, trading/bartering, portal lighting, dimension travel, enchanting, brewing, riding.

DELIVER THREE THINGS:
1. MILESTONE SOTA: per stage (wood/stone/iron/diamond/diamond-pickaxe/obsidian+portal/nether traversal/blaze rods/ender pearls/eyes+stronghold/End fight/dragon kill), which published agent got there, model + conditions. Explicitly: has any autonomous agent (LLM or RL) killed the ender dragon from a fresh survival world in a published result as of 2026? Search hard: "ender dragon" agent, JARVIS-1, Optimus-3, GITM (claims obtaining all items? verify what "ObtainDiamond ancestor" claims mean), Voyager follow-ups, "Minecraft AGI benchmark 2025".
2. REQUIREMENTS DAG: a practical task decomposition for beating the game the way a cautious player (not a glitch speedrunner) would: per stage — required items/quantities, required NEW capabilities beyond our current verb set (name each missing verb/skill explicitly), main dangers, and what a 3-6 villager TEAM could parallelize at that stage. Use Minecraft wiki knowledge (1.21 mechanics): iron -> diamonds (Y-level, fortune?), obsidian via diamond pick vs lava-bucket casting, nether: fortress finding, blaze farming (fire resistance? shields?), pearls: enderman hunting vs piglin barter (gold), eyes of ender, stronghold navigation, End: crystal destruction (bow REQUIRED? towers climbable?), dragon perch mechanics, bed-explosion tactics, escape logistics.
3. MINEFLAYER FEASIBILITY: for each missing capability (place block, bucket, bed, bow/pvp ranged, barter, portal + dimension change, elytra ignore) — does mineflayer support it, which plugin (mineflayer-pvp, mineflayer-auto-eat, pathfinder in nether terrain), known issues (dimension-switch session handling, ghast/lava pathfinding). Check mineflayer GitHub for dimension-travel and End-fight issue reports.

RETURN <=2000 words, the three sections, tables where natural. No preamble.`,
  },
]

const AUDIT_PROMPT = `Read-only REPO CAPABILITY AUDIT for D:/Documents/GitHub/minecraft-ai-agents. You have file tools (Read/Grep/Glob); do NOT edit anything. Goal: an exact inventory of what the villagers can DO today, as the baseline for a beat-the-game / long-horizon-collaboration roadmap.

${NORTH_STAR}

INVENTORY (file:line anchors for every claim):
1. VERBS: the full action vocabulary in the decision contract (packages/events schemas: ActionRequested params, per-verb param schemas + clamps + timeout table) and the executor switch (services/minecraft-service/src/actions/executor.ts). List every verb with params and limits.
2. EXECUTOR SKILLS: what the body can actually accomplish — gather block families (which? ores? tool-tier gates?), craft chain resolution depth (services/minecraft-service/src/world/crafting.ts: which items resolve end-to-end — planks/sticks/table/furnace/smelt/tool tiers? does it place the table/furnace? can it place ANY other block?), hunting (services/minecraft-service/src/world/hunting.ts), movement (pathfinder config, physicsSimCache).
3. REFLEXES + ARBITRATION: services/minecraft-service/src/bots/ (hazard.ts, BotSession.ts, anything named guard/tether/combat/eat): every reflex, its trigger, its busy-state, how it preempts commands.
4. TICK + SCHEDULING: agent-service — is the tick strictly fixed-interval or is there reactive/off-cycle scheduling (check agent_service scheduler modules and tests/test_scheduler_reactive.py — what triggers exist)? Where would an interrupt-driven deliberation slot in?
5. TEAM/COLLAB MACHINERY: race sections/percepts (brain/race.py), COMMUNITY_GOAL, relationships (affinity/trust wiring into prompts), chat earshot mechanics, government-service as-built (what the election machine + ballot box can do TODAY, its Kafka contracts).
6. MEMORY: memory-service retrieval scoring, reflection cadence + provenance, what gets written when.
7. GAP LIST: explicitly name capabilities that DO NOT exist: free block placement, bucket, bed, bow/ranged, barter/trade, portal/dimension handling, enchanting, brewing, container use (chests), shared/persistent goal state across ticks (is there ANY standing goal object beyond race sections?), task allocation between villagers.

RETURN <=2000 words, sections 1-7, dense, file:line anchors. Final message is the deliverable, no preamble.`

phase('Deep read')
const readThunks = PAPERS.map((p) => () => agent(deepReadPrompt(p), { label: `read:${p.key}`, phase: 'Deep read' }))
const scanThunks = SCANS.map((s) => () => agent(s.prompt, { label: `scan:${s.key}`, phase: 'Field scan' }))
const auditThunk = [() => agent(AUDIT_PROMPT, { label: 'repo-audit', phase: 'Repo audit' })]

const results = await parallel([...readThunks, ...scanThunks, ...auditThunk])

const out = { papers: {}, scans: {}, audit: null }
PAPERS.forEach((p, i) => { out.papers[p.key] = results[i] })
SCANS.forEach((s, i) => { out.scans[s.key] = results[PAPERS.length + i] })
out.audit = results[PAPERS.length + SCANS.length]

const missing = []
PAPERS.forEach((p) => { if (!out.papers[p.key]) missing.push(`read:${p.key}`) })
SCANS.forEach((s) => { if (!out.scans[s.key]) missing.push(`scan:${s.key}`) })
if (!out.audit) missing.push('repo-audit')
if (missing.length) log(`WARNING — agents returned null (dropped): ${missing.join(', ')}`)

return out