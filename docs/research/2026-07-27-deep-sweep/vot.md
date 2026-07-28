# Mind's Eye of LLMs (VoT) — second-pass extraction

Wu, Mao, Zhang, Xia, Dong, Cui, Wei (Microsoft Research). 34 pp. All experiments **zero-shot, temperature 0, top_p 1** (p5, §4.1) — the entire paper is run in our decoding regime, so its numbers transfer to greedy local stacks without a temperature caveat.

---

## 1. PROMPTS (all verbatim)

**The four setting prompts (p6, §4.1)** — one sentence each, appended after task instruction + input parameters; this suffix IS the entire intervention:

- **GPT-4 CoT:** `Let's think step by step.`
- **GPT-4 w/o Viz:** `Don't use visualization. Let's think step by step.`
- **GPT-4V CoT:** `Let's think step by step.` (+ counterpart image input)
- **GPT-4 VoT:** `Visualize the state after each reasoning step.`

Zero few-shot examples anywhere. Structured input template = "task instruction, input parameters and prompt of specific setting" in that order (p16, §B). Answers extracted by sub-string pattern matching; exact match for MCQ (p6, §4.3).

**Route Planning instruction (Fig 6, p17):**
> "Navigation Task: for a provided map, 🏠 is the home as starting point, 🏢 is the office as the destination. ⬜ means the road, 🚧 means the obstacle. There exists one and only one viable route for each map. Each step you choose a direction and move to the end of the continuous road or the destination.
> map:
> [emoji grid]
> Starting from 🏠, provide the steps to navigate to 🏢.
> Visualize the state after each reasoning step."

Two load-bearing phrases: **"There exists one and only one viable route"** (a hard invariant the model can self-check against — see self-refine below) and **"move to the end of the continuous road"** — moves are *macro-actions* (corridor-to-corner), not per-cell steps. This collapses a long grid path into ~6 decisions. Directly reusable idea for our villagers: define verbs at corridor/landmark granularity, not block granularity.

**Next Step Prediction (Fig 6, p17):** same header + map, then:
> "Starting from 🏠, to navigate to 🏢, you made following movements:
> 1. Move right to the end of continuous road.
> 2. Move down to the end of continuous road.
> 3. Move left to the end of continuous road.
> What's the direction of next movement?
> A. Up  B. Left  C. Down  D. Right
> Visualize the state after each reasoning step."

History-of-moves-then-predict-next is structurally identical to a villager tick prompt (action history → next intent).

**Visual Tiling (Fig 7, p17):**
> "Task: given a set of polyominoes and corresponding variations of each polyomino, fit them into the empty squares (⬜) in the target rectangle without overlapping any existing polyominoes or going outside the rectangle. The variations allow only translation, not rotation or reflection. It's guaranteed that there always exists a solution."

Then `------------------------`-separated sections: `Target rectangle with 12 empty squares:` [grid] / `Provided polyominoes:` numbered list with inline emoji swatches (`1. Tetromino I (🟥)`) / per-piece `Variations for Tetromino X:` with `Variation N fitting into its bounding box:` mini-grids / MCQ (`A. 2  B. 3  C. Neither`) / VoT suffix. **"It's guaranteed that there always exists a solution"** is the phrase that later powers self-correction (Fig 17).

**NL Navigation prompt (pp17–19, §B.2, verbatim opening):**
> "You have been given a 3 by 3 square grid. Starting from a vertex, you will move along the edges of the grid. Initially, you are positioned at the bottom-left corner of the grid, where you will find a torch, then you go right, where you will find an infant bed, … Now you have all the information on the map. You start at the position where the torch is located, then you go right by one step, … What will you find?"

No grid given — pure prose; the model must *invent* its own map representation.

**Prompt-sensitivity variants tested (the wording IS the finding):**
- Appendix C, p19: "when GPT-4 is prompted with **'use ascii-art to visualize'**, the complete tracking rate increases to **98.5% (+78.5%)**, boosting task performance to 62.5% (+3.5%)" (NL navigation task). Limitations (p10) restates: prompting "use ascii-art" significantly increases tracking; that's the only alternative phrasing tested — no larger phrasing grid exists in the paper.
- Fig 8b, p18: deleting the single word **"reasoning"** ("Visualize the state after each ~~reasoning~~ step") makes GPT-4 emit the answer first and paint visualizations *after* it, unconditioned — tracking rate and accuracy drop. The word "reasoning" is what forces interleaving.

---

## 2. MECHANICS

### Grid serialization — INPUT (the part we care most about)

