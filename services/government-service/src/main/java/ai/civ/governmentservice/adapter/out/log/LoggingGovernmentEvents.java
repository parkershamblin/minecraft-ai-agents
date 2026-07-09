package ai.civ.governmentservice.adapter.out.log;

import ai.civ.governmentservice.application.port.out.GovernmentEventsPort;
import ai.civ.governmentservice.domain.Candidate;
import ai.civ.governmentservice.domain.Election;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * M2-6's emission adapter: structured log lines only. The wire form of
 * ElectionStarted/ElectionDecided is M2-7's contract work (schemas + fixtures
 * in packages/events, then a Kafka producer adapter replaces this class
 * behind the same port). Deliberate — contract-first forbids shipping event
 * shapes that have no schema, and nothing consumes government.events until
 * event-service archives it (also M2-7).
 */
@Component
class LoggingGovernmentEvents implements GovernmentEventsPort {

    private static final Logger log = LoggerFactory.getLogger(LoggingGovernmentEvents.class);

    @Override
    public void electionStarted(Election election) {
        log.info("ElectionStarted (log-only until M2-7 contracts) electionId={} office={} startsAt={} endsAt={}",
                election.id(), election.office(), election.startsAt(), election.endsAt());
    }

    @Override
    public void electionDecided(Election election, Candidate winner, Map<UUID, Long> votesByCandidateId) {
        log.info("ElectionDecided (log-only until M2-7 contracts) electionId={} winnerCandidateId={} winnerVillagerId={} voteCounts={}",
                election.id(), winner.id(), winner.villagerId(), votesByCandidateId);
    }
}
