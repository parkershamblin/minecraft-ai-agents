package ai.civ.eventservice.application.port.out;

import ai.civ.eventservice.application.query.EventFilter;
import ai.civ.eventservice.application.query.EventPage;
import ai.civ.eventservice.domain.StoredEvent;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

public interface EventStorePort {

    /**
     * Append a batch in a single round trip.
     *
     * @return the eventIds actually inserted; an id missing from the result
     *         already existed (duplicate delivery) and was ignored
     */
    Set<UUID> appendAll(List<StoredEvent> events);

    EventPage query(EventFilter filter);

    Optional<StoredEvent> findById(UUID eventId);
}
