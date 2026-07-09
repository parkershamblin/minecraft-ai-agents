package ai.civ.governmentservice.adapter.out.kafka;

import static org.assertj.core.api.Assertions.assertThat;

import ai.civ.governmentservice.application.port.out.Provenance;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/** The envelope shape is packages/events/envelope.schema.json — field for field. */
class GovernmentEnvelopeFactoryTest {

    private static final Instant FROZEN = Instant.parse("2026-07-08T19:00:00.123Z");
    private final ObjectMapper json = new ObjectMapper();
    private final GovernmentEnvelopeFactory factory =
            new GovernmentEnvelopeFactory(json, Clock.fixed(FROZEN, ZoneOffset.UTC));

    @Test
    void buildsAContractShapedEnvelope() throws Exception {
        UUID aggregate = UUID.randomUUID();
        UUID correlation = UUID.randomUUID();
        UUID causation = UUID.randomUUID();

        GovernmentEnvelopeFactory.Built built = factory.build(
                "VoteCast", "Election", aggregate,
                Provenance.ofCommand(correlation, causation),
                Map.of("electionId", aggregate.toString()));

        JsonNode envelope = json.readTree(built.json());
        UUID eventId = UUID.fromString(envelope.get("eventId").asText());
        assertThat(eventId.version()).isEqualTo(7); // UUIDv7, like every id in the system
        assertThat(envelope.get("eventType").asText()).isEqualTo("VoteCast");
        assertThat(envelope.get("schemaVersion").asInt()).isEqualTo(1);
        assertThat(envelope.get("occurredAt").asText()).isEqualTo("2026-07-08T19:00:00.123Z");
        assertThat(envelope.get("source").asText()).isEqualTo("government-service");
        assertThat(envelope.get("aggregateType").asText()).isEqualTo("Election");
        assertThat(envelope.get("aggregateId").asText()).isEqualTo(aggregate.toString());
        assertThat(envelope.get("correlationId").asText()).isEqualTo(correlation.toString());
        assertThat(envelope.get("causationId").asText()).isEqualTo(causation.toString());
        assertThat(envelope.get("payload").get("electionId").asText()).isEqualTo(aggregate.toString());
        assertThat(built.kafkaKey()).isEqualTo(aggregate.toString());
        assertThat(built.eventId()).isEqualTo(eventId.toString());
    }

    @Test
    void rootEventsCarryNullCausation() throws Exception {
        GovernmentEnvelopeFactory.Built built = factory.build(
                "ElectionStarted", "Election", UUID.randomUUID(),
                new Provenance(UUID.randomUUID(), null), Map.of());
        JsonNode envelope = json.readTree(built.json());
        assertThat(envelope.hasNonNull("causationId")).isFalse();
        assertThat(envelope.has("causationId")).isTrue(); // present as explicit null
    }
}
