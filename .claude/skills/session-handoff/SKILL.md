---
name: session-handoff
description: Use when ending a session or writing durable state — a docs/HANDOFF.md entry, the CLAUDE.md HANDOFF section, correcting a published number where it landed (HANDOFF/commit/PR surfaces; deriving the corrected number itself is the bench-report skill), committing gitignored run evidence (bench/results, *.log), cleaning up .claude/worktrees, or choosing branch names, commit-message format, or squash-vs-merge style. Delivers the fixed-shape handoff entry, correction/suite-count honesty rules, green-boundary commit cadence, and safe worktree cleanup.
---

# Session handoff — writing durable state without lying to the next session

**When to use:** any session end; any edit to `docs/HANDOFF.md` or the
`## HANDOFF` section of `CLAUDE.md`; any correction to an already-published
number; committing run evidence that a report cites; removing or recovering
worktrees. **When not:** report traceability and derived-vs-typed report rules
are the **bench-report** skill; per-suite test doctrine and current sizes are
the **regression-test** skill; demo STATUS.md/RESULT.json check-off is the
**demo-filming** skill; running sweeps is the **race-sweep** skill.

## 1. The two handoff surfaces

- `docs/HANDOFF.md` — the session diary. Entries go **newest-first**.
- `CLAUDE.md` `## HANDOFF (current session)` — the rolling curated summary
  every future session auto-loads. Update it the same commit; prune superseded
  paragraphs rather than letting it grow unboundedly.
- `docs/CONTEXT-agent-brief.md` — when a dated brief exists, **it wins over
  older docs and handoff notes** (its own header says so). Check its date
  before re-litigating anything it marks SETTLED or FROZEN.

## 2. Fixed-shape entry (this checklist is authoritative; the twelfth-session entry in docs/HANDOFF.md is the closest model — it predates the suite-count and owner-decision rows)

- [ ] **Parker's brief** — what was asked, verbatim intent.
- [ ] **Root cause** — if the session was a fix, the mechanism, not the symptom.
- [ ] **What shipped** — PR numbers, branch, merge style used.
- [ ] **Validation with receipts** — attempt ids, decision mixes, ledger
      queries; numbers you sampled, not numbers you remember.
- [ ] **Suite counts, freshly run** (section 3 below).
- [ ] **Deploy state** — deployed vs merged-only vs code-landed-not-run.
      Mark the negatives explicitly: `NOT DEPLOYED`, `NOT RACED`, `NOT built`.
- [ ] **Open owner decisions** — anything blocked on Parker, labelled
      `OWNER DECISION OPEN` so it can't read as done.
- [ ] **Diagnosis traps for next time** — what a fresh session would
      misdiagnose and the probe that disambiguates.

## 3. Suite-size honesty — run, never copy

Cite a suite count only from output produced **this session**. The standing
incident: CLAUDE.md's HANDOFF labelled the 25-test suite "contracts 25", but
the 25-count pytest suite is **bench** (`bench/test_race_metrics.py`);
contracts is the `packages/events/test/validate.mjs` fixture gate, a different
thing entirely — copied counts drift into mislabels.

```powershell
task test          # all seven suites; record each suite's count from its own output
```

Per-suite commands live in the `test:` task of `Taskfile.yml` (and the
regression-test skill). Note `task test` does NOT run the minecraft-service
typecheck — if the entry claims "tsc clean", run it explicitly:

```powershell
npm run typecheck --workspace @civ/minecraft-service
```

## 4. Corrections: stated in place, never silent

