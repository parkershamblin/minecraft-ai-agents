package ai.civ.governmentservice.application.port.in;

import ai.civ.governmentservice.domain.Vote;
import java.util.UUID;

/**
 * Casting is idempotent on the (electionId, voterVillagerId) natural key:
 * a repeat cast returns the EXISTING vote with created=false, never
 * double-counts, and never switches the recorded candidate — the first vote
 * stands (04-api-design). In M2-6 this is driven by REST; M2-7's
 * commands.government consumer drives the same use case.
 */
public interface CastVoteUseCase {

    record CastResult(Vote vote, boolean created) {
    }

    CastResult cast(UUID electionId, UUID voterVillagerId, UUID candidateId, String reason);
}
