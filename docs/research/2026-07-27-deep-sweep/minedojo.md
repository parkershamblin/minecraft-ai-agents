# MineDojo — second pass (prompts, task formats, wiki structure, axis findings)

Paper: Fan et al., *MineDojo: Building Open-Ended Embodied Agents with Internet-Scale Knowledge*, NeurIPS 2022 D&B. 40pp. Note up front: this is a 2022 RL-era paper — the only LLM in it is GPT-3 used **offline** for text generation (guidance + task ideas). There are exactly three prompt templates in the whole paper, all short. The durable value for us is the task-definition machinery and the knowledge-base schemas.

## 1. PROMPTS (complete inventory)

**P1 — GPT-3 guidance generation ("task hints"), Sec C.3 p27, first used Sec 2.1 p4.**
- Purpose: turn a one-line task goal into a numbered step-by-step plan (the 𝒢 field of the task tuple), via `GPT-3-davinci` API.
- Structure: single-sentence zero-shot template, explicitly "Inspired by [67]" (Kojima zero-shot CoT). Verbatim (p27):
  > `How to {task goal} in Minecraft? Let's think step by step.`
- Few-shot examples: **zero**. Output format: freeform numbered list (`1) ... 2) ...`).
- Example outputs verbatim — for "bring a pig into Nether" (p4): `1) Find a pig in the overworld; 2) Right-click on the pig with a lead; 3) Right-click on the Nether Portal with the lead and pig selected; 4) The pig will be pulled through the portal!` For "find material and craft a gold pickaxe" (p27): `1) Find a place with a lot of trees; 2) Cut down the trees and gather the wood; 3) Find a place with a lot of stone; 4) Mine the stone and gather the cobblestone; 5) Find a place with a lot of iron; 6) Mine the iron and gather the iron ingots; 7) Find a place with a lot of gold; 8) Mine the gold and gather the gold ingots; 9) Craft a gold pickaxe.` For "sail on boat with a sheep" (p27): 4 steps ending `4) Use the WASD keys to move the boat. The sheep should stay in the boat.`
- The load-bearing observation: outputs are in **human-tutorial register** ("Right-click", "WASD keys") — GPT-3 is regurgitating wiki/tutorial text. Feeding these to an agent requires mapping to your action verbs; for us the gold-pickaxe example maps almost 1:1 onto `gather`/`craft` chains, which is exactly the register we want.
- **8B-survival**: fully survives. It is one-shot offline text generation; llama3.1:8b at temp 0 produces comparable step lists. The paper itself never executes these plans (p4: "For our current agent implementation, we do not use detailed Guidance") — they only *propose* (p4, citing SayCan [3] and Socratic Models [143]) feeding "each step in the guidance to our learned reward model sequentially so that it becomes a stagewise reward function for a complex multi-stage task." That proposal, transposed to our stack, is: pre-generate the step list once, then let the ledger (not MineCLIP) verify each stage — a staged-subgoal scheme that costs one extra LLM call per task, not per tick.

**P2 — GPT-3 creative-task generation, Sec 2.2 Approach 2, pp4-5.**
- Purpose: expand the creative task pool by brainstorming from seeds.
- Structure verbatim (p4-5): `Here are some example creative tasks in Minecraft: {a few examples}. Let's brainstorm more detailed while reasonable creative tasks in Minecraft.`
- Few-shot: yes — `{a few examples}` filled from manually-authored (216) and YouTube-mined tasks. Exact count of examples not stated ("a few").
- Yield: **302 creative tasks after de-duplication** (p5), with GPT-3 showing "surprisingly proficient understanding of Minecraft terminology."
- Note the two load-bearing words: "**detailed while reasonable**" — the constraint pair that keeps brainstorm output executable. 8B-survival: yes; useful for us as an episode/goal ideation generator for the YouTube pipeline.

