package ai.civ.governmentservice.domain;

import java.time.Instant;
import java.util.UUID;

/**
 * A seated government. P2 is a mayoralty: ElectionDecided seats exactly one
 * active government of type 'mayoralty' at a time — seating a new one
 * dissolves the incumbent (a village has one mayor).
 */
public record Government(
        UUID id,
        String name,
        String governmentType,
        UUID mayorVillagerId,
        String charterJson,
        Instant establishedAt,
        Instant dissolvedAt) {

    public static final String TYPE_MAYORALTY = "mayoralty";
}
