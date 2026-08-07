# Skill tool-schema layer — what the LLM sees

Status: **PARTIALLY IMPLEMENTED** (`configVersion` 8). The wiring PR landed
§3's failure vocabulary, §4's params rules R1–R9 plus the importance/sentiment
rider, §5's first three verbs, and all of §6's debt — one atomic contract PR,
one bump, as §5 requires. Still design-only: §2's staged namespaces (every
verb ships in `overworld`, and the `GamePhase` ratchet has no milestones to
read until the nether arc exists) and §7's UCB-ranked retrieval (the exposed
set is small enough that the ≈30 cap does not bind yet, so `policy.ts` still
feeds nothing). What shipped is recorded per section below.

This doc remains "the part nobody hands us"
(`docs/CONTEXT-agent-brief.md:118–121`): vendored plugins and ported Voyager
skills give us mechanism, but the parameter types, the enums, the failure
vocabulary the model reads to decide what to do next, and the choice of which
skills the model sees at all — that layer has to be designed against *this*
stack's three decision channels and *this* stack's measured failure corpus.

Related docs: `09-survival-plan.md` (reflex layer origins),
`10-red-vs-blue.md` (the one-additive-commit contract-surface house rule),
`docs/reports/function-calling-2026-07-27.md` (provider-seam verdicts this
design is constrained by), `docs/CONTEXT-agent-brief.md` (ranked direction;
frozen platform).

## 0. Constraints this design cannot negotiate with

Three decision channels exist and all three must accept the same logical
contract (`docs/reports/function-calling-2026-07-27.md`, "The decision
channel, per provider"):

| Channel | Mechanism | What it enforces | What it ignores |
|---|---|---|---|
| Ollama (llama3.1:8b, gemma3:12b, gemma4) | `format:` decode grammar over `DECISION_SCHEMA` (contract.py:30) | types, enums, required keys, key order | numeric bounds (measured — the 92.2% corpus class below), `description` text, `default` |
| OpenAI | one forced strict tool `decide` from `decision_tool_schema()` (contract.py:407) | closed objects, required-nullable, enums; bounds/anyOf/$refs supported since ~May 2025 | — (we strip bounds anyway, see §4) |
| Anthropic | same forced strict tool | closed objects, enums; **rejects** type-array+enum nullables (live 400, 2026-07-27) and constraint keywords | — |

Hard rules that follow:

- **The Ollama grammar is test-pinned byte-identical**
  (`services/agent-service/tests/test_tool_schema.py`); any change to what the
  local models decode against is a benchmark `configVersion` bump, and the
  owner's standing rule is to **batch such changes behind one bump** (CLAUDE.md,
  "Decision worth making"). Everything in this doc is therefore designed to
  ship as ONE atomic contract PR (§5).
- **One schema serves both frontier providers.** `_strictify`
  (contract.py:367–403) closes every object, makes every property
  required-nullable, rewrites nullable enums as `anyOf(enum, null)`
  (contract.py:381–387 — Anthropic strict 400s on a type array paired with
  enum members), and strips the twelve `_STRICT_UNSUPPORTED_KEYWORDS`
  (contract.py:328–343). New skill schemas must survive that transform
  losslessly, which is a design constraint on how we express bounds (§4).
- **The measured failure corpus points at bounds, not verbs.** Of 25,690
  decisions in the committed bench windows, 3,351 were malformed (13.0%) and
  **92.2% of those are numeric-bounds violations** — values the decode grammar
  cannot constrain, caught only post-parse; there were **zero invalid verbs
  ever** (`demos/failure-taxonomy-corpus/metrics.json`). Enum selection is a
  solved problem at 8B; open numeric ranges are the failure mode. §4 turns
  that into an authoring rule.
- **Small deep surface.** ≈30 well-understood tools is a learnable interface
  for an 8B model; 300 is not (`docs/CONTEXT-agent-brief.md:93–94`). Every
  section below — the reflex split, the namespace gates, the UCB cap — exists
  to hold the exposed surface at that size while the *library* grows without
  limit.

## 1. Exposed vs reflex — what never costs a token

The split already exists in principle (there is deliberately no `eat` verb —
ActionRequested.v1.schema.json:30 — and the system prompt tells the villager
"your body looks after itself where it can", prompts.py:29). The skills batch
makes it systematic. A skill is wired in exactly one of two places:

