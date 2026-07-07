"""Event envelope builder — Python mirror of minecraft-service's, validated
against the same packages/events schema in tests. This is the SECOND copy
(after agent-service's): the promised packages/shared-py extraction is now
due — flagged in HANDOFF, deliberately not done inside M1-9."""

import uuid
from datetime import UTC, datetime
from typing import Any

from uuid6 import uuid7

TOPIC_AGENT = "agent.events"


def build_envelope(
    event_type: str,
    aggregate_id: uuid.UUID | str,
    payload: dict[str, Any],
    *,
    correlation_id: uuid.UUID | str | None = None,
    causation_id: uuid.UUID | str | None = None,
    aggregate_type: str = "Villager",
    event_id: uuid.UUID | None = None,
) -> dict[str, Any]:
    return {
        "eventId": str(event_id or uuid7()),
        "eventType": event_type,
        "schemaVersion": 1,
        "occurredAt": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "source": "memory-service",
        "aggregateType": aggregate_type,
        "aggregateId": str(aggregate_id),
        "correlationId": str(correlation_id or uuid7()),
        "causationId": str(causation_id) if causation_id else None,
        "payload": payload,
    }
