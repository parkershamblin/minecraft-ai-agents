package ai.civ.eventservice.adapter.in.kafka;

import ai.civ.eventservice.domain.StoredEvent;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.OffsetDateTime;
import java.time.format.DateTimeParseException;
import java.util.List;
import java.util.UUID;
import org.springframework.stereotype.Component;

/**
 * Envelope JSON -> StoredEvent. Structural validation only (required fields,
 * parseable types): the ledger is a tolerant reader and must not drop facts
 * over payload details it does not understand. Full JSON-Schema validation
 * against packages/events is the producers' contract-test job, not the
 * store's runtime job.
 */
@Component
public class EnvelopeMapper {

    private static final List<String> REQUIRED = List.of(
            "eventId", "eventType", "schemaVersion", "occurredAt", "source",
            "aggregateType", "aggregateId", "correlationId", "payload");

    private final ObjectMapper json;

    EnvelopeMapper(ObjectMapper json) {
        this.json = json;
    }

    public StoredEvent toStoredEvent(String message, String topic) {
        JsonNode node;
        try {
            node = json.readTree(message);
        } catch (Exception e) {
            throw new InvalidEnvelopeException("not JSON: " + e.getMessage(), e);
        }
        if (node == null || !node.isObject()) {
            throw new InvalidEnvelopeException("envelope must be a JSON object");
        }
        for (String field : REQUIRED) {
            if (!node.hasNonNull(field)) {
                throw new InvalidEnvelopeException("missing required envelope field: " + field);
            }
        }
        if (!node.get("payload").isObject()) {
            throw new InvalidEnvelopeException("payload must be a JSON object");
        }
        try {
            return new StoredEvent(
                    UUID.fromString(node.get("eventId").asText()),
                    node.get("eventType").asText(),
                    node.get("schemaVersion").asInt(),
                    OffsetDateTime.parse(node.get("occurredAt").asText()),
                    null,
                    node.get("source").asText(),
                    node.get("aggregateType").asText(),
                    UUID.fromString(node.get("aggregateId").asText()),
                    UUID.fromString(node.get("correlationId").asText()),
                    node.hasNonNull("causationId") ? UUID.fromString(node.get("causationId").asText()) : null,
                    topic,
                    node.get("payload").toString());
        } catch (IllegalArgumentException | DateTimeParseException e) {
            throw new InvalidEnvelopeException("malformed envelope field: " + e.getMessage(), e);
        }
    }
}
