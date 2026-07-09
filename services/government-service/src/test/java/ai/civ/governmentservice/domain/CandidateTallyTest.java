package ai.civ.governmentservice.domain;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class CandidateTallyTest {

    private static final Instant T0 = Instant.parse("2026-07-08T12:00:00Z");
    private static final UUID ELECTION = UUID.randomUUID();

    private static Candidate candidate(UUID id, Instant registeredAt) {
        return new Candidate(id, ELECTION, UUID.randomUUID(), null, registeredAt);
    }

    @Test
    void pluralityWins() {
        Candidate a = candidate(UUID.fromString("00000000-0000-7000-8000-00000000000a"), T0);
        Candidate b = candidate(UUID.fromString("00000000-0000-7000-8000-00000000000b"), T0.plusSeconds(1));
        assertThat(CandidateTally.winner(List.of(a, b), Map.of(a.id(), 2L, b.id(), 5L)))
                .contains(b);
    }

    @Test
    void tieBreaksToEarliestRegistered() {
        Candidate late = candidate(UUID.fromString("00000000-0000-7000-8000-00000000000a"), T0.plusSeconds(30));
        Candidate early = candidate(UUID.fromString("00000000-0000-7000-8000-00000000000b"), T0);
        assertThat(CandidateTally.winner(List.of(late, early), Map.of(late.id(), 3L, early.id(), 3L)))
                .contains(early);
    }

    @Test
    void tieAtSameInstantBreaksToSmallestId_totalOrder() {
        Candidate idA = candidate(UUID.fromString("00000000-0000-7000-8000-00000000000a"), T0);
        Candidate idB = candidate(UUID.fromString("00000000-0000-7000-8000-00000000000b"), T0);
        assertThat(CandidateTally.winner(List.of(idB, idA), Map.of(idA.id(), 1L, idB.id(), 1L)))
                .contains(idA);
    }

    @Test
    void candidateWithZeroVotesLosesToAnyVotes() {
        Candidate a = candidate(UUID.fromString("00000000-0000-7000-8000-00000000000a"), T0);
        Candidate b = candidate(UUID.fromString("00000000-0000-7000-8000-00000000000b"), T0.plusSeconds(1));
        // a registered first but only b's single vote counts
        assertThat(CandidateTally.winner(List.of(a, b), Map.of(b.id(), 1L))).contains(b);
    }

    @Test
    void zeroVotesOverallIsEmpty_theCallerAnnulsInstead() {
        Candidate a = candidate(UUID.randomUUID(), T0);
        assertThat(CandidateTally.winner(List.of(a), Map.of())).isEmpty();
    }
}
