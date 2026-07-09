package ai.civ.governmentservice.adapter.in.scheduling;

import ai.civ.governmentservice.application.port.in.AdvanceElectionsUseCase;
import java.time.Clock;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * The driving adapter for time itself: every clock-ms, one advance pass.
 * All state-machine writes flow through the use case; this class only
 * supplies "now". Tests set civ.election.clock-ms high and call the use case
 * with synthetic instants instead (the initial delay keeps the boot tick out
 * of their way).
 */
@Component
class ElectionClock {

    private final AdvanceElectionsUseCase advanceElections;
    private final Clock clock;

    ElectionClock(AdvanceElectionsUseCase advanceElections, Clock clock) {
        this.advanceElections = advanceElections;
        this.clock = clock;
    }

    @Scheduled(
            initialDelayString = "${civ.election.clock-ms:5000}",
            fixedDelayString = "${civ.election.clock-ms:5000}")
    void tick() {
        advanceElections.advance(clock.instant());
    }
}
