package ai.civ.governmentservice.adapter.out.log;

import ai.civ.governmentservice.application.error.GovernanceRejectedException.ErrorCode;
import ai.civ.governmentservice.application.port.out.GovernmentEventsPort;
import ai.civ.governmentservice.application.port.out.Provenance;
import ai.civ.governmentservice.domain.Candidate;
import ai.civ.governmentservice.domain.Election;
import ai.civ.governmentservice.domain.Vote;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

/**
 * Broker-less fallback adapter (civ.governance.kafka-enabled=false): the
 * M2-6 shape, kept for tests that don't need Kafka and for running the
 * service standalone. The real adapter is KafkaGovernmentEvents.
 */
@Component
@ConditionalOnProperty(prefix = "civ.governance", name = "kafka-enabled", havingValue = "false")
class LoggingGovernmentEvents implements GovernmentEventsPort {

    private static final Logger log = LoggerFactory.getLogger(LoggingGovernmentEvents.class);

    @Override
    public void electionStarted(Election election, Provenance provenance) {
        log.info("ElectionStarted (log-only, kafka disabled) electionId={} office={} startsAt={} endsAt={}",
                election.id(), election.office(), election.startsAt(), election.endsAt());
    }

    @Override
    public void candidateNominated(Candidate candidate, Provenance provenance) {
        log.info("CandidateNominated (log-only, kafka disabled) electionId={} villagerId={}",
                candidate.electionId(), candidate.villagerId());
    }

    @Override
    public void voteCast(Vote vote, Candidate candidate, Provenance provenance) {
        log.info("VoteCast (log-only, kafka disabled) electionId={} voterId={} candidateVillagerId={}",
                vote.electionId(), vote.voterVillagerId(), candidate.villagerId());
    }

    @Override
    public void electionDecided(Election election, Candidate winner, List<Candidate> candidates,
                                Map<UUID, Long> votesByCandidateId, Provenance provenance) {
        log.info("ElectionDecided (log-only, kafka disabled) electionId={} winnerVillagerId={} voteCounts={}",
                election.id(), winner.villagerId(), votesByCandidateId);
    }

    @Override
    public void governanceRejected(UUID commandId, UUID villagerId, String action, UUID electionId,
                                   ErrorCode errorCode, String message, Provenance provenance) {
        log.info("GovernanceRejected (log-only, kafka disabled) commandId={} villagerId={} errorCode={}",
                commandId, villagerId, errorCode);
    }
}
