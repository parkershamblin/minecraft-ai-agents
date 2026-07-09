package ai.civ.governmentservice.application.port.in;

import java.time.Instant;
import java.util.UUID;

/**
 * The single governance executor's entry point (08-m2-plan ruling 3): every
 * consumed GovernanceRequested terminates in exactly one outcome —
 * CandidateNominated / VoteCast on success, GovernanceRejected otherwise,
 * nothing at all only for a redelivered commandId (its outcome already
 * exists). Driven by the Kafka adapter; tests drive it directly.
 */
public interface HandleGovernanceCommandUseCase {

    /**
     * The flattened, structurally-parsed command. Raw string params arrive
     * as-parsed (may be null / unparseable) — semantic validation and the
     * INVALID_PARAMS rejection live in the use case, not the adapter.
     */
    record GovernanceCommand(
            UUID commandId,
            UUID villagerId,
            String action,
            String electionIdRaw,
            String candidateVillagerIdRaw,
            String reason,
            String platform,
            Instant occurredAt,
            UUID correlationId) {
    }

    void handle(GovernanceCommand command);
}
