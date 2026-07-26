"""Tier A golden test — locks the RB-race metric extractor to the committed
flagship fixture (film/flagship-slice.json, attempt 019f9361…, Phase 0's
filmed take). If the extractor's computation drifts, this fails; if the drift
is intentional, regenerate the expected doc with:

    uv run python bench/bench_race.py --slice film/flagship-slice.json --label flagship

and copy the tierA object into race_flagship.expected.json.

Tier B is golden-locked to the first Phase 2 sweep run (bench-llama3.1-8b-r1,
attempt 019f9400…): its attempt + villager-window slices are committed under
bench/race/fixtures/, verified 3-way at capture time (offline computation ==
live extraction during the run == fresh ledger re-fetch). Regenerate the
expected doc after an intentional drift with:

    uv run python bench/bench_race.py \
        --slice bench/race/fixtures/bench-llama3.1-8b-r1.slice.json \
        --window-slice bench/race/fixtures/bench-llama3.1-8b-r1.window.json \
        --label tierb-regen

and copy the result over race_bench-llama3.1-8b-r1.expected.json.

The synthetic cases at the bottom lock the two 2026-07-25 validity fixes with
hand-computable numbers, because the fixture alone cannot distinguish them: on
a real run the two teams' latency distributions nearly coincide, so the pooled
percentile and the old mean-of-medians agree to ~1%. The synthetic window
separates the teams by two orders of magnitude, where the two methods disagree
by 2x and only one of them is a percentile.
"""

import json
from pathlib import Path

import aggregate_race
import bench_race

BENCH_DIR = Path(__file__).resolve().parent
REPO_ROOT = BENCH_DIR.parent
SLICE = REPO_ROOT / "film" / "flagship-slice.json"
EXPECTED = BENCH_DIR / "results" / "race_flagship.expected.json"
FIXTURES = BENCH_DIR / "race" / "fixtures"
TIERB_SLICE = FIXTURES / "bench-llama3.1-8b-r1.slice.json"
TIERB_WINDOW = FIXTURES / "bench-llama3.1-8b-r1.window.json"
TIERB_EXPECTED = BENCH_DIR / "results" / "race_bench-llama3.1-8b-r1.expected.json"


def compute():
    name_of, _ = bench_race.load_roster()
    return bench_race.tier_a(bench_race.load_slice(SLICE), name_of)


def test_headline_numbers():
    a = compute()
    assert a["winner"] == {"team": "blue", "villager": "Ansel"}
    assert a["durationSeconds"] == 911.4
    assert a["honestRace"] == {"fakeProviderDelta": 0, "budgetTrippedDelta": 0}
    # blue crossed all 5 rungs; red was 3 rungs deep when the race ended
    assert list(a["milestones"]["blue"]) == bench_race.MILESTONES
    assert list(a["milestones"]["red"]) == ["first_coal", "first_iron_ore", "furnace_placed"]


def test_tier_a_matches_expected_doc():
    expected = json.loads(EXPECTED.read_text(encoding="utf-8"))
    assert compute() == expected


def test_roster_is_seed_sourced():
    # 6 race villagers carry a team field in the single-source seed roster
    _, team_of = bench_race.load_roster()
    assert sorted(team_of.values()).count("red") == 3
    assert sorted(team_of.values()).count("blue") == 3


def compute_sweep_run():
    # extract_pair, not tier_a/tier_b separately: Tier B's tokensPerMinute needs
    # Tier A's durationSeconds, so the tiers must be paired the same way the
    # sweep and --reextract pair them or the expected doc would never match.
    name_of, team_of = bench_race.load_roster()
    return bench_race.extract_pair(
        bench_race.load_slice(TIERB_SLICE),
        bench_race.load_slice(TIERB_WINDOW),
        name_of, team_of,
    )


def test_tier_b_matches_expected_doc():
    expected = json.loads(TIERB_EXPECTED.read_text(encoding="utf-8"))
    assert compute_sweep_run() == expected


