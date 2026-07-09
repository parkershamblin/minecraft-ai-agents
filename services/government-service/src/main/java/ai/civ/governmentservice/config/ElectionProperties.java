package ai.civ.governmentservice.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Election window defaults (overridable per election via POST /elections) and
 * the clock cadence. Defaults are the filmable timescales from the M2-6 AC:
 * nominating ~10 min, voting ~15 min.
 */
@ConfigurationProperties(prefix = "civ.election")
public record ElectionProperties(
        int nominatingWindowSeconds,
        int votingWindowSeconds,
        long clockMs) {
}