- **Pure emoji glyph runs. No coordinates, no row/column labels, no cell separators.** One row of the map = one line of emojis; the block sits after `map:` inside fences. Cell vocabulary: 🏠 start, 🏢 destination, ⬜ walkable, 🚧 obstacle (nav); 🟥🟩🟦🟨🟪 colored pieces + ⬜ empty (tiling). The legend is *inline prose with the emoji embedded in the sentence* ("⬜ means the road, 🚧 means the obstacle") — semantics are declared once, never per-cell.
- Maps up to 7×9 / 9×7 (p6); tiling rectangle 5×4. Generation (Alg 1, p15): semi-Eulerian graph of k alternating horizontal/vertical edges; path cells → ⬜, everything untouched → 🚧, bounding box normalized to the square grid. Distances stretched recursively to prevent path overlap.
- **Why emoji, explicitly:** §A.3 p16 — the visual dataset is made by "drawing text onto an image… we adopt color emojis for a fair comparison as they're more visual friendly to a multimodal model." Emoji-in / emoji-out was chosen for GPT-4V parity, *not* because it's optimal for text models — the +78.5% ascii-art result says single-width ASCII may track better. For our code-rendered local-map percept: prefer 1-char ASCII cells with an inline prose legend; keep the no-coordinates, one-line-per-row shape; state movement semantics as macro-actions.

### Grid serialization — OUTPUT (model-produced)

- Visual nav (Figs 12–13, pp23–24): full map re-rendered in a fenced block after every move; current position/trail marked with 🚶 walking-person emoji. Rigid alternation: `Step n: Move <dir> to the end of the continuous road.` → grid → next step. Final answer = numbered direction list ("1. Right / 2. Down / … We have now reached the destination").
- Spontaneous format diversity (Fig 10 p22, §E.1 p21) — "nearly 30 different symbols": mark-the-path (repeat one symbol), **arrows ⬅⬆⬇➡ encoding position AND heading simultaneously**, round pin 📍, ✅ checklist column, numbered boxes 1️⃣–5️⃣ for *temporal* steps, and "remove road" (converting traversed ⬜ to 🚧 to prevent backtracking — the model invents tabu-marking).
- NL nav output (Fig 15, pp27–29): the model *chooses* an ASCII table — `+---+---+---+` borders, `|` separators, one-letter landmark abbreviations, a bullet legend ("T = Cassette player…"), current position marked `*W*` with asterisks. Re-prints the full 3×3 table after every single step.
- 3D (Fig 11, p23): ASCII cube with vertices labeled 0–7, unfolded face-by-face correctly.

### Trace structure (pp23–26, 30–34)

Strict interleave: NL step sentence → fenced grid of resulting state → repeat; verdict sentence + option letter last. Tiling connective tissue verbatim: "After placing Tetromino T (🟪), the target rectangle looks like this:". Fig 8a (p18) contrasts: CoT does all verbal reasoning first and paints one decorative grid *after* the answer (track rate 57.4% vs VoT 87.1% on tiling).

### Quantified mechanics

- Tracking metrics (§5.1 p7): Complete = one viz per reasoning step; Partial = ≥1 viz before answer. VoT complete: route 86.2%, next-step 92.9%, tiling 87.1%, NL-nav 20% (partial 80.5%). CoT complete on route planning: **1.2%**. "LLMs inherently exhibit the capability of visual state tracking when spatiotemporal simulation is integral to reasoning" (p7, bold in original).
- Table 2 (p8): the pipeline's weak stage is *drawing*, not *reading*: visualization compliance ~51–52%, visualization accuracy only 24–26%, but "**LLMs are able to make correct decisions in 65%-77% of the cases when accurate internal state visualizations are generated**." I.e., if a *correct* map is in context, even GPT-4 acts correctly only ~2/3–3/4 of the time — and generating the correct map is the bottleneck. Strong argument for our plan: render the map code-side (100% accurate by construction) and spend the LLM only on the 65–77% decision stage.

---

## 3. AXIS FINDINGS beyond the first pass