**Reflexes** run inside minecraft-service, below deliberation, at zero token
cost: auto-eat (mineflayer-auto-eat), armor wearing (armor-manager), tool
auto-equip inside gather/craft (mineflayer-tool, the SV-14 absorption),
hazard escape, self-defense fight-or-flee, and the guard post-return tether.
The mind hears about them only as percepts and as *plumbing* failure codes
(`BODY_BUSY`, `HAZARD_ESCAPE_IN_PROGRESS`, `SELF_DEFENSE_IN_PROGRESS`) that
never count against its intents (§3).

**Exposed skills** are tools the model selects. The classification rule, in
priority order — a skill is EXPOSED iff any of these hold, and a REFLEX
otherwise:

1. **It spends a turn.** A tick buys one world action; anything that commits
   the body for seconds-to-minutes has opportunity cost, and opportunity cost
   is a decision (the survival-cluster ruling that created the no-eat-verb
   precedent).
2. **Correctness depends on context the body cannot see** — goals, the race
   ladder, social state, what a teammate asked for. Eating when hungry is
   unconditionally correct (reflex); *choosing to hunt so there is food to
   eat* is not (exposed — "acquisition is the mind's job").
3. **It is irreversible or resource-spending** — crafting consumes materials,
   placing commits a block, giving transfers property.

And a skill is a REFLEX iff it needs sub-second latency (an LLM at 1.6s–10s
per decision cannot do physics-time reactions — Stephen Blum's planner/reflex
split, saved as a standing directive) or is unconditionally correct whenever
its trigger fires.

Consequence for the schema layer: **reflexes have no `SkillSchemaStub`**
(types.ts:100–105 is the LLM-facing stub; a reflex is not LLM-facing). They
still return `SkillResult` and log `SkillInvocationRecord` rows — mastery
bookkeeping covers the whole library — but they never enter the exposed set,
never occupy one of the ≈30 slots, and never appear in any decode grammar.

## 2. Staged namespaces — gating the surface by game phase

Tool-selection accuracy degrades as the surface grows, so the surface must
not grow monotonically with the library. Namespaces (Stephen's RSG point 1,
adopted): every exposed skill belongs to exactly one namespace, and only the
namespaces for the current game phase render.

| Namespace | Contents (illustrative) | Unlocks |
|---|---|---|
| `core` | move, chat, follow, idle | always |
| `overworld` | gather, craft, hunt + the v-next verbs (§5) | always (the starting phase) |
| `nether` | portal lighting, bucket work, blaze-farm skills | nether entered |
| `stronghold` | eye-throw + deterministic triangulation reader, stronghold navigation | blaze rods + ender pearls banked |
| `end` | dragon-phase skills; the one-cycle macro as ONE precompiled tool (RSG point 5), never runtime-generated | end portal entered |
| `civic` | `declare_candidacy`, `vote` | a live election window |

`civic` is already the proof this works: the governance verbs are not
world-verbs at all but a decision-level add-on
(`governanceAction`, contract.py:62–84), and they are gated today by prompt
presence — the section renders only while an election window is open, and the
schema description forbids inventing an `electionId` the prompt didn't quote.
Zero governance verbs pollute a race tick. The game-phase namespaces
generalize that gate.

**The gating signal.** Requirements: derived from ledger facts (never
in-memory-only — the RaceState boot-rehydration precedent), shared per
settlement (not per villager), and **monotonic** (a ratchet). Definition:

> `GamePhase` = the highest phase whose entry milestone exists in the ledger.
> Entry milestones are `ProgressionMilestone` events emitted by the executor's
> milestone mapper (the RB-1 machinery — own outcome events →
> `ProgressionMilestone`), extended with per-phase entries
> (`nether_entered`, `stronghold_ready`, `end_entered`). agent-service holds
> a cache fed by the same percept consumer that feeds `RaceState`, rehydrated
> from the ledger at boot.

Why a ratchet: a phase that could revoke (all nether-capable villagers died)
would churn the local decode grammar mid-run and corrupt mastery statistics
(a skill's success rate must not be diluted by ticks where it wasn't even
offerable). A respawned villager keeps its unlocked namespaces.

Why settlement-wide, not per villager: on the Ollama channel the namespace
set *is* the decode grammar (the `action` enum plus the `params` union), and
per-villager grammars would mean per-villager configVersions — unbenchable.
One phase, one grammar, every brain sees the same surface (also required by
the brain-swap invariant: swapping models is a config flag, never a schema
change).

