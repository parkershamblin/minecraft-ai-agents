package ai.civ.eventservice.application.port.in;

import ai.civ.eventservice.application.query.EventFilter;
import ai.civ.eventservice.application.query.EventPage;
import ai.civ.eventservice.domain.StoredEvent;
import java.util.Optional;
import java.util.UUID;

public interface QueryEventsUseCase {

    EventPage list(EventFilter filter);

    Optional<StoredEvent> byId(UUID eventId);
}
