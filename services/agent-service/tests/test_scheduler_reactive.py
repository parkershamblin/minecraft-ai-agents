"""M1-2: the reactive-tick guards (injected clock) and the wakeup loop."""

import asyncio
import uuid

from agent_service.brain.graph import VillagerBrief
from agent_service.brain.scheduler import TickScheduler

ELARA = VillagerBrief(id=uuid.uuid4(), name="Elara", personality={}, backstory=None)


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


def scheduler_with(clock, **kwargs) -> TickScheduler:
    scheduler = TickScheduler(None, 60, now_fn=clock, **kwargs)
    key = str(ELARA.id)
    # simulate a registered, mid-cycle villager without starting the loop
    scheduler._wakeups[key] = asyncio.Event()
    scheduler._last_tick_at[key] = clock() - 30.0
    scheduler._next_scheduled_at[key] = clock() + 30.0
    return scheduler


class TestReactiveGuards:
    def test_grants_within_limits(self):
        clock = Clock()
        scheduler = scheduler_with(clock)
        assert scheduler.request_reactive(str(ELARA.id), "cause-1") is True
        assert scheduler._pending_cause[str(ELARA.id)] == "cause-1"
        assert scheduler._wakeups[str(ELARA.id)].is_set()

    def test_cooldown_declines(self):
        clock = Clock()
        scheduler = scheduler_with(clock)
        scheduler._last_tick_at[str(ELARA.id)] = clock() - 5.0  # ticked 5s ago < 15s cooldown
        assert scheduler.request_reactive(str(ELARA.id), "x") is False

    def test_imminent_scheduled_tick_declines(self):
        clock = Clock()
        scheduler = scheduler_with(clock)
        scheduler._next_scheduled_at[str(ELARA.id)] = clock() + 5.0  # fires in 5s anyway
        assert scheduler.request_reactive(str(ELARA.id), "x") is False

    def test_five_minute_cap(self):
        clock = Clock()
        scheduler = scheduler_with(clock, max_reactive_per_5min=3)
        key = str(ELARA.id)
        for i in range(3):
            clock.now += 20  # stay past cooldown, inside the 5-min window
            scheduler._last_tick_at[key] = clock.now - 16
            scheduler._next_scheduled_at[key] = clock.now + 30  # the loop keeps this in the future
            assert scheduler.request_reactive(key, f"c{i}") is True
        clock.now += 20
        scheduler._last_tick_at[key] = clock.now - 16
        scheduler._next_scheduled_at[key] = clock.now + 30
        assert scheduler.request_reactive(key, "c3") is False  # capped

        clock.now += 301  # the window slides
        scheduler._last_tick_at[key] = clock.now - 16
        scheduler._next_scheduled_at[key] = clock.now + 30
        assert scheduler.request_reactive(key, "c4") is True

    def test_unknown_villager_declines(self):
        scheduler = scheduler_with(Clock())
        assert scheduler.request_reactive("nobody", "x") is False


async def test_wakeup_produces_reactive_tick_with_cause(monkeypatch):
    """Loop integration with tiny timings: a wakeup fires an early tick that
    threads the cause; the next tick is scheduled a full interval later."""
    ticks: list[tuple[str, str | None]] = []

    async def fake_run_tick(graph, villager, *, cause=None, trigger="scheduled"):
        ticks.append((trigger, cause))
        return {"outcome": None}

    monkeypatch.setattr("agent_service.brain.scheduler.run_tick", fake_run_tick)

    scheduler = TickScheduler(None, 1, reactive_cooldown_s=0.0, imminent_s=0.05)
    scheduler.ensure([ELARA])
    await asyncio.sleep(0.1)  # first scheduled tick fires immediately (delay 0)
    assert ticks[0] == ("scheduled", None)

    granted = scheduler.request_reactive(str(ELARA.id), "heard-event-id")
    assert granted is True
    await asyncio.sleep(0.1)
    assert ("reactive", "heard-event-id") in ticks

    await scheduler.stop()
