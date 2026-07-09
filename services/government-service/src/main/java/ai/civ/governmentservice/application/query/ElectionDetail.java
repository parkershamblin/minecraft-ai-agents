package ai.civ.governmentservice.application.query;

import ai.civ.governmentservice.domain.Candidate;
import ai.civ.governmentservice.domain.Election;
import ai.civ.governmentservice.domain.Vote;
import java.util.List;

/**
 * The read model behind GET /elections/{id}: the election, its candidates
 * with live per-candidate counts (the tally), and — only when
 * include=votes — the individual votes with their reasons.
 * {@code votes} is null when not requested (vs empty = requested, none cast).
 */
public record ElectionDetail(
        Election election,
        List<CandidateCount> candidates,
        long totalVotes,
        List<Vote> votes) {

    public record CandidateCount(Candidate candidate, long votes) {
    }
}
