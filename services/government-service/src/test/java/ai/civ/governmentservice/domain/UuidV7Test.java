package ai.civ.governmentservice.domain;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class UuidV7Test {

    @Test
    void versionAndVariantBitsAreCorrect() {
        UUID id = UuidV7.next(Clock.systemUTC());
        assertThat(id.version()).isEqualTo(7);
        assertThat(id.variant()).isEqualTo(2); // RFC 4122/9562 variant '10'
    }

    @Test
    void embedsTheClockMillisInTheTop48Bits() {
        Instant frozen = Instant.parse("2026-07-08T12:00:00.123Z");
        UUID id = UuidV7.next(Clock.fixed(frozen, ZoneOffset.UTC));
        long timestamp = id.getMostSignificantBits() >>> 16;
        assertThat(timestamp).isEqualTo(frozen.toEpochMilli());
    }

    @Test
    void laterMillisSortAfterEarlierMillis() {
        UUID earlier = UuidV7.next(Clock.fixed(Instant.parse("2026-07-08T12:00:00.000Z"), ZoneOffset.UTC));
        UUID later = UuidV7.next(Clock.fixed(Instant.parse("2026-07-08T12:00:00.001Z"), ZoneOffset.UTC));
        assertThat(earlier.getMostSignificantBits() >>> 16)
                .isLessThan(later.getMostSignificantBits() >>> 16);
    }

    @Test
    void noCollisionsInABurst() {
        Clock clock = Clock.systemUTC();
        Set<UUID> seen = new HashSet<>();
        for (int i = 0; i < 10_000; i++) {
            assertThat(seen.add(UuidV7.next(clock))).isTrue();
        }
    }
}
