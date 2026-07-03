"""In-process asyncio tick scheduler. Villager i is offset by i x interval/N
(deliberate backpressure on the LLM provider); each villager's loop is
sequential, which IS the per-villager in-flight guard — no distributed locks
for a process that doesn't shard yet (the design review's ruling)."""

import asyncio
import time

from agent_service.brain.graph import VillagerBrief, run_tick
from agent_service.logging import logger
from agent_service.metrics import tick_seconds, ticks_total


class TickScheduler:
    def __init__(self, compiled_graph, interval_seconds: int):
        self._graph = compiled_graph
        self._interval = interval_seconds
        self._tasks: dict[str, asyncio.Task] = {}
        self._stopped = False

    def ensure(self, villagers: list[VillagerBrief]) -> None:
        """Start a loop for any villager that doesn't have one (idempotent —
        called at boot and after each seed)."""
        for index, villager in enumerate(villagers):
            key = str(villager.id)
            if key in self._tasks and not self._tasks[key].done():
                continue
            delay = (index * self._interval) / max(len(villagers), 1)
            self._tasks[key] = asyncio.create_task(
                self._loop(villager, delay), name=f"tick:{villager.name}"
            )
            logger.info("tick loop scheduled", villager=villager.name, initial_delay_s=round(delay, 1))

    async def stop(self) -> None:
        self._stopped = True
        for task in self._tasks.values():
            task.cancel()

    async def _loop(self, villager: VillagerBrief, initial_delay: float) -> None:
        await asyncio.sleep(initial_delay)
        while not self._stopped:
            started = time.perf_counter()
            try:
                await run_tick(self._graph, villager)
                ticks_total.labels(outcome="ok").inc()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 — a tick may never kill the loop
                ticks_total.labels(outcome="error").inc()
                logger.error("tick failed", villager=villager.name, error=str(exc))
            finally:
                tick_seconds.observe(time.perf_counter() - started)
            await asyncio.sleep(self._interval)
