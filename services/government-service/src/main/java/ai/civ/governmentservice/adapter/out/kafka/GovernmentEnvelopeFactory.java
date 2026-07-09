package ai.civ.governmentservice.adapter.out.kafka;

import ai.civ.governmentservice.application.port.out.Provenance;
import ai.civ.governmentservice.domain.UuidV7;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.time.Clock;
import java.time.format.DateTimeFormatter;
import java.util.Map;
import java.util.UUID;
import org.springframework.stereotype.Component;

/**
 * The Java envelope builder — hand-rolled like its Python and TS siblings
 * (no Java codegen, 08-m2-plan ruling 6); shape verified against
 * packages/events/envelope.schema.json by unit test. Third copy in the
 * codebase: the shared-envelope extraction stays parked until a second JAVA
 * producer exists, same call as packages/shared-py.
 */
@Component
public class GovernmentEnvelopeFactory {

    public record Built(String eventId, String kafkaKey, String json) {
    }

    private final ObjectMapper json;
    private final Clock clock;

    GovernmentEnvelopeFactory(ObjectMapper json, Clock clock) {
        this.json = json;
        this.clock = clock;
    }

    public Built build(String eventType, String aggregateType, UUID aggregateId,
                       Provenance provenance, Map<String, Object> payload) {
        UUID eventId = UuidV7.next(clock);
        ObjectNode envelope = json.createObjectNode();
        envelope.put("eventId", eventId.toString());
        envelope.put("eventType", eventType);
        envelope.put("schemaVersion", 1);
        envelope.put("occurredAt", DateTimeFormatter.ISO_INSTANT.format(clock.instant()));
        envelope.put("source", "government-service");
        envelope.put("aggregateType", aggregateType);
        envelope.put("aggregateId", aggregateId.toString());
        envelope.put("correlationId", provenance.correlationId().toString());
        if (provenance.causationId() == null) {
            envelope.putNull("causationId");
        } else {
            envelope.put("causationId", provenance.causationId().toString());
        }
        envelope.set("payload", json.valueToTree(payload));
        return new Built(eventId.toString(), aggregateId.toString(), envelope.toString());
    }
}
