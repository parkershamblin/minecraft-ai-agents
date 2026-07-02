package ai.civ.eventservice.adapter.in.kafka;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import ai.civ.eventservice.domain.StoredEvent;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.OffsetDateTime;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * Mapper is exercised against the REAL fixtures from packages/events — if the
 * contract package changes shape, this test is the first thing that breaks.
 */
class EnvelopeMapperTest {

    private final EnvelopeMapper mapper = new EnvelopeMapper(new ObjectMapper());

    static String fixture(String name) throws IOException {
        return Files.readString(Path.of("..", "..", "packages", "events", "fixtures", name));
    }

    @Test
    void mapsTheVillagerSpawnedFixtureFieldForField() throws IOException {
        StoredEvent event = mapper.toStoredEvent(fixture("VillagerSpawned.v1.json"), "world.events");

        assertThat(event.eventId()).isEqualTo(UUID.fromString("019f8e2b-0000-7000-8000-00000000a001"));
        assertThat(event.eventType()).isEqualTo("VillagerSpawned");
        assertThat(event.schemaVersion()).isEqualTo(1);
        assertThat(event.occurredAt()).isEqualTo(OffsetDateTime.parse("2026-07-02T18:40:12.041Z"));
        assertThat(event.source()).isEqualTo("minecraft-service");
        assertThat(event.aggregateType()).isEqualTo("Villager");
        assertThat(event.aggregateId()).isEqualTo(UUID.fromString("019f8e2a-0000-7000-8000-0000000e1a2a"));
        assertThat(event.causationId()).isNull();
        assertThat(event.topic()).isEqualTo("world.events");
        assertThat(event.payloadJson()).contains("\"name\":\"Elara\"");
    }

    @Test
    void nullCausationIdIsARootEventNotAnError() throws IOException {
        StoredEvent event = mapper.toStoredEvent(fixture("DecisionMade.v1.json"), "agent.events");
        assertThat(event.causationId()).isNull();
    }

    @Test
    void missingRequiredFieldIsInvalid() {
        assertThatThrownBy(() -> mapper.toStoredEvent("{\"eventType\":\"X\"}", "world.events"))
                .isInstanceOf(InvalidEnvelopeException.class)
                .hasMessageContaining("missing required envelope field");
    }

    @Test
    void nonJsonIsInvalid() {
        assertThatThrownBy(() -> mapper.toStoredEvent("not json at all", "world.events"))
                .isInstanceOf(InvalidEnvelopeException.class);
    }

    @Test
    void nonObjectPayloadIsInvalid() {
        String message = """
                {"eventId":"019f8e2b-0000-7000-8000-00000000a001","eventType":"X","schemaVersion":1,
                 "occurredAt":"2026-07-02T18:40:12.041Z","source":"minecraft-service","aggregateType":"Villager",
                 "aggregateId":"019f8e2a-0000-7000-8000-0000000e1a2a",
                 "correlationId":"019f8e2b-0000-7000-8000-c0de00000000","causationId":null,"payload":[1,2]}
                """;
        assertThatThrownBy(() -> mapper.toStoredEvent(message, "world.events"))
                .isInstanceOf(InvalidEnvelopeException.class)
                .hasMessageContaining("payload must be a JSON object");
    }
}
