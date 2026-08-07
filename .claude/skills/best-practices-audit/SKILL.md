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
task gen; git diff --numstat -- packages/events/generated   # non-empty => real drift
npm test --workspace @civ/events                            # the fixture/validate.mjs gate
```

- Use `git diff --numstat`, NOT `git status`: on Windows `task gen` rewrites
  files with CRLF, so `git status` reports files whose content is identical
  (`.gitattributes` normalizes them to LF on add). `--numstat` shows the real
  line delta and skips that false positive.
- Non-empty output = uncommitted codegen. The gate's historical blind spot
  (doc §6.2) was ENFORCEMENT, not detection — it fired and was merged past.
  Verify enforcement with C10, not just the workflow file.
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

`Taskfile.yml`'s `test` task includes the minecraft-service typecheck since
2026-08-07 (V10 fixed). The check remains: whenever a doc claims a suite or
gate is "part of green", confirm the `test:` task actually runs it, and
verify claimed suite COUNTS by running the suite, never by copying prose
(see V11 below and the session-handoff skill).

### C5 — prose numbers match generated artifacts (domain: reporting)

Hand-written narrative drifts; generated reports do not. For every number in
CLAUDE.md HANDOFF, `docs/runbooks/*.md`, or `docs/reports/*.md` inside scope,
find its generated source (`bench/results/AXIS_REPORT.md`, `RACE_REPORT.md`,
`bench/results/sweep/manifest.json`) and diff the claim. Full traceability
doctrine: the bench-report skill.

```powershell
Select-String -Path docs\runbooks\race-sensitivity-sweep.md, CLAUDE.md -Pattern '16384'   # V12/V13: hits must be the stated CORRECTIONs, not bare 5/5 claims
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

Any listed script without `-z none` in its rpk argv is a finding. All seven
hits (produce-cmd, produce-gov-cmd, spawn-fleet, despawn-fleet, spawn-teams,
drill-rb1, drill-rb2) gained the flag 2026-08-07 (V9 fixed) — the check
remains for NEW scripts that produce onto live topics.

### C10 — gates are ENFORCED, not merely present (domain: CI)

A workflow file proves a gate RUNS; only branch protection proves it BLOCKS.
This distinction cost the repo a stale-generated-types merge (V2): the
contracts check went red on PR #109 and the PR merged 18 seconds later.

```powershell
gh api repos/parkershamblin/minecraft-ai-agents/branches/main/protection -q '.required_status_checks.contexts'
```

Expect `contracts` and `ci / test`. A 404 means every gate in the repo is
advisory. Also spot-check that a recently-merged PR's checks were green:

```powershell
gh pr list --state merged --limit 5 --json number,headRefOid | ConvertFrom-Json | ForEach-Object { $_ } | ForEach-Object { "PR $($_.number)"; gh api "repos/parkershamblin/minecraft-ai-agents/commits/$($_.headRefOid)/check-runs" -q '.check_runs[] | select(.conclusion=="failure") | .name' }
```

### C11 — the two plumbing mirrors agree (domain: contracts/brain)

`_PLUMBING_CODES` (awareness.py) and `PLUMBING_CODES` (skills/stats.ts) are
the same vocabulary in two languages. `ABORTED` sat in one and not the other
from unit-10 until 2026-08-07 because the test asserted membership for a
hardcoded list instead of set equality (V17).

```powershell
npx vitest run test/skillsStats.test.ts --root services/minecraft-service
```

The test now parses awareness.py and asserts equality both directions; a
green run IS the check. Any new hardcoded-list test of a mirrored vocabulary
is itself a finding — assert set equality against the canonical source.

### C9 — failure-code classification is TRUE about the wire (domain: contracts/brain)

Every code the executor emits must be in the ActionFailed enum, and every
plumbing code in `_PLUMBING_CODES`
(`services/agent-service/src/agent_service/brain/awareness.py`) in the same
commit that lets it reach the wire. Check: grep new `errorCode` emissions in
the diff against both tables, plus `RETRYABLE_BY_CODE`
(`services/minecraft-service/src/world/skillVerbs.ts`).

## B. Violations baseline — V1–V16 found 2026-08-07, V17–V18 in the round-2
## re-audit the same day. ALL EIGHTEEN are FIXED.

There is no open violation as of 2026-08-07. That is a snapshot, not a
guarantee: re-verify every disposition before reporting (section C) — a FIXED
item can regress, and a green baseline is exactly when an audit gets lazy.
When every item below still checks out, say so in one line and spend the
effort on section A's checks against the CURRENT diff instead.
Format: V# (check that finds it) [disposition] — location: finding.

**Contracts / tripwires**
- V1 (C9) [FIXED 2026-08-07] — the INTERNAL pathfinder carve-out shipped. `src/world/pathfinderErrors.ts` classifies bare pathfinder rejections at the executor's single catch-all: `PATH_SEARCH_EXHAUSTED` (NEW code, plumbing, retryable) for the 12,067-event search-budget string, `PATH_NOT_FOUND` (existing, substantive, non-retryable) for the 2,278 "No path to the goal!", `ABORTED` for the 332 cancellations. Unknown throws still become INTERNAL. Ledger-counted from event_db, all history — the doc's older 4,361/4,905 figure was one bench window, not the corpus.
- V2 (C1) [FIXED 2026-08-07] — ANSWERED then closed: the gate never missed the revert. PR #109's `contracts` check concluded `failure` and the PR merged 18s later because `main` had NO branch protection (404). Protection now requires `contracts` + `ci / test` (admins exempt, non-strict). See C10 — check enforcement, not just the workflow.
- V3 (C2) [FIXED 2026-08-07] — `skillVerbs.test.ts` "contract tripwire (schema-read)" now pins STORAGE_FAMILIES (+food) to the Store/Retrieve item enums.
- V4 (C2) [FIXED 2026-08-07] — same describe block asserts every `PlaceParams.item` member is craftable (the CONTAINER_NOT_FOUND recovery invariant).
- V5 (C2) [FIXED 2026-08-07] — the gate R1 claimed now exists: `test/skillSchemaStubs.test.ts` loads every `*Schema` export in `skills/library/` and asserts R2 closure, R3 (no optional properties; nullable enums as `anyOf`), and failure-code reachability against the committed ActionFailed enum. The byte-equality clause is written and self-activates when a stub name enters the contract's action enum; it asserts the promoted set is empty today, so the dormancy is stated rather than skipped.

**Deploy / compose**
- V6–V8 (C3) [FIXED 2026-08-07] — `MOVE_MAX_DISTANCE`, the five `PLUGIN_*` flags, and `COMMAND_MAX_AGE_SECONDS` now forwarded in the minecraft-service compose block with code-default values.
- V9 (C8) [FIXED 2026-08-07] — all seven rpk-producing scripts pass `-z none`; check remains for new scripts.

**Testing / CI**
- V10 (C4) [FIXED 2026-08-07] — Taskfile `test` now runs the minecraft-service typecheck between the vitest suite and the Python suites.

**Docs / prose drift**
- V11 (C4) [FIXED 2026-08-07] — CLAUDE.md "contracts 25" corrected in place to "bench 25" with the correction stated.
- V12 (C5) [FIXED 2026-08-07] — `docs/runbooks/race-sensitivity-sweep.md` Results section corrected in place: 25 kept rows, ctx conclusion rests on two arms, the −224 s figure withdrawn.
- V13 (C5) [FIXED 2026-08-07] — CLAUDE.md "3b RESULTS" paragraph corrected the same way.

**Name families**
- V14/V15 (C6) [FIXED 2026-08-07] — `RESOURCE_BLOCKS.wood` now derives from `WOOD_LOGS` (bamboo_block filtered as a non-world block), so STORAGE_FAMILIES inherits pale oak; regression test "pale oak counts as wood end-to-end" in skillVerbs.test.ts.

**Session hygiene**
- V16 (session-handoff skill) [FIXED 2026-08-07] — tree cleared, each item on its merits after reading it: `demos/event-driven-vs-wallclock/compute_metrics.py` committed (real A/B analysis for the event-driven arc, and it imports `_PLUMBING_CODES` live so contract changes flow into it); both papers committed via LFS; `.vscode/` + `.idea/` gitignored rather than tracked (auto-written by the VS Code Java extension, and this repo has never tracked IDE config). Re-check: `git status --porcelain`.

**Found in round 2 (2026-08-07)**
- V17 (C11) [FIXED 2026-08-07] — `skills/stats.ts` `PLUMBING_CODES` was missing `ABORTED`, which joined `awareness.py` in unit-10: the mastery table booked skill failures the brain had already ruled plumbing. The guarding test asserted membership for six hardcoded codes instead of set equality, so it stayed green through the drift. Test replaced with a parse-and-compare tripwire.
- V18 (C1) [FIXED 2026-08-07] — the local C1 command produced a false positive on Windows (`git status` flags CRLF-only rewrites from `task gen`); check now uses `git diff --numstat`.

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
