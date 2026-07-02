package ai.civ.eventservice.application.service;

import ai.civ.eventservice.application.port.in.QueryEventsUseCase;
import ai.civ.eventservice.application.port.out.EventStorePort;
import ai.civ.eventservice.application.query.EventFilter;
import ai.civ.eventservice.application.query.EventPage;
import ai.civ.eventservice.domain.StoredEvent;
import java.util.Optional;
import java.util.UUID;
import org.springframework.stereotype.Service;

@Service
public class EventQueryService implements QueryEventsUseCase {

    private final EventStorePort store;

    EventQueryService(EventStorePort store) {
        this.store = store;
    }

    @Override
    public EventPage list(EventFilter filter) {
        return store.query(filter);
    }

    @Override
    public Optional<StoredEvent> byId(UUID eventId) {
        return store.findById(eventId);
    }
}
