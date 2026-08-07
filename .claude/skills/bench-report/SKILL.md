---
name: bench-report
description: Use when writing, regenerating, or auditing any empirical writeup — bench/results/RACE_REPORT.md, bench/results/AXIS_REPORT.md, a docs/reports narrative, or benchmark numbers quoted in HANDOFF/runbook prose (win rates, time-to-goal, CIs, tokens/decision, latency percentiles). Delivers the derived-not-typed, sample-then-write, configVersion-comparability, and traceability rules that keep every published number reproducible from bench/results/sweep/manifest.json.
---

# Writing and auditing empirical reports

When to use: any time a benchmark statistic is about to land in prose or a
table — regenerating `RACE_REPORT.md` / `AXIS_REPORT.md`, writing a
`docs/reports/` narrative, quoting sweep numbers in `docs/HANDOFF.md` or a
runbook, or auditing any of these for staleness. NOT for running the sweep
that produces the data (see the race-sweep skill), the configVersion
bump-vs-fold-vs-metadata decision (see the contract-change skill), or
HANDOFF entry shape and worktree/commit cadence (see the session-handoff
skill).

## 1. The provenance chain — derived, never typed

`bench/results/sweep/manifest.json` → saved raw slices
(`bench/results/sweep/slices/*.slice.json` + `.window.json`) → per-run
`bench/results/race_<label>.json` → `bench/aggregate_race.py` →
`RACE_REPORT.md` / `AXIS_REPORT.md` + `race_sweep_summary.{json,csv}`.

- Every figure in the generated reports — including the threats-to-validity
  numbers — is computed by `aggregate_race.py`. The ONE hand-written element
  is the `FAILURE_GLOSS` verdict phrase (a dict in `aggregate_race.py`);
  every number beside it is derived.
- NEVER hand-edit a generated report. PR #92's audit corrected lfm2.5's
  numbers by hand inside `RACE_REPORT.md` and the next generator run
  silently reverted the correction. Fix the generator or the data, then
  regenerate.
- When the metric layer itself is wrong, fix the extractor and re-derive ALL
  history offline (stdlib-only — no ledger, no GPU, no docker):

```powershell
uv run python bench/bench_race.py --reextract   # recompute every race_<label>.json from saved slices
uv run python bench/aggregate_race.py           # rewrite RACE_REPORT.md, AXIS_REPORT.md, summaries
```

- Axis rows never share a table with model rows: the aggregator partitions
  on the manifest's `sweepKind` and writes `AXIS_REPORT.md` separately.
  Its Coverage section separates "missing coverage" from "recovered
  failures (audit trail)" — keep both; a silent truncation reads as coverage.

## 2. Writing a number into prose

- [ ] Sample first, THEN write. Compute from the full available sample
      before typing anything: the v8 move-range stat was first written off a
      4-sample snapshot and propagated into a commit message, PR #113, and
      the config history before two larger passes corrected it twice.
- [ ] Prefer an aggregate over a "100% of N" universal when N is small:
      "6.4 blocks total across 21 commands, 18 of 21 exactly zero" survives
      one counter-example; "every one was zero" did not.
- [ ] State precision limits when two nearby counts exist — the narrative
      report says it exactly: errorCode `INTERNAL` totals 4,399 while the
      pathfinder-timeout string is 4,280, "the two are not interchangeable".
- [ ] Never extrapolate a slope beyond its observed index span (the
      withdrawn +272.8 s figure multiplied a 3-step observed span by 4).
- [ ] Rates need floors — `aggregate_race.py` enforces
      `GATHER_RATE_MIN_SAMPLE = 50` (window-edge orphan outcomes can exceed
      the denominator and print 166.7%) and `CORRELATION_MIN_WINS = 3`;
      won-only correlations are selection artifacts the generator itself
      labels "should not be quoted".
- [ ] Corrections are withdrawn ON THE RECORD with the reason, never
      silently edited. Model: the wear section of
      `docs/reports/rb-race-model-sweep-2026-07-25.md` — "An earlier figure
      of +272.8 s was an off-by-one…" and the withdrawn "run index alone
      can account for the entire winner ranking" claim, disproved by the
      derived wear probe.

## 3. configVersion comparability

- A bump means "old rows are invalid, re-bench". Never pool a model's rows
  across versions; each model is reported at its HIGHEST version only.
- Keep the aggregator's banners: the version-mix blockquote ("Rows span
  configVersions … NOT comparable to each other") and the
  "Provisional rows (n < 3)" block — a bump retires a model's older rows,
  so a re-bench in progress shows at its true N; read N before the order.
- Every bump gets a `$versionHistory` entry in
  `bench/race/frozen-config.json` stating what changed and ending with the
  non-comparability claim (v3–v8 are the models to imitate; v2 is the
  byte-identical exception — comparability preserved, and its entry says so).
- Whether a change is a bump, a fold into an unraced bump, or no-bump
  metadata (lowercase frozen-config keys): the contract-change skill owns
  that decision tree. This skill owns the comparability consequence — e.g.
  after the v8 fold, the published table correctly still shows v7 rows
  until re-benched.

