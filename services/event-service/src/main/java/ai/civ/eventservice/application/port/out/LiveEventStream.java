package ai.civ.eventservice.application.port.out;

import ai.civ.eventservice.domain.StoredEvent;

/**
 * Out-port for the live feed. Only events that were actually inserted are
 * published here — duplicates never reach subscribers, so the SSE stream
 * inherits the store's idempotency.
 */
public interface LiveEventStream {

    void publish(StoredEvent event);
}