**P3 — MineCLIP task prompts (reward-model text, not LLM prompts), pp33, 35-36.**
- The task prompt string doubles as the reward query: `milk a cow`, `hunt a cow`, `shear a sheep`, `hunt a sheep`, template `Combat {monster}` (p36), `find a nether portal`, `find an ocean`, `dig a hole`, `put carpets on the floor` (p36). Reward = P(video ↔ G) against a negative set G⁻ of *other tasks' goal strings* ("milk a cow" vs "hunt a sheep" etc., p33), post-processed `r = max(P_G − 1/N_T, 0)` (DIRECT) or `r_t = P_G,t − P_G,t−1` (DELTA, for static targets — DIRECT makes agents "stare at the object of interest but fail to move closer," p33-34).
- 8B-relevance: none as a reward (needs the RL loop), but see Axis Findings for MineCLIP-as-offline-judge.

There are no other prompts — no system prompts, no agent loop prompts, no dialogue.

## 2. MECHANICS

**Task 5-tuple (Sec 2.1 p4).** Programmatic task `T = (G, 𝒢, I, f_S, f_R)`:
- `G` — English goal, e.g. verbatim *"find material and craft a gold pickaxe"*;
- `𝒢` — natural-language guidance ("helpful hints, recipes, or advice"), GPT-3-generated for a subset (P1 above);
- `I` — initial conditions "of the agent and the world, such as the initial inventory, spawn terrain, and weather";
- `f_S: s_t → {0,1}` — deterministic success function on simulator state;
- `f_R: s_t → ℝ` — optional dense reward, provided "for a small subset" only (hand-crafting is the expensive part — the whole paper exists to replace it).

Creative task = **3-tuple** `T = (G, 𝒢, I)` (Sec 2.2 p4) — success has no code definition; MineCLIP or humans judge.

**Concrete task specs verbatim (Fig A.1, p26)** — YAML, key = task id, two fields:
```yaml
survival_sword_food:
  category: survival
  prompt: survive as long as possible given a sword and some food

harvest_wool_with_shears_and_sheep:
  category: harvest
  prompt: harvest wool from a sheep with shears and a sheep nearby

techtree_from_barehand_to_wooden_sword:
  category: tech-tree
  prompt: find material and craft a wooden sword

combat_zombie_pigman_nether_diamond_armors_diamond_sword_shield:
  category: combat
  prompt: combat a zombie pigman in nether with a diamond sword,
    shield, and a full suite of diamond armors
```
The task id itself encodes `I` (initial equipment + location). 1,581 programmatic tasks are generated by **filling manually written templates** over the **Cartesian product of {target item} × {initial inventory} × {world conditions}**, then "filter out combinations that are impossible (such as farming certain plants in the desert)" (Harvest, p26; Combat same recipe, p26). Four categories (p4): Survival, Harvest, Tech Tree, Combat. This template×Cartesian-product×impossibility-filter recipe is directly reusable as a curriculum generator for our race/bench harness.

**Creative-task mining pipeline (Sec 2.2 p4, C.2 pp26-27).** Three sources totalling 1,560: 216 manual + 1,042 YouTube-mined + 302 GPT-3. YouTube mining is a 3-stage human-in-the-loop funnel:
- Stage 1: search YouTube **playlists** for key phrases `"Minecraft Tutorial"` and `"Minecraft Guide"`; apply the D.1 heuristic filters (p26).
- Stage 2: show a human annotator the **title only** in a CLI; binary accept/reject, "a few seconds on average" (p26).
- Stage 3: Label Studio UI with full video + description; annotator can reject (*Invalid*), adjust start/end timestamps, select the title, or edit/expand the description into the task goal (Fig A.2, p27). Examples mined: *"make an automated mining machine"*, *"grow cactus up to the sky"* (p27).
The design insight: a cheap high-recall pass (title-only, seconds each) before the expensive precise pass.