def test_tier_b_headline_numbers():
    b = compute_sweep_run()["tierB"]
    assert set(b) == {"red", "blue", bench_race.RUN_BLOCK_KEY}
    for name, team in b.items():
        if name == bench_race.RUN_BLOCK_KEY:
            continue
        # every counter grouped and non-empty — the live-smoke sanity, locked
        assert team["gatherRequests"] > 0
        assert team["gatheredTotal"] > 0
        assert 0 <= team["wasteRatio"] <= 1
        assert team["llm"]["decisions"] > 0
        assert team["llm"]["tokensUsed"] > 0
        assert team["llm"]["latencyMsP50"] <= team["llm"]["latencyMsP95"]


def test_run_block_is_consistent_with_the_teams():
    """The run block must be the SAME sample as the teams, just pooled — a
    drifting denominator here would silently rescale every table column."""
    result = compute_sweep_run()
    b = result["tierB"]
    run = b[bench_race.RUN_BLOCK_KEY]["llm"]
    teams = [t for k, t in b.items() if k != bench_race.RUN_BLOCK_KEY]
    assert run["decisions"] == sum(t["llm"]["decisions"] for t in teams)
    assert run["tokensUsed"] == sum(t["llm"]["tokensUsed"] for t in teams)
    assert run["tokensPerDecision"] == round(run["tokensUsed"] / run["decisions"], 1)
    # duration comes from Tier A, and the rate is per MINUTE not per second
    duration = result["tierA"]["durationSeconds"]
    assert b[bench_race.RUN_BLOCK_KEY]["durationSeconds"] == duration
    assert run["tokensPerMinute"] == round(run["tokensUsed"] / (duration / 60), 1)
    # a pooled percentile is bracketed by the two team percentiles it pools
    lat = run["latencyMs"]
    assert lat["n"] == run["decisions"]
    p50s = [t["llm"]["latencyMsP50"] for t in teams]
    assert min(p50s) <= lat["p50"] <= max(p50s)
    assert lat["p50"] <= lat["p90"] <= lat["p95"] <= lat["p99"]


# --------------------------------------------------------------------------
# Synthetic window — the two 2026-07-25 validity fixes, by hand
# --------------------------------------------------------------------------

def synthetic_window():
    """Six DecisionMade events, three per team, with the teams' latency
    distributions deliberately two orders of magnitude apart."""
    _, team_of = bench_race.load_roster()
    by_team: dict[str, list[str]] = {}
    for villager_id, team in team_of.items():
        by_team.setdefault(team, []).append(villager_id)
    latencies = {"red": [10, 20, 30], "blue": [1000, 2000, 3000]}
    events = []
    for team, values in latencies.items():
        villager = sorted(by_team[team])[0]
        for i, ms in enumerate(values):
            events.append({
                "eventType": "DecisionMade",
                "payload": {
                    "villagerId": villager,
                    "latencyMs": ms,
                    "tokensUsed": 100,
                    # one schema-violation fallback: real cost, decision idle
                    "error": team == "blue" and i == 0,
                },
            })
    return events


def test_pooled_latency_is_a_percentile_not_a_mean_of_medians():
    _, team_of = bench_race.load_roster()
    b = bench_race.tier_b(synthetic_window(), team_of, duration_seconds=120.0)

    # per-team fields keep their old per-team meaning (other consumers + CSV)
    assert b["red"]["llm"]["latencyMsP50"] == 20.0
    assert b["blue"]["llm"]["latencyMsP50"] == 2000.0

    # what the aggregator USED to compute: decision-weighted mean of team p50s
    weighted_mean_of_medians = (20.0 * 3 + 2000.0 * 3) / 6
    assert weighted_mean_of_medians == 1010.0

    # what it computes now: p50 of the pooled sample [10,20,30,1000,2000,3000].
    # Interpolated rank 0.5*(6-1) = 2.5 → 30 + (1000-30)*0.5 = 515.
    lat = b[bench_race.RUN_BLOCK_KEY]["llm"]["latencyMs"]
    assert lat["p50"] == 515.0
    assert lat["p50"] != weighted_mean_of_medians
    assert lat["n"] == 6
    # rank 0.9*5 = 4.5 → 2000 + (3000-2000)*0.5
    assert lat["p90"] == 2500.0
    assert lat["p99"] == 2950.0


