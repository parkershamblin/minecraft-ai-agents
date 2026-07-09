package ai.civ.governmentservice.domain;

import java.security.SecureRandom;
import java.time.Clock;
import java.util.UUID;

/**
 * UUIDv7 (RFC 9562): 48-bit unix-millis timestamp, then version/variant bits
 * over random. Row ids here are time-ordered like every other id in the
 * system (event ids are UUIDv7 everywhere). Java 21 has no built-in v7;
 * this is the standard bit layout, verified by unit test.
 */
public final class UuidV7 {

    private static final SecureRandom RANDOM = new SecureRandom();

    private UuidV7() {
    }

    public static UUID next(Clock clock) {
        long millis = clock.millis();
        byte[] random = new byte[10];
        RANDOM.nextBytes(random);

        long msb = (millis & 0xFFFFFFFFFFFFL) << 16;          // 48-bit timestamp
        msb |= 0x7000L;                                        // version 7
        msb |= ((random[0] & 0x0FL) << 8) | (random[1] & 0xFFL); // rand_a (12 bits)

        long lsb = 0x8000000000000000L;                        // variant 10xx
        lsb |= (random[2] & 0x3FL) << 56;
        for (int i = 3; i < 10; i++) {
            lsb |= (random[i] & 0xFFL) << (8 * (9 - i));
        }
        return new UUID(msb, lsb);
    }
}
