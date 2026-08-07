---
name: best-practices-audit
description: Use when asked to audit a diff, PR, branch, or the whole repo against this project's own rules — "check this against our doctrine", "conformance sweep", "what rules are we breaking" — or before merging changes that touch packages/events, infrastructure/docker/docker-compose.yml, Taskfile.yml, .github/workflows, or HANDOFF/runbook numbers. Delivers greppable per-domain checks, the known-open-violations baseline as of 2026-08-07, and a re-verify-then-report procedure. It reports; it never fixes.
---

# Best-practices audit

When to use: any request to check work (a diff, a PR, a service, the whole
tree) against this repo's own established rules. This skill is AUDIT-ONLY —
it produces a findings report, never edits. For the procedure behind a
finding, hand off by name: contract changes → the contract-change skill;
deploys → deploy-service; minecraft-service code → mineflayer-runtime; test
authoring → regression-test; sweep execution → race-sweep; report numbers →
bench-report; live-system interrogation → live-forensics; clips →
demo-filming; end-of-session state → session-handoff. Do not use this skill
to fix what it finds — report, then let the owner or a follow-up task fix.

All commands run from the repo root; PowerShell unless marked.

## A. Per-domain checks

Run every check whose domain the audited scope touches. Each is a command
plus an interpretation rule.

### C1 — contract seams complete (domain: contracts)

Any diff touching `packages/events/schemas/` must also touch fixtures,
committed generated types, and the body/brain seams (full walk: the
contract-change skill).

```powershell
task gen; git status --porcelain packages/events   # dirty => generated-type drift
npm test --workspace @civ/events                   # the fixture/validate.mjs gate
```

- Dirty output after `task gen` = uncommitted codegen. Known blind spot: the
  gate has missed a revert-shaped divergence (doc `docs/architecture/10-skill-tool-schema.md`
  §6.2 — the WHY is still unanswered), so a clean gate on a revert PR proves less.
- Grep the diff: a schema enum/verb change with no matching edit in
  `services/agent-service/src/agent_service/llm/contract.py` or
  `services/minecraft-service/src/world/` is an incomplete seam walk.

### C2 — body-side enum tripwires exist (domain: contracts/testing)

Every schema enum the executor consumes needs a test that loads the schema
file and asserts exact equality (authoring pattern: the regression-test skill).

```powershell
Select-String -Path services\minecraft-service\test\*.test.ts -Pattern 'ActionRequested.v1.schema.json' -List | Select-Object Filename
```

Compare that file list against the enums in
`packages/events/schemas/commands/ActionRequested.v1.schema.json` ($defs:
GatherParams, CraftParams, HuntParams, PlaceParams, StoreParams,
RetrieveParams…). An enum with no schema-reading test can grow without a
body-side failure (that silence is how `chest` stayed uncraftable until the
crafting.test.ts tripwire fired).

### C3 — compose forwards every knob the code reads (domain: deploy)

```powershell
$keys = Select-String -Path services/minecraft-service/src/config.ts -Pattern '^\s{2}([A-Z][A-Z0-9_]+):' | ForEach-Object { $_.Matches.Groups[1].Value }
$compose = Get-Content infrastructure/docker/docker-compose.yml -Raw
$keys | Where-Object { $compose -notmatch $_ }
```

Output = knobs a deployed container can NEVER receive (compose interpolation
only forwards listed vars — deploy-service skill). Not every hit is a bug:
flag a knob when a doc, HANDOFF entry, or runbook claims it is tunable at
deploy time (e.g. "run PLUGIN_ARMOR_MANAGER=0"). Repeat the pattern for
other services' settings files when scope touches them.

### C4 — `task test` covers what HANDOFF calls green (domain: testing/CI)

`Taskfile.yml`'s `test` task runs seven suites but NOT
`npm run typecheck --workspace @civ/minecraft-service`, while HANDOFF cites
"tsc clean" as part of green. Until fixed, an audit of "suite green" claims
must run it manually:

```powershell
npm run typecheck --workspace @civ/minecraft-service
```

Also verify claimed suite COUNTS by running the suite, never by copying
prose (see V11 below and the session-handoff skill).

