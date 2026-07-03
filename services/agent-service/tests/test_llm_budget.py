from datetime import UTC, datetime, timedelta

from agent_service.llm.budget import BudgetedProvider
from agent_service.llm.providers import FakeProvider, LLMResponse


class CountingProvider:
    """Pretends every call costs 600 tokens."""

    name = "counting"
    model = "counting-1"

    def __init__(self):
        self.calls = 0

    async def complete(self, system: str, user: str) -> LLMResponse:
        self.calls += 1
        return LLMResponse(
            text='{"action":"idle","params":{},"reasoning":"r","importance":1,"sentiment":0}',
            tokens_in=500,
            tokens_out=100,
            latency_seconds=0.01,
            provider=self.name,
            model=self.model,
        )


class Clock:
    def __init__(self):
        self.now = datetime(2026, 7, 2, 12, 0, tzinfo=UTC)

    def __call__(self) -> datetime:
        return self.now


async def test_trips_at_budget_and_delegates_to_fake():
    primary = CountingProvider()
    budgeted = BudgetedProvider(primary, daily_token_budget=1500, clock=Clock())

    await budgeted.complete("s", "u")  # 600
    await budgeted.complete("s", "u")  # 1200
    response = await budgeted.complete("s", "u")  # 1800 -> trips DURING this call
    assert response.provider == "counting"  # the tripping call itself still ran on primary
    assert primary.calls == 3

    after_trip = await budgeted.complete("s", "u")
    assert after_trip.provider == "fake"  # breaker open
    assert primary.calls == 3  # primary never called again


async def test_midnight_utc_closes_the_breaker():
    clock = Clock()
    primary = CountingProvider()
    budgeted = BudgetedProvider(primary, daily_token_budget=500, clock=clock)

    await budgeted.complete("s", "u")  # 600 >= 500 -> tripped
    assert (await budgeted.complete("s", "u")).provider == "fake"

    clock.now += timedelta(days=1)  # midnight passed
    response = await budgeted.complete("s", "u")
    assert response.provider == "counting"
    assert budgeted.tokens_spent_today == 600  # fresh day's ledger


async def test_fake_fallback_is_itself_contract_valid():
    budgeted = BudgetedProvider(CountingProvider(), daily_token_budget=1, clock=Clock())
    await budgeted.complete("s", "u")  # trips immediately
    from agent_service.llm.contract import validate_decision

    fake_response = await budgeted.complete("s", "u")
    assert fake_response.provider == "fake"
    validate_decision(fake_response.text)


async def test_never_trips_under_budget():
    budgeted = BudgetedProvider(FakeProvider(), daily_token_budget=1_000_000, clock=Clock())
    for _ in range(10):
        assert (await budgeted.complete("s", "u")).provider == "fake"  # fake primary, 0 tokens
    assert budgeted.tokens_spent_today == 0
