# MineLand — second-pass extraction (appendices, prompts, mechanics)

Paper: 33pp. Prompts appendix is Section T (p31): "We list part of the prompts" — ONLY the short-term and long-term plan generator prompts are published (Figs 16-17), plus the VLM judge prompt (Fig 13). Code-generator and critic prompts are NOT printed; p19 states explicitly: "For the remaining parts of MineLand that are not emphasized, we used the default setting of Voyager [57]" — so their action/critic prompts are Voyager's verbatim.

## 1. PROMPTS

### 1a. Long-term plan generator (Fig 17, p33)
Purpose: one-shot life/goal plan generated on FIRST access to the memory library, stored there and never per-tick. Structure in order: role line → "I will give you the following information:" → TaskInfo block → personality → observation block → vision input → 8 numbered criteria. Zero few-shot examples. No output-format spec shown (free text plan).

Role line verbatim: "You are a helpful assistant that utilize the information provided below to formulate a comprehensive long-term plan in Minecraft, aiding me in achieving my ultimate goal."

TaskInfo fields: `task_id, is_success, is_failed, goal, guidance` plus `score/local_score/global_score` each annotated "No need to focus on" — they suppress irrelevant fields IN the schema description rather than omitting them.

Load-bearing criteria verbatim:
- 3) "The long-term plan should fits my personality and can guide me to my ultimate goal."
- 5) "Some tasks will have default prerequisites, the prerequisites should be achieved before achieve the ultimate goal."
- 6) "Do not skip steps in an attempt to complete the task."
- 7) "Sometimes the ultimate goal can be relatively simple that don't need complex long-term plan, in this case you should tell me concise long-term plan." (budget escape hatch — worth copying)
- 8) "If you have a friend, you must work with him(her), this is highest priority!" (cooperation is a hard prompt mandate, not emergent)

### 1b. Short-term plan generator (Fig 16, p32)
Purpose: per-iteration next-task selection from associative memory. The published fragment is the 25-item criteria list ("You should follow the following criteria:"). This list IS the technique — it encodes verb grammar, reactivity, and cooperation protocol:

- 3) "You should always pay attention to the current chat and current event, which will have some special events you need to react immediatly based on your current situation and personality." (reactivity)
- 4) "The next task should not be too hard since I may not have the necessary resources or have learned enough skills to complete it yet." (curriculum self-gating)
- 5) **The verb grammar**: "The next task should follow a concise format, such as \"Mine [quantity] [block]\", \"Craft [quantity] [item]\", \"Smelt [quantity] [item]\", \"Kill [quantity] [mob]\", \"Cook [quantity] [food]\", \"Equip [item]\", \"Talk [message]\" etc. It should be a single phrase. Do not propose multiple tasks at the same time. Do not mention anything else." — closest published prior to our fixed-verb decision contract.
- 7) "Previous information may contain errors or may have changed. If there is a difference between the current information and the previous information, take the current information as accurate." (stale-memory tiebreak — copy this)
- 10) "before use or collect or craft something, you need to get closer to them first or craft one."
- 14) "There are likely to be events that you need to deal with, and those that threaten your life or your completion of the task are high priority and you need to deal with them first." (priority rule stated in-prompt)
- 16-20, the cooperation micro-protocol: 16) "You can chat with you friends, give them your position, talk about how to cooperate." 17) "…you should remember the position of your friend." 18) "Don't mistake your friends for zombies." 19) "Any harvest or techtree task, if you and your friend together achieve the goal, it counts as success, so you should work together to achieve more with less." 20) "Your friends' resources is also yours, you can give him some resources or ask for resources." (shared-credit + shared-inventory framing; division of labor is prompt-mandated, not negotiated)
- 25) "Equip yourself with the right tools before mining something."
- 9) "set critic_info as \"unfinished\"." — implies a structured output field; format spec itself not shown.

8B verdict: the verb grammar (5), current-beats-remembered rule (7), and precondition rules (10, 21, 25) survive local greedy directly — they are constraint-style, not reasoning-style. The 25-item length is risky at 8B (instruction dilution); we'd prune to ~10.

