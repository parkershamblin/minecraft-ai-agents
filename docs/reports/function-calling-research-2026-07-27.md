# Function-calling / tool-use research — verdict and what shipped (2026-07-27)

Trigger: mentor advice (Stephen Blum, PubNub CTO) — Voyager prints markdown
code blocks; "the modern approach would be with function calling tool use."
Five-agent research sweep (repo recon + Ollama mechanics + frontier APIs +
small-model evidence + agent-loop patterns), all sources fetched 2026-07-27.

## Bottom line

**The advice is right in spirit, and this stack already implements its
substance.** One grammar-constrained JSON decision per tick IS a forced
function call: OpenAI documents strict function calling and strict structured
outputs as the same constrained-decoding machinery, and Anthropic's own
guidance for many related actions is "group them into a single tool with an
`action` parameter" — which is DECISION_SCHEMA verbatim. What the research
changed is not the architecture but three schema-level facts we were getting
wrong or leaving unfixed — all shipped today (below).

**Switching the decision channel to Ollama's literal `tools` API would be a
reliability REGRESSION on our hardware.** The load-bearing facts:

1. **Ollama tool calls are not grammar-constrained.** `format` (what we use)
   compiles the JSON schema to a decode-time grammar; `tools` renders
   definitions into the chat template, the model free-generates, and a
   server-side parser scrapes tool calls back out (grammar enforcement was
   requested in ollama#6002 and never shipped; 2026 changelogs still fix
   parser bugs). Malformed/hallucinated args and calls-that-land-in-content
   are documented failure modes.
2. **No `tool_choice` in Ollama** (native or /v1) — cannot force
   exactly-one-call-per-tick; a plain-text non-answer becomes a new failure
   branch we don't have today.
3. **gemma3:12b has no tool template** (Google: prompt-based only;
   ollama#9941 open) — passing `tools` 400s. Adopting native FC forks the
   model roster mid-benchmark. gemma4 DOES have native FC tokens (first
   Gemma with them); llama3.1 has a template but vLLM's docs state small
   llamas "frequently fail to emit tool calls in the correct format."
4. **`tools` + `format` together = documented "tool suppression"** (arXiv
   2606.25605): the grammar masks tool-call tokens; the model silently stops
   calling tools. The obvious hybrid is a trap.
5. **8B evidence favors what we run**: dottxt's rebuttal of "Let Me Speak
   Freely" measured structured ≥ unstructured on Llama-3-8B on every task;
   the 2026 synthesis ("Capacity, Not Format", 2606.09410) is "reason free,
   constrain late" — recover quality by putting free reasoning BEFORE the
   constrained fields. No published Minecraft agent ships native FC as its
   action channel; mindcraft (community successor) uses a !command DSL + SFT
   (Andy models), Odyssey uses a fixed skill library + trusted executor —
   both converge on our architecture.

## The pasted "Voyager rebuilt with modern tool use" plan, point by point

1. **`execute_mineflayer_script` tool / CFG raw-JS output** — does not
   survive here, three independent kills: Voyager's own ablation (GPT-3.5
   codegen = 5.7x fewer items; "open-source LLMs cannot provide"), our
   trusted-executor stance (LLM-authored JS on the shared minecraft-service
   event loop is the exact starvation failure profiled in M2-2), and OpenAI
   Custom Tools + CFG being a frontier-API feature Ollama doesn't have.
2. **Standardized tool_result feedback roles** — transfers as PATTERN, and
   we already run its equivalent: ActionCompleted/ActionFailed percepts
   paired with the last decision in the next prompt, plus today's
   abandon-and-repropose failure streaks. A literal multi-turn tool_result
   loop within a tick doesn't fit the GPU: at 20 villagers there are ZERO
   spare round-trips (30s tick / ~1.6s p50 × 20 = the whole budget); at 6,
   at most one. If ever added: fixed two-phase tick (one observation call,
   one forced decision), never an open loop.
3. **Dynamic tool loading / tool_search for the skill library** — the
   concept transfers as pgvector retrieval (shortlist candidate 4: verb-plan
   skill library, ledger-verified before commit); the API feature is
   OpenAI-platform-only. Same idea, local seam.
4. **Tool-per-primitive + strict mode replacing prompt documentation** —
   half transfers. Strict grammar enforcement: we already have it via
   `format` (stronger than Ollama `tools` would give us). But the prompt
   documentation CANNOT go away on our stack: Ollama's grammar ignores
   schema `description` fields — the model never sees them — so the system
   prompt's verb documentation stays load-bearing. Also: ~8 tool defs cost
   ~800–2,000 prompt tokens on frontier APIs; our single consolidated schema
   costs zero prompt tokens (grammar is server-side).
