package ai.civ.governmentservice.adapter.in.rest;

import ai.civ.governmentservice.application.query.ElectionDetail;
import ai.civ.governmentservice.domain.Election;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * The wire shape of an election: candidates always carry their live tally;
 * votes (with reasons — the campaign's receipts) appear only under
 * include=votes. Null fields are omitted-when-absent JSON nulls, matching the
 * other services' camelCase style.
 */
public record ElectionDto(
        UUID electionId,
        String office,
        String status,
        UUID governmentId,
        Instant startsAt,
        Instant nominatingEndsAt,
        Instant endsAt,
        UUID winnerCandidateId,
        UUID winnerVillagerId,
        String annulledReason,
        List<CandidateDto> candidates,
        long totalVotes,
        List<VoteDto> votes) {

    public record CandidateDto(
            UUID candidateId, UUID villagerId, String platform, Instant registeredAt, long votes) {
    }

    private static final ObjectMapper JSON = new ObjectMapper();

    /** candidates.platform is stored as a jsonb string scalar; unwrap to prose. */
    private static String plainPlatform(String platformJson) {
        if (platformJson == null) {
            return null;
        }
        try {
            return JSON.readTree(platformJson).asText();
        } catch (Exception e) {
            return platformJson;
        }
    }

    public record VoteDto(UUID voteId, UUID candidateId, UUID voterId, String reason, Instant castAt) {
    }

    static ElectionDto from(ElectionDetail detail) {
        Election e = detail.election();
        UUID winnerVillagerId = detail.candidates().stream()
                .filter(c -> c.candidate().id().equals(e.winnerCandidateId()))
                .map(c -> c.candidate().villagerId())
                .findFirst().orElse(null);
        return new ElectionDto(
                e.id(),
                e.office(),
                e.status().db(),
                e.governmentId(),
                e.startsAt(),
                e.nominatingEndsAt(),
                e.endsAt(),
                e.winnerCandidateId(),
                winnerVillagerId,
                e.annulledReason(),
                detail.candidates().stream()
                        .map(c -> new CandidateDto(
                                c.candidate().id(), c.candidate().villagerId(),
                                plainPlatform(c.candidate().platformJson()),
                                c.candidate().registeredAt(), c.votes()))
                        .toList(),
                detail.totalVotes(),
                detail.votes() == null ? null : detail.votes().stream()
                        .map(v -> new VoteDto(v.id(), v.candidateId(), v.voterVillagerId(), v.reason(), v.castAt()))
                        .toList());
    }
}
