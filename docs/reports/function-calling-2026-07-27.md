# Function calling / tool use — re-verified verdict and what shipped (2026-07-27)

Trigger: mentor advice (Stephen Blum, PubNub CTO) — Voyager scrapes markdown
code blocks; "the modern approach would be with function calling tool use."
Owner re-raised the advice with the full conversation transcript (including
RSG speedrun architecture) and chose the implementation path explicitly:
**native strict tool calling at the frontier-provider seam; the local Ollama
grammar channel stays.** This report replaces the discarded first-pass
verdict (recoverable at commit `5f738d6`); every load-bearing claim was
re-verified by a fresh 5-lane workflow against 2026-07-27 primary sources,
including live probes on this box's Ollama install.

## The decision channel, per provider (as shipped)

| Provider | Channel | Mechanism |
|---|---|---|
| Ollama (llama3.1:8b, gemma3:12b, gemma4) | grammar-constrained JSON via `format` | UNCHANGED — `DECISION_SCHEMA` byte-identical, no decode-grammar change, no benchmark configVersion churn (test-pinned in `test_tool_schema.py`) |
| OpenAI | single FORCED strict function tool `decide` | `tools` + `tool_choice` pinned + `strict: true` + `parallel_tool_calls: false`; arguments JSON feeds the unchanged `validate_decision` path |
| Anthropic (NEW provider) | single FORCED strict tool `decide` | Messages API, `tool_choice {type: tool, disable_parallel_tool_use}`, `strict: true` (GA, no beta), thinking disabled, NO sampling params (removed on current Claude models) |

One `decision_tool_schema()` (contract.py) serves both frontier providers:
reasoning first (brief-CoT-before-pick cut wrong-function selection
30.5%→1.5%, arXiv 2604.02155), `params` as an anyOf union of the real
ActionRequested $defs (refs inlined, idle = closed empty object), objects
closed with required-nullable properties, constraint keywords stripped for
the wire (bounds stay enforced post-parse by `validate_decision`).

## Re-verification results (workflow wf_313f6c1d, 5 lanes, 2026-07-27)

