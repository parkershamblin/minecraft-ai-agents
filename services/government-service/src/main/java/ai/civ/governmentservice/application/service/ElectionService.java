package ai.civ.governmentservice.application.service;

import ai.civ.governmentservice.application.error.GovernanceRejectedException;
import ai.civ.governmentservice.application.error.GovernanceRejectedException.ErrorCode;
import ai.civ.governmentservice.application.port.in.AdvanceElectionsUseCase;
import ai.civ.governmentservice.application.port.in.CastVoteUseCase;
import ai.civ.governmentservice.application.port.in.OpenElectionUseCase;
import ai.civ.governmentservice.application.port.in.QueryElectionUseCase;
import ai.civ.governmentservice.application.port.out.ElectionStorePort;
import ai.civ.governmentservice.application.port.out.GovernmentEventsPort;
import ai.civ.governmentservice.application.port.out.GovernmentStorePort;
import ai.civ.governmentservice.application.query.ElectionDetail;
import ai.civ.governmentservice.config.ElectionProperties;
import ai.civ.governmentservice.domain.Candidate;
import ai.civ.governmentservice.domain.CandidateTally;
import ai.civ.governmentservice.domain.Election;
import ai.civ.governmentservice.domain.ElectionStatus;
import ai.civ.governmentservice.domain.Government;
import ai.civ.governmentservice.domain.UuidV7;
import ai.civ.governmentservice.domain.Vote;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import java.time.Clock;
import java.time.Instant;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;