**Playthrough task (C.4, pp27-28).** Special category: bare-handed fresh world → defeat the Ender Dragon. "Technically a programmatic task" (simulator-checkable) but split out for "sheer difficulty… lots of preparation, exploration, agility, and trial-and-error… extremely long horizon (hundreds of thousands of steps)… one of the moonshot goals" (p28). This is *our* stated end goal; note the horizon count is in 20Hz low-level actions — our verb-level abstraction divides it by ~10³.

**Wiki dump structure (D.2, pp29-30) — for retrieval ingestion.** 6,735 pages scraped with Selenium; every page yields five element types:
- **Screenshot**: full-page render + bounding boxes of every salient element (visual layout preserved);
- **Text**: only from hand-selected HTML tags `p, h1, h2, ul, dl`;
- **Images/Animations**: raw files (JPG/PNG/GIF) + captions; JS animations saved frame-by-frame;
- **Sprites**: micro-icons embedded in text (multimodal tutorials), saved with bounding boxes **located within the text** — i.e., inline item references are recoverable;
- **Tables**: per-cell text + bounding box, **header cells stored separately** "as they carry the semantic meaning of each column"; tables reconstructable from strings+boxes (p30).
Content types visible in Figs A.4/A.5 (pp29-30): villager trade tables (level / item wanted / default quantity / item given / quantity), item-ingredient tables (product / ingredient / exp / description — e.g. iron ingot uses), hostile-mob gallery, biome tables (name / features / description / screenshot), block pages with a standard ToC (Obtaining → Breaking / Natural generation / Crafting / Post-generation; Usage → Crafting ingredient / Smelting ingredient / Fuel), and **"First day" tutorial pages** — objective checklists with inline sprites and sub-steps ("collect at least 5-8 logs… crafting table, followed by 4 sticks…"). For our pgvector ingestion the highest-value slices are: recipe/trade/mob tables (structured — better as tool-callable lookups than embeddings) and tutorial pages (chunked prose — exactly the register P1's GPT-3 was parroting; retrieving the real thing beats generating it). Hosting: Zenodo DOI `10.5281/zenodo.6640448`; **license CC BY-NC-SA 3.0** (p28/39) — non-commercial, matters if episodes are monetized; the YouTube (`10.5281/zenodo.6641142`) and Reddit (`10.5281/zenodo.6641114`) metadata are CC BY 4.0. Reddit dump (D.3, pp30-31): PRAW, r/Minecraft, posts with score ≥5 and non-NSFW, 4 types (image 65.7% / video 15.8% / text 14.7% / link 3.8%, Fig A.6), comments stored with parent IDs so threads reconstruct; Detoxify (threshold 0.5) filters both Reddit and YouTube (delete if any toxicity category > 0.5, p29). YouTube: 33 years of video / 2.2B transcript words; filters: views < 100, aspect ratio < 1, duration < 1 min, age-restricted (p29); only IDs+metadata released.

## 3. AXIS FINDINGS

**Long-horizon.** (a) The stagewise-reward proposal (p4, quoted in P1) is the paper's only long-horizon mechanism, and it was never implemented — the RL agents were trained on flat single-stage tasks. The concrete transferable: goal → GPT-3 step list → verify each step with an external checker; our ledger is a *better* checker than MineCLIP (exact, free). (b) Playthrough framing (p28): they explicitly rank tech-tree tasks by whether "similar exploration strategies transfer to different tech levels" (p26) — tech-tree tasks are *designed* as a transfer ladder (wood→stone→iron→diamond, p26). (c) Multi-task RL agent (Table 4 p10): fine-tuning the 12-task agent on 4 held-out harder tasks reaches ~5% of the from-scratch sample budget (p10-11) — RL-only, not transportable. (d) A subtle negative result for vision-based success detection on *builds*: MineCLIP F1 vs humans is 97-100 on simple creative tasks (Table 2 p8) but drops to **63.7 (attn) / 37.4 (avg) on "Build a House"** (Table A.5 p38) — construction progress is exactly where a video judge fails; keep build verification code-side (block counts via the executor), which our stack already does.

**Reactivity.** Nothing usable at the deliberation layer. Combat tasks "require fast reflex" (p4) and are solved by 20Hz PPO over an 89-action space (81 camera bins 9×9 yaw×pitch ±60° @15°, 6 movement, use, attack — no-op merged into camera, p37). Two RL-internal notes with no 30s-tick analogue: action-smoothing KL loss over a 3-action window (p37, Eq. 3) because jittery policies fall out of MineCLIP's training distribution (smooth human video); DELTA vs DIRECT reward for static targets (p33-34). The honest reading: MineDojo confirms fast-reflex behavior lives *below* the language layer — supports our executor-side guards (GuardTether etc.) rather than tick-rate heroics.

**Collaboration.** Zero. MineDojo is strictly single-agent — one agent, one task prompt; no multi-agent API, no communication channel anywhere in the paper. (The villager *trade tables* in the wiki dump, p29, are the closest thing: a ready-made price schedule if we ever wire villager-to-villager trading.)

**8B-survival scorecard:** P1/P2 prompts — survive trivially (offline, one-shot). Task-template Cartesian generator — pure engineering, survives. MineCLIP as RL reward — dead (PPO + 8×V100 + 640K video-text pairs, pp32-33). MineCLIP as offline binary success judge (K-means threshold protocol, p37) — inference-only ViT-B/16 + 12-layer text encoder, would run on the consumer GPU, but its weak spot (builds) is our main uncovered verification gap, so marginal value.

## 4. REFERENCES TO CHASE

1. **[67] Kojima et al., "Large Language Models are Zero-Shot Reasoners," arXiv 2205.11916 (NeurIPS 2022)** — source of the exact `Let's think step by step` guidance template; the zero-cost decomposition trick already validated on smaller models; directly applicable to our deliberation prompt for multi-step goals.
2. **[3] Ahn et al., "Do As I Can, Not As I Say" (SayCan), 2022** (no arXiv id printed, p12) — the pattern MineDojo cites for step-by-step guidance grounding: LLM proposes steps, an affordance/value model gates them. Our analogue: LLM proposes, executor+ledger gates. The canonical reference for our close-the-loop design.
3. **[143] Zeng et al., "Socratic Models," arXiv 2204.00598 (2022)** — zero-shot composition of multiple frozen models through language as the exchange medium; relevant to composing our LLM + rule-based verifiers without any training.
4. **[10] Baker et al., "Video PreTraining (VPT)," arXiv 2206.11795 (2022)** — the contrasting approach (behavioral cloning from 70k hrs labeled video, obtains diamond pickaxe); useful as the boundary marker for what *requires* training infrastructure we don't have; also the strongest published low-level Minecraft controller if we ever want a learned executor beneath the verbs.
5. **[48] Guss et al., "MineRL," arXiv 1907.13440 (2019)** — the diamond challenge MineDojo subsumes ("obtain 1 diamond" is one MineDojo task, p4); its human demonstration dataset is the standard long-horizon Minecraft benchmark lineage our race harness implicitly competes with.
6. **[104] Shah et al., "MineRL BASALT," arXiv 2107.01969 (2021)** — learning fuzzy, human-judged tasks from human feedback; the evaluation-protocol prior art for tasks our ledger can't score (creative builds), including human-judgment protocols cheaper than training a judge.
7. **[84] Oh et al., "Self-Imitation Learning," ICML 2018** — only if the LoRA-SFT path activates: MineDojo's biggest RL win (Fig A.8 p35) came from re-training on the agent's *own successful trajectories* with a prioritized buffer (successes uniform, near-misses ≥ μ+2σ return, Algorithm 1 p33) — the same success-filtered-trajectory principle as MINDcraft's SFT result already on our shortlist, and a concrete recipe for what to put in the export: wins plus high-percentile near-misses, not wins alone.