def test_error_fallbacks_stay_in_the_sample():
    """Schema-violation fallbacks are counted, not dropped: they cost real
    latency and real tokens, and for the worst models they ARE the run."""
    _, team_of = bench_race.load_roster()
    run = bench_race.tier_b(synthetic_window(), team_of, 120.0)[bench_race.RUN_BLOCK_KEY]["llm"]
    assert run["decisions"] == 6
    assert run["decisionsWithError"] == 1
    assert run["latencyMs"]["n"] == 6  # the error row's 1000ms is in there
    assert run["tokensUsed"] == 600


def test_tokens_per_decision_is_window_length_invariant():
    """THE point of the token fix: a stalled model's 75-minute watchdog window
    must not make it look hungrier than a model that won in 10 minutes."""
    _, team_of = bench_race.load_roster()
    short = bench_race.tier_b(synthetic_window(), team_of, 120.0)[bench_race.RUN_BLOCK_KEY]["llm"]
    long = bench_race.tier_b(synthetic_window(), team_of, 4500.0)[bench_race.RUN_BLOCK_KEY]["llm"]

    assert short["tokensUsed"] == long["tokensUsed"] == 600  # the old column
    assert short["tokensPerDecision"] == long["tokensPerDecision"] == 100.0
    assert short["tokensPerMinute"] == 300.0   # 600 tokens / 2.0 min
    assert long["tokensPerMinute"] == 8.0      # 600 tokens / 75.0 min

    # no duration (Tier A absent) → explicitly None, never a silent wrong rate
    no_duration = bench_race.tier_b(synthetic_window(), team_of)[bench_race.RUN_BLOCK_KEY]
    assert no_duration["durationSeconds"] is None
    assert no_duration["llm"]["tokensPerMinute"] is None
    assert no_duration["llm"]["tokensPerDecision"] == 100.0


def test_aggregator_reads_the_pooled_run_block():
    """pooled_tier_b must take latency + token rates from the run block and
    must NOT fold the run block into the per-team counter sums."""
    _, team_of = bench_race.load_roster()
    per_run = aggregate_race.pooled_tier_b(
        bench_race.tier_b(synthetic_window(), team_of, 120.0))
    assert per_run["latencyMsP50"] == 515.0
    assert per_run["latencyMsP99"] == 2950.0
    assert per_run["tokensUsed"] == 600.0
    assert per_run["tokensPerDecision"] == 100.0
    assert per_run["tokensPerMinute"] == 300.0
    # synthetic window has no gather/action events at all — if the run block
    # had been summed as a team this would have raised KeyError instead
    assert per_run["gatherEfficiency"] is None
    assert per_run["wasteRatio"] is None


def test_mean_ci95():
    from stats import mean_ci95

    # n=5 (the sweep's N): df=4 → t=2.776; s=√2.5, se=s/√5=√0.5
    ci = mean_ci95([1, 2, 3, 4, 5])
    assert ci.n == 5
    assert ci.mean == 3
    assert abs(ci.half - 2.776 * 0.5**0.5) < 1e-9
    assert abs(ci.low - (3 - ci.half)) < 1e-12
    assert abs(ci.high - (3 + ci.half)) < 1e-12

    # degenerate samples: no interval, never a crash
    import math
    assert mean_ci95([]).n == 0
    one = mean_ci95([7.5])
    assert one.mean == 7.5 and math.isnan(one.half)
    zero_var = mean_ci95([2.0, 2.0, 2.0])
    assert zero_var.mean == 2.0 and zero_var.half == 0.0


# ---------------------------------------------------------------------------
# v3 world protocol — the pinned seed lives in two files that nothing links.
# ---------------------------------------------------------------------------