**Grammar stability rule:** the exposed surface may change only at phase
boundaries on the local channel. Each phase's grammar is a fixed, versioned
artifact, test-pinned the way `test_tool_schema.py` pins today's single
grammar. The frontier channel could legally vary tools per tick, but doesn't
— parity across channels is what makes A/B and brain-swap results
comparable. (Per-tick *ordering* within a fixed surface is allowed — §7.)

## 3. The failure vocabulary — the contract the model reads

`SkillFailureCode` (types.ts:13–29) is a **closed union**, deliberately:
"never invent strings outside this union — silent-escape codes are how
SUPERSEDED slipped past the enum" (types.ts:10–11, and §6 pays that debt).
It splits into codes shared with the `ActionFailed` wire enum
(ActionFailed.v1.schema.json:22–39) and skill-local codes that join the enum
in the v-next PR.

The vocabulary matters more than the params: it is what the model reads on
the *next* tick, via three surfaces —

1. the paired outcome line ("Your last decision: … → it FAILED: …",
   prompts.py:563–580),
2. the failure-streak ledger in `ActionAwareness`
   (`brain/awareness.py`) feeding the standing CHANGE COURSE section
   (prompts.py:587–598), and
3. the `errorMessage`, whose house style is *teach the missing link* (the
   `SMELT_FAILED` and `TOOL_TIER_REQUIRED` descriptions in
   ActionFailed.v1.schema.json:40 name the tier / the missing ingredient).

### 3.1 Per-code guidance

The guidance column below is normative: it is the recovery the
`errorMessage` must teach (executor side) and the behavior prompt hints may
reinforce (agent side). "Class" is the awareness split — **plumbing codes say
nothing about the intent itself and never count toward failure streaks**
(awareness.py:23–30); substantive codes are the world refusing the idea, and
three consecutive refusals of the same intent raise CHANGE COURSE
(abandon_after=3, awareness.py:88; streaks expire after 10 quiet ticks,
awareness.py:36).

**Shared codes (already on the wire).** The first six are the
SkillFailureCode ∩ ActionFailed intersection (types.ts:15–20);
`INVALID_PARAMS` is wire-only — a skill can never return it (it is not in
the union), but the model still reads it, so its guidance belongs here:

