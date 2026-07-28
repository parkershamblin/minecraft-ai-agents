## Findings

### Q1 — Proven SFT recipes: thresholds, format, filtering, generalization

- **500 trajectories is enough to move a 7B on one domain.** FireAct ([2310.05915](https://arxiv.org/abs/2310.05915)): fine-tuning Llama-2-7B on 500 GPT-4-generated ReAct trajectories → **+77% relative HotpotQA EM**; mixing CoT/ReAct/Reflexion formats improved robustness. Explicit finding: few-shot prompting is the weak regime for small models; SFT is where they become agents.
- **~1.9k verified trajectories + general-data mixing gives cross-task generalization.** AgentTuning ([2310.12823](https://arxiv.org/abs/2310.12823)): AgentInstruct = 1,866 success-filtered interaction trajectories over 6 tasks, mixed ~20% agent / 80% general instructions — the mix ratio is load-bearing: pure agent data tanks held-out tasks. AgentLM-70B held-out 0.51→1.40; 7B generalization ≈ GPT-3.5.
- **Format matters more than volume.** Agent-FLAN ([2403.12881](https://arxiv.org/abs/2403.12881)): decompose "format following" from "reasoning," recast ReAct loops as normal multi-turn chat (closer to pretraining distribution), and add **negative samples specifically to suppress tool hallucination** → Llama-2-7B beats prior agent-tuning by 3.5% on held-in AND held-out.
- **Scaling to 50k trajectories keeps paying.** AgentBank ([2410.07706](https://arxiv.org/abs/2410.07706)): 50k+ trajectories, 16 tasks / 5 skill dimensions → Samoyed-7B/13B significantly beat baselines on held-out tasks (EMNLP-F 2024).
- **Verification of training data is the secret ingredient in function calling.** APIGen/xLAM ([2406.18518](https://arxiv.org/abs/2406.18518), [2409.03215](https://arxiv.org/abs/2409.03215)): 60k samples passed through **3-stage verification (format → execution → semantic)**; small xLAM-fc models hit the top of BFCL, beating GPT-4 on tool use. TinyAgent ([2409.00608](https://arxiv.org/abs/2409.00608)): curated function-calling SFT lifted a **1.1B from 12.7%→78.9%** and a **7B from 41.3%→83.1%** success (vs GPT-4-Turbo 79.1%). NexusRaven-V2-13B (CodeLlama-13B base, [GitHub](https://github.com/nexusflowai/NexusRaven-V2)) beats GPT-4 by ~4-7% on nested/composite function calling.
- **Minecraft-specific precedents:** MINDcraft/MineCollab (2504.17950, from our prior sweep): 16k transitions from ~200 successful 70B trajectories → llama3-8b 0.00→0.28. Odyssey ([2407.15325](https://arxiv.org/abs/2407.15325)): LoRA-tuned LLaMA-3-8B on Minecraft-wiki-derived Q&A driving a 220-skill library — an 8B, LoRA, Minecraft, consumer-scale existence proof.

**Synthesis:** full-context transitions (state + history → action) formatted as ordinary chat turns; trajectory-level success filtering (universal — nobody at this scale needed reward weighting); step-level filtering by execution result where available (APIGen); 20-50% general instruct data mixed in; 500-2k trajectories for one domain, 10k+ transitions for solid effect at 8B.

### Q2 — Self-improvement from own rollouts (no bigger teacher)

- **Works at 7B with two preconditions: BC warm start + automatic verifier.** AgentGym/AgentEvol ([2406.04151](https://arxiv.org/abs/2406.04151)): Llama-2-7B, behavior-cloning warm start, then ReST-style explore→filter→train iterations on its own rollouts → **surpasses GPT-4-Turbo and AgentLM-70B on WebShop, ALFWorld, TextCraft**. No bigger teacher in the loop.
- **Failures are also fuel.** ETO ([2403.02502](https://arxiv.org/abs/2403.02502)): Llama-2-7B, SFT warm start, then DPO on contrastive pairs built from its own success-vs-failure trajectories → consistent gains over pure behavioral cloning on WebShop/ScienceWorld/ALFWorld, including unseen tasks.
- **The original STaR ([2203.14465](https://arxiv.org/abs/2203.14465)) bootstrapped a 6B model** — small-model self-filtering is not frontier-dependent when a correctness check exists. ReST-meets-ReAct ([2312.10003](https://arxiv.org/abs/2312.10003)) converged in 2 iterations, but its initial policy was PaLM-2-L — frontier-dependent cold start, same as MINDcraft's 70B teacher.

**Verdict for us:** the bigger teacher solves only the cold-start (nonzero success rate). Our llama3.1:8b already **wins races** — the cold-start problem does not exist. Ledger win/DNF labels are the verifier. STaR-style filtering on our own rollouts survives 8B local; ETO-style DPO from win-vs-DNF pairs is the iteration-2 upgrade.

### Q3 — Constrained decoding: downstream effect at small scale

- The scary result — "Let Me Speak Freely" ([2408.02442](https://arxiv.org/abs/2408.02442)), format restriction degrades reasoning — **does not hold up under controlled replication**. dottxt's rebuttal ([Say What You Mean](https://blog.dottxt.ai/say-what-you-mean.html)), **Llama-3-8B-Instruct, identical prompts**: structured beat unstructured on all three tasks — GSM8K 0.78 vs 0.77, Last Letter 0.77 vs 0.73, Shuffled Objects 0.44 vs 0.41. The original paper's deltas came from mismatched prompts and an AI-parser advantage for free-form.
- JSONSchemaBench ([2501.10868](https://arxiv.org/abs/2501.10868)): 10k real-world schemas across Guidance/Outlines/llama.cpp/XGrammar/OpenAI/Gemini — constrained decoding delivers compliance without quality loss, but framework coverage/efficiency varies widely (llama.cpp-lineage grammars, i.e. what Ollama uses, are mid-pack on coverage).
- Caveat: Grammar-Aligned Decoding (2405.21047) shows naive grammar-constrained greedy decoding can warp the distribution at token boundaries. Practical rule: **constrain the envelope, not the thinking** — free-text `reason` field first, then enum-constrained `action` verb, then loosely-typed params.

**For us:** keep Ollama JSON-schema mode on; at 8B the measured effect on task success is neutral-to-positive and it eliminates the schema-violation death mode we saw with lfm2.5. Ordering thought-before-action inside the schema is the free win.

### Q4 — Prompting patterns for small models in ~8k ctx

- **Plan-then-ground modularization beats monolithic ReAct at 7B.** Lumos ([2311.05657](https://arxiv.org/abs/2311.05657), ACL 2024): separate planning (tool-agnostic subgoals) and grounding (low-level actions) modules, unified data format, 7B — beats GPT-4/3.5-based agents on complex QA/web tasks and larger open agents. But note: it's a *training* recipe; pure prompting versions of plan-then-act are weak at 8B.
- **First-thought prefix + self-consistent action generation.** Agent distillation ([2505.17612](https://arxiv.org/abs/2505.17612)): forcing a short first-thought before actions improves trajectory quality; sampling several candidate actions and taking the self-consistent/valid one improves small-agent test-time robustness (tension with strict greedy — cheap to do since actions are ~50 tokens).
- **Few-shot exemplar retrieval:** TinyAgent's fine-tuned tool-retrieval (ToolRAG) contributed measurably to its GPT-4-Turbo-beating success rate; generic few-shot in-context exemplars underperform SFT at this scale (FireAct).
- **Greedy is right.** Renze & Guven ([2402.05201](https://arxiv.org/abs/2402.05201), EMNLP-F 2024): temperature 0.0-1.0 makes **no statistically significant difference** to problem-solving accuracy across 9 LLMs; recommendation is 0.0 for reproducibility. No published evidence that sampling beats greedy for single-shot agentic decisions; our own v7 data (means overlapping at temp 0) is consistent.
- State summarization: no clean ablation paper found at 8B; the convergent MINDcraft/MineLand verdict from the prior sweep (structured state > chat history) plus our own num_ctx-insensitivity result (prompts fit in 4096) is the best available evidence — cadence, not context, is our binding constraint.

### Q5 — LoRA practicalities (8B, one RTX 4090)

- QLoRA Llama-3.1-8B fits in **~7-8 GB VRAM** (rank 32, all linear layers, batch 1) — a 24 GB 4090 runs it with headroom for longer sequences ([Unsloth](https://unsloth.ai/blog/llama3-1), [docs](https://unsloth.ai/docs/get-started/fine-tuning-llms-guide/lora-hyperparameters-guide)).
- Standard recipe: **rank 16-32, alpha 2×rank, lr 1e-4-2e-4, 2-3 epochs, all linear projections**; higher ranks give diminishing returns for domain/behavior tuning.
- Budget estimate for our volume: 16k transitions × ~2k tokens ≈ 32M tokens/epoch; effective QLoRA throughput on a 4090 with Unsloth ≈ 2-4k tok/s → **~3-5 GPU-hours/epoch, one overnight run for 2 epochs** (estimate, not a published benchmark; Unsloth's headline "1-2 hours on consumer hardware" is for smaller sets).
- Deployment path exists: Unsloth exports merged GGUF directly, so the tuned model drops into Ollama unchanged.

## Recipe we should run

**Ledger→SFT, self-teacher (candidate 3, upgraded with this evidence):**
1. **Export:** winning races only → per-decision transitions (system prompt + structured state → JSON decision), formatted as plain chat turns (Agent-FLAN). Step-filter: drop decisions whose action returned `ActionFailed` (APIGen-style execution verification — the ledger already stores results).
2. **Volume:** target 10-16k transitions ≈ 100-200 winning races. We have ~40 kept honest wins on record across v3-v7; a few unattended sweep-nights closes the gap. Add hallucination-negatives (Agent-FLAN): synthetic states where the right answer is `idle`/`chat`, and malformed-intent refusals.
3. **Mix:** 30-50% general instruct data (AgentTuning's η) so reflection/chat quality survives.
4. **Train:** QLoRA rank 32, 2 epochs, overnight on the 4090; export GGUF → Ollama.
5. **Eval:** existing race harness A/B, N=5, honesty gates — zero new infra.
6. **Iterate (phase 2):** ETO-style DPO from win-vs-DNF decision pairs in matched states; AgentEvol says 2-3 iterations of explore→filter→retrain keeps climbing without any bigger teacher.

**Expected lift:** at our scale the literature range is +0.28 absolute (MINDcraft, from zero) to +77% relative (FireAct, from working); for an already-winning 8B, the realistic target is faster wins + fewer DNFs/mutes (reliability tail), i.e. sd and DNF-rate, not just mean. **Cost:** $0 API, ~5-15 GPU-hours offline, no contract changes.

## Verdict table

| Technique | Key evidence | Survives 8B-12B local greedy? |
|---|---|---|
| Success-filtered SFT, 500-2k trajectories | FireAct +77% rel; AgentTuning; MINDcraft 0→0.28 | **Yes** — the single best-proven lever |
| General-data mixing (20-50%) | AgentTuning η ablation | **Yes** — mandatory, prevents held-out collapse |
| Format decomposition + hallucination negatives | Agent-FLAN +3.5% | **Yes** — data-side only |
| Execution-verified training data | APIGen/xLAM, TinyAgent 12.7→78.9% | **Yes** — our ledger does it for free |
| Self-improvement from own rollouts | AgentEvol 7B > GPT-4-Turbo; ETO; STaR@6B | **Yes**, given warm start + verifier (we have both) |
| Bigger-teacher distillation | MINDcraft 70B→8B; ReST-meets-ReAct | Works but **not required** for us (cold start already solved) |
| JSON-schema constrained decoding | dottxt: 0.78/0.77/0.44 ≥ unstructured; JSONSchemaBench | **Yes** — neutral-to-positive; constrain envelope, not reasoning |
| Thought-field-before-action in schema | dottxt; 2505.17612 first-thought | **Yes** — free |
| Greedy (temp 0) | 2402.05201: no sig. diff 0.0-1.0 | **Yes** — keep |
| Plan-then-ground modular prompting (untrained) | Lumos is a *trained* recipe | **Partial** — needs SFT to pay off at 7B |
| Self-consistent action sampling | 2505.17612 | Maybe — cheap, but breaks strict greedy determinism |
| RL/PPO-style loops | — | **No** — infra we don't have, not needed per AgentEvol |

Sources: [AgentTuning](https://arxiv.org/abs/2310.12823) · [FireAct](https://arxiv.org/abs/2310.05915) · [Lumos](https://arxiv.org/abs/2311.05657) · [TinyAgent](https://arxiv.org/abs/2409.00608) · [xLAM](https://arxiv.org/abs/2409.03215) · [APIGen](https://arxiv.org/abs/2406.18518) · [NexusRaven-V2](https://github.com/nexusflowai/NexusRaven-V2) · [Agent-FLAN](https://arxiv.org/abs/2403.12881) · [AgentBank](https://arxiv.org/abs/2410.07706) · [AgentGen](https://arxiv.org/abs/2408.00764) · [ETO](https://arxiv.org/abs/2403.02502) · [AgentGym/AgentEvol](https://arxiv.org/abs/2406.04151) · [ReST-meets-ReAct](https://arxiv.org/abs/2312.10003) · [STaR](https://arxiv.org/abs/2203.14465) · [Let Me Speak Freely](https://arxiv.org/abs/2408.02442) · [Say What You Mean](https://blog.dottxt.ai/say-what-you-mean.html) · [JSONSchemaBench](https://arxiv.org/abs/2501.10868) · [Agent distillation](https://arxiv.org/abs/2505.17612) · [Temperature study](https://arxiv.org/abs/2402.05201) · [Odyssey](https://arxiv.org/abs/2407.15325) · [Unsloth Llama-3.1](https://unsloth.ai/blog/llama3-1)