"""The feedback loop: a world.events consumer (group agent-service.perception)
that turns world facts into percepts on Redis lists.

M1-1: ChatObserved fans out one percept per hearer (speaker excluded — the
echo-loop guard again), carrying the source envelope's eventId+correlationId —
the identity thread that makes conversation chains ledger-traceable. A chat
percept may also request a reactive tick via the scheduler hook (M1-2).
"""

import asyncio
import json
from datetime import UTC, datetime
from typing import Callable

import redis.asyncio as aioredis
from aiokafka import AIOKafkaConsumer

from agent_service.logging import logger

_ACTION_TYPES = {"ActionCompleted", "ActionFailed"}
_QUEUE_CAP = 20
_QUEUE_TTL_SECONDS = 600
# Committed group offsets survive restarts, so a redeploy drains the backlog —
# without this guard, days-old chat replays as fresh percepts (observed live:
# Elara 'heard' a Wren line from a previous session).
_MAX_PERCEPT_AGE_SECONDS = 600


def _is_stale(occurred_at: str | None) -> bool:
    if not occurred_at:
        return False
    try:
        occurred = datetime.fromisoformat(occurred_at.replace("Z", "+00:00"))
    except ValueError:
        return False
    return (datetime.now(UTC) - occurred).total_seconds() > _MAX_PERCEPT_AGE_SECONDS


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
        # Set after scheduler construction (main.py): (villager_id, cause_event_id) -> bool.
        self.on_chat_percept: Callable[[str, str], bool] | None = None

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
            await self.handle(envelope)

    async def handle(self, envelope: dict) -> None:
        """One envelope -> zero or more percepts. Extracted from the Kafka
        loop so the fanout rules are unit-testable."""
        event_type = envelope.get("eventType")
        payload = envelope.get("payload", {})
        if _is_stale(envelope.get("occurredAt")):
            return  # backlog drain after a redeploy — history is not perception

        if event_type in _ACTION_TYPES:
            villager_id = payload.get("villagerId")
            if not villager_id:
                return
            await self._push(
                villager_id,
                {
                    "type": event_type,
                    "action": payload.get("action"),
                    "detail": payload.get("result")
                    or {"errorCode": payload.get("errorCode"), "errorMessage": payload.get("errorMessage")},
                    "sourceEventId": envelope.get("eventId"),
                    "correlationId": envelope.get("correlationId"),
                    "occurredAt": envelope.get("occurredAt"),
                },
            )

        elif event_type == "ChatObserved":
            speaker_id = payload.get("villagerId")  # null when a player spoke
            percept = {
                "type": "ChatObserved",
                "speakerName": payload.get("speakerUsername"),
                "speakerVillagerId": speaker_id,
                "message": payload.get("message"),
                "sourceEventId": envelope.get("eventId"),
                "correlationId": envelope.get("correlationId"),
                "occurredAt": envelope.get("occurredAt"),
            }
            for hearer_id in payload.get("heardByIds", []):
                if hearer_id == speaker_id:
                    continue  # a villager never perceives their own utterance
                await self._push(hearer_id, percept)
                if self.on_chat_percept:
                    self.on_chat_percept(hearer_id, envelope.get("eventId"))

    async def _push(self, villager_id: str, percept: dict) -> None:
        key = f"percepts:{villager_id}"
        async with self._redis.pipeline(transaction=True) as pipe:
            pipe.rpush(key, json.dumps(percept))
            pipe.ltrim(key, -_QUEUE_CAP, -1)
            pipe.expire(key, _QUEUE_TTL_SECONDS)
            await pipe.execute()