### C5 — prose numbers match generated artifacts (domain: reporting)

Hand-written narrative drifts; generated reports do not. For every number in
CLAUDE.md HANDOFF, `docs/runbooks/*.md`, or `docs/reports/*.md` inside scope,
find its generated source (`bench/results/AXIS_REPORT.md`, `RACE_REPORT.md`,
`bench/results/sweep/manifest.json`) and diff the claim. Full traceability
doctrine: the bench-report skill.

```powershell
Select-String -Path docs\runbooks\race-sensitivity-sweep.md, CLAUDE.md -Pattern '16384'   # the live example, V12/V13
```

### C6 — name families agree (domain: runtime)

Three sources of block/item names must not diverge: hardcoded family lists,
skill-layer lists, and schema enums. Compare:
`RESOURCE_BLOCKS` (`services/minecraft-service/src/world/resources.ts`) vs
`WOOD_LOGS` (`services/minecraft-service/src/skills/names.ts`) vs
`STORAGE_FAMILIES` (`services/minecraft-service/src/world/skillVerbs.ts`).
Registry-resolved families (the `food` family resolves live off
`registry.foods`) are the correct pattern; hardcoded twins drift (V14/V15).

### C7 — CI paths filters self-include (domain: CI)

Caller workflows must list their own file, the reusable workflow, and
`packages/events` where consumed (CLAUDE.md gotcha):

```powershell
Get-ChildItem .github\workflows\*.yml | Where-Object Name -ne '_reusable-service.yml' | ForEach-Object { $raw = Get-Content $_.FullName -Raw; if ($raw -match 'paths:' -and $raw -notmatch [regex]::Escape($_.Name)) { "MISSING self-include: $($_.Name)" } }
```

No output = pass (passes as of 2026-08-07).

### C8 — rpk produce defense-in-depth (domain: deploy)

Scripts that `rpk topic produce` onto live topics should pass `-z none`
(rpk's default snappy killed agent-service's consumer once — CLAUDE.md):

```powershell
Select-String -Path scripts\*.mjs -Pattern "rpk', 'topic', 'produce'" -List | Select-Object Filename
```

Any listed script without `-z none` in its rpk argv is a finding. As of
2026-08-07 all seven hits (produce-cmd, produce-gov-cmd, spawn-fleet,
despawn-fleet, spawn-teams, drill-rb1, drill-rb2) lack it — safe only while
no Python service consumes `commands.*`.

### C9 — failure-code classification is TRUE about the wire (domain: contracts/brain)

Every code the executor emits must be in the ActionFailed enum, and every
plumbing code in `_PLUMBING_CODES`
(`services/agent-service/src/agent_service/brain/awareness.py`) in the same
commit that lets it reach the wire. Check: grep new `errorCode` emissions in
the diff against both tables, plus `RETRYABLE_BY_CODE`
(`services/minecraft-service/src/world/skillVerbs.ts`).

## B. Known open violations — baseline 2026-08-07

Re-verify before reporting (section C); some may be fixed by the time you run.
Format: V# (check that finds it) — location: finding.

**Contracts / tripwires**
- V1 (C9) — `docs/architecture/10-skill-tool-schema.md` §3.1 vs `awareness.py:23`: INTERNAL is substantive-by-omission from `_PLUMBING_CODES`, yet that doc's own corpus (§3.1's bench window) counts ~4,361 of 4,905 INTERNAL occurrences as one pathfinder-timeout infrastructure string; carve-out flagged, designed nowhere. (The 4,399/4,280 pair quoted in bench-report comes from the narrative report's different window — two measurements, not a disagreement; don't cross-correct.)
- V2 (C1) — same doc §6.2: WHY the drift gate missed a revert-shaped divergence is unanswered; a gate that misses reverts will miss the next one.
- V3 (C2) — `skillVerbs.ts` `STORAGE_FAMILIES` mirrors the Store/Retrieve item enum but `skillVerbs.test.ts` never loads the schema — enum can grow silently.
- V4 (C2) — `PlaceParams.item` enum (crafting_table/furnace/chest) has no schema-reading tripwire; only crafting.test.ts and hunting.test.ts read the schema.
- V5 (C2) — doc rule R1 claims stub-params-vs-$defs divergence "is a CI failure", but no test compares `SkillSchemaStub.params` to the schema $defs.