### 1c. VLM construction judge (Fig 13, p29)
Verbatim opening: "Please act as an impartial judge and evaluate the quality of the construction tasks performed by an AI agent. The evaluation should be based on a comparison between the provided blueprint and the construction results. Focus on the main structure of the building and disregard the background and surroundings. Focus on the accuracy of the structure and disregard the detailed design and patterns. After providing your explanation, please give an integer score between 1 and 5 by strictly following this format: \"[[rating]]\", for example: \"Rating: [[4]]\"." Then the 5→1 rubric inline (Table 17 text), then "[Image1: Blueprint] [Image2: Agent Construction Result]". Zero-shot, rubric-in-prompt, explanation-before-score, bracketed extraction token. Frontier-VLM only for images, but the explanation→"Rating: [[n]]" pattern is a good local LLM-judge scaffold. Worked examples of judge outputs: Figs 14-15 p30 (stele scored 3, monument scored 1).

## 2. MECHANICS

### Alex architecture (pp7, 18-21)
VLM-based (gpt-4-vision-preview, **temperature 0**, text-embedding-ada-002 embeddings, Chroma vector store — footnote 9 p19). Max tokens 512 everywhere except action component 512×3 (Appendix F p21).

**Brain = memory component + planning component** (E.1 p19). Memory library stores: personality, persona, long-term goals, short-term goals, chat records, experienced events, mastered skills, environmental information — and hosts the long-term planner. Per iteration it embeds observations + critic info + tasks into the vector DB. On critic-confirmed completion, a "skill manager" writes "a concise description of the relevant skill" into a separate skill vector DB (Voyager skill library, description-keyed). **Associative memory** = short-term working memory holding situation-relevant retrievals, "aiding the short-term planner to focus on important rather than irrelevant information." Bidirectional flow (p20): library pushes relevant info → associative memory; associative memory returns generated short-term plans → stored back in the library. Retrieval limits (F, p21): chat 5, event 2, environment 2, skill 5, recent chat 8, short-term plan 5 — a concrete per-category retrieval budget, unlike our single pgvector top-k.

**Hierarchical planning gate** (E.2 p20): "MineLand considers the current task's complexity degree. If it is complex, it will generate a long-term plan for later decomposition into short-term plans; Otherwise, a short-term plan will be generated directly and executed immediately." Long-term planner "interleaves daily routines and tasks."

**Action module** (E.3 p20): three parts — Action component (plan→steps+code), Critic component ("detect whether a certain execution result conforms to the short-term plan… whether the current plan has been completed"), Dispatching component (routes env info to the other two). Retry budgets (F p21): Dispatching FAILED TIMES LIMIT = 3 (code errors), code execution time limit = 2000 ticks (100s); Critic FAILED TIMES LIMIT = **2** (failed short-term plans → abandon), Critic Mode "auto". Their 2-strike plan abandonment vs our 3-strike abandon-and-repropose: same mechanism, tighter budget. Separately, an "action correction module" (p19) handles "minor action corrections" reflexively below the social brain — the executor-side clamp pattern we already use.

### Observation serialization (Fig 17 p33 — the format fed to planners)
```
observation(
  Name: My id.
  Equipment: My equipment.
  Inventory: My inventory.
  Voxels: blocks around me. voxels[i][j][k] = blocksAt(MyPosition.offset(i-1, j-1, k-1))
  Life state: My life state.
  Face vector: My face vector.
  Location state: My location state.
  Time: tick (game tick), time (in-game time), day (day count). )
```
Voxels is a **3×3×3 block cube centered on the agent** (offsets −1..1) — tactile "what can I touch," not a survey; everything farther arrives via vision (VLM) or events. Delta vs our percept snapshot: they carry face vector (orientation) and explicit tick/day; we don't serialize immediate-adjacency blocks. Cheap and survives 8B trivially.

