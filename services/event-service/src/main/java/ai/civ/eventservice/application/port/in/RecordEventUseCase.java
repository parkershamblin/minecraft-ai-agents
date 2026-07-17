package ai.civ.eventservice.application.port.in;

import ai.civ.eventservice.domain.StoredEvent;
import java.util.List;

public interface RecordEventUseCase {

    /**
     * Append a batch to the ledger in one round trip; redelivered eventIds are
     * silent no-ops (idempotent consumer). Any failure throws before offsets
     * are committed, so no event in the batch can be lost.
     */
    void record(List<StoredEvent> events);
}
