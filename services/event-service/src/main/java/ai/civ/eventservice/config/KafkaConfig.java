package ai.civ.eventservice.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.kafka.listener.DefaultErrorHandler;
import org.springframework.util.backoff.FixedBackOff;

@Configuration
public class KafkaConfig {

    /**
     * Unlimited retries with a fixed backoff. Parse failures never reach this
     * handler (the listener parks them); what remains is transient
     * infrastructure failure (DB down), where blocking the partition is the
     * point: the ledger applies backpressure instead of losing facts. With the
     * batch listener a failure re-delivers the WHOLE batch, which is safe:
     * the multi-row insert is atomic and redelivered eventIds no-op.
     */
    @Bean
    DefaultErrorHandler kafkaErrorHandler() {
        return new DefaultErrorHandler(new FixedBackOff(2_000L, FixedBackOff.UNLIMITED_ATTEMPTS));
    }
}
