package ai.civ.governmentservice.adapter.in.kafka;

import ai.civ.governmentservice.application.port.in.HandleGovernanceCommandUseCase;
import ai.civ.governmentservice.application.port.in.HandleGovernanceCommandUseCase.GovernanceCommand;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Component;

/**
 * The commands.government consumer — the single governance executor's inbound
 * adapter. Poison messages are parked (logged + counted), never retried;
 * infrastructure failures propagate so the error handler retries and the
 * partition backs up instead of losing commands (event-service pattern).
 */
@Component
public class GovernanceCommandConsumer {

    private static final Logger log = LoggerFactory.getLogger(GovernanceCommandConsumer.class);

    private final GovernanceCommandMapper mapper;
    private final HandleGovernanceCommandUseCase handler;
    private final Counter parked;

    GovernanceCommandConsumer(GovernanceCommandMapper mapper, HandleGovernanceCommandUseCase handler,
                              MeterRegistry metrics) {
        this.mapper = mapper;
        this.handler = handler;
        this.parked = Counter.builder("civ_governance_parked_total")
                .description("Messages on commands.government that were not valid GovernanceRequested envelopes")
                .register(metrics);
    }

    @KafkaListener(
            topics = "${civ.governance.commands-topic}",
            autoStartup = "${civ.governance.kafka-enabled:true}")
    public void onMessage(ConsumerRecord<String, String> record) {
        GovernanceCommand command;
        try {
            command = mapper.toCommand(record.value());
        } catch (InvalidCommandException e) {
            parked.increment();
            log.warn("parked non-command message on {} (partition {}, offset {}): {}",
                    record.topic(), record.partition(), record.offset(), e.getMessage());
            return;
        }
        MDC.put("correlationId", command.correlationId().toString());
        try {
            handler.handle(command);
        } finally {
            MDC.remove("correlationId");
        }
    }
}