When a published number turns out wrong (HANDOFF, commit message, PR body,
report), do not overwrite it as if it were always right — state the
correction where the number lives, with what changed and why. The model is
CLAUDE.md's move-range stat, corrected twice in one session with the full
chain kept ("first written off a four-sample snapshot… an 11-sample pass
corrected it… a 21-sample pass replaced the framing"). The chain is the
value: it teaches the next session how the error happened.

Rules that fall out of that incident:

- A number already propagated (commit message, PR, HANDOFF) gets the
  correction in **every** place it landed, not just the newest.
- Sampling/aggregate discipline for producing the number in the first place
  (sample-then-write, aggregates over "100% of N"): see the bench-report skill.

## 5. The stale-prose hazard: derive or date

Hand-written narrative drifts where generated artifacts do not — a runbook's
prose "Results" section can contradict the manifest-generated report beside
it (live example catalogued in the **bench-report** skill). When citing
numbers in HANDOFF/runbook prose, either **derive** them (point at the
generated file: `bench/results/AXIS_REPORT.md`, `sweep/manifest.json`) or
**date** them ("as of 2026-08-07, N=…") so a future reader knows the
freshness. Never restate a generated table's conclusion in prose without a
pointer to the artifact that can falsify it.

## 6. Green-boundary commit/push cadence

Commit AND push at every green boundary (suite pass, approved demo, working
checkpoint) — in a destroyed worktree, uncommitted working files are the only
unrecoverable state (SV-2, CLAUDE.md). Before ending any session:

```powershell
git status --porcelain    # empty, or every line accounted for in the handoff entry
```

An entry that leaves untracked work behind must name it and say why it is
uncommitted — the current tree's untracked `demos/event-driven-vs-wallclock/`
is exactly the state this rule exists to prevent.

Style (main's log doubles as the changelog and bench audit trail):

| Thing | Rule | Verified example |
|---|---|---|
| Branch | short kebab-case topic, no `type/` prefix | `unit10-skill-contract`, `v3-protocol` |
| Commit | `type(scope): headline — outcome (#N)`; body with real numbers | `44238d1` |
| Trailers | `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` + `Claude-Session: <url>` for session work | `d3da925` |
| Merge | squash single-purpose PRs; merge-commit multi-commit narrative branches whose hashes reports cite | `gh pr merge <N> --squash` / `--merge` |

## 7. Committing gitignored run evidence

`bench/results/*` and `*.log` are gitignored with an explicit allowlist in
`bench/.gitignore` (RACE_REPORT.md, AXIS_REPORT.md, `*.expected.json`,
`sweep/manifest.json`, sweep summaries). Evidence a committed report cites
must actually enter git:

```powershell
git check-ignore -v bench/results/<file>   # confirm which rule hides it
git add -f bench/results/<file>            # deliberate force-add (cb09802, 58f2166)
git ls-files bench/results                 # cross-check every filename the report cites
```

A report merged citing files that silently never entered git breaks the
traceability chain (`b51d46c` fixed a real filename mismatch after the fact).
Recurring artifact types: extend the allowlist instead of habitual `-f`.

## 8. Worktree cleanup discipline

- [ ] `git worktree list` — enumerate before touching anything.
- [ ] For each candidate: `gh pr list` (open PR on its branch?) and
      `git log --oneline -5 <branch>` (recent commits = recent activity).
- [ ] A file-locked `.claude/worktrees/<name>` dir means a LIVE session —
      do not remove it, do not check out its branch (SV-2: a cleanup pass
      destroyed a live session's worktree and re-implemented its ticket).
- [ ] Never let a root-repo `git add -A` sweep a sibling worktree in — it
      lands as an embedded-repo gitlink. `.gitignore`'s `.claude/worktrees/`
      line blocks it now (`d3da925`), but only for that path; if one is
      staged anyway: `git rm --cached <path>` (index-only, files untouched).
- [ ] Recovery procedures for a vanished worktree: the SV-2 gotcha in
      CLAUDE.md (re-`git worktree add`; hand-rebuild `.git\worktrees\<name>`
      metadata) — branches survive, only working files don't.

## Verification

Prove the skill was followed before closing the session:

```powershell
# 1. Suite counts in the entry came from THIS run (compare to what you wrote)
task test

# 2. Nothing left behind unaccounted for
git status --porcelain

# 3. Every evidence file the entry/report cites is tracked
git ls-files bench/results | Select-String <cited-filename>

# 4. No sibling worktree gitlink staged
git diff --cached --stat    # no bare .claude/worktrees/<name> entry

# 5. Handoff surfaces agree: docs/HANDOFF.md newest entry, CLAUDE.md HANDOFF
#    section, and docs/CONTEXT-agent-brief.md date do not contradict each other
```

Entry checklist passes when: every number has a same-session receipt, every
negative state is named, corrections carry their chain, and `git status` is
clean or explained.
