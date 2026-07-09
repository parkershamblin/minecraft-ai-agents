package ai.civ.governmentservice.application.port.in;

import java.time.Instant;

/**
 * One pass of the election clock: every non-terminal election whose boundary
 * has passed moves one or more phases. Takes an explicit {@code now} so tests
 * can step time deterministically; the scheduled adapter passes the wall
 * clock. Idempotent — a pass where nothing is due changes nothing.
 */
public interface AdvanceElectionsUseCase {

    void advance(Instant now);
}
