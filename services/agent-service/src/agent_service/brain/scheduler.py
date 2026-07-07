"""The tick scheduler — now with ears.

Each villager's loop waits on a per-villager asyncio.Event with a timeout of
"time until my next scheduled tick". A chat percept may set the event
(request_reactive), producing an early tick that carries the heard event's id
as causation — subject to three guards that keep the GPU arithmetic honest
(cap 3/5min at 20 villagers = 91% worst-case duty on the 4090):

  1. cooldown: >= REACTIVE_COOLDOWN_S since this villager's last tick
  2. cap: <= MAX_REACTIVE_PER_5MIN reactive ticks per villager
  3. imminence: declined when the scheduled tick is < IMMINENT_S away anyway

A reactive tick counts as the tick — the next scheduled one is a full
interval later, so reactive bursts pace the cadence rather than stack on it.
Sequential-per-villager execution remains the in-flight guard.
"""

import asyncio
import time
from collections import deque
from typing import Callable

from agent_service.brain.graph import VillagerBrief, run_tick
from agent_service.logging import logger
from agent_service.metrics import tick_seconds, ticks_total


class TickScheduler:
    def __init__(
        self,
        compiled_graph,
        interval_seconds: int,
        *,
        reactive_cooldown_s: float = 15.0,
        max_reactive_per_5min: int = 3,
        imminent_s: float = 10.0,
        now_fn: Callable[[], float] = time.monotonic,
    ):
        self._graph = compiled_graph
        self._interval = interval_seconds
        self._cooldown = reactive_cooldown_s
        self._max_reactive = max_reactive_per_5min
        self._imminent = imminent_s
        self._now = now_fn

        self._tasks: dict[str, asyncio.Task] = {}
        self._wakeups: dict[str, asyncio.Event] = {}
        self._next_scheduled_at: dict[str, float] = {}
        self._last_tick_at: dict[str, float] = {}
        self._reactive_times: dict[str, deque] = {}
        self._pending_cause: dict[str, str] = {}
        self._stopped = False

    # ------------------------------------------------------------------ hooks

    def request_reactive(self, villager_id: str, cause_event_id: str) -> bool:
        """Called by the perception consumer on a chat percept. Returns True
        when a reactive tick was granted. Pure bookkeeping + Event.set —
        safe to call from any task."""
        if self._stopped or villager_id not in self._wakeups:
            return False
        now = self._now()

        if now - self._last_tick_at.get(villager_id, -1e9) < self._cooldown:
            return False
        if self._next_scheduled_at.get(villager_id, 1e18) - now < self._imminent:
            return False  # the scheduled tick will hear it anyway
        window = self._reactive_times.setdefault(villager_id, deque())
        while window and now - window[0] > 300.0:
            window.popleft()
        if len(window) >= self._max_reactive:
            return False

        window.append(now)
        self._pending_cause[villager_id] = cause_event_id
        self._wakeups[villager_id].set()
        return True

    # ------------------------------------------------------------ lifecycle

    def ensure(self, villagers: list[VillagerBrief]) -> None:
        for index, villager in enumerate(villagers):
            key = str(villager.id)
            if key in self._tasks and not self._tasks[key].done():
                continue
            self._wakeups[key] = asyncio.Event()
            delay = (index * self._interval) / max(len(villagers), 1)
            self._tasks[key] = asyncio.create_task(
                self._loop(villager, delay), name=f"tick:{villager.name}"
            )
            logger.info("tick loop scheduled", villager=villager.name, initial_delay_s=round(delay, 1))

    async def stop(self) -> None:
        self._stopped = True
        for task in self._tasks.values():
            task.cancel()

    # ----------------------------------------------------------------- loop

    async def _loop(self, villager: VillagerBrief, initial_delay: float) -> None:
        key = str(villager.id)
        event = self._wakeups[key]
        self._next_scheduled_at[key] = self._now() + initial_delay
        await asyncio.sleep(initial_delay)

        while not self._stopped:
            cause = self._pending_cause.pop(key, None)
            trigger = "reactive" if cause else "scheduled"
            event.clear()

            started = time.perf_counter()
            self._last_tick_at[key] = self._now()
            try:
                await run_tick(self._graph, villager, cause=cause, trigger=trigger)
                ticks_total.labels(outcome="ok", trigger=trigger).inc()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 — a tick may never kill the loop
                ticks_total.labels(outcome="error", trigger=trigger).inc()
                logger.error("tick failed", villager=villager.name, trigger=trigger, error=str(exc))
            finally:
                tick_seconds.observe(time.perf_counter() - started)

            # A tick is a tick: the next scheduled one is a full interval out.
            self._next_scheduled_at[key] = self._now() + self._interval
            try:
                await asyncio.wait_for(event.wait(), timeout=self._interval)
            except TimeoutError:
                pass  # the scheduled cadence fires
