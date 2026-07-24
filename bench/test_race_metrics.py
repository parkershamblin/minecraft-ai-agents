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
"""

import json
from pathlib import Path

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
    name_of, team_of = bench_race.load_roster()
    return {
        "tierA": bench_race.tier_a(bench_race.load_slice(TIERB_SLICE), name_of),
        "tierB": bench_race.tier_b(bench_race.load_slice(TIERB_WINDOW), team_of),
    }


def test_tier_b_matches_expected_doc():
    expected = json.loads(TIERB_EXPECTED.read_text(encoding="utf-8"))
    assert compute_sweep_run() == expected


def test_tier_b_headline_numbers():
    b = compute_sweep_run()["tierB"]
    assert set(b) == {"red", "blue"}
    for team in b.values():
        # every counter grouped and non-empty — the live-smoke sanity, locked
        assert team["gatherRequests"] > 0
        assert team["gatheredTotal"] > 0
        assert 0 <= team["wasteRatio"] <= 1
        assert team["llm"]["decisions"] > 0
        assert team["llm"]["tokensUsed"] > 0
        assert team["llm"]["latencyMsP50"] <= team["llm"]["latencyMsP95"]


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
