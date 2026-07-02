package ai.civ.eventservice.adapter.in.rest;

import ai.civ.eventservice.domain.StoredEvent;
import com.fasterxml.jackson.annotation.JsonRawValue;
import java.time.OffsetDateTime;
import java.util.UUID;

/**
 * Wire shape for one stored event — the envelope plus the store's own
 * bookkeeping (recordedAt, topic). payload is emitted verbatim
 * ({@link JsonRawValue}): the store never re-interprets what it archived.
 */
public record EventDto(
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
        @JsonRawValue String payload) {

    public static EventDto from(StoredEvent e) {
        return new EventDto(
                e.eventId(), e.eventType(), e.schemaVersion(), e.occurredAt(), e.recordedAt(),
                e.source(), e.aggregateType(), e.aggregateId(), e.correlationId(), e.causationId(),
                e.topic(), e.payloadJson());
    }
}
