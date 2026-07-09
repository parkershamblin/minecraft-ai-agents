package ai.civ.governmentservice.adapter.out.kafka;

import ai.civ.governmentservice.application.error.GovernanceRejectedException.ErrorCode;
import ai.civ.governmentservice.application.port.out.GovernmentEventsPort;
import ai.civ.governmentservice.application.port.out.Provenance;
import ai.civ.governmentservice.config.GovernanceProperties;
import ai.civ.governmentservice.domain.Candidate;
import ai.civ.governmentservice.domain.Election;
import ai.civ.governmentservice.domain.Vote;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

/**
 * The real emission adapter (M2-7): government/* v1 envelopes onto
 * government.events. Sends are deferred to AFTER the surrounding transaction
 * commits — a rolled-back vote must never leave a ghost VoteCast on the
 * topic. The residual gap (crash between commit and send) is a logged ledger
 * gap, the accepted M1-9 no-outbox tradeoff.
 */
@Component
@ConditionalOnProperty(prefix = "civ.governance", name = "kafka-enabled",
        havingValue = "true", matchIfMissing = true)
class KafkaGovernmentEvents implements GovernmentEventsPort {

    private static final Logger log = LoggerFactory.getLogger(KafkaGovernmentEvents.class);

    private final KafkaTemplate<String, String> kafka;
    private final GovernmentEnvelopeFactory envelopes;
    private final GovernanceProperties props;
    private final ObjectMapper json;

    KafkaGovernmentEvents(KafkaTemplate<String, String> kafka, GovernmentEnvelopeFactory envelopes,
                          GovernanceProperties props, ObjectMapper json) {
        this.kafka = kafka;
        this.envelopes = envelopes;
        this.props = props;
        this.json = json;
    }

    @Override
    public void electionStarted(Election election, Provenance provenance) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("electionId", election.id().toString());
        payload.put("office", election.office());
        payload.put("startsAt", election.startsAt().toString());
        payload.put("nominatingEndsAt", election.nominatingEndsAt().toString());
        payload.put("endsAt", election.endsAt().toString());
        emit("ElectionStarted", "Election", election.id(), provenance, payload);
    }

    @Override
    public void candidateNominated(Candidate candidate, Provenance provenance) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("electionId", candidate.electionId().toString());
        payload.put("candidateId", candidate.id().toString());
        payload.put("villagerId", candidate.villagerId().toString());
        payload.put("platform", plainPlatform(candidate.platformJson()));
        emit("CandidateNominated", "Election", candidate.electionId(), provenance, payload);
    }

    @Override
    public void voteCast(Vote vote, Candidate candidate, Provenance provenance) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("electionId", vote.electionId().toString());
        payload.put("voterId", vote.voterVillagerId().toString());
        payload.put("candidateId", vote.candidateId().toString());
        payload.put("candidateVillagerId", candidate.villagerId().toString());
        payload.put("reason", vote.reason());
        emit("VoteCast", "Election", vote.electionId(), provenance, payload);
    }

    @Override
    public void electionDecided(Election election, Candidate winner, List<Candidate> candidates,
                                Map<UUID, Long> votesByCandidateId, Provenance provenance) {
        // Keyed by candidate VILLAGER id, zero-filled: the contract's promise.
        Map<String, Object> voteCounts = new LinkedHashMap<>();
        long total = 0;
        for (Candidate candidate : candidates) {
            long votes = votesByCandidateId.getOrDefault(candidate.id(), 0L);
            voteCounts.put(candidate.villagerId().toString(), votes);
            total += votes;
        }
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("electionId", election.id().toString());
        payload.put("winnerCandidateId", winner.id().toString());
        payload.put("winnerVillagerId", winner.villagerId().toString());
        payload.put("voteCounts", voteCounts);
        payload.put("totalVotes", total);
        emit("ElectionDecided", "Election", election.id(), provenance, payload);
    }

    @Override
    public void governanceRejected(UUID commandId, UUID villagerId, String action, UUID electionId,
                                   ErrorCode errorCode, String message, Provenance provenance) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("commandId", commandId.toString());
        payload.put("villagerId", villagerId.toString());
        payload.put("action", action);
        payload.put("electionId", electionId == null ? null : electionId.toString());
        payload.put("errorCode", errorCode.name());
        payload.put("message", message);
        // aggregate = the acting villager: a rejection may have no valid election.
        emit("GovernanceRejected", "Villager", villagerId, provenance, payload);
    }

    // ------------------------------------------------------------- plumbing

    private void emit(String eventType, String aggregateType, UUID aggregateId,
                      Provenance provenance, Map<String, Object> payload) {
        GovernmentEnvelopeFactory.Built built =
                envelopes.build(eventType, aggregateType, aggregateId, provenance, payload);
        if (TransactionSynchronizationManager.isSynchronizationActive()) {
            TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                @Override
                public void afterCommit() {
                    send(eventType, built);
                }
            });
        } else {
            send(eventType, built);
        }
    }

    private void send(String eventType, GovernmentEnvelopeFactory.Built built) {
        kafka.send(props.eventsTopic(), built.kafkaKey(), built.json())
                .whenComplete((result, error) -> {
                    if (error != null) {
                        // Ledger gap, logged loud (M1-9 no-outbox tradeoff).
                        log.error("government event publish FAILED (ledger gap) eventType={} eventId={}",
                                eventType, built.eventId(), error);
                    } else {
                        log.info("government event published eventType={} eventId={}",
                                eventType, built.eventId());
                    }
                });
    }

    private String plainPlatform(String platformJson) {
        if (platformJson == null) {
            return null;
        }
        try {
            return json.readTree(platformJson).asText();
        } catch (Exception e) {
            return platformJson; // stored by us as a JSON string scalar; defensive only
        }
    }
}