## 4. Stats layer

- Aggregate N runs via `stats.mean_ci95` (`bench/stats.py`): mean ±
  Student-t 95% CI, exact t-table through df=30, normal approximation above.
- n=1 renders as "X (n=1)", never with an interval (`fmt_ci` in
  `aggregate_race.py` handles it — qwen's single v2 win is the example).
- Percentiles use linear interpolation between closest ranks
  (`stats.percentile`); latency p50 is a true percentile of pooled raw
  per-decision samples, never a mean of per-team medians.
- Treat adjacent table rows as ties unless CIs separate — at n=5 the table
  shows reliability, not a ranking.
- DNF policy (kept-DNF win-rate denominator, won-only time-to-goal,
  tokens/decision as the headline column) is set at sweep/extraction time —
  see the race-sweep skill; when auditing, check the report restates it.

## 5. Narrative report structure

Model: `docs/reports/rb-race-model-sweep-2026-07-25.md`.

- [ ] Header provenance block: Date · Data (kept + discarded counts, date
      range) · Protocol (`bench/race/frozen-config.json`) · Numbers table
      path · Attempt ids ("every claim below traces to one" in
      `bench/results/sweep/manifest.json`) · PRs.
- [ ] Threats-to-validity section that distinguishes FIXED (name the
      version or layer that fixed it) from unfixable-for-these-rows,
      recorded as a threat rather than corrected as an error (e.g.
      time-of-day ran free in v1/v2 — not reconstructible).
- [ ] Decisions about future work never retract collected data: the roster
      exclusion lives in frozen-config `modelRoster` and the report says
      "The rows themselves stand: this is a decision about future
      GPU-hours, not a retraction of data."

## 6. Fresh-eyes traceability pass (before publishing)

Run it as a reviewer who did not write the report — the Phase-3 pass
verified 30/30 attempt ids and all 25 aggregate cells, and caught 3 stale
lfm2.5 run-1-only numbers plus qwen overstatements that had propagated
into BOTH reports from earlier PR prose.

- [ ] Every attempt id quoted in the text exists in `manifest.json`.
- [ ] Every appendix row and aggregate cell reproduces from manifest +
      `race_<label>.json` (or rerun `--reextract` + aggregate and diff).
- [ ] Claims unverifiable from the repo (smoke timings, param counts):
      source them secondarily and say so, or cut them.

## 7. The stale-prose scan

Generated artifacts self-correct on regeneration; hand-written narrative
does not. The canonical example (found and corrected in place 2026-08-07):
the "Results" section of `docs/runbooks/race-sensitivity-sweep.md` and
CLAUDE.md's "3b RESULTS" paragraph both claimed ctx "4096 / 8192 / 16384
all went 5/5" for over a week AFTER the manifest showed all five ctx-16384
rows retroactively discarded (`outcome: "contaminated"`, Elara reconnect
storm) plus one block-setup failure — the generated `AXIS_REPORT.md`
showed N=0 the whole time. The corrections now sit in those docs as the
model for stating a correction where the number lived.

When touching ANY prose that quotes sweep numbers:

- [ ] For each "arm/model went X/N" claim, count kept rows in the manifest:

```powershell
uv run python -c "import json; rs=json.load(open('bench/results/sweep/manifest.json'))['runs']; print(sum(1 for r in rs if r.get('axisValue')=='16384' and not r['discarded']))"
```

      (`uv run python`, never bare `python` — the CLAUDE.md stale-3.8 gotcha.)
- [ ] Derive the number fresh or date it ("as of the 2026-07-26 sweep");
      same for suite counts — run the suite, don't copy (the HANDOFF's old
      "contracts 25" mislabel, corrected 2026-08-07, was a copied count).
- [ ] If prose and a generated artifact disagree, the generated artifact
      wins: fix the prose and state the correction in place.

## Verification

```powershell
# 1. Reports match generator + data — an empty diff proves nothing was hand-typed:
uv run python bench/aggregate_race.py
git diff --stat bench/results/RACE_REPORT.md bench/results/AXIS_REPORT.md

# 2. Extractor still golden (Tier A flagship slice + Tier B sweep fixture):
cd bench && uv run --python 3.12 --with pytest pytest -q

# 3. Comparability banners present where they should be:
Select-String -Path bench/results/RACE_REPORT.md -Pattern 'NOT comparable|Provisional rows|\(n=1\)'

# 4. Spot-check one quoted table N against kept manifest rows — filter the
#    configVersion too (pooling versions here returns 24, the table says 5),
#    and use .get: legacy rows carry no configVersion/sweepKind key:
uv run python -c "import json; rs=json.load(open('bench/results/sweep/manifest.json'))['runs']; print(sum(1 for r in rs if r['model']=='llama3.1:8b' and r.get('configVersion')==7 and r.get('sweepKind','model')=='model' and not r['discarded']))"   # -> 5
```

A published narrative additionally passes section 6 in full: every attempt
id resolves, every cell reproduces, unverifiable claims are sourced or cut.
