package ai.civ.eventservice.application.query;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

/** Query parameters for the event store; all fields optional except limit. */
public record EventFilter(
        List<String> types,
        String aggregateType,
        UUID aggregateId,
        UUID correlationId,
        OffsetDateTime since,
        OffsetDateTime until,
        Cursor cursor,
        int limit) {

    public static final int MAX_LIMIT = 100;
    public static final int DEFAULT_LIMIT = 25;

    public EventFilter {
        if (limit < 1 || limit > MAX_LIMIT) {
            throw new IllegalArgumentException("limit must be between 1 and " + MAX_LIMIT);
        }
    }
}