5. **"Executes like Claude Code"** — the loop shape Claude Code uses is
   open-ended multi-turn tool calling with turn caps, which Anthropic's own
   taxonomy contrasts with "workflows … predictability and consistency for
   well-defined tasks." A 30s-tick embodied fleet on one GPU is the workflow
   quadrant; OpenAI's Agents SDK even ships `stop_on_first_tool` +
   forced tool_choice to collapse the loop to exactly our shape.

## What shipped (branch `feedback-loop-close`)

1. **reasoning first in DECISION_SCHEMA.** Grammar-constrained decode emits
   keys in schema order; `action`/`params` sat BEFORE `reasoning`, so
   villagers committed to the action then rationalized. Evidence: brief
   CoT-before-pick cut wrong-function selection 30.5%→1.5% (arXiv
   2604.02155); reasoning-first is the "reason free, constrain late" fix.
   Guarded by a test — reordering is a behavior change, not a cleanup.
2. **`params` union in the provider-facing schema.** New
   `decision_schema()` (contract.py) tightens free-form `params` to an anyOf
   of the REAL per-verb shapes from ActionRequested.v1 ($refs inlined,
   idle = empty object). The decode grammar can no longer produce params no
   verb accepts; action↔params pairing stays validate_decision's job.
3. **`decision_schema(strict=True)` for the OpenAI path** — repays the
   debt-register item "OpenAI params reshape before any OpenAI run"
   (free-form `params` 400'd under strict mode since M1-3). Mechanical
   recursive transform: every object closed, every property required,
   previously-optional properties nullable (enums gain null), annotation
   `default` stripped; `_normalize_params` already strips explicit nulls so
   decode-side null and wire-side absence agree. **Reshaped, NOT yet
   verified against the live OpenAI API** — one-call smoke required before
   any filming run (residual risk: keyword support for minimum/maximum in
   current strict mode unverified).
4. **Live smoke (llama3.1:8b, temp 0, Ollama 0.32.4):** grammar accepted the
   union; output emitted reasoning-first; clean `gather wood count 8`
   decision through validate_decision. Ollama 0.32.4 postdates the
   `think:false`+`format` silent-bypass bug class (#15260, hit 0.20.0) — but
   pin this check into any Ollama upgrade: that bug silently removed grammar
   enforcement for thinking-capable models, which is our gemma4/qwen path.

Tests: agent-service 234 green (6 new in test_decision_schema.py).

## Benchmark note (do not skip)

The decode grammar changed for EVERY Ollama run — reasoning-first ordering +
params union plausibly shift model behavior (that's the point). The v7 model
table was benched under the old schema: any future race comparison against
v7 numbers needs a configVersion bump, and this batches naturally with the
far-target gate + failure streaks already on this branch (the owner's
"batch executor fixes behind one bump" note applies).

## Deferred options, in order of evidence

- **gemma4-only native-FC A/B**: gemma4 has real FC tokens + a July 2026
  Ollama reliability patch. Only worth it if gemma4's malformed-decision
  rate in the ledger is measurably worse than llama's. Splits the harness;
  low priority.
- **Query/observation verbs** (pull perception, MINDcraft-style): fits as
  1 bounded extra call at ≤6 villagers, never at 20. Pair with a hard
  two-phase tick if ever built.
- **Enum-tightening pass over params** (e.g. item ids beyond CraftParams):
  wrong-valid-VALUE is the failure class grammars only catch when the value
  space is closed. Largely done already; revisit when verbs widen.

## Load-bearing sources

Ollama: ollama.com/blog/structured-outputs · ollama.com/blog/streaming-tool ·
github.com/ollama/ollama issues #6002, #9941, #15260 · docs.ollama.com/openai
(tool_choice unsupported). Frontier: developers.openai.com function-calling +
structured-outputs guides · platform.claude.com define-tools /
strict-tool-use ("group them into a single tool with an action parameter";
tool_choice any + strict) · anthropic.com/engineering/writing-tools-for-agents.
Evidence: blog.dottxt.ai/say-what-you-mean.html (Llama-3-8B) · arXiv
2604.02155 (brief-CoT ordering) · 2606.09410 (Capacity, Not Format) ·
2606.25605 (tool suppression) · 2605.26128 (Constraint Tax, sub-3B) ·
docs.vllm.ai tool_calling (small-llama format failures) ·
github.com/kolbytn/mindcraft (Andy SFT lineage) · arXiv 2407.15325 (Odyssey).
Full agent reports: workflow wf_35f6f7e5-dae journal (session-local).
