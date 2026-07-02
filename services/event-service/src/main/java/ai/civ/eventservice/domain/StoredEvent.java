package ai.civ.eventservice.domain;

import java.time.OffsetDateTime;
import java.util.UUID;

/**
 * One immutable fact in the ledger. Deliberately anemic — the event store is
 * not a behavioral model. The payload stays raw JSON: this service is
 * schema-agnostic by design (typed envelope columns + opaque payload), which is
 * why it needs no generated types from packages/events.
 *
 * @param recordedAt server-side ingest time; null until persisted (set by the DB)
 */
public record StoredEvent(
        UUID eventId,
        String eventType,
        int schemaVersion,
        OffsetDateTime occurredAt,
        OffsetDateTime recordedAt,
        String source,
        String aggregateType,
        UUID aggregateId,
        UUID correlationId,
        UUID causationId,
        String topic,
        String payloadJson) {
}
