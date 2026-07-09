package ai.civ.governmentservice.application.port.in;

import ai.civ.governmentservice.application.query.ElectionDetail;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * The operator lever — the one piece of the arc that is seeded, not organic
 * (08-m2-plan ruling 2: institutions are seeded, politics must be organic).
 */
public interface OpenElectionUseCase {

    /**
     * Every field is optional: office defaults to "mayor", startsAt to now,
     * windows to the configured filmable timescales. candidateVillagerIds is
     * an operator convenience for dev/smoke — organic candidacies arrive via
     * the M2-7 command plane during the nominating window.
     */
    record OpenElection(
            String office,
            Instant startsAt,
            Integer nominatingWindowSeconds,
            Integer votingWindowSeconds,
            List<UUID> candidateVillagerIds) {
    }

    ElectionDetail open(OpenElection command);
}
