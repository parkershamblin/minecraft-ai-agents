import json
from typing import Any

from aiokafka import AIOKafkaProducer

from agent_service.logging import logger


class EventPublisher:
    """Envelope publisher; key = aggregateId keeps per-villager ordering."""

    def __init__(self, brokers: str):
        self._producer = AIOKafkaProducer(
            bootstrap_servers=brokers,
            key_serializer=lambda k: k.encode(),
            value_serializer=lambda v: json.dumps(v).encode(),
        )

    async def start(self) -> None:
        await self._producer.start()

    async def stop(self) -> None:
        await self._producer.stop()

    async def publish(self, topic: str, envelope: dict[str, Any]) -> None:
        await self._producer.send_and_wait(topic, key=envelope["aggregateId"], value=envelope)
        logger.debug("published", topic=topic, event_type=envelope["eventType"], event_id=envelope["eventId"])
