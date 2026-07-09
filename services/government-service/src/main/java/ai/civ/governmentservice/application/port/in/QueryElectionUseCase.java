package ai.civ.governmentservice.application.port.in;

import ai.civ.governmentservice.application.query.ElectionDetail;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface QueryElectionUseCase {

    Optional<ElectionDetail> byId(UUID electionId, boolean includeVotes);

    /** Newest first, tallies included, votes omitted — the dashboard's
     * bootstrap ("what is the village's current/latest arc?"). */
    List<ElectionDetail> latest(int limit);
}
