package ai.civ.eventservice.application.service;

import ai.civ.eventservice.application.port.in.RecordEventUseCase;
import ai.civ.eventservice.application.port.out.EventStorePort;
import ai.civ.eventservice.application.port.out.LiveEventStream;
import ai.civ.eventservice.domain.StoredEvent;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.stereotype.Service;

@Service
public class EventIngestService implements RecordEventUseCase {

    private final EventStorePort store;
    private final LiveEventStream live;
    private final MeterRegistry metrics;
    private final Map<String, Counter> ingestedByTopic = new ConcurrentHashMap<>();
    private final Counter duplicates;

    EventIngestService(EventStorePort store, LiveEventStream live, MeterRegistry metrics) {
        this.store = store;
        this.live = live;
        this.metrics = metrics;
        this.duplicates = Counter.builder("civ_events_duplicates_total")
                .description("Redelivered eventIds ignored by the idempotent consumer")
                .register(metrics);
    }

    @Override
    public void record(StoredEvent event) {
        boolean inserted = store.append(event);
        if (inserted) {
            ingestedByTopic
                    .computeIfAbsent(event.topic(), topic -> Counter.builder("civ_events_ingested_total")
                            .description("Events appended to the store")
                            .tag("topic", topic)
                            .register(metrics))
                    .increment();
            live.publish(event);
        } else {
            duplicates.increment();
        }
    }
}
