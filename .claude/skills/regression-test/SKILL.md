---
name: regression-test
description: Use when writing, reviewing, or running tests in any service — encoding a live incident as a regression test, adding a schema-growth tripwire, executor/watchdog tests, Settings/provider tests, golden fixtures, structural tests, or when you need the exact per-suite run commands (vitest, pytest, validate.mjs, gradlew). Delivers the repo's testing doctrine plus verified suite commands and current green sizes.
---

# Testing doctrine — all services

**When to use:** adding or changing tests anywhere, turning a live failure into
a test, or running/interpreting the suites. **When not:** contract fixture
rules (valid+invalid fixtures, $defs, drift gate) live in the contract-change
skill; the bench golden-fixture *capture* protocol (3-way verification, frozen
config) is race-sweep/bench-report territory — this skill owns only the test
SHAPE; executor/mineflayer implementation patterns the tests pin are the
mineflayer-runtime skill; pulling ledger slices from the live system is the
live-forensics skill.

## 1. Encode every production incident as a dated regression test

When a deploy, demo gate, or bench run catches a bug, the fix ships WITH a test
that carries the incident:

- [ ] Test name states the **failure class**, not the function under test
      ("never supersedes a spawn — losing it costs the villager its body").
- [ ] Comment carries the **date** and a one-line story of the failure.
- [ ] Constants are the **real ids/coordinates/values** from the incident,
      never sanitized synthetics — e.g. `orphanSweep.test.ts` pins the real
      orphan attempt id `019f8b48-9940-703c-9ae0-fd1f5ad93a9d`;
      `executor.test.ts`'s no-op-move test quotes the live measurement
      ("150 moves, median 30ms, model asking for range 1000").
- [ ] Put it in the suite that owns the seam (executor bugs in
      `services/minecraft-service/test/executor.test.ts`, prompt/decision bugs
      in `services/agent-service/tests/test_prompts.py`, etc.).

Named models to copy: THE WEDGE REGRESSION and "the rb2-exit-3 stall" in
`executor.test.ts`; the items-vs-applications block in `skillsWoodTier.test.ts`
("Live-gate regression (2026-07-28)"); the 748-invented-electionIds test in
`test_prompts.py`; `test_race_rehydrate.py`'s module docstring.

## 2. Replay real incident data offline BEFORE spending GPU or live time

The v5 relocation sweep shipped on unit tests alone and fired zero times live;
the replay test written afterward proved it in seconds, offline. Order:

1. Pull the real coordinates/event slice from executor logs or the ledger for
   the failed run (query grammar: see the live-forensics skill).