def test_compose_seed_matches_frozen_config():
    """A drifting seed is invisible until a whole sweep has raced the wrong map.

    `frozen.world.seed` is what sweep_race.py verifies via RCON after each
    restore; compose's `SEED` is what actually generates the world the pristine
    snapshot was cut from. If they ever disagree, the restore gate passes on the
    snapshot while any regenerated world is a different map.
    """
    import json
    import re
    from pathlib import Path

    repo = Path(__file__).resolve().parent.parent
    frozen = json.loads(
        (repo / "bench" / "race" / "frozen-config.json").read_text(encoding="utf-8"))
    seed = frozen["frozen"]["world"]["seed"]

    compose = (repo / "infrastructure" / "docker" / "docker-compose.yml").read_text(
        encoding="utf-8")
    m = re.search(r'^\s*SEED:\s*"?(-?\d+)"?\s*$', compose, re.MULTILINE)
    assert m, "no SEED pin found in docker-compose.yml minecraft service"
    assert m.group(1) == seed, (
        f"compose SEED={m.group(1)} but frozen.world.seed={seed} — "
        "the benchmark world would not be the world the seed gate checks for")


def test_no_reset_rows_are_excluded_from_v3_aggregates():
    """A v3+ row with no worldSeed was raced with --no-world-reset: honest, but
    not the protocol its version claims. It must never be pooled silently."""
    import aggregate_race

    manifest = {"runs": [
        {"model": "m", "index": 1, "label": "a", "configVersion": 3,
         "worldSeed": "6233701440491701965", "outcome": "won",
         "durationSeconds": 100.0, "discarded": False,
         "resultFile": "bench/results/does-not-exist.json"},
        {"model": "m", "index": 2, "label": "b", "configVersion": 3,
         "worldSeed": None, "outcome": "won", "durationSeconds": 900.0,
         "discarded": False, "resultFile": "bench/results/does-not-exist.json"},
    ]}
    unreset = [r for r in manifest["runs"]
               if r.get("configVersion", 1) >= aggregate_race.PROTOCOL_WORLD_VERSION
               and not r.get("worldSeed")]
    assert [r["label"] for r in unreset] == ["b"]


def test_kept_does_not_resume_across_world_protocols():
    """The resume key must include worldSeed, or five --no-world-reset rows let
    a later seeded sweep skip the block and publish them as v3."""
    import sweep_race

    manifest = {"runs": [
        {"model": "m", "index": 1, "configVersion": 3, "worldSeed": None,
         "discarded": False},
    ]}
    unreset = {"sweepKind": "model", "model": "m", "index": 1,
               "configVersion": 3, "worldSeed": None,
               "axis": None, "axisValue": None}
    seeded = {**unreset, "worldSeed": "6233701440491701965"}
    assert sweep_race.kept(manifest, sweep_race.run_key(unreset)) is True
    assert sweep_race.kept(manifest, sweep_race.run_key(seeded)) is False


def test_axis_runs_never_satisfy_a_model_table_resume():
    """A tick-60 sensitivity run and a model-table run share (model, index,
    configVersion, worldSeed). Only sweepKind/axis keep them apart."""
    import sweep_race

    axis_row = {"sweepKind": "axis", "model": "m", "index": 1,
                "configVersion": 3, "worldSeed": "s", "axis":
                "TICK_INTERVAL_SECONDS", "axisValue": "60", "discarded": False}
    manifest = {"runs": [axis_row]}
    model_key = sweep_race.run_key({"sweepKind": "model", "model": "m",
                                    "index": 1, "configVersion": 3,
                                    "worldSeed": "s", "axis": None,
                                    "axisValue": None})
    assert sweep_race.kept(manifest, model_key) is False
    assert sweep_race.kept(manifest, sweep_race.run_key(axis_row)) is True
    # 60 and "60" must not fork the key.
    assert (sweep_race.run_key({**axis_row, "axisValue": 60})
            == sweep_race.run_key(axis_row))


def test_axis_may_only_replace_a_pinned_knob():
    import pytest
    import sweep_race

    env = sweep_race.frozen_env("llama3.1:8b", {"TICK_INTERVAL_SECONDS": 60})
    assert env["TICK_INTERVAL_SECONDS"] == "60"
    with pytest.raises(RuntimeError, match="not a knob the frozen config pins"):
        sweep_race.frozen_env("llama3.1:8b", {"NOT_A_FROZEN_KNOB": 1})


