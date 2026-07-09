package ai.civ.governmentservice.application.port.out;

import ai.civ.governmentservice.application.error.GovernanceRejectedException.ErrorCode;
import ai.civ.governmentservice.domain.Candidate;
import ai.civ.governmentservice.domain.Election;
import ai.civ.governmentservice.domain.Vote;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * The emission seam for government facts and rejections — the wire shapes are
 * the government/* v1 contracts in packages/events (M2-7). Implementations:
 * KafkaGovernmentEvents (the real adapter, civ.governance.kafka-enabled=true)
 * or LoggingGovernmentEvents (broker-less fallback). Callers emit inside
 * their transaction; the Kafka adapter defers the send to after-commit, so a
 * rolled-back mutation never leaves a ghost fact on the topic.
 */
public interface GovernmentEventsPort {

    void electionStarted(Election election, Provenance provenance);

    void candidateNominated(Candidate candidate, Provenance provenance);

    /** Emitted exactly once per STORED vote (never for idempotent replays). */
    void voteCast(Vote vote, Candidate candidate, Provenance provenance);

    /**
     * candidates carries every candidacy so zero-vote candidates appear in
     * voteCounts with 0 (the contract's promise to tally consumers).
     */
    void electionDecided(Election election, Candidate winner, List<Candidate> candidates,
                         Map<UUID, Long> votesByCandidateId, Provenance provenance);

    void governanceRejected(UUID commandId, UUID villagerId, String action, UUID electionId,
                            ErrorCode errorCode, String message, Provenance provenance);
}
