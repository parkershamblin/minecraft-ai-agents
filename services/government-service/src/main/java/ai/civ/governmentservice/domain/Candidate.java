package ai.civ.governmentservice.domain;

import java.time.Instant;
import java.util.UUID;

/** A candidacy. villagerId is a logical ref into agent_db (never a FK). */
public record Candidate(
        UUID id,
        UUID electionId,
        UUID villagerId,
        String platformJson,
        Instant registeredAt) {
}
