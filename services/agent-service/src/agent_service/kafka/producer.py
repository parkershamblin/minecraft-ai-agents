import asyncio
import json
from typing import Any

from aiokafka import AIOKafkaProducer

from agent_service.logging import logger


class EventPublisher:
    """Envelope publisher; key = aggregateId keeps per-villager ordering.

    publish() is fire-and-forget: the shared producer batches events and keeps
    per-partition ordering, and the tick pays ONE broker round-trip at its end
    (flush(), called from the reflect node) instead of one per event. Delivery
    failures surface through the done-callback log, correlationId included.
    """

    def __init__(self, brokers: str):
        self._producer = AIOKafkaProducer(
            bootstrap_servers=brokers,
            key_serializer=lambda k: k.encode(),
            value_serializer=lambda v: json.dumps(v).encode(),
        )

    async def start(self) -> None:
        await self._producer.start()

    async def stop(self) -> None:
        await self._producer.stop()  # flushes anything still buffered

    async def publish(self, topic: str, envelope: dict[str, Any]) -> None:
        future = await self._producer.send(topic, key=envelope["aggregateId"], value=envelope)
        future.add_done_callback(
            lambda f: self._log_delivery(
                f, topic, envelope["eventType"], envelope["eventId"], envelope.get("correlationId")
            )
        )
        logger.debug("published", topic=topic, event_type=envelope["eventType"], event_id=envelope["eventId"])

    async def flush(self) -> None:
        """Await delivery of everything published so far — the once-per-tick seam."""
        await self._producer.flush()

    @staticmethod
    def _log_delivery(
        future: asyncio.Future, topic: str, event_type: str, event_id: str, correlation_id: str | None
    ) -> None:
        if future.cancelled() or future.exception() is None:
            return
        logger.error(
            "event delivery failed",
            topic=topic,
            event_type=event_type,
            event_id=event_id,
            correlationId=correlation_id,
            error=str(future.exception()),
        )
