package ai.civ.governmentservice.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

/** The command plane's knobs (M2-7). kafkaEnabled=false = broker-less M2-6 shape. */
@ConfigurationProperties(prefix = "civ.governance")
public record GovernanceProperties(
        boolean kafkaEnabled,
        String commandsTopic,
        String eventsTopic,
        long commandMaxAgeSeconds) {
}