@Service
public class ElectionService
        implements OpenElectionUseCase, QueryElectionUseCase, CastVoteUseCase, AdvanceElectionsUseCase {

    private static final Logger log = LoggerFactory.getLogger(ElectionService.class);

    private final ElectionStorePort store;
    private final GovernmentStorePort governments;
    private final GovernmentEventsPort events;
    private final ElectionProperties props;
    private final Clock clock;
    private final TransactionTemplate tx;
    private final Counter opened;
    private final Map<String, Counter> transitions = new ConcurrentHashMap<>();
    private final Map<String, Counter> votes = new ConcurrentHashMap<>();
    private final MeterRegistry metrics;

    ElectionService(ElectionStorePort store, GovernmentStorePort governments, GovernmentEventsPort events,
                    ElectionProperties props, Clock clock, TransactionTemplate tx, MeterRegistry metrics) {
        this.store = store;
        this.governments = governments;
        this.events = events;
        this.props = props;
        this.clock = clock;
        this.tx = tx;
        this.metrics = metrics;
        this.opened = Counter.builder("civ_elections_opened_total")
                .description("Elections opened via the operator lever")
                .register(metrics);
    }

    // ---------------------------------------------------------------- open

    @Override
    @Transactional
    public ElectionDetail open(OpenElection cmd) {
        Instant now = clock.instant();
        String office = cmd.office() == null || cmd.office().isBlank() ? "mayor" : cmd.office().trim();
        long nominatingSeconds = windowSeconds(cmd.nominatingWindowSeconds(), props.nominatingWindowSeconds());
        long votingSeconds = windowSeconds(cmd.votingWindowSeconds(), props.votingWindowSeconds());
        Instant startsAt = cmd.startsAt() == null ? now : cmd.startsAt();

        UUID incumbentId = governments.activeGovernment(Government.TYPE_MAYORALTY)
                .map(Government::id).orElse(null);
        Election election = new Election(
                UuidV7.next(clock), incumbentId, office, ElectionStatus.SCHEDULED, null,
                startsAt,
                startsAt.plusSeconds(nominatingSeconds),
                startsAt.plusSeconds(nominatingSeconds + votingSeconds),
                null, now);
        store.insertElection(election);

        // Operator-seeded candidates (dev/smoke convenience). Deduped: the
        // schema's UNIQUE would reject a repeat, and an operator typo should
        // not 500 an otherwise valid open.
        Set<UUID> seeded = new LinkedHashSet<>(
                cmd.candidateVillagerIds() == null ? List.of() : cmd.candidateVillagerIds());
        for (UUID villagerId : seeded) {
            store.insertCandidate(new Candidate(UuidV7.next(clock), election.id(), villagerId, null, now));
        }

        events.electionStarted(election);
        opened.increment();
        log.info("election opened electionId={} office={} startsAt={} nominatingEndsAt={} endsAt={} seededCandidates={}",
                election.id(), office, election.startsAt(), election.nominatingEndsAt(), election.endsAt(),
                seeded.size());
        return detail(election.id(), false).orElseThrow();
    }

    private static long windowSeconds(Integer override, int configured) {
        long seconds = override == null ? configured : override;
        if (seconds < 1) {
            throw new IllegalArgumentException("window durations must be at least 1 second, got " + seconds);
        }
        return seconds;
    }

    // ---------------------------------------------------------------- query

    @Override
    @Transactional(readOnly = true)
    public Optional<ElectionDetail> byId(UUID electionId, boolean includeVotes) {
        return detail(electionId, includeVotes);
    }

    private Optional<ElectionDetail> detail(UUID electionId, boolean includeVotes) {
        return store.findElection(electionId).map(election -> {
            Map<UUID, Long> counts = store.voteCounts(electionId);
            List<ElectionDetail.CandidateCount> candidates = store.candidatesOf(electionId).stream()
                    .map(c -> new ElectionDetail.CandidateCount(c, counts.getOrDefault(c.id(), 0L)))
                    .toList();
            long total = counts.values().stream().mapToLong(Long::longValue).sum();
            return new ElectionDetail(election, candidates, total,
                    includeVotes ? store.votesOf(electionId) : null);
        });
    }

    // ---------------------------------------------------------------- vote

    @Override
    @Transactional
    public CastResult cast(UUID electionId, UUID voterVillagerId, UUID candidateId, String reason) {
        // Lock first: casting serializes against the clock's transitions, so a
        // vote either lands before the tally or is rejected WINDOW_CLOSED —
        // never an uncounted row behind a decided election.
        Election election = store.lockElection(electionId)
                .orElseThrow(() -> new GovernanceRejectedException(
                        ErrorCode.UNKNOWN_ELECTION, "no election " + electionId));

        // Idempotency BEFORE the window check: a replay of an accepted vote
        // returns 200 with the existing fact even after the window closed.
        Optional<Vote> existing = store.findVote(electionId, voterVillagerId);
        if (existing.isPresent()) {
            voteCounter("duplicate").increment();
            return new CastResult(existing.get(), false);
        }

        if (election.status() != ElectionStatus.VOTING) {
            throw new GovernanceRejectedException(ErrorCode.WINDOW_CLOSED,
                    "election " + electionId + " is " + election.status().db() + ", not voting");
        }
        boolean isCandidate = store.candidatesOf(electionId).stream()
                .anyMatch(c -> c.id().equals(candidateId));
        if (!isCandidate) {
            throw new GovernanceRejectedException(ErrorCode.NOT_A_CANDIDATE,
                    "candidate " + candidateId + " is not registered in election " + electionId);
        }

        Vote vote = new Vote(UuidV7.next(clock), electionId, candidateId, voterVillagerId,
                blankToNull(reason), clock.instant());
        if (!store.insertVoteIfAbsent(vote)) {
            // Lost a same-voter race despite the lock path — the constraint is
            // the final arbiter; return the fact that won.
            voteCounter("duplicate").increment();
            return new CastResult(store.findVote(electionId, voterVillagerId).orElseThrow(), false);
        }
        voteCounter("accepted").increment();
        log.info("vote cast electionId={} voterVillagerId={} candidateId={}",
                electionId, voterVillagerId, candidateId);
        return new CastResult(vote, true);
    }

    private static String blankToNull(String s) {
        return s == null || s.isBlank() ? null : s;
    }

    // ---------------------------------------------------------------- clock

    @Override
    public void advance(Instant now) {
        for (Election election : store.findActiveElections()) {
            try {
                // One transaction per election: a poisoned row logs and moves
                // on; it must not wedge the whole clock (the M1-10 lesson —
                // scheduled loops fail loud and partial, never silent and total).
                tx.executeWithoutResult(status -> advanceOne(election.id(), now));
            } catch (Exception e) {
                log.error("election advance failed electionId={}", election.id(), e);
            }
        }
    }

    private void advanceOne(UUID electionId, Instant now) {
        Election election = store.lockElection(electionId).orElse(null);
        while (election != null && !election.status().terminal()) {
            ElectionStatus due = election.duePhase(now).orElse(null);
            if (due == null) {
                return;
            }
            switch (due) {
                case NOMINATING -> {
                    store.updateStatus(electionId, ElectionStatus.NOMINATING);
                    transitionCounter(ElectionStatus.NOMINATING).increment();
                    log.info("election nominating window open electionId={} votingOpensAt={}",
                            electionId, election.nominatingEndsAt());
                }
                case VOTING -> {
                    if (store.candidatesOf(electionId).isEmpty()) {
                        annul(electionId, "no_candidates");
                    } else {
                        store.updateStatus(electionId, ElectionStatus.VOTING);
                        transitionCounter(ElectionStatus.VOTING).increment();
                        log.info("election voting window open electionId={} closesAt={}",
                                electionId, election.endsAt());
                    }
                }
                case DECIDED -> decide(election, now);
                default -> {
                    return;
                }
            }
            election = store.findElection(electionId).orElse(null);
        }
    }

    private void decide(Election election, Instant now) {
        Map<UUID, Long> counts = store.voteCounts(election.id());
        List<Candidate> candidates = store.candidatesOf(election.id());
        Optional<Candidate> winner = CandidateTally.winner(candidates, counts);
        if (winner.isEmpty()) {
            annul(election.id(), "no_votes");
            return;
        }

        Candidate mayor = winner.get();
        store.decideWinner(election.id(), mayor.id());

        // A village has one mayor: seating the new government dissolves the
        // incumbent (re-elections just work; the first election finds none).
        governments.activeGovernment(Government.TYPE_MAYORALTY).ifPresent(incumbent -> {
            governments.dissolve(incumbent.id(), now);
            log.info("government dissolved governmentId={} mayorVillagerId={}",
                    incumbent.id(), incumbent.mayorVillagerId());
        });
        Government seated = new Government(UuidV7.next(clock), "Village Mayoralty",
                Government.TYPE_MAYORALTY, mayor.villagerId(), null, now, null);
        governments.insertGovernment(seated);

        transitionCounter(ElectionStatus.DECIDED).increment();
        events.electionDecided(store.findElection(election.id()).orElseThrow(), mayor, counts);
        log.info("election decided electionId={} winnerCandidateId={} mayorVillagerId={} governmentId={} totalVotes={}",
                election.id(), mayor.id(), mayor.villagerId(), seated.id(),
                counts.values().stream().mapToLong(Long::longValue).sum());
    }

    private void annul(UUID electionId, String reason) {
        store.annul(electionId, reason);
        transitionCounter(ElectionStatus.ANNULLED).increment();
        log.info("election annulled electionId={} reason={}", electionId, reason);
    }

    private Counter transitionCounter(ElectionStatus to) {
        return transitions.computeIfAbsent(to.db(), status -> Counter
                .builder("civ_election_transitions_total")
                .description("Election state machine transitions")
                .tag("to", status)
                .register(metrics));
    }

    private Counter voteCounter(String outcome) {
        return votes.computeIfAbsent(outcome, o -> Counter
                .builder("civ_votes_total")
                .description("Vote casts by outcome (accepted, duplicate)")
                .tag("outcome", o)
                .register(metrics));
    }
}