2. Commit them as constants/fixtures with the run id in a comment
   (model: `services/minecraft-service/test/relocationReplay.test.ts` — Fen's
   and Ansel's logged targets from bench-llama3.1-8b-v5-r3/r3b).
3. First test **reproduces the failure** against the old behavior's contract.
4. Later tests **prove the fix**, including the boundary it must not break.
5. Only then deploy/re-race. Brain-side, `task race:replay` runs the offline
   decision replay (seconds, no world/docker/tick).

## 3. Golden tests document their regen command in the docstring

A golden/expected-doc test must carry, in its module docstring, the exact
command that regenerates the expected file after an INTENTIONAL drift and
where to copy the output — never tribal knowledge. Model:
`bench/test_race_metrics.py` (both `uv run python bench/bench_race.py --slice …`
variants verbatim, plus which `.expected.json` to overwrite). Add synthetic
cases when the fixture cannot distinguish two computation methods.

## 4. Time-sensitive tests: runtime stamps or a pinned clock — never mixed

Any envelope crossing a freshness guard stamps `occurredAt` at test runtime
(`datetime.now(UTC)` / `new Date().toISOString()`). Hardcoded dates are legal
only when:

| Pattern | When | Model |
|---|---|---|
| runtime `_now()` helper | subject compares against wall clock | `test_percept_fanout.py` (its one hardcoded date is the deliberate stale case) |
| inject `now` / park the clock | subject accepts a clock | `orphanSweep.test.ts` (`NOW_MS` injected via `nowMs`), `test_llm.py`'s `Clock` for the midnight budget rollover, `ElectionLifecycleIntegrationTest.java` (`civ.election.clock-ms=3600000`, tests step `AdvanceElectionsUseCase` by hand) |
| backdate relative to `Date.now()` | asserting staleness itself | `executor.test.ts` stale-command test |

A hardcoded "fresh" date is a time bomb: green until the wall clock passes it
(bit `test_percept_fanout.py` on 2026-07-07).

## 5. Provider/Settings tests: pin every env-derived field + autouse scrub

pydantic-settings reads the developer's real `.env` and process env, so an
unpinned test is green or red depending on whose machine runs it (the
local-only `task test` flake — fixed twice, once per Python service):

- [ ] Every `Settings(...)` construction pins the fields the test depends on
      (`llm_model_ollama="llama3.1:8b"` at minimum).
- [ ] The module carries an autouse env scrub — `_no_env_leakage` in
      `test_llm_providers.py` delenv's `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
      `LLM_PROVIDER`, `OLLAMA_BASE_URL`, `LLM_TEAM_MODELS`, `OLLAMA_NUM_CTX`;
      `services/memory-service/tests/test_llm.py` has the twin.
- [ ] When fixing a Settings flake in one Python service, audit the other —
      the second .env flake existed because the first fix wasn't mirrored.
- [ ] Provider behavior flags ride every call: the qwen3.5-family test pins
      `think:false` on warmup AND chat, with `/api/show` probed exactly once.

## 6. Fakes held to the real contract; stub factory in one place

- Every fake standing in for a real seam is validated against the committed
  contract inside its own test: FakeProvider decisions through
  `validate_decision`, FakeSummarizer through jsonschema vs
  `REFLECTION_SCHEMA`, published envelopes ajv-compiled from
  `packages/events/schemas/` (model: `orphanSweep.test.ts`).
- Session/dep stubs come from ONE factory (`sessionStub` in
  `executor.test.ts` satisfies `SessionActions`) so growing the interface
  breaks one place.
- A fake pinning a domain assumption needs a live gate to have confirmed it:
  unit fakes pinned craftItem count as item YIELD; the live world treats it as
  recipe APPLICATIONS — `skillsWoodTier.test.ts` now pins `ceil(items/4)` at
  the call boundary.
- Guard against vacuous passes: `pluginWiring.test.ts` asserts every
  destructured CJS plugin export `typeof === 'function'`, else identity
  assertions pass with `undefined` on both sides.

## 7. Schema-growth tripwires: exact equality with the committed enum

Any code table mirroring a contract enum gets a test asserting equality
against the schema JSON read straight from `packages/events` — a contract
commit that grows the enum then fails LOUD in the consumer until it catches
up (this is how the `chest` addition surfaced every body-side gap). Models:

- `crafting.test.ts`: `expect([...CRAFTABLE_ITEMS]).toEqual(schema.$defs.CraftParams.properties.item.enum)`
- `test_tool_schema.py`: case set equality against `DELIBERATE_ACTIONS`;
  `test_arrival_ranges_are_bounded_enums` pins the move/follow range enums
- `packages/events/test/validate.mjs`: a fixture whose action has no
  `PARAMS_DEF_BY_ACTION` entry fails loud (map kept in step with
  agent-service's `_PARAMS_DEF_BY_ACTION`) — fixture authoring itself: see
  the contract-change skill

## 8. Watchdog/executor tests: fake timers, exactly-one-outcome

Executor tests run `vi.useFakeTimers()` in beforeEach + `advanceTimersByTimeAsync`
and must cover the wedge invariants (all present in `executor.test.ts`):

- [ ] `execute()` RESOLVES after the watchdog fires even when the action
      promise never settles (the 2026-07-07 double wedge).
- [ ] Exactly one outcome per commandId — late completions suppressed,
      completions cancel the watchdog, superseded commands still get one.
- [ ] Busy released on every path including timeout.
- [ ] Oversized `timeoutMs` clamps to the ceiling; prose speaks the APPLIED
      deadline.
- [ ] Pin the full prescriptive `errorMessage` with `toBe` where the whole
      message is the contract (timeout/clamp prose — the villager reads it
      verbatim next tick); `toContain` only to assert a specific recovery
      lever appears in a longer message (the maxDistance/count lever tests).
- [ ] An UNCODED throw stays `INTERNAL` — a real bug must not wear an honest
      failure code.

## 9. Plumbing-code exemptions: each site tested

The canonical plumbing set lives in
`services/agent-service/src/agent_service/brain/awareness.py`
(`_PLUMBING_CODES` — includes `ABORTED` since unit-10; new codes join in the
same commit that lets them reach the wire). Every consumer that must ignore
plumbing gets its own test: `test_awareness.py::test_plumbing_failures_never_count`
(`abandon_after=1`), `skillsStats.test.ts` pins `isPlumbingCode` to the
awareness.py mirror AND that callers filter plumbing BEFORE seeding stats.

## 10. Integration tests: one session-scoped Postgres; all else Docker-free

Python suites request a session-scoped testcontainers fixture starting the
SAME image compose uses (`pgvector/pgvector:0.8.0-pg16`), run
`alembic upgrade head` before any test, and export connection env
(`services/agent-service/tests/conftest.py`; memory-service adds
`StubEmbeddings` with known per-topic vectors for deterministic ranking).
Offline tests never request the fixture, so plain pytest runs without Docker.
Java uses `@Testcontainers`/`@Container` (`EventStoreIntegrationTest.java`)
and parks scheduled clocks (section 4).

## 11. Architecture rules are structural tests, not review promises

"Module X must never import Y" → a test that walks the source tree and asserts
it, paired with a sanity check that the walk saw a plausible tree so an empty
glob can't pass vacuously. Model: `noPovInFleet.test.ts` (fleet src minus
`src/pov` never references prismarine-viewer; `fleetFiles.length > 10` guard).

## 12. Per-suite commands and sizes (counts verified by running, 2026-08-07)

From repo root, PowerShell. Never bare `python` (stale 3.8 on this box);
never bare `gradlew.bat` (NoDefaultCurrentDirectoryInExePath — and run it
from PowerShell, not Git Bash, which mangles `cmd /c`):

```powershell
task test                                            # all seven suites, in order
npm test --workspace @civ/events                     # contracts: validate.mjs fixture gate
npm test --workspace @civ/minecraft-service          # 761 tests / 51 files
npm run typecheck --workspace @civ/minecraft-service # tsc --noEmit — NOT in task test
cd services/agent-service; uv run pytest -q          # 247
cd services/memory-service; uv run pytest -q         # 51
cd services/event-service; cmd /c .\gradlew.bat test
cd services/government-service; cmd /c .\gradlew.bat test
cd bench; uv run --python 3.12 --with pytest pytest -q   # 25 — bench has NO pyproject by design
```

Traps: `task test` omits the minecraft typecheck even though HANDOFF counts
"tsc clean" as green — run it manually. The 25-test pytest suite is **bench**
(HANDOFF's "contracts 25" label is a mislabel; contracts is the validate.mjs
gate, not a counted pytest suite). Java integration suites need Docker up.

## Verification

Prove you followed this skill:

```powershell
# Suites green at the sizes above (run the ones your change touches + typecheck)
npm test --workspace @civ/minecraft-service; npm run typecheck --workspace @civ/minecraft-service

# New regression test carries date + real incident data (grep your own diff)
git diff --cached -U0 | Select-String -Pattern '202[0-9]-[01][0-9]-[0-3][0-9]'

# Tripwire tests still pin the committed schema (must FAIL if you grew an enum
# without updating the consumer)
npm test --workspace @civ/events

# No hardcoded fresh dates sneaked into freshness-guard tests
Select-String -Path services/agent-service/tests/test_percept_fanout.py -Pattern '_now\(\)' | Select-Object -First 1

cd services/agent-service; uv run pytest -q   # last — the cd changes cwd
```

A golden-test change is complete only when the regen command in the docstring
still reproduces the committed expected file.