def test_single_axis_guard_rejects_a_second_drifting_knob():
    import pytest
    import sweep_race

    env = sweep_race.frozen_env("llama3.1:8b", {"TICK_INTERVAL_SECONDS": 60})
    sweep_race.assert_single_axis(env, "TICK_INTERVAL_SECONDS", "60")
    env["OLLAMA_NUM_CTX"] = "4096"
    with pytest.raises(RuntimeError, match="varies ONE axis"):
        sweep_race.assert_single_axis(env, "TICK_INTERVAL_SECONDS", "60")


def test_race_timeout_scales_with_the_tick_arm():
    """The 75-minute watchdog is inter-milestone; a fixed process bound would
    censor the slow arm in the direction that flatters it."""
    import sweep_race

    base = sweep_race.race_timeout_seconds(30)
    slow = sweep_race.race_timeout_seconds(60)
    assert base == sweep_race.RACE_TIMEOUT_SECONDS
    assert slow > base
    assert slow == sweep_race.STALL_WATCHDOG_SECONDS + 2 * (
        sweep_race.RACE_TIMEOUT_SECONDS - sweep_race.STALL_WATCHDOG_SECONDS)


def test_axis_runs_are_partitioned_out_of_the_model_report():
    """The model report walks every run in four places plus the discarded
    ledger; an axis run reaching any of them is an untraceable number."""
    import aggregate_race

    manifest = {"runs": [
        {"model": "m", "index": 1, "label": "bench-m-r1", "discarded": False,
         "outcome": "won", "durationSeconds": 100.0},
        {"model": "m", "index": 1, "label": "sens-tick-60-m-r1",
         "sweepKind": "axis", "axis": "TICK_INTERVAL_SECONDS",
         "axisValue": "60", "discarded": False, "outcome": "won",
         "durationSeconds": 900.0},
        {"model": "m", "index": 2, "label": "sens-tick-60-m-r2",
         "sweepKind": "axis", "axis": "TICK_INTERVAL_SECONDS",
         "axisValue": "60", "discarded": True, "outcome": "no-clean-run",
         "reason": "no clean run in 3 tries"},
    ]}
    model_manifest, axis_runs = aggregate_race.split_manifest(manifest)
    assert [r["label"] for r in model_manifest["runs"]] == ["bench-m-r1"]
    assert len(axis_runs) == 2
    # The discarded axis row must not inflate the model report's honesty ledger.
    assert all(r.get("sweepKind", "model") == "model"
               for r in model_manifest["runs"])


def test_axis_report_lists_holes_instead_of_shrinking_n_silently():
    import aggregate_race

    axis_runs = [
        {"model": "m", "index": 1, "label": "sens-tick-30-m-r1",
         "sweepKind": "axis", "axis": "TICK_INTERVAL_SECONDS",
         "axisValue": "30", "axisBaseline": "30", "discarded": False,
         "outcome": "won", "durationSeconds": 600.0},
        {"model": "m", "index": 1, "label": "sens-tick-60-m-r1",
         "sweepKind": "axis", "axis": "TICK_INTERVAL_SECONDS",
         "axisValue": "60", "axisBaseline": "30", "discarded": True,
         "outcome": "no-clean-run", "reason": "no clean run in 3 tries"},
    ]
    blocks = aggregate_race.axis_blocks(axis_runs)
    baseline = blocks[("m", "TICK_INTERVAL_SECONDS", "30")]
    slow = blocks[("m", "TICK_INTERVAL_SECONDS", "60")]
    assert baseline["n"] == 1 and baseline["wins"] == 1
    assert slow["n"] == 0
    assert [h["label"] for h in slow["holes"]] == ["sens-tick-60-m-r1"]