- **8B verdict, full row (Table 3, p9):** LLAMA3-8B CoT→VoT: route completing 4.65→4.97, success 0→0.2, next-step 28.73→**26.75 (regresses)**, tiling 47.24→46.73, NL-nav 16.50→15.50. Every VoT delta at 8B is noise or negative; 70B is the smallest model where VoT wins significantly (route succ 2.62→5.85, next-step 49.01→54.09, NL-nav 26.00→32.50). GPT-3.5 is mixed (tiling +3.9, next-step −4.3). Asking our 8–12B models to paint their own maps is confirmed dead; *feeding* them maps is untested here (input-side maps are present in all conditions — the paper never ablates map-in-context vs none for small models).
- **Difficulty scaling (Fig 9 + Table 6, p20; §D p19):** GPT-4/70B degrade smoothly with map size k (75→45%, 62→47%); **LLAMA3-8B is flat ~25–33% = 4-way random guessing at every k ≥ 3**, with one exception: VoT lifts 8B to ~50% at k=2 only. "VoT might be advantageous… in simpler spatial reasoning tasks, potentially compensating for the inherent weaknesses of smaller language models" (p20). For us: if we ever use in-context maps at 8B, keep them tiny (local 5×5-ish crops), never base-scale.
- **When NOT to visualize (§5.2 end, p8):** ring navigation reduces to modular arithmetic ("(15 − 3) % 12"); there GPT-4 CoT beats VoT **52.5% vs 49.5%**. "VoT prompting might underperform in those tasks where LLMs can leverage logical reasoning without visualizing internal states." Distance/direction questions our executor can answer numerically should stay numeric in the prompt, not map-rendered.
- **Invariant-triggered self-refine (§E.3 p21, Fig 17 pp32–34):** GPT-4 concludes "C. Neither", then — verbatim, highlighted in the trace — "However, **there seems to be a mistake because the task guarantees that there always exists a solution**. Let's re-evaluate…", retries, and gets it right. The stated hard invariant in the prompt functioned as a free self-verification hook. Cheap, model-agnostic, worth testing at 8B: phrase villager goal sections with checkable invariants ("the ledger confirms you hold 0 iron — a plan assuming iron is invalid").
- **Long-horizon collapse even at GPT-4 (Table 1, p7):** route planning success 14.72% (VoT, best) vs next-step 63.94% — the same model is 4× better at *one step given history* than at emitting the whole plan. Supports our tick architecture (one intent per tick, executor owns the path) over plan-emission.
- **Emergence conjecture (Appendix C, p19):** tracking ability plausibly comes from ascii-art in code comments during pretraining — "interleaved ascii diagrams, natural language and programming language" (cites Rust deque, emacs undo docs). If we ship a map percept, formatting it like a code-comment ascii diagram (fenced, monospace, terse) targets the distribution the ability was learned from.

---

## 4. REFERENCES TO CHASE

1. **[MHV+24] Momennejad et al., "Evaluating Cognitive Maps and Planning in LLMs with CogEval,"** arXiv:2309.15129 (2024) — systematic planning eval showing LLMs hallucinate paths/fall into loops on graph tasks; the negative baseline for our long-horizon axis and a source of failure taxonomies to detect in the ledger.
2. **[LWG+22] Liu et al., "Mind's Eye: Grounded Language Model Reasoning through Simulation"** (2022) — run a physics simulator, inject its results into the prompt; reasoning done by code, language done by LLM. The published ancestor of our "spatial truth stays code-side" doctrine; survives small models by construction.
3. **[HGM+23] Hao et al., "Reasoning with Language Model is Planning with World Model"** (RAP, 2023) — LLM-as-world-model + MCTS. Frontier/search-infrastructure-dependent; read for the state-action formalism, not for deployment at 8B.
4. **[YBL+23] Yamada et al., "Evaluating Spatial Understanding of Large Language Models"** (2023) — source of the NL-navigation task and the square/ring structure variants; the ring→modular-arithmetic reduction (where CoT beat VoT) comes from its task family.
5. **[MXF+23] Mirchandani et al., "Large Language Models as General Pattern Machines"** (2023) — LLMs as zero-shot sequence transformers over ASCII/grid tokens; closest prior art on *input-side* grid serialization choices.
6. **[YIL23] Yang, Ishay, Lee, "Coupling LLMs with Logic Programming"** (2023) — LLM converts spatial language to logic forms, solver reasons. Same offload pattern as our executor; relevant if we add a code-side spatial QA tool.
7. **[GT23] Gurnee & Tegmark, "Language Models Represent Space and Time"** (2023) — linear internal spatial representations; background only, no engineering payload for us.

**Bottom line vs north star:** VoT itself is dead at our model class (their own Table 3), but three transferables survive 8B greedy for free: (a) the input map format — legend-in-prose, unlabeled glyph rows, ASCII over emoji per the +78.5% phrasing result, kept tiny per the k=2 finding; (b) macro-action verb semantics ("move to the end of the continuous road") to shrink decision horizons; (c) checkable invariants stated in the prompt as self-refine hooks. The 65–77%-decision vs 24–26%-drawing split (Table 2, p8) is the quantitative case for rendering the map percept in code and never asking the model to maintain it.