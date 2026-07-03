"""Daily token budget — the wallet's circuit breaker.

In-process counter with UTC-day rollover (agent-service is one process; a
Redis counter replaces this the day it shards). When the day's total crosses
the budget, deliberation flips to the fake provider until midnight UTC and
the civ_llm_budget_tripped gauge goes to 1 — Grafana alerts on it.
"""

from datetime import UTC, datetime
from typing import Callable

from agent_service.llm.providers import FakeProvider, LLMProvider, LLMResponse
from agent_service.logging import logger
from agent_service.metrics import llm_budget_tripped


class BudgetedProvider:
    name = "budgeted"

    def __init__(
        self,
        primary: LLMProvider,
        daily_token_budget: int,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    ):
        self._primary = primary
        self._fallback = FakeProvider()
        self._budget = daily_token_budget
        self._clock = clock
        self._day = clock().date()
        self._spent = 0
        self._tripped = False
        llm_budget_tripped.set(0)

    @property
    def model(self) -> str:
        return self._active.model

    @property
    def _active(self) -> LLMProvider:
        return self._fallback if self._tripped else self._primary

    @property
    def tokens_spent_today(self) -> int:
        return self._spent

    def _roll_day(self) -> None:
        today = self._clock().date()
        if today != self._day:
            self._day = today
            self._spent = 0
            if self._tripped:
                self._tripped = False
                llm_budget_tripped.set(0)
                logger.info("llm budget reset — circuit breaker closed", day=str(today))

    async def complete(self, system: str, user: str) -> LLMResponse:
        self._roll_day()
        response = await self._active.complete(system, user)
        self._spent += response.tokens_in + response.tokens_out
        if not self._tripped and self._spent >= self._budget:
            self._tripped = True
            llm_budget_tripped.set(1)
            logger.warning(
                "DAILY TOKEN BUDGET EXHAUSTED — deliberation switched to fake until midnight UTC",
                spent=self._spent,
                budget=self._budget,
            )
        return response
