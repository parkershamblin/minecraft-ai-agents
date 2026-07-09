package ai.civ.governmentservice.adapter.out.persistence;

import ai.civ.governmentservice.application.port.out.ProcessedCommandsPort;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

@Repository
class JdbcProcessedCommands implements ProcessedCommandsPort {

    private final JdbcClient jdbc;

    JdbcProcessedCommands(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    @Override
    public boolean claim(UUID commandId, UUID villagerId, String action) {
        // The PK is the claim: a concurrent duplicate blocks on the row, then
        // conflicts to 0 once the first delivery's transaction commits.
        int inserted = jdbc.sql("""
                        INSERT INTO processed_commands (command_id, villager_id, action, outcome)
                        VALUES (:commandId, :villagerId, :action, 'claimed')
                        ON CONFLICT (command_id) DO NOTHING
                        """)
                .param("commandId", commandId)
                .param("villagerId", villagerId)
                .param("action", action)
                .update();
        return inserted == 1;
    }

    @Override
    public void complete(UUID commandId, String outcome) {
        jdbc.sql("UPDATE processed_commands SET outcome = :outcome WHERE command_id = :commandId")
                .param("outcome", outcome)
                .param("commandId", commandId)
                .update();
    }
}
