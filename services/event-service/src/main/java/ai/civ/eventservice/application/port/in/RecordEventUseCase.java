package ai.civ.eventservice.application.port.in;

import ai.civ.eventservice.domain.StoredEvent;

public interface RecordEventUseCase {

    /** Append to the ledger; a redelivered eventId is a silent no-op (idempotent consumer). */
    void record(StoredEvent event);
}