### Physical-needs state as the LLM sees it (C.2 pp16-17; K p24)
State space: **Health** int [0,20]; **Food** (satiety); **Oxygen** (appears only when submerged); Inventory; Equipment. Surfaced numerically — the p24 transcript shows the planner reading it: "The agent's life is critically low at 1, and the food level is at 0, which is also critical. The agent has 2 pieces of bread in the inventory, which should be consumed immediately…" Ablation (K pp24-25): same agent w/o needs state knows it has bread, never eats, "continuously collected resources to cope with threats," dies to a zombie at night. With needs: eats → dirt shelter → survives the day. Lesson: needs must be in the serialized state with critical thresholds visible, not implied.

### Interrupt system (§2.5 p5; E.4 pp20-21)
- **Granularity**: high-level action code "is divided into several steps, with each step lasting 50-200 milliseconds" (50ms = 1 MC tick, footnote 4 p5). Interrupts land only at step boundaries.
- **Step protocol**: "Before taking a step, the agent is provided with the running states of the previous code, either *running*, *ready*, or *exceptions*. After completing a step, the agent … can choose to either switch to a new action code or continue executing the previous one. This function of choosing is implemented by an automatic gate control system with two gates: *New* and *Resume*." That's the whole gate: a binary preempt/continue check at every 50-200ms code step.
- **Who decides**: simulator maintains "a dedicated event queue that stores various special events categorized by their urgency (e.g., hurt events, chat events, and death events)" (p20) — urgency classes, no numeric levels published. Agent-side, "Alex first decides in the associative memory whether the event requires high-priority processing; if so, it interrupts the current code to generate a new short-term plan" (p19). Options on attention-worthy events (pp20-21): **Defer** (low priority, e.g. chat), **Context Switching** ("temporarily stores the ongoing task in the memory library and focuses on addressing the new event" — saved state = the task record in the library; resume = re-retrieve it), **Concurrent Processing** (handle both).
- For us: the queue + gate is entirely architecture, model-agnostic — implementable in our executor/consumer with rule-based urgency (hurt > task > chat) without any LLM call, giving sub-tick reactivity despite the 30s deliberation. Their LLM-in-the-loop version, even with GPT-4V, only managed hurt-response 8/10 and chat-response 2/10 (Table 6 p9) vs 0/10, 0/10 without multitasking (agent dies to zombie) — the mechanism is essential but their soft prioritization is leaky; a hard rule-based gate should beat it.

### 2-agent cooperation mechanics (§5.2 p8, §5.5 p9, Table 3 p8)
Channel: Minecraft chat bar, **distance-constrained** (p5) — messages delivered only under a distance threshold; auditory + body-language likewise. Division of work is not negotiated by protocol; it emerges from criteria 16-20 + chat: "when one agent says in a chat that he needs two sticks, another agent will ask for getting together near the table, and then give the sticks to him" (p9). Numbers: code iterations/agent to unlock tools (Table 3) — single 7±2 / 10±3 / 25±7 (wood/stone/iron); cooperative 13±5 / 20±7 / 49±10; competitive 6±2 / 10±3 / 27±10. Cooperative RAW iterations are ~2× single because they count communication turns; excluding chat cost, "the code iteration cost of agents cooperating is reduced by 20% per agent" (p9). Competitive agents iterate less but "make more mistakes" (p8). Personality gates cooperation hard: high extraversion+agreeableness → co-op >8/10 runs; no personality → **0/10** (p8); at 48 agents, 48/48 high-personality vs 24/48 low showed cooperative intent in long-term plans (Table 15 p28).

## 3. AXIS FINDINGS a first pass likely missed

