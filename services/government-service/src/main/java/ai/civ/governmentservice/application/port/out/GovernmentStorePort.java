package ai.civ.governmentservice.application.port.out;

import ai.civ.governmentservice.domain.Government;
import java.time.Instant;
import java.util.Optional;
import java.util.UUID;

public interface GovernmentStorePort {

    /** The one undissolved government of this type, if any. */
    Optional<Government> activeGovernment(String governmentType);

    void insertGovernment(Government government);

    void dissolve(UUID governmentId, Instant at);
}
