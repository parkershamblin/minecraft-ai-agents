package ai.civ.governmentservice.application.port.out;

import ai.civ.governmentservice.domain.UuidV7;
import java.time.Clock;
import java.util.UUID;
import org.slf4j.MDC;

/**
 * Where an emitted event came from: one correlationId per causal chain, and
 * the direct cause's eventId (null for roots). Three origins exist here —
 * a consumed command (correlation + causation from its envelope), a REST
 * request (the CorrelationIdFilter's MDC id, no causation), and the scheduled
 * clock (fresh correlation, no causation — the M1-9 job-run precedent).
 */
public record Provenance(UUID correlationId, UUID causationId) {

    public static Provenance ofCommand(UUID correlationId, UUID commandEventId) {
        return new Provenance(correlationId, commandEventId);
    }

    /** Clock-driven emissions are root events on a fresh correlation. */
    public static Provenance root(Clock clock) {
        return new Provenance(UuidV7.next(clock), null);
    }

    /** REST-driven: reuse the request's correlationId when it parses. */
    public static Provenance ofRestRequest(Clock clock) {
        String mdc = MDC.get("correlationId");
        if (mdc != null) {
            try {
                return new Provenance(UUID.fromString(mdc), null);
            } catch (IllegalArgumentException ignored) {
                // caller-supplied header wasn't a uuid — fall through
            }
        }
        return root(clock);
    }
}
