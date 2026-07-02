package ai.civ.eventservice.adapter.in.kafka;

import ai.civ.eventservice.application.port.in.RecordEventUseCase;
import ai.civ.eventservice.domain.StoredEvent;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Component;

/**
 * The single ingest seam: every topic — including commands.minecraft, which is
 * archived (never acted on) so the causation chain DecisionMade ->
 * ActionRequested -> ActionCompleted survives in the ledger.
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

    @KafkaListener(topics = "#{'${civ.topics}'.split(',')}")
    public void onMessage(ConsumerRecord<String, String> record) {
        StoredEvent event;
        try {
            event = mapper.toStoredEvent(record.value(), record.topic());
        } catch (InvalidEnvelopeException e) {
            // Poison messages are parked (logged + counted), never retried —
            // retrying a parse failure would wedge the partition forever.
            parked.increment();
            log.warn("parked non-envelope message on {} (partition {}, offset {}): {}",
                    record.topic(), record.partition(), record.offset(), e.getMessage());
            return;
        }
        MDC.put("correlationId", event.correlationId().toString());
        try {
            // DB failures propagate: the error handler retries indefinitely,
            // blocking this partition. For a ledger that is correct behavior —
            // backpressure over data loss.
            recordEvent.record(event);
        } finally {
            MDC.remove("correlationId");
        }
    }
}