**Ollama — do-not-migrate CONFIRMED on every claim, as of v0.32.5
(released 2026-07-27):**
- Tool calls are template-rendered and server-side text-parsed, not
  grammar-constrained. ollama#6002 is cosmetically closed "completed" but
  the maintainer comment defers grammar tools past the new engine — and
  current main's `tools/tools.go` is a streaming TEXT parser (state machine
  scanning for template tags). 2026 parser bugfixes (v0.30.12 brace
  handling, #15241/#15254 gemma4 malformed JSON) are impossible under
  grammar decode.
- No `tool_choice` on either API surface (native lacks the parameter; /v1
  docs list it unsupported). Live probe: `tool_choice: "required"` silently
  accepted with ZERO effect.
- gemma3 still toolless (#9941 open; live probe: hard 400 "does not support
  tools"). gemma4 DOES declare tools capability now — but its parser history
  is bumpy and **#15539: gemma4 tools parsing fails under system prompt +
  think:false + tools — exactly this stack's configuration.**
- tools+format together = tool suppression, reproduced LIVE on this box:
  tool_calls vanish, JSON lands in content (#8095; arXiv 2606.25605
  "Constraint Tax" formalizes the grammar-token-mask mechanism).
- **Live probe key result:** llama3.1:8b under native tools emitted 3/3
  schema-valid calls — but decisions were THINNER than the format path
  (params always `{}`, terse fragment reasoning) while the format-grammar
  control emitted full params and sentence reasoning, keys in schema order.
  Same model, same prompt: the grammar channel produces better decisions.

**OpenAI — one stale belief corrected:** strict function calling and strict
structured outputs are officially the same constrained-decoding machinery
(docs verbatim), and since ~May 2025 strict mode DOES support numeric
bounds, pattern/format, anyOf, $defs/$ref — the old "no minimum/maximum"
rule is Azure-mirror staleness. parallel_tool_calls×strict incompatibility
is obsolete. Responses API is now the recommended surface (flat tool shape,
`allowed_tools`, Agents SDK `stop_on_first_tool` = exactly our one-shot
shape); our provider stays on chat/completions for now — a Responses port
is mechanical when wanted. Docs moved: platform.openai.com →
developers.openai.com.

**Anthropic:** strict tool use is GA (no beta header); "consolidate related
operations into one tool with an action parameter" is still verbatim
official guidance — DECISION_SCHEMA is that pattern. Adaptive thinking now
supports forced tool use; manual-enabled thinking still rejects it. We send
`thinking: {type: "disabled"}` (accepted on Sonnet/Opus at effort ≤ high;
claude-fable-5 rejects it — configured default is `claude-sonnet-5`, the
high-volume tier for a 30s-tick fleet). Sampling params are REMOVED on
current Claude models — the provider sends no temperature, so Anthropic
decisions are not greedy-reproducible (flagged for any future bench use).
Key-emission order inside strict tool input is NOT documented — reasoning-
first is best-effort there, load-bearing only on the Ollama grammar path.

**Adversarial refute lane:** 6/7 claims survived attack with primary
sources; the 7th ("no published Minecraft agent ships native FC as its
action channel") is eroding — mindcraft has an open native-tool-calling PR
(#769) and mindcraft-ce ships experimental structured tool calls on a
non-default branch. Direction of travel noted; changes nothing today.

## What Stephen's points map to now

1. Structured execution instead of markdown scraping — DONE everywhere
   (grammar on Ollama since M1; native forced strict tools on frontier as
   of this commit).
2. Standardized feedback roles — the tick loop equivalent is
   ActionCompleted/ActionFailed percepts paired with the last decision +
   the CHANGE COURSE failure streaks; a literal multi-turn tool_result loop
   doesn't fit a 30s tick on one GPU (zero spare round-trips at 20
   villagers).
3. Dynamic tool loading / tool_search — maps to the verb-plan skill library
   candidate (pgvector retrieval); OpenAI `defer_loading`/tool-search and
   Anthropic mid-conversation `tool_addition` are the frontier-side
   mechanisms if the verb set ever outgrows one schema.
4. Strict mode replacing prose-begging — DONE (this commit for tools;
   grammar before). The system-prompt verb documentation stays load-bearing
   on Ollama, whose grammar ignores schema descriptions.
5. Structured outputs for curriculum/critic — critic is rule-based via the
   ledger (better than an LLM critic); curriculum remains a shortlist
   candidate with a trusted-code validity filter.
6. Parallel sensory tools — inverted here: percepts are pushed each tick
   (cheaper on a fixed cadence); MINDcraft-style query verbs are the pull
   option if context pressure grows.
7. Prompt caching — Anthropic: tools→system→messages prefix order; our
   stable system prompt + tools block is cache-friendly by construction
   (worth adding cache_control when an Anthropic filming run is real).
   Ollama keeps its own KV cache.

RSG-specific advice (stage-gated namespaces, planner/reflex split,
deterministic triangulation, ledger-as-tool-history, one-cycle macro) is
saved to agent memory; the ledger and reflex split are already this
architecture, the rest belongs to a future beat-the-game arc.

## Open items

- **Live smoke both frontier providers before any filming run** — no API
  keys on this box today; one forced-call smoke each catches strict-schema
  400s. Residual risks: Anthropic's exact strict-keyword tolerance for our
  stripped schema; OpenAI accepting the anyOf params union (their docs say
  yes; unverified live).
- Anthropic path has no prompt-cache markers yet (`cache_control` on the
  tools/system prefix) — add when usage is real, it's a pure cost knob.
- OpenAI Responses API port — mechanical, brings `allowed_tools` and
  stop_on_first_tool ergonomics; not needed for correctness.
- Ollama upgrade rule stands: after ANY bump, re-verify the
  think:false+format interaction (#15260 class) and now also the gemma4
  tools-parser class (#15539) if anything ever touches tools there.

## Sources

Full per-lane findings with URLs: workflow `wf_313f6c1d-fdd` journal
(session-local). Headline primaries: github.com/ollama/ollama #6002 #8095
#8155 #9941 #15241 #15260 #15539 + releases v0.30.12–v0.32.5 +
`tools/tools.go`; docs.ollama.com api/chat + openai-compatibility;
developers.openai.com function-calling + structured-outputs guides +
changelog 2025-05-20; platform.claude.com define-tools / strict tool use /
tool-use overview; arXiv 2606.25605, 2604.02155, 2606.09410; dottxt
"Say What You Mean"; live probes on Ollama 0.32.4 (this box, all three race
models).
