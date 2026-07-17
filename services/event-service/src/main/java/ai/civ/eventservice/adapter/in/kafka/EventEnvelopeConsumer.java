package ai.civ.eventservice.adapter.in.kafka;

import ai.civ.eventservice.application.port.in.RecordEventUseCase;
import ai.civ.eventservice.domain.StoredEvent;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import java.util.ArrayList;
import java.util.List;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Component;

/**
 * The single ingest seam: every topic — including commands.minecraft, which is
 * archived (never acted on) so the causation chain DecisionMade ->
 * ActionRequested -> ActionCompleted survives in the ledger.
 *
 * Batch listener (spring.kafka.listener.type/ack-mode: batch): one poll's
 * records become one multi-row insert instead of a round trip per record.
 * Concurrency spreads the six topics' partitions across parallel consumers.
 */
@Component
public class EventEnvelopeConsumer {

    private static final Logger log = LoggerFactory.getLogger(EventEnvelopeConsumer.class);

    private final EnvelopeMapper mapper;
    private final RecordEventUseCase recordEvent;
    private final Counter parked;

    EventEnvelopeConsumer(EnvelopeMapper mapper, RecordEventUseCase recordEvent, MeterRegistry metrics) {
        this.mapper = mapper;
        this.recordEvent = recordEvent;
        this.parked = Counter.builder("civ_events_parked_total")
                .description("Messages that were not valid envelopes and were skipped")
                .register(metrics);
    }

    @KafkaListener(topics = "#{'${civ.topics}'.split(',')}",
            concurrency = "${civ.consumer-concurrency:3}")
    public void onMessages(List<ConsumerRecord<String, String>> records) {
        List<StoredEvent> events = new ArrayList<>(records.size());
        for (ConsumerRecord<String, String> record : records) {
            try {
                events.add(mapper.toStoredEvent(record.value(), record.topic()));
            } catch (InvalidEnvelopeException e) {
                // Poison messages are parked (logged + counted), never retried —
                // retrying a parse failure would wedge the partition forever.
                parked.increment();
                log.warn("parked non-envelope message on {} (partition {}, offset {}): {}",
                        record.topic(), record.partition(), record.offset(), e.getMessage());
            }
        }
        if (events.isEmpty()) {
            return;
        }
        // DB failures propagate: the error handler retries the whole batch
        // indefinitely, blocking these partitions. For a ledger that is correct
        // behavior — backpressure over data loss. Retrying a batch is safe:
        // the insert is atomic (all-or-nothing), and redelivered ids no-op.
        recordEvent.record(events);
    }
}
