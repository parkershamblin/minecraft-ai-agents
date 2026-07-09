package ai.civ.governmentservice.domain;

import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

/**
 * The pure winner rule, kept out of SQL and out of Spring so it can be unit
 * tested exhaustively: plurality of votes; ties break to the earliest
 * registered candidate ("first to declare"), then by candidate id — a total
 * order, so the same stored rows always produce the same mayor. Zero votes is
 * the caller's problem (the election annuls as 'no_votes' before this runs).
 */
public final class CandidateTally {

    private CandidateTally() {
    }

    public static Optional<Candidate> winner(List<Candidate> candidates, Map<UUID, Long> votesByCandidateId) {
        if (votesByCandidateId.isEmpty()) {
            return Optional.empty();
        }
        return candidates.stream()
                .sorted(Comparator
                        .comparingLong((Candidate c) -> -votesByCandidateId.getOrDefault(c.id(), 0L))
                        .thenComparing(Candidate::registeredAt)
                        .thenComparing(Candidate::id))
                .findFirst();
    }
}