| Code | Meaning | What the model should try next | Class |
|---|---|---|---|
| `RESOURCE_NOT_FOUND` | nothing matching within the search radius | move somewhere new FIRST, then retry — retrying in place is the canonical wasted turn (the race-discipline rule, prompts.py:427–431) | substantive |
| `PATH_NOT_FOUND` | target unreachable from here | pick a nearer or different target; very far targets need a staging move (the `MOVE_MAX_DISTANCE` gate's message names a waypoint) | substantive |
| `TOOL_REQUIRED` | the action needs a tool the pack lacks | craft the named tool; the craft chain is one step per turn | substantive |
| `TOOL_TIER_REQUIRED` | tool exists but tier too low (message names the tier) | craft the named tier first — never re-attempt the gather bare | substantive |
| `TIMEOUT` | the trip exceeded the per-verb budget (graph.py:46–56, ceiling 60s) | smaller `count`, nearer target, or move first; repeated timeouts mean this spot cannot be worked | substantive |
| `INVALID_PARAMS` | executor-side param rejection | should be unreachable from a validated decision; reaching the model means schema drift — fix the contract, not the prompt | substantive |
| `INTERNAL` | executor fault, not the idea's fault | retry once, then change task | substantive (see caveat) |

**RESOLVED 2026-08-07 — the `INTERNAL` carve-out shipped.** It was flagged
here as substantive-by-omission from `_PLUMBING_CODES` while ~4,361 of 4,905
occurrences in the §3.1 window were one pathfinder-timeout string. A full
ledger count (event_db, all history) made the case larger than the flag:

| pathfinder string | events | landed as | now |
|---|---|---|---|
| `Took to long to decide path to goal!` | 12,067 | INTERNAL | `PATH_SEARCH_EXHAUSTED` (new, PLUMBING) |
| `No path to the goal!` | 2,278 | INTERNAL | `PATH_NOT_FOUND` (existing, substantive) |
| `Digging aborted` | 207 | INTERNAL | `ABORTED` (existing, PLUMBING) |
| `The goal was changed before…` | 125 | INTERNAL | `ABORTED` (existing, PLUMBING) |

Design as shipped: `src/world/pathfinderErrors.ts` is a pure classifier at the
executor's catch-all — ONE choke point instead of ten `goto` call sites, so a
new call site is covered the day it is written. The split's load-bearing
asymmetry is that **`PATH_SEARCH_EXHAUSTED` is plumbing and retryable while
`PATH_NOT_FOUND` stays substantive and non-retryable**: a compute budget can
come out differently next tick, the world's "no route exists" verdict cannot.
Anything unrecognised still becomes `INTERNAL` — a real executor bug must
never wear a tidy code. Note two of the four classes needed no new vocabulary
at all; they were honest codes that were simply never mapped.

**Skill-local codes (join the wire enum in the v-next PR):**

| Code | Meaning | What the model should try next | Class |
|---|---|---|---|
| `UNSUPPORTED_NAME` | name not in minecraft-data for 1.21.6 (guarded lookups, names.ts:48/61) | pick from the offered enum; structurally near-impossible from the model side once params are enums (§4 R6) — its real audience is skill-porting drift | substantive |
| `RECIPE_UNAVAILABLE` | no recipe for that item here (missing table context, unknown item) | craft/place a crafting_table first, or choose a craftable item | substantive |
| `MISSING_MATERIALS` | recipe known, ingredients absent (message lists them) | gather or craft the listed inputs — the TOOL CHECK arithmetic precedent (prompts.py:213+) | substantive |
| `PLACE_FAILED` | no legal spot, or the world rejected the placement (post-place world verify — the ghost-place lesson) | move to open ground and retry | substantive |
| `CONTAINER_NOT_FOUND` | no chest within range | craft+place a chest, or go to the settlement stores | substantive |
| `TARGET_NOT_FOUND` | the entity the skill needed is absent | move to where it was last seen; herds and villagers move | substantive |
| `INVENTORY_FULL` | no room to pick up the yield | deposit into a chest or toss low-value stacks first | substantive |
| `ABORTED` | the harness cancelled the skill mid-flight (shutdown, supersede, reflex preemption) | nothing — the world never refused the intent | **plumbing** |

Two of these deliberately reuse Phase-A wire names (`PLACE_FAILED`,
`CONTAINER_NOT_FOUND` appeared in the reverted ADR-11 enum and survive in the
stale generated types, §6) — same semantics, so re-adding them is name-stable.

### 3.2 Awareness integration rules

- The v-next PR adds `ABORTED` to `_PLUMBING_CODES` (awareness.py:23–30) in
  the same commit that lets it reach the wire. Every other skill-local code
  counts toward streaks.
- `_intent_identity` (awareness.py:58–84) gains a keying rule per new verb in
  the same commit — an unkeyed verb falls into the generic `f"{action}:"`
  bucket, which would merge distinct intents ("place torch" vs "place
  chest") into one streak and abandon both.
- `SkillSchemaStub.failureCodes` (types.ts:104) is the per-skill contract:
  the codes THIS skill can return, type-checked against the union. It is also
  model-facing — §4 R8 renders it into the tool description, so the model
  knows a skill's failure modes *before* choosing it, not only after.

## 4. Per-skill params — authoring rules for `SkillSchemaStub.params`

types.ts:96–98 states the baseline ("strict-safe: required-nullable fields,
anyOf(enum, null) for nullable enums, additionalProperties: false, no
free-form objects"). This section is the full consolidated rule set. R1–R9
are normative for every stub written in `library/*.ts`.

- **R1 — the schema source of truth is `packages/events`.** A stub's `params`
  must be byte-equal to the `$defs` entry the v-next PR proposes (the
  validate.mjs fixture discipline: fixtures are held to the per-action $defs,
  validate.mjs:34–57). The stub is the design artifact; the contract is the
  shipped truth. Divergence is a CI failure, same as generated-type drift —
  enforced since 2026-08-07 by
  `services/minecraft-service/test/skillSchemaStubs.test.ts`, which loads every
  `*Schema` export in `skills/library/` and asserts R2 closure, R3 (no optional
  properties; nullable enums as `anyOf(enum, null)`), and that every declared
  `failureCode` exists in the committed `ActionFailed` enum. The byte-equality
  clause is written and self-activating: it compares a stub to its `$defs` the
  moment a stub name appears in the contract's `action` enum, and asserts the
  set is empty today so the dormancy is a stated fact rather than a silent
  skip. (Before that date this paragraph described a gate that did not exist;
  the gate caught an R3 shape error on its first run.)
- **R2 — closed objects everywhere.** `additionalProperties: false`, every
  property listed. No free-form `{type: object}` — that is the M1-3 latent
  400 (`DECISION_SCHEMA`'s outer `params` is the one legacy exception, and it
  is tightened to the anyOf union before any frontier wire call,
  contract.py:432–438).
- **R3 — optional means required-nullable.** Non-enum optionals:
  `"type": ["T", "null"]`. Optional *enums*: `anyOf(enum, null)` — never a
  type array next to enum members (the shipped `_strictify` fix,
  contract.py:381–387; Anthropic strict 400s otherwise). `null` means "use
  the default": `_normalize_params` strips explicit nulls before wire
  validation (contract.py:132–138), so decode-side null and wire-side absence
  agree.
- **R4 — bounded small integer ranges are ENUMS, not min/max.** Any integer
  parameter whose legal range has cardinality ≤ 16 is expressed as an integer
  enum (`"enum": [1,2,3,4,5,6,7,8]`), not `minimum`/`maximum`. Rationale:
  enums survive all three channels — the Ollama grammar enforces them at
  decode time, and `enum` is not in `_STRICT_UNSUPPORTED_KEYWORDS`
  (contract.py:328–343) so the frontier wire keeps them — while
  `minimum`/`maximum` are enforced by *no* channel at decode time (grammar
  can't; frontier stripped). The corpus says this is the whole ballgame:
  92.2% of malformed local decisions are numeric-bounds violations
  (metrics.json), i.e. exactly the constraint class the grammar never saw.
  `GatherParams.count` 1–8 is the poster child. This changes decode grammars
  → rides the single v-next configVersion bump.
- **R5 — larger and continuous ranges stay numbers with bounds in source.**
  Cardinality > 16 or non-integer (coordinates, `maxDistance` 4–64,
  affinity/trust deltas −20..20): keep `minimum`/`maximum` in the schema
  source, enforced post-parse by `validate_decision` (contract.py:271+),
  stripped for the frontier wire. The strip stays conservative — OpenAI
  strict has supported bounds since ~May 2025, but Anthropic strict does not,
  and one schema serves both (contract.py:325–343; function-calling report,
  "one stale belief corrected").
- **R6 — game-object names are enums resolved through `names.ts` families,
  never free strings.** The `GatherParams.resource` / `CraftParams.item`
  family precedent (ActionRequested.v1.schema.json:149–160, 200–216): the
  model picks an abstract family; the executor resolves it against the world
  via `guardedItem`/`guardedBlock` (names.ts:48, 61) so `UNSUPPORTED_NAME`
  is an executor-porting bug, never a model affordance.
- **R7 — defaults live in source + prose, never only in schema.** Keep
  `default` in the schema source (the executor and docs read it); it is
  stripped for the frontier wire and invisible to the Ollama grammar, so the
  model-visible statement of a default is the description text — which on the
  Ollama channel means the SYSTEM_TEMPLATE verb documentation
  (prompts.py:20–27), the only description surface a grammar-constrained
  model ever sees. Every new verb ships its SYSTEM_TEMPLATE line in the same
  commit (§5 blast radius).
- **R8 — the stub renders as: one-line description + params + failure
  modes.** Frontier tool descriptions and the SYSTEM_TEMPLATE line are
  generated from the same stub fields: `description`, the params summary,
  and `failureCodes` ("can fail: MISSING_MATERIALS, PLACE_FAILED") — the
  model should know a tool's failure surface before choosing it.
- **R9 — depth ≤ 2.** `params` → properties → scalars; `Position`
  (ActionRequested.v1.schema.json:57–76) is the only sanctioned nested
  object. Nesting is where small models drift (the `_PARAM_ALIASES` and
  decision-level-key-leak normalizations exist because of it,
  contract.py:115–123).

**Rider on the outer schema (same bump):** the decision-level ratings share
the bounds problem — `importance` 0–10 and `sentiment` −1..1 are open numbers
(contract.py:36–37) that only post-parse validation bounds. Under R4,
`importance` becomes an integer enum 0–10 and `sentiment` a quantized enum
(−1.0 to 1.0 in 0.25 steps, 9 members; it feeds memory scoring, which loses
nothing at quarter resolution). The corpus doesn't break the 3,090
bounds violations down by field, but these two and `count` are the bounded
fields a grammar could actually close; `relationshipUpdates` deltas (−20..20,
cardinality 41) stay R5 numbers.

## 5. ActionRequested v-next — the additive growth path

Schema evolution is additive-only within a version (the packages/events house
rule), and the published benchmark table is protected from configVersion
churn (owner's rule). Therefore: **all of §4's grammar changes, every new
verb, every new failure code, and §6's debt ship as ONE atomic PR with ONE
configVersion bump.** The RB-1 precedent is the model: "fixtures + task gen +
FakeProvider rows + timeout-table rows, same commit (house rule)"
(10-red-vs-blue.md:43).

### 5.1 New verbs — SHIPPED at configVersion 8

**Owner note:** the names below shipped as designed (`place`, `store`,
`retrieve`). A rename is cheap *before* this lands in a benchmarked run and
expensive after — it would be a second decode-grammar change and a second
re-bench — so it is the one decision worth making now rather than later.

Two changes from the draft, both forced by "a failure code with no verb that
can return it is dead vocabulary" read in the other direction — a verb whose
precondition nothing can satisfy is dead affordance:

- `torch` left the `PlaceParams` enum. Nothing in the craft enum makes one, so
  offering it would be a tool that can only ever fail.
- `chest` JOINED the craft enum (8 planks, generic recipe path, no bespoke
  chain). `CONTAINER_NOT_FOUND`'s prescribed recovery is "craft+place a
  chest", which was advice no villager could take. The `CRAFTABLE_ITEMS`
  assertion in `crafting.test.ts` caught this the moment the schema grew.

One correction the implementation forced: `StoreParams.count` and
`RetrieveParams.count` are TOTALS across the family, not per-stack. Retrieval
therefore reads the chest (`checkItemInsideChest`) before withdrawing and
plans against real contents — asking for `count` of every candidate name would
withdraw a multiple of what was asked, and for `food` that is the whole box.

Derived from the skill-local failure codes the kernel already declares (a
failure code with no verb that can return it is dead vocabulary), and
deliberately NOT a resurrection of the reverted Phase-A set (`56823ad` stays
reverted absent an explicit owner ask — red line). The minimal set the ported
library needs:

```jsonc
// $defs additions (source form — bounds/defaults present, stripped per-channel)
"PlaceParams": {
  "type": "object",
  "properties": {
    "item": { "enum": ["crafting_table", "furnace", "chest", "torch"] },
    "position": { "anyOf": [{ "$ref": "#/$defs/Position" }, { "type": "null" }],
                  "description": "null = the executor picks legal adjacent ground (the default)" }
  },
  "required": ["item"],
  "additionalProperties": false
},
"StoreParams": {   // chest deposit
  "type": "object",
  "properties": {
    "item":  { "enum": ["wood", "stone", "coal", "raw_iron", "food"] },  // families, R6
    "count": { "enum": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16] }  // R4
  },
  "required": ["item"],
  "additionalProperties": false
},
"RetrieveParams": { /* mirror of StoreParams */ }
```

| Verb | Failure codes (stub `failureCodes`) | Timeout row (graph.py:46–56) | Namespace |
|---|---|---|---|
| `place` | `MISSING_MATERIALS`, `PLACE_FAILED`, `TIMEOUT` | 30_000 | overworld |
| `store` | `CONTAINER_NOT_FOUND`, `MISSING_MATERIALS`, `TIMEOUT` | 30_000 | overworld |
| `retrieve` | `CONTAINER_NOT_FOUND`, `TARGET_NOT_FOUND`, `INVENTORY_FULL`, `TIMEOUT` | 30_000 | overworld |

No verb may carry a timeout above `TIMEOUT_TABLE_MAX_MS` = 60s — the ceiling
is load-bearing for every reflex-lockout safety argument (graph.py:41–45),
and raising it triggers the contingency review, not a bigger number.

`ActionFailed.errorCode` gains, additively: the eight skill-local codes of
types.ts:22–29 plus `SUPERSEDED` (§6).

### 5.2 The blast radius — the checklist the PR must walk

Adding one verb touches six seams; the PR template should enumerate them
(a miss is a silent runtime hole, not a compile error, on several):

1. **Schemas** — `packages/events/schemas/commands/ActionRequested.v1.schema.json`
   (action enum :19–29, `$defs`, params description :34) and
   `world/ActionFailed.v1.schema.json` (errorCode enum :22–39).
2. **Fixtures** — valid + invalid per new verb/params shape; validate.mjs
   holds fixtures to the $defs.
3. **`packages/events/test/validate.mjs`** — the `PARAMS_DEF_BY_ACTION` map
   (:41–57), explicitly kept in step with contract.py's seam maps (:38–40).
4. **`services/agent-service/…/llm/contract.py`** — `DELIBERATE_ACTIONS`
   (:22) and `_PARAMS_DEF_BY_ACTION` (:98–105); `decision_tool_schema()`'s
   params union and the Ollama grammar follow automatically from those two
   (:432–438), which is the point of the seam.
5. **`brain/graph.py` + `brain/prompts.py` + `brain/awareness.py`** — the
   timeout-table row (:46–56); the SYSTEM_TEMPLATE verb line (:20–27, the
   Ollama channel's only description surface, R7); the `_intent_identity`
   keying rule (§3.2).
6. **`services/minecraft-service/…/actions/executor.ts`** — dispatch to the
   library skill; every emitted code already in the (now-grown) enum.

Mechanical riders in the same PR: `task gen` regen committed (CI drift-gates
it — and see §6.2), FakeProvider decision rows for the new verbs (the RB
house rule), `test_tool_schema.py` re-pin of the new grammar bytes, and the
`configVersion` bump — exactly one.

## 6. Known debt this PR pays down

### 6.1 `SUPERSEDED` is live on the wire and missing from the enum

The v7 latest-intent-wins executor emits
`ActionFailed{errorCode: 'SUPERSEDED'}` (executor.ts:199) — 209 occurrences
in the committed bench corpus (metrics.json `by_code`) — and
`awareness.py:24` already lists it in `_PLUMBING_CODES`. But the
`ActionFailed.v1` enum (:22–39) does not contain it: the schema is currently
*false about the wire*, and any consumer that validates payloads against it
rejects real events. types.ts:10–11 names this incident as the reason the
skill vocabulary is a closed union. Fix: additive enum entry + fixture. The
enum's description should also record its class (plumbing: "the mind changed
its mind; the world never refused the intent").

### 6.2 Stale generated types still declare the reverted Phase-A surface

Revert `56823ad` removed the Phase-A verbs from the source schemas but
`task gen` was never re-run: `packages/events/generated/ts/ActionRequested_v1.ts:29–36`
still declares `place_block`/`use_bucket`/`equip`/`give`/`deposit`/
`withdraw`/`toss`/`consume`, `generated/ts/ActionFailed_v1.ts:36–40` still
declares `ITEM_NOT_CARRIED`/`PLACE_FAILED`/`CONTAINER_NOT_FOUND`/
`LIQUID_NOT_FOUND`/`GIVE_FAILED`, and the generated Python mirrors both
(`generated/py/civ_events/commands/ActionRequested_v1_schema.py:23`,
`world/ActionFailed_v1_schema.py:28`). Nothing imports the phantom members
today, but any consumer typed against them would compile against verbs the
executor answers with `UNKNOWN_ACTION`. The v-next `task gen` rewrites these
files anyway.

**ANSWERED 2026-08-07 — the gate did not miss it. Nothing required it to
pass.** Evidence, all from the GitHub API:

- `56823ad` itself has **zero check runs** — it is an intermediate commit on a
  branch, and GitHub only checks a PR's head and a push's tip. Expected.
- PR #109 (`demo-sprint` → `main`), head `a6f2d88`, ran the gate and its
  `contracts` check concluded **`failure`**. The PR was merged 18 seconds
  later anyway, at 2026-07-28T18:40:29Z.
- `main` had **no branch protection at all** (`GET /branches/main/protection`
  → 404), so a red required-looking check blocked nothing.
- The follow-up PR #110 (`fix-contracts-job-failure`, commit `3f06e61`
  "Regenerate stale event contract types") is the repair, arriving ~44 min
  after the bad merge.

So the failure mode is not detection, it is **enforcement**: the gate was
advisory. Fixed the same day by enabling branch protection on `main` requiring
the `contracts` and `ci / test` checks (admins exempt, so the owner keeps an
escape hatch; non-strict, so an out-of-date branch is not blocked). The
generalisable lesson, now carried in the `contract-change` skill: *a gate
whose result nothing consumes is a report, not a gate* — check enforcement,
not just the workflow file.

## 7. Retrieval priority — how the exposed set is chosen and ordered

The mastery policy layer (`skills/policy.ts`, parallel worker) owns the
per-skill stats table fed by `SkillInvocationRecord` rows (types.ts:84–91):
attempts, successes, trailing success rate, cost, and the context columns of
`SkillInvocationContext` (types.ts:44–50). This section defines the ONLY
things the schema layer consumes from it: which skills render, and in what
order.

**The pipeline, per phase change (local) / per tick (frontier ordering
only):**

1. **Eligible** = library ∩ current namespaces (§2) ∖ superseded.
   *Superseded skills leave the exposed set but NEVER the library* — a
   respawned agent still needs `punch_tree` even though `iron_axe_harvest`
   superseded it (`docs/CONTEXT-agent-brief.md:77–79`). Deprecation is a
   retrieval decision, not a deletion.
2. **Ranked** by UCB over the stats table (selection-under-uncertainty is a
   solved bandit problem; ~30 lines, brief §3). The exploitation term is the
   trailing success rate *in the current context bucket* — mastered means
   succeeded across DISTINCT contexts (types.ts:41–42), so a skill proven
   only in forests ranks lower in a desert.
3. **Capped** at ≈30 exposed tools, with the current 7 deliberate verbs
   (contract.py:22) **pinned** — they never drop out, whatever their rank.
   Pinning keeps the floor of the interface stable for regression comparison
   and keeps the SYSTEM_TEMPLATE core stable for prompt caching (the
   Anthropic tools→system prefix is cache-friendly by construction —
   function-calling report §7).
4. **Novelty escape hatch**: a fixed fraction ε of deliberations includes the
   highest-ranked *un-mastered* eligible skill even when the mastery gate
   would hold it back (no new skills while a goal-path skill is below
   threshold — the gate lives in policy.ts). ε is explicitly the knob nobody
   has values for yet (`docs/CONTEXT-agent-brief.md:145–150`); it ships as
   config, default conservative, and it is a *bench axis*, not a constant to
   argue about.

**Channel split, restated precisely:** rank ORDER applies everywhere, every
tick — it is the frontier `tools` array order and the system-prompt
documentation order, and order is cheap (no grammar change, models attend to
earlier tools). Rank INCLUSION — which skills are in the surface at all —
changes only at phase boundaries on the local channel (§2 grammar-stability
rule), because inclusion is the decode grammar. On the frontier channel we
*could* vary inclusion per tick and deliberately don't, for cross-brain
parity. If the exposed set ever outgrows what one schema can carry, the
frontier-side relief valves are OpenAI deferred loading / Anthropic
mid-conversation tool addition (function-calling report §3) — the local
channel has no equivalent, which is one more reason the cap is ≈30 and not
"whatever fits".

## Appendix — what this doc pins vs leaves open

Implementation status at `configVersion` 8 — SHIPPED: §3 vocabulary (all eight
skill-local codes + `SUPERSEDED`), §3.2 (`ABORTED` plumbing, per-verb intent
keying), §4 R1–R9 + the rating rider, §5 (three verbs, six seams, one bump),
§6.1 and §6.2. NOT SHIPPED: §2 namespaces, §7 UCB retrieval — both wait on a
surface big enough to need them.

| Pinned by this doc | Left open (owner / PR time) |
|---|---|
| Exposure rule (§1), namespace set + ratchet gating signal (§2) | exact per-phase milestone predicates beyond nether/stronghold/end sketches |
| Failure vocabulary, per-code guidance, plumbing additions (§3) | ~~the `INTERNAL` pathfinder-subclass carve-out design~~ — SHIPPED 2026-08-07 (§3.1) |
| Params rules R1–R9 + importance/sentiment enum rider (§4) | final verb names + enum member lists in §5.1 (DRAFT) |
| One-PR/one-bump rule + the 6-seam checklist (§5) | PR timing — it is a configVersion event and the owner sequences those |
| `SUPERSEDED` enum fix + `task gen` re-run (§6) | ~~why the drift gate missed the revert~~ — ANSWERED 2026-08-07 (§6.2): it didn't; nothing enforced it |
| UCB cap ≈30, pinned core 7, superseded-drops-out-never-deleted, ε as config (§7) | the value of ε (bench axis) |
