package ai.civ.governmentservice.application.service;

import ai.civ.governmentservice.application.error.GovernanceRejectedException.ErrorCode;
import ai.civ.governmentservice.application.port.in.HandleGovernanceCommandUseCase;
import ai.civ.governmentservice.application.port.out.ElectionStorePort;
import ai.civ.governmentservice.application.port.out.GovernmentEventsPort;
import ai.civ.governmentservice.application.port.out.ProcessedCommandsPort;
import ai.civ.governmentservice.application.port.out.Provenance;
import ai.civ.governmentservice.config.GovernanceProperties;
import ai.civ.governmentservice.domain.Candidate;
import ai.civ.governmentservice.domain.Election;
import ai.civ.governmentservice.domain.ElectionStatus;
import ai.civ.governmentservice.domain.UuidV7;
import ai.civ.governmentservice.domain.Vote;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import java.time.Clock;
import java.time.Duration;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * The single governance executor. One consumed command -> exactly one outcome
 * event, enforced by the processed_commands claim inside this transaction:
 * a Kafka redelivery fails the claim and emits nothing. Rejections are not
 * errors — they are teaching material (they become percepts in M2-8), so
 * their messages are prescriptive prose, the M2-1 lesson.
 */
@Service
public class GovernanceCommandService implements HandleGovernanceCommandUseCase {

    private static final Logger log = LoggerFactory.getLogger(GovernanceCommandService.class);

    private final ElectionStorePort store;
    private final ProcessedCommandsPort processed;
    private final GovernmentEventsPort events;
    private final GovernanceProperties props;
    private final Clock clock;
    private final MeterRegistry metrics;
    private final Map<String, Counter> outcomes = new ConcurrentHashMap<>();

    GovernanceCommandService(ElectionStorePort store, ProcessedCommandsPort processed,
                             GovernmentEventsPort events, GovernanceProperties props,
                             Clock clock, MeterRegistry metrics) {
        this.store = store;
        this.processed = processed;
        this.events = events;
        this.props = props;
        this.clock = clock;
        this.metrics = metrics;
    }

    @Override
    @Transactional
    public void handle(GovernanceCommand cmd) {
        if (!processed.claim(cmd.commandId(), cmd.villagerId(), cmd.action())) {
            // At-least-once redelivery: the first delivery already produced
            // this command's one outcome. Silently done.
            count("duplicate_delivery");
            log.info("governance command already processed commandId={}", cmd.commandId());
            return;
        }

        Provenance provenance = Provenance.ofCommand(cmd.correlationId(), cmd.commandId());
        UUID electionId = parseUuid(cmd.electionIdRaw());

        // Freshness guard, day one (ruling 7): a frozen consumer group must
        // never replay dead civic intents as live ones.
        long ageSeconds = Duration.between(cmd.occurredAt(), clock.instant()).getSeconds();
        if (ageSeconds > props.commandMaxAgeSeconds()) {
            reject(cmd, electionId, ErrorCode.STALE_COMMAND,
                    "this request is " + ageSeconds + "s old (limit " + props.commandMaxAgeSeconds()
                            + "s) and the moment has passed; look at the current village affairs instead",
                    provenance);
            return;
        }

        if (electionId == null) {
            reject(cmd, null, ErrorCode.INVALID_PARAMS,
                    "the request names no valid electionId; use the election announced in village affairs",
                    provenance);
            return;
        }

        switch (cmd.action()) {
            case "vote" -> vote(cmd, electionId, provenance);
            case "declare_candidacy" -> declareCandidacy(cmd, electionId, provenance);
            default -> reject(cmd, electionId, ErrorCode.INVALID_PARAMS,
                    "unknown governance action '" + cmd.action() + "'", provenance);
        }
    }

