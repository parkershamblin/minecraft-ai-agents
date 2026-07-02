package ai.civ.eventservice.application.port.out;

import ai.civ.eventservice.application.query.EventFilter;
import ai.civ.eventservice.application.query.EventPage;
import ai.civ.eventservice.domain.StoredEvent;
import java.util.Optional;
import java.util.UUID;

public interface EventStorePort {

    /** @return true if inserted, false if the eventId already existed (duplicate delivery) */
    boolean append(StoredEvent event);

    EventPage query(EventFilter filter);

    Optional<StoredEvent> findById(UUID eventId);
}
