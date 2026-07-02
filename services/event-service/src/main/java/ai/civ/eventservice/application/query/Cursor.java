package ai.civ.eventservice.application.query;

import java.nio.charset.StandardCharsets;
import java.time.OffsetDateTime;
import java.util.Base64;
import java.util.UUID;

/**
 * Keyset-pagination cursor over the total order (occurred_at, event_id).
 * Opaque base64 on the wire — clients never construct or parse it. Keyset
 * beats offset on an append-heavy table: O(log n) and no page drift as new
 * rows land mid-scroll.
 */
public record Cursor(OffsetDateTime occurredAt, UUID eventId) {

    public String encode() {
        return Base64.getUrlEncoder().withoutPadding()
                .encodeToString((occurredAt + "|" + eventId).getBytes(StandardCharsets.UTF_8));
    }

    public static Cursor decode(String encoded) {
        try {
            String raw = new String(Base64.getUrlDecoder().decode(encoded), StandardCharsets.UTF_8);
            int sep = raw.lastIndexOf('|');
            return new Cursor(OffsetDateTime.parse(raw.substring(0, sep)), UUID.fromString(raw.substring(sep + 1)));
        } catch (RuntimeException e) {
            throw new IllegalArgumentException("malformed cursor", e);
        }
    }
}
