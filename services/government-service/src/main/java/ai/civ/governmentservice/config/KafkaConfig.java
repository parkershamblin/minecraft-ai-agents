package ai.civ.governmentservice.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.kafka.listener.DefaultErrorHandler;
import org.springframework.util.backoff.FixedBackOff;

@Configuration
public class KafkaConfig {

    /**
     * Unlimited retries with fixed backoff (event-service pattern): parse
     * failures never get here (the listener parks them); what remains is
     * transient infrastructure failure, where blocking the partition is
     * correct — backpressure over losing governance commands.
     */
    @Bean
    DefaultErrorHandler kafkaErrorHandler() {
        return new DefaultErrorHandler(new FixedBackOff(2_000L, FixedBackOff.UNLIMITED_ATTEMPTS));
    }
}