- **Model floor for the whole stack** (Table 16 p28): gpt-3.5-turbo-1106 scores N/A(0/3) on even "Harvest 1 white wool with 1 shears"; gpt-4-1106-preview 4(1/3); gpt-4-vision-preview 4±2(3/3). Their agent framework collapses below GPT-4 class — corroborates the synthesis verdict that this prompt-heavy NL stack does NOT survive 8B as-is; adopt mechanisms (gates, verb grammar, retrieval budgets), not the stack.
- **Long-horizon single-agent** (L p25, Fig 11): diamonds 2/6 attempts under the honest "no target location until visually discovered" restriction ("Voyager can 'cheat'. Voyager obtains the location of the target directly from the system"), ~60 code iterations to diamond pickaxe. Our gather contract has the same oracle-vs-honest question.
- **Chat is the wrong interrupt class**: chat deferred by design AND mostly dropped anyway (2/10) — while their own stage-performance results show multi-agent dialogue is where scores die: keypoint 0.98-0.99 vs appropriateness 0.59-0.67, human 3-4, "agents' words are too redundant" (Tables 11-12 pp26-27); 13-agent Romeo & Juliet: 0.09/0.20/1, omitted from appendix as unreadable (p26, Table 5 p9).
- **Vision ablation quantified** (H p22, Table 10): find-the-ocean — 80% success/46.4s with vision vs 40%/81.5s without; w/o vision agents "randomly choose their direction" (Fig 8 p23 shows verbatim rationales). Relevant ceiling estimate for our text-only stack on spatial-search tasks.
- **Retry budgets as published constants** (p21): 3 code-error retries, 2 plan failures then abandon, 2000-tick execution cap — a tested prior for tuning our failure-streak threshold (we chose 3) and trip budgets.
- **Construction failure decomposition** (p8, pp29-31): failures = (1) no auxiliary-structure planning (scaffolding), (2) no fine-grained placement APIs. Verb-set gap, not model gap — their fix is "a richer set of low-level APIs" (p31).
- Conformity experiment (Table 14 p28): conformist persona follows 1-9 confederates to the WRONG tower; independent persona never does — persona text alone flips group behavior at temp 0.

## 4. REFERENCES TO CHASE (pp10-13)

- **[58] JARVIS-1: Open-world Multi-task Agents with Memory-Augmented Multimodal Language Models** — arXiv:2311.05997, 2023. Long-horizon Minecraft tech-tree to diamond via multimodal memory; the strongest published long-horizon comparison point for axis (a).
- **[59] Describe, Explain, Plan and Select (DEPS)** — arXiv:2302.01560, 2023. Interactive planning with error *explanation* feeding replanning — the direct academic ancestor of our abandon-and-repropose loop; check what explanation text buys at small scale.
- **[69] Ghost in the Minecraft (GITM)** — arXiv:2305.17144, 2023. Text-based knowledge/memory, NO vision, hierarchical goal decomposition to diamond — closest architecture to our text-only stack of anything MineLand cites.
- **[65] Zhang et al., Building Cooperative Embodied Agents Modularly with LLMs (CoELA)** — NeurIPS 2023 FMDM workshop. The reference design for LLM cooperation protocols (belief/communication modules); axis (b), likely frontier-dependent — read for the protocol structure, not the model.
- **[53] Salvucci & Taatgen, Threaded Cognition: An Integrated Theory of Concurrent Multitasking** — Psychological Review 115(1):101, 2008. The cognitive-science basis of the interrupt/multitasking component; useful for designing our reactivity gate's defer/switch/concurrent taxonomy without any LLM.
- **[11] S-Agent: Self-organizing Agents in Open-ended Environment** — ICLR 2024 LLM-Agents workshop. Self-organized collaborative building + resource collection; axis (b) division-of-labor without central planner.
- **[67] Hierarchical Auto-Organizing System for Open-ended Multi-Agent Navigation (HAS)** — 2024. Hierarchical organization of many Minecraft agents; relevant to scaling 6→20 villagers with grouped command flow.
- **[64] Creative Agents: Empowering Agents with Imagination for Creative Tasks** — 2023. Blueprint-conditioned building; only relevant if we ever attempt construction verbs; VLM-dependent.

Files: paper at `D:\Documents\GitHub\minecraft-ai-agents\papers\MineLand.pdf`; synthesis doc this feeds: `D:\Documents\GitHub\minecraft-ai-agents\docs\reports\papers-synthesis-2026-07-27.md`.