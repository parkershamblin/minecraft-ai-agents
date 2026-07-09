package ai.civ.governmentservice.application.port.out;

import ai.civ.governmentservice.domain.Candidate;
import ai.civ.governmentservice.domain.Election;
import ai.civ.governmentservice.domain.ElectionStatus;
import ai.civ.governmentservice.domain.Vote;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

public interface ElectionStorePort {

    void insertElection(Election election);

    void insertCandidate(Candidate candidate);

    Optional<Election> findElection(UUID electionId);

    /**
     * SELECT ... FOR UPDATE — the row lock serializes vote casting against
     * clock transitions (a vote can never slip in between the tally and the
     * decided flip; it either counts or is rejected WINDOW_CLOSED). Same
     * discipline as agent-service's relationship updates. Requires an active
     * transaction.
     */
    Optional<Election> lockElection(UUID electionId);

    /** Elections in a non-terminal status — the clock's scan set. */
    List<Election> findActiveElections();

    /** Newest first (created_at, id DESC), any status. */
    List<Election> findLatestElections(int limit);

    void updateStatus(UUID electionId, ElectionStatus to);

    void annul(UUID electionId, String reason);

    void decideWinner(UUID electionId, UUID winnerCandidateId);

    /** Ordered by (registeredAt, id) — the tie-break order, stable. */
    List<Candidate> candidatesOf(UUID electionId);

    /** ON CONFLICT DO NOTHING on the natural key; true iff a row was inserted. */
    boolean insertVoteIfAbsent(Vote vote);

    Optional<Vote> findVote(UUID electionId, UUID voterVillagerId);

    /** candidateId -> vote count; candidates with zero votes are absent. */
    Map<UUID, Long> voteCounts(UUID electionId);

    List<Vote> votesOf(UUID electionId);
}
