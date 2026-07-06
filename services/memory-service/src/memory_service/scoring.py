"""Pure scoring logic — the domain rules of the Memory context.

Sprint 1 uses heuristics; CIV-8 folds importance/sentiment into the
deliberation output (never a separate LLM scoring call, per the design
review's cost ruling), with these heuristics as the permanent fallback.
"""

from datetime import UTC, datetime

# Dramatic events matter more — these floors bias retrieval toward the
# betrayals and elections the show is made of.
_IMPORTANCE_FLOORS: dict[str, float] = {
    "died": 9.0,
    "death": 9.0,
    "killed": 9.0,
    "betray": 8.5,
    "attack": 7.5,
    "stole": 7.0,
    "elect": 7.0,
    "vote": 6.5,
    "law": 6.0,
    "love": 6.0,
    "hate": 6.0,
    "friend": 5.0,
    "promise": 5.0,
}

_POSITIVE_WORDS = frozenset(
    "good great happy glad love friend beautiful promising kind safe warm thanks welcome".split()
)
_NEGATIVE_WORDS = frozenset(
    "bad sad angry hate enemy ugly dangerous afraid hurt died killed betrayed stole broken".split()
)


def score_importance(content: str, memory_type: str = "observation") -> float:
    """Heuristic 0..10. Reflections are inherently distilled (floor 7);
    otherwise start mundane and rise with dramatic keywords and mentions."""
    if memory_type == "reflection":
        base = 7.0
    else:
        base = 3.0
    lowered = content.lower()
    keyword_floor = max(
        (floor for token, floor in _IMPORTANCE_FLOORS.items() if token in lowered),
        default=0.0,
    )
    # Longer content usually encodes more happened — a gentle nudge, capped.
    length_bonus = min(len(content) / 200.0, 1.0)
    return round(min(10.0, max(base, keyword_floor) + length_bonus), 2)


def score_sentiment(content: str) -> float:
    """Tiny-lexicon sentiment in [-1, 1]. Deliberately crude and fast."""
    words = [w.strip(".,!?;:'\"").lower() for w in content.split()]
    positive = sum(1 for w in words if w in _POSITIVE_WORDS)
    negative = sum(1 for w in words if w in _NEGATIVE_WORDS)
    total = positive + negative
    if total == 0:
        return 0.0
    return round((positive - negative) / total, 2)


def recency_score(last_accessed_at: datetime, now: datetime | None = None, decay_per_hour: float = 0.995) -> float:
    """Exponential decay on hours since last access (generative-agents style:
    memories you keep touching stay warm)."""
    now = now or datetime.now(UTC)
    hours = max(0.0, (now - last_accessed_at).total_seconds() / 3600.0)
    return decay_per_hour**hours


def retrieval_score(
    recency: float,
    importance: float,
    relevance: float,
    w_recency: float = 1.0,
    w_importance: float = 1.0,
    w_relevance: float = 1.0,
) -> float:
    """recency x importance x relevance, weighted-sum form (paper-faithful).
    importance arrives 0..10 and is normalized here; relevance is cosine
    similarity in [-1, 1] clamped to [0, 1]."""
    return (
        w_recency * recency
        + w_importance * (importance / 10.0)
        + w_relevance * max(0.0, min(1.0, relevance))
    )
