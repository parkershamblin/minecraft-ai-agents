from datetime import UTC, datetime, timedelta

from memory_service.scoring import (
    recency_score,
    retrieval_score,
    score_importance,
    score_sentiment,
)


class TestImportance:
    def test_mundane_observations_score_low(self):
        assert score_importance("I saw a tree near the pond.") < 5.0

    def test_dramatic_events_score_high(self):
        assert score_importance("Bram betrayed me at the mine entrance.") >= 8.0
        assert score_importance("Wren died defending the granary.") >= 9.0

    def test_reflections_have_a_floor(self):
        assert score_importance("I do not trust Bram anymore.", memory_type="reflection") >= 7.0

    def test_clamped_to_ten(self):
        long_drama = "betrayed and killed " * 50
        assert score_importance(long_drama) <= 10.0


class TestSentiment:
    def test_positive(self):
        assert score_sentiment("What a good, happy morning with a kind friend!") > 0.5

    def test_negative(self):
        assert score_sentiment("The enemy stole everything; I am angry and afraid.") < -0.5

    def test_neutral_when_no_signal(self):
        assert score_sentiment("The pond is next to the oak tree.") == 0.0


class TestRecency:
    def test_now_is_one(self):
        now = datetime.now(UTC)
        assert recency_score(now, now) == 1.0

    def test_decays_monotonically(self):
        now = datetime.now(UTC)
        fresh = recency_score(now - timedelta(hours=1), now)
        stale = recency_score(now - timedelta(hours=72), now)
        assert 0.0 < stale < fresh < 1.0


class TestRetrievalScore:
    def test_weights_shift_the_ranking(self):
        # same memory, judged under two regimes
        relevance_led = retrieval_score(0.2, 2.0, 0.9, w_recency=0.1, w_importance=0.1, w_relevance=2.0)
        recency_led = retrieval_score(0.2, 2.0, 0.9, w_recency=2.0, w_importance=0.1, w_relevance=0.1)
        assert relevance_led > recency_led

    def test_relevance_clamped_to_unit(self):
        assert retrieval_score(0.0, 0.0, 5.0) == retrieval_score(0.0, 0.0, 1.0)
