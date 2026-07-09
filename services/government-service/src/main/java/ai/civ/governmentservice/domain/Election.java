package ai.civ.governmentservice.domain;

import java.time.Instant;
import java.util.Optional;
import java.util.UUID;

/**
 * An election as stored: three wall-clock boundaries drive the phase
 * transitions ({@code startsAt} opens nominating, {@code nominatingEndsAt}
 * opens voting, {@code endsAt} closes voting). The scheduled clock is the only
 * writer of transitions; {@link #duePhase} is the pure decision it applies.
 */
public record Election(
        UUID id,
        UUID governmentId,
        String office,
        ElectionStatus status,
        UUID winnerCandidateId,
        Instant startsAt,
        Instant nominatingEndsAt,
        Instant endsAt,
        String annulledReason,
        Instant createdAt) {

    /**
     * The next phase this election is due to enter at {@code now}, or empty if
     * it should stay put. Boundaries are inclusive: at exactly {@code startsAt}
     * nominating is open. Terminal states never transition. Callers loop —
     * a clock that slept through a whole window cascades one phase at a time
     * (and an election nobody entered decays to annulled via the usual rules,
     * never silently skipping a phase).
     */
    public Optional<ElectionStatus> duePhase(Instant now) {
        return switch (status) {
            case SCHEDULED -> now.isBefore(startsAt)
                    ? Optional.empty() : Optional.of(ElectionStatus.NOMINATING);
            case NOMINATING -> now.isBefore(nominatingEndsAt)
                    ? Optional.empty() : Optional.of(ElectionStatus.VOTING);
            case VOTING -> now.isBefore(endsAt)
                    ? Optional.empty() : Optional.of(ElectionStatus.DECIDED);
            case DECIDED, ANNULLED -> Optional.empty();
        };
    }
}
