package ai.civ.governmentservice.domain;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Instant;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class ElectionTest {

    private static final Instant STARTS = Instant.parse("2026-07-08T12:00:00Z");
    private static final Instant NOMINATING_ENDS = STARTS.plusSeconds(600);
    private static final Instant ENDS = NOMINATING_ENDS.plusSeconds(900);

    private static Election election(ElectionStatus status) {
        return new Election(UUID.randomUUID(), null, "mayor", status, null,
                STARTS, NOMINATING_ENDS, ENDS, null, STARTS.minusSeconds(60));
    }

    @Test
    void scheduledStaysPutBeforeStartsAt() {
        assertThat(election(ElectionStatus.SCHEDULED).duePhase(STARTS.minusMillis(1))).isEmpty();
    }

    @Test
    void boundariesAreInclusive_atExactlyStartsAtNominatingOpens() {
        assertThat(election(ElectionStatus.SCHEDULED).duePhase(STARTS))
                .isEqualTo(Optional.of(ElectionStatus.NOMINATING));
    }

    @Test
    void nominatingOpensVotingAtNominatingEndsAt() {
        assertThat(election(ElectionStatus.NOMINATING).duePhase(NOMINATING_ENDS.minusMillis(1))).isEmpty();
        assertThat(election(ElectionStatus.NOMINATING).duePhase(NOMINATING_ENDS))
                .isEqualTo(Optional.of(ElectionStatus.VOTING));
    }

    @Test
    void votingClosesToDecidedAtEndsAt() {
        assertThat(election(ElectionStatus.VOTING).duePhase(ENDS.minusMillis(1))).isEmpty();
        assertThat(election(ElectionStatus.VOTING).duePhase(ENDS))
                .isEqualTo(Optional.of(ElectionStatus.DECIDED));
    }

    @Test
    void phasesNeverSkip_aLateClockCascadesOneStepAtATime() {
        // Even a full day late, SCHEDULED is only ever due for NOMINATING —
        // the advance loop iterates; the machine never jumps a phase.
        assertThat(election(ElectionStatus.SCHEDULED).duePhase(ENDS.plusSeconds(86400)))
                .isEqualTo(Optional.of(ElectionStatus.NOMINATING));
    }

    @Test
    void terminalStatesNeverTransition() {
        assertThat(election(ElectionStatus.DECIDED).duePhase(ENDS.plusSeconds(1))).isEmpty();
        assertThat(election(ElectionStatus.ANNULLED).duePhase(ENDS.plusSeconds(1))).isEmpty();
        assertThat(ElectionStatus.DECIDED.terminal()).isTrue();
        assertThat(ElectionStatus.ANNULLED.terminal()).isTrue();
        assertThat(ElectionStatus.VOTING.terminal()).isFalse();
    }

    @Test
    void statusRoundTripsThroughItsDbForm() {
        for (ElectionStatus status : ElectionStatus.values()) {
            assertThat(ElectionStatus.fromDb(status.db())).isEqualTo(status);
        }
        assertThat(ElectionStatus.VOTING.db()).isEqualTo("voting");
    }
}
