package ai.civ.governmentservice.application.port.in;

import ai.civ.governmentservice.application.query.ElectionDetail;
import java.util.Optional;
import java.util.UUID;

public interface QueryElectionUseCase {

    Optional<ElectionDetail> byId(UUID electionId, boolean includeVotes);
}
