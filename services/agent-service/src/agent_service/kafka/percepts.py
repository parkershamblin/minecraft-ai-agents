"""The feedback loop the design review said was assigned to nobody: a
world.events consumer (group agent-service.perception) that turns action
outcomes into percepts on Redis lists — Elara remembers she reached the oak
tree because this consumer told her tick about it."""

import asyncio
import json

import redis.asyncio as aioredis
from aiokafka import AIOKafkaConsumer

from agent_service.logging import logger

# M1 extends this set with ChatObserved (fan out one percept per hearer).
_PERCEPT_TYPES = {"ActionCompleted", "ActionFailed"}
_QUEUE_CAP = 20
_QUEUE_TTL_SECONDS = 600


class PerceptConsumer:
    def __init__(self, brokers: str, redis: aioredis.Redis):
        self._consumer = AIOKafkaConsumer(
            "world.events",
            bootstrap_servers=brokers,
            group_id="agent-service.perception",
            auto_offset_reset="latest",  # stale outcomes are not fresh percepts
            enable_auto_commit=True,
        )
        self._redis = redis
        self._task: asyncio.Task | None = None

    async def start(self) -> None:
        await self._consumer.start()
        self._task = asyncio.create_task(self._run(), name="percept-consumer")
        logger.info("percept consumer running", group="agent-service.perception")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
        await self._consumer.stop()

    async def _run(self) -> None:
        async for message in self._consumer:
            try:
                envelope = json.loads(message.value)
            except json.JSONDecodeError:
                continue
            if envelope.get("eventType") not in _PERCEPT_TYPES:
                continue
            payload = envelope.get("payload", {})
            villager_id = payload.get("villagerId")
            if not villager_id:
                continue
            percept = {
                "type": envelope["eventType"],
                "action": payload.get("action"),
                "detail": payload.get("result") or {
                    "errorCode": payload.get("errorCode"),
                    "errorMessage": payload.get("errorMessage"),
                },
                "occurredAt": envelope.get("occurredAt"),
            }
            key = f"percepts:{villager_id}"
            async with self._redis.pipeline(transaction=True) as pipe:
                pipe.rpush(key, json.dumps(percept))
                pipe.ltrim(key, -_QUEUE_CAP, -1)
                pipe.expire(key, _QUEUE_TTL_SECONDS)
                await pipe.execute()
