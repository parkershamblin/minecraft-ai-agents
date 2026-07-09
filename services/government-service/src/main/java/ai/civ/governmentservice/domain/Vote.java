package ai.civ.governmentservice.domain;

import java.time.Instant;
import java.util.UUID;

/**
 * A cast vote. (electionId, voterVillagerId) is the natural idempotency key:
 * the schema's UNIQUE constraint makes redelivery a silent no-op that returns
 * this existing fact (08-m2-plan ruling 5). reason is the LLM's rationale —
 * episode gold, rendered on the M2-9 dashboard.
 */
public record Vote(
        UUID id,
        UUID electionId,
        UUID candidateId,
        UUID voterVillagerId,
        String reason,
        Instant castAt) {
}