def test_recovered_failures_are_not_reported_as_missing_coverage():
    """A block-setup failure whose run index was later re-raced successfully is
    audit trail, not a hole — reporting it as missing coverage understates N
    and reads as a truncated sweep."""
    import aggregate_race

    axis_runs = [
        # run 1 failed setup, then run 1 was re-raced and kept
        {"model": "m", "index": 1, "label": "setup-m-ctx-4096", "sweepKind": "axis",
         "axis": "OLLAMA_NUM_CTX", "axisValue": "4096", "axisBaseline": "8192",
         "discarded": True, "outcome": "block-setup-failed", "reason": "fleet offline"},
        {"model": "m", "index": 1, "label": "sens-ctx-4096-m-r1", "sweepKind": "axis",
         "axis": "OLLAMA_NUM_CTX", "axisValue": "4096", "axisBaseline": "8192",
         "discarded": False, "outcome": "won", "durationSeconds": 700.0},
        # run 2 never recovered — genuine missing coverage
        {"model": "m", "index": 2, "label": "sens-ctx-4096-m-r2", "sweepKind": "axis",
         "axis": "OLLAMA_NUM_CTX", "axisValue": "4096", "axisBaseline": "8192",
         "discarded": True, "outcome": "no-clean-run", "reason": "3 dirty tries"},
    ]
    b = aggregate_race.axis_blocks(axis_runs)[("m", "OLLAMA_NUM_CTX", "4096")]
    assert b["n"] == 1 and b["wins"] == 1
    assert [r["index"] for r in b["recovered"]] == [1]
    assert [r["index"] for r in b["uncovered"]] == [2]


# ---------------------------------------------------------------------------
# Fleet-health gate — the honesty gate covers the brain, this covers the body.
# ---------------------------------------------------------------------------

def _window(spawn_counts, completed_counts=None):
    """Synthetic villager window: N VillagerSpawned per racer, plus acts."""
    import bench_race as br
    name_of, team_of = br.load_roster()
    id_of = {name_of[v]: v for v in team_of}
    events = []
    for name, n in spawn_counts.items():
        for _ in range(n):
            events.append({"eventType": "VillagerSpawned",
                           "payload": {"villagerId": id_of[name]}})
    for name, n in (completed_counts or {}).items():
        for _ in range(n):
            events.append({"eventType": "DecisionMade",
                           "payload": {"villagerId": id_of[name]}})
            events.append({"eventType": "ActionCompleted",
                           "payload": {"villagerId": id_of[name]}})
    return events, name_of, team_of


def test_fleet_health_passes_a_normal_race():
    import sweep_race

    roster = ["Elara", "Bram", "Wren", "Ansel", "Petra", "Fen"]
    ev, name_of, team_of = _window({n: 1 for n in roster}, {n: 5 for n in roster})
    h = sweep_race.fleet_health(ev, name_of, team_of)
    assert h["ok"] is True
    assert h["storming"] == {}
    assert h["mute"] == []


def test_fleet_health_catches_a_reconnect_storm():
    """The real failure: 1962 spawns for one villager while the honesty gate
    reported {0,0} and the run banked as KEPT."""
    import sweep_race

    roster = ["Elara", "Bram", "Wren", "Ansel", "Petra", "Fen"]
    spawns = {n: 1 for n in roster}
    spawns["Elara"] = 1962
    ev, name_of, team_of = _window(spawns, {n: 5 for n in roster})
    h = sweep_race.fleet_health(ev, name_of, team_of)
    assert h["ok"] is False
    assert h["storming"] == {"Elara": 1962}


def test_fleet_health_tolerates_a_couple_of_honest_reconnects():
    """A server hiccup mid-race is normal; the threshold must not fire on it."""
    import sweep_race

    roster = ["Elara", "Bram", "Wren", "Ansel", "Petra", "Fen"]
    spawns = {n: 1 for n in roster}
    spawns["Fen"] = 3
    ev, name_of, team_of = _window(spawns, {n: 5 for n in roster})
    h = sweep_race.fleet_health(ev, name_of, team_of)
    assert h["ok"] is True


def test_fleet_health_records_mute_villagers_without_gating():
    """Deliberated but never acted is a weaker signal than a storm — a villager
    really can fail every action — so it is recorded, not gated on."""
    import sweep_race

    roster = ["Elara", "Bram", "Wren", "Ansel", "Petra", "Fen"]
    completed = {n: 5 for n in roster}
    del completed["Elara"]
    ev, name_of, team_of = _window({n: 1 for n in roster}, completed)
    ev.append({"eventType": "DecisionMade",
               "payload": {"villagerId": [v for v in team_of
                                          if name_of[v] == "Elara"][0]}})
    h = sweep_race.fleet_health(ev, name_of, team_of)
    assert h["ok"] is True
    assert h["mute"] == ["Elara"]
