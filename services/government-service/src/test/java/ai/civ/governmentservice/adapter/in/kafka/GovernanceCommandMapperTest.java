package ai.civ.governmentservice.adapter.in.kafka;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import ai.civ.governmentservice.application.port.in.HandleGovernanceCommandUseCase.GovernanceCommand;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import org.junit.jupiter.api.Test;

class GovernanceCommandMapperTest {

    private final GovernanceCommandMapper mapper = new GovernanceCommandMapper(new ObjectMapper());

    private static String fixture(String name) throws IOException {
        return Files.readString(Path.of("..", "..", "packages", "events", "fixtures", name));
    }

    @Test
    void mapsTheContractFixtureFieldForField() throws Exception {
        GovernanceCommand cmd = mapper.toCommand(fixture("GovernanceRequested.v1.json"));
        assertThat(cmd.commandId().toString()).isEqualTo("019f8e2b-0012-7000-8000-00000000b012");
        assertThat(cmd.villagerId().toString()).isEqualTo("019f8e2a-0000-7000-8000-0000000e1a2a");
        assertThat(cmd.action()).isEqualTo("vote");
        assertThat(cmd.electionIdRaw()).isEqualTo("019f8e2a-0000-7000-8000-0000e1ec0001");
        assertThat(cmd.candidateVillagerIdRaw()).isEqualTo("019f8e2a-0000-7000-8000-0000000b2a44");
        assertThat(cmd.reason()).contains("shared his bread");
        assertThat(cmd.platform()).isNull();
        assertThat(cmd.occurredAt()).isEqualTo(Instant.parse("2026-07-08T19:12:30.000Z"));
        assertThat(cmd.correlationId().toString()).isEqualTo("019f8e2b-0001-7000-8000-c0de00000001");
    }

    @Test
    void offEnumActionsArePicked_theInvalidFixtureIsParkedNotRejected() {
        // GovernanceRejected.action could not carry 'propose_law' validly, so
        // the mapper parks it (no contract outcome for a non-contract message).
        assertThatThrownBy(() -> mapper.toCommand(fixture("invalid/GovernanceRequested.bad-action.v1.json")))
                .isInstanceOf(InvalidCommandException.class)
                .hasMessageContaining("propose_law");
    }

    @Test
    void nonJsonAndMissingFieldsArePicked() {
        assertThatThrownBy(() -> mapper.toCommand("chat noise, not an envelope"))
                .isInstanceOf(InvalidCommandException.class);
        assertThatThrownBy(() -> mapper.toCommand("{\"eventType\":\"GovernanceRequested\"}"))
                .isInstanceOf(InvalidCommandException.class)
                .hasMessageContaining("missing required envelope field");
    }
}
