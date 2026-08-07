---
name: contract-change
description: Use when touching anything under packages/events (ActionRequested verbs/params, ActionFailed errorCode enum, GovernanceRequested, schemas, fixtures), editing DECISION_SCHEMA or decision_tool_schema in agent-service llm/contract.py, adding a failure code, or deciding a configVersion bump in bench/race/frozen-config.json. Delivers the six-seam atomic-PR checklist, LLM-decodable field authoring rules, and the bump-vs-fold decision tree.
---

# Contract change — one PR, one bump, six seams

Use this for ANY change to the event contracts: a new/changed ActionRequested
verb or params shape, a new ActionFailed errorCode, a DECISION_SCHEMA edit, a
governance verb, any schema or fixture in `packages/events`. Do NOT use it for
the executor's implementation of a verb (see the mineflayer-runtime skill),
test-authoring doctrine beyond the tripwires below (see the regression-test
skill), running a benchmark sweep (race-sweep), or writing comparability prose
in reports (bench-report). This skill owns the configVersion decision tree;
siblings point here.

## 1. The six-seam checklist — one atomic PR

A verb or params change is never a one-file edit. Most misses fail SILENTLY at
runtime, not at compile time (v7 emitted SUPERSEDED for days while the schema
said otherwise; unit-10's chest bug was the same class).

- [ ] **Seam 1 — schemas.** `packages/events/schemas/commands/ActionRequested.v1.schema.json`:
  the `action` enum, a new `$defs` entry, and the `params` description listing
  every action→shape mapping. If the verb can emit new failure codes, grow
  `schemas/world/ActionFailed.v1.schema.json` `errorCode` in the same PR (§3).
- [ ] **Seam 2 — fixtures.** One valid fixture per new verb/params shape
  (`fixtures/ActionRequested.<verb>.v1.json`, e.g. `ActionRequested.place.v1.json`)
  plus negatives under `fixtures/invalid/` (§4).
- [ ] **Seam 3 — `packages/events/test/validate.mjs`.** Add the verb to
  `PARAMS_DEF_BY_ACTION` (`null` = takes `{}`). A fixture whose action has no
  map entry fails LOUD by design ("map it to its $defs shape").
- [ ] **Seam 4 — `services/agent-service/src/agent_service/llm/contract.py`.**
  `DELIBERATE_ACTIONS` + `_PARAMS_DEF_BY_ACTION` (governance verbs:
  `GOVERNANCE_ACTIONS` + `_GOVERNANCE_DEF_BY_ACTION`). The Ollama grammar and
  the frontier params union both derive from these — that is the point of the seam.
- [ ] **Seam 5 — brain plumbing**, all three files:
  `brain/graph.py` `_TIMEOUT_MS_BY_ACTION` row — never above
  `TIMEOUT_TABLE_MAX_MS` (60s); the cap is load-bearing for the reflex-lockout
  safety argument. `brain/prompts.py` `SYSTEM_TEMPLATE` verb line — on the
  Ollama channel this is the ONLY description surface the model ever sees, so
  state defaults and semantics in prose (R7 below). `brain/awareness.py`
  `_intent_identity` keying — an unkeyed verb falls into the generic bucket and
  merges distinct intents ("place chest", "place furnace") into one abandonment streak.
- [ ] **Seam 6 — executor dispatch.** The action switch in
  `services/minecraft-service/src/actions/executor.ts` (unmatched actions throw
  `ActionError('UNKNOWN_ACTION')`), and every code the handler can emit already
  present in the (now-grown) ActionFailed enum. Implementation details: see the
  mineflayer-runtime skill.

**Riders in the SAME PR:**

- [ ] `task gen` output committed (§5).
- [ ] FakeProvider `_SCRIPT` row per new verb in `llm/providers.py`.
  CI-enforced since 2026-08-07:
  `test_llm_providers.py::test_script_covers_every_deliberate_action` asserts
  `_SCRIPT` covers `DELIBERATE_ACTIONS` exactly (before that, hunt/follow
  silently had no rows), and every scripted row walks `validate_decision`.
- [ ] `test_tool_schema.py::test_params_union_accepts_every_verb_and_idle` case
  added — it asserts `set(cases) == DELIBERATE_ACTIONS`, so an unexercised verb fails.
- [ ] Body-side enum tripwire for any executor table mirroring a schema enum:
  a test that reads the committed schema JSON and asserts exact equality
  (`test/crafting.test.ts` pins `CRAFTABLE_ITEMS` to `CraftParams.item.enum`;
  `hunting.test.ts` pins `HUNT_FAMILIES` keys to `HuntParams.animal.enum`) —
  this is how `chest` joining the craft enum fired loud in the body's suite.
- [ ] Exactly ONE `configVersion` bump in `bench/race/frozen-config.json` with a
  `$versionHistory` entry (§6), and a PR-body note that the published model
  table stands until re-benched.

## 2. LLM-decodable field authoring rules

Full catalog: `docs/architecture/10-skill-tool-schema.md` §4 (R1–R9). The ones
that bite:

| Rule | Doctrine |
|---|---|
| R4 | Bounded integer range with cardinality ≤ 16 → integer **enum** (`GatherParams.count` 1–8, `importance` 0–10, `MoveParams.range`/`FollowParams.range` 1–8), never `minimum`/`maximum`. min/max is enforced by NO decode channel — the Ollama grammar can't express bounds, the strict wire strips them; 92.2% of malformed local decisions were bounds violations, worst case the unbounded move range that turned walks into no-ops. |
| R5 | Cardinality > 16 or non-integer (`maxDistance` 4–64, affinity deltas −20..20): keep min/max in schema source, enforced post-parse by `validate_decision`, stripped for the frontier wire by `_STRICT_UNSUPPORTED_KEYWORDS` (12 keywords incl. `default`, bounds, `pattern`, `format`). Strip stays conservative: Anthropic strict has no bounds support, one schema serves both providers. |
| R7 | Defaults live in schema source AND prose. `default` is stripped for the wire and invisible to the grammar — the model-visible statement is the `SYSTEM_TEMPLATE` verb line. |
| R9 | Depth ≤ 2: `params` → properties → scalars; `Position` is the only sanctioned nested object. |
| Strict shapes | Everything reaching the frontier wire must survive `_strictify` losslessly: objects closed with every property required; optional non-enum → `"type": [T, "null"]`; optional **enum** → `anyOf(enum, null)` — never a type array next to enum members (Anthropic 400'd the first live smoke); no `{"type": "object"}` without properties (the latent M1-3 OpenAI 400). Explicit null means "use the default": `_normalize_params` strips nulls pre-validation. |

**Grammar is a versioned artifact.** `DECISION_SCHEMA` is passed verbatim as
Ollama's `format` (`providers.py`) — property order is generation order under
constrained decoding, so reordering keys IS a grammar change.
`test_tool_schema.py` pins its shape (`test_base_decision_schema_keeps_its_shape`,
`test_reasoning_is_the_first_property`). `params` stays free-form there by
design; `decision_tool_schema()` derives the strict frontier tool (reasoning
first, params tightened to an anyOf union of the real `$defs`, then
`_strictify`). Change the source and let both channels follow — never hand-fork
the derived direction.

## 3. Failure-code addition end-to-end

- [ ] Enum entry in `ActionFailed.v1.schema.json` with a description recording
  its class and prescriptive recovery.
- [ ] Skill-local codes extend the closed union `SkillFailureCode` in
  `services/minecraft-service/src/skills/types.ts` — never invent strings outside it.
- [ ] `RETRYABLE_BY_CODE` ruling in `src/world/skillVerbs.ts` — its
  `Record<SkillFailureCode, boolean>` type makes omission a compile error.
- [ ] Fixture (`fixtures/ActionFailed.superseded.v1.json` is the precedent).
- [ ] Plumbing-class codes join `awareness.py` `_PLUMBING_CODES` in the SAME
  commit that lets them reach the wire (the ABORTED rule) — a late
  classification books abandonment streaks against intents the world never
  refused. The body-side mirror `isPlumbingCode` is pinned to the awareness set
  by `test/skillsStats.test.ts`.
- [ ] **Reachability, both directions:** some verb can actually return the code,
  and the prescriptive `errorMessage` names only recoveries the villager can
  perform end-to-end (CONTAINER_NOT_FOUND prescribed "craft a chest" while
  chest wasn't craftable; torch was cut because nothing could make one).
- [ ] Never let the executor emit a code the enum lacks — the v7 SUPERSEDED gap
  made the schema false about the wire.

## 4. Fixture discipline

- Every payload schema has ≥ 1 valid fixture; `validate.mjs` enumerates and
  fails on gaps.
- Every rejection class worth guarding gets a fixture under `fixtures/invalid/`
  that MUST fail validation — a passing invalid fixture is itself a failure
  ("the negative test is broken").
- Command `params` are free-form on the wire, so fixtures are additionally held
  to the per-action `$defs` via `PARAMS_DEF_BY_ACTION` — kept explicitly in
  step with contract.py's `_PARAMS_DEF_BY_ACTION`/`_GOVERNANCE_DEF_BY_ACTION`.

## 5. task gen + the drift gate (and its revert blind spot)

```powershell
task gen                                            # TS via codegen/gen-ts.mjs + Python via uvx datamodel-code-generator
git diff --exit-code -- packages/events/generated   # the exact CI check — run BEFORE committing
```

Commit schemas + fixtures + `generated/` in ONE commit. CI
(`.github/workflows/events-contracts.yml`) re-runs codegen and fails on any
diff.

**The `56823ad` incident, correctly diagnosed (2026-08-07):** the gate did NOT
miss it. PR #109's `contracts` check concluded `failure` and the PR merged 18
seconds later, because `main` had no branch protection — the check was
advisory. Stale generated types then sat on main until #110. `main` now
requires `contracts` + `ci / test` (admins exempt). The transferable rule: **a
gate whose result nothing consumes is a report, not a gate** — when you add
one, verify enforcement (`gh api .../branches/main/protection`), not just that
the workflow file exists.

On Windows, check drift with `git diff --numstat -- packages/events/generated`
rather than `git status`: `task gen` writes CRLF, and `.gitattributes`
normalizes to LF on add, so `git status` reports content-identical files.

## 6. configVersion: bump, fold, or free

| Situation | Ruling |
|---|---|
| DECISION_SCHEMA bytes, the action enum, or any `$defs` shape in the params union changed | **Bump** — with a `$versionHistory` entry saying what changed and why rows aren't comparable. Batch every pending grammar change behind ONE bump (owner's standing rule; the table moved twice in two days when fixes bumped separately). |
| Fix lands after a bump but BEFORE any run has raced under it | **Fold** into the existing bump (the v8 range fix, PR #113 — it was free). |
| Metadata-only lowercase keys — top-level `modelRoster`/`sensitivityAxes`, and lowercase entries inside `frozen` (`frozen.world`, `frozen.mobs`, `frozen.difficulty`) — `frozen_env()` exports only `frozen`'s UPPERCASE keys | **Free**, no bump. |
| Change confined to `decision_tool_schema()` while DECISION_SCHEMA stays byte-identical | **Free** — the frontier tool wire is not the local decode grammar. |

`bench/sweep_race.py` keys resume/skip on `configVersion` (`run_key`): an
unbumped grammar change silently pools incomparable rows; an unnecessary bump
burns a full N=5 re-bench. Sweep mechanics: race-sweep skill; report
comparability prose: bench-report skill.

## CI caveats for contract PRs

- Seams 4–6 live in service dirs: each service workflow path-includes
  `packages/events/**` so a contract change rebuilds every consumer — keep that
  line when adding a caller workflow.
- Additive-only within a version: renames/removals/type changes create a new
  `.vN` file and bump `schemaVersion` on the wire; published versions are never
  edited in place. Deliberate deviations are recorded in
  `packages/events/README.md`, not silently patched.

## Verification

```powershell
task gen
git diff --exit-code -- packages/events/generated        # no codegen drift
git diff main -- bench/race/frozen-config.json            # exactly ONE configVersion bump + history entry
npm test --workspace @civ/events                          # fixtures + gates (contracts suite)
npm test --workspace @civ/minecraft-service               # body-side enum tripwires fire/pass
cd services/agent-service; uv run pytest -q tests/test_tool_schema.py   # grammar pin + every-verb case (cd last — changes cwd)
```

Seam-coverage probe for a new verb — every location must hit:

```powershell
rg -l "<new_verb>" packages/events/schemas packages/events/fixtures packages/events/test/validate.mjs services/agent-service/src/agent_service/llm/contract.py services/agent-service/src/agent_service/brain services/agent-service/src/agent_service/llm/providers.py services/minecraft-service/src/actions/executor.ts
```

Finish with `task test` (full suites) before the PR.