    private void vote(GovernanceCommand cmd, UUID electionId, Provenance provenance) {
        Optional<Election> election = store.lockElection(electionId);
        if (election.isEmpty()) {
            reject(cmd, electionId, ErrorCode.UNKNOWN_ELECTION,
                    "no election " + electionId + " exists; it may have been announced wrongly", provenance);
            return;
        }

        // ALREADY_VOTED before the window check: "you already voted" is the
        // truer teaching than "the window closed" for a re-voter.
        if (store.findVote(electionId, cmd.villagerId()).isPresent()) {
            reject(cmd, electionId, ErrorCode.ALREADY_VOTED,
                    "you already voted in this election; the first vote stands and cannot be changed",
                    provenance);
            return;
        }

        Election e = election.get();
        if (e.status() != ElectionStatus.VOTING) {
            reject(cmd, electionId, ErrorCode.WINDOW_CLOSED,
                    windowMessage("voting", e), provenance);
            return;
        }

        UUID candidateVillagerId = parseUuid(cmd.candidateVillagerIdRaw());
        if (candidateVillagerId == null) {
            reject(cmd, electionId, ErrorCode.INVALID_PARAMS,
                    "a vote must name candidateVillagerId — whom are you voting for?", provenance);
            return;
        }
        Optional<Candidate> candidate = store.candidatesOf(electionId).stream()
                .filter(c -> c.villagerId().equals(candidateVillagerId))
                .findFirst();
        if (candidate.isEmpty()) {
            reject(cmd, electionId, ErrorCode.NOT_A_CANDIDATE,
                    "that villager is not a candidate in this election; vote for one of the declared candidates",
                    provenance);
            return;
        }

        Vote vote = new Vote(UuidV7.next(clock), electionId, candidate.get().id(),
                cmd.villagerId(), blankToNull(cmd.reason()), clock.instant());
        if (!store.insertVoteIfAbsent(vote)) {
            reject(cmd, electionId, ErrorCode.ALREADY_VOTED,
                    "you already voted in this election; the first vote stands and cannot be changed",
                    provenance);
            return;
        }

        processed.complete(cmd.commandId(), "vote_cast");
        count("vote_cast");
        events.voteCast(vote, candidate.get(), provenance);
        log.info("vote cast via command plane electionId={} voterVillagerId={} candidateVillagerId={}",
                electionId, cmd.villagerId(), candidateVillagerId);
    }

    private void declareCandidacy(GovernanceCommand cmd, UUID electionId, Provenance provenance) {
        Optional<Election> election = store.lockElection(electionId);
        if (election.isEmpty()) {
            reject(cmd, electionId, ErrorCode.UNKNOWN_ELECTION,
                    "no election " + electionId + " exists; it may have been announced wrongly", provenance);
            return;
        }

        boolean alreadyRunning = store.candidatesOf(electionId).stream()
                .anyMatch(c -> c.villagerId().equals(cmd.villagerId()));
        if (alreadyRunning) {
            reject(cmd, electionId, ErrorCode.ALREADY_A_CANDIDATE,
                    "you already declared your candidacy in this election; campaign instead of re-filing",
                    provenance);
            return;
        }

        Election e = election.get();
        if (e.status() != ElectionStatus.NOMINATING) {
            reject(cmd, electionId, ErrorCode.WINDOW_CLOSED,
                    windowMessage("nominating", e), provenance);
            return;
        }

        Candidate candidate = new Candidate(UuidV7.next(clock), electionId, cmd.villagerId(),
                toJsonString(cmd.platform()), clock.instant());
        store.insertCandidate(candidate);

        processed.complete(cmd.commandId(), "candidate_nominated");
        count("candidate_nominated");
        events.candidateNominated(candidate, provenance);
        log.info("candidacy declared via command plane electionId={} villagerId={}",
                electionId, cmd.villagerId());
    }

    private void reject(GovernanceCommand cmd, UUID electionId, ErrorCode code, String message,
                        Provenance provenance) {
        processed.complete(cmd.commandId(), "rejected:" + code.name());
        count("rejected");
        events.governanceRejected(cmd.commandId(), cmd.villagerId(), cmd.action(), electionId,
                code, message, provenance);
        log.info("governance command rejected commandId={} villagerId={} action={} errorCode={}",
                cmd.commandId(), cmd.villagerId(), cmd.action(), code);
    }

    private static String windowMessage(String wanted, Election e) {
        String state = switch (e.status()) {
            case SCHEDULED -> "has not opened yet";
            case NOMINATING -> "is still in nominations (voting opens at " + e.nominatingEndsAt() + ")";
            case VOTING -> "is already voting (nominations closed at " + e.nominatingEndsAt() + ")";
            case DECIDED -> "is already decided";
            case ANNULLED -> "was annulled";
        };
        return "the " + wanted + " window is closed: this election " + state;
    }

    private static UUID parseUuid(String raw) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        try {
            return UUID.fromString(raw.trim());
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    private static String blankToNull(String s) {
        return s == null || s.isBlank() ? null : s;
    }

    /** candidates.platform is jsonb; a bare JSON string scalar is valid jsonb. */
    private static String toJsonString(String s) {
        return s == null || s.isBlank() ? null : "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
    }

    private void count(String outcome) {
        outcomes.computeIfAbsent(outcome, o -> Counter
                .builder("civ_governance_commands_total")
                .description("Consumed governance commands by outcome")
                .tag("outcome", o)
                .register(metrics)).increment();
    }
}