**Deploy / compose**
- V6 (C3) — compose does not forward `MOVE_MAX_DISTANCE` (config.ts, wired in src/index.ts): far-target gate untunable in deploys; recorded in `docs/CONTEXT-agent-brief.md`.
- V7 (C3) — compose does not forward `PLUGIN_COLLECTBLOCK/TOOL/PVP/AUTO_EAT/ARMOR_MANAGER`: the documented PLUGIN_ARMOR_MANAGER=0 toggle cannot reach a deployed fleet.
- V8 (C3) — compose does not forward `COMMAND_MAX_AGE_SECONDS`: freshness-guard window fixed at 600 in deploys.
- V9 (C8) — produce-cmd/spawn-fleet/despawn-fleet (and four more scripts C8 finds) rpk-produce without `-z none`.

**Testing / CI**
- V10 (C4) — Taskfile `test` omits the minecraft-service typecheck script; "tsc clean" must be remembered manually.

**Docs / prose drift**
- V11 (C4) — CLAUDE.md HANDOFF labels the 25-test pytest suite "contracts 25"; the 25-count suite is bench (contracts is the validate.mjs fixture gate).
- V12 (C5) — `docs/runbooks/race-sensitivity-sweep.md` "Results" still claims ctx 4096/8192/16384 all 5/5, but the manifest shows ALL FIVE ctx-16384 rows retroactively discarded (contaminated) — AXIS_REPORT.md correctly shows the arm at 0 kept.
- V13 (C5) — CLAUDE.md "3b RESULTS" paragraph carries the same stale "all 5/5" claim.

**Name families**
- V14 (C6) — `RESOURCE_BLOCKS.wood` is 8 logs ending at cherry_log; `WOOD_LOGS` carries 10 (adds pale_oak_log, bamboo_block): a wood gather cannot see logs the skill layer can mine.
- V15 (C6) — `STORAGE_FAMILIES.wood` derives from `RESOURCE_BLOCKS.wood`, inheriting the gap into store/retrieve; the food family resolves live off the registry and is the fix pattern.

**Session hygiene**
- V16 (session-handoff skill) — tree held uncommitted work at 2026-08-07 session start (untracked .vscode/, demos/event-driven-vs-wallclock/, papers/Many-agentSimulationsTowardAICivilization.pdf; modified papers/MineLand.pdf) against the green-boundary push rule. Re-check: `git status --porcelain`.

## C. Audit procedure

- [ ] Fix the scope: diff, PR, service, or whole repo. List which domains it touches.
- [ ] Run every section-A check for those domains; capture command output.
- [ ] For each baseline V# in scope, RE-RUN its check now — report each as
      STILL-OPEN (with fresh evidence), FIXED (name the commit/PR if findable
      via `git log --oneline -- <path>`), or CHANGED (describe).
- [ ] New findings get the next V number, the same one-line format, and the
      check that found them; propose appending them to this file's section B
      (proposing the edit is reporting, not fixing).
- [ ] Report format: per-domain findings, most severe first, each with its
      evidence command and output. Do NOT fix anything — even one-line fixes.

## Verification

Prove the audit ran, not just read:

```powershell
task gen; git status --porcelain packages/events        # C1 evidence captured
npm test --workspace @civ/events                        # exit 0 or a finding
npm run typecheck --workspace @civ/minecraft-service    # C4 evidence
git status --porcelain                                  # V16 disposition
```

- The report contains a disposition (STILL-OPEN / FIXED / CHANGED) for every
  baseline V# inside scope — none skipped, none copied from this file without
  a fresh command run.
- Every reported number/count was produced by a command in this session, not
  quoted from CLAUDE.md or a runbook (the C5 rule applied to your own report).
- No working-tree modifications: `git status --porcelain` shows the same
  set before and after the audit (reports go to the conversation, not files).
