package ai.civ.governmentservice.adapter.in.rest;

import ai.civ.governmentservice.application.port.in.CastVoteUseCase;
import ai.civ.governmentservice.application.port.in.OpenElectionUseCase;
import ai.civ.governmentservice.application.port.in.QueryElectionUseCase;
import ai.civ.governmentservice.application.query.ElectionDetail;
import io.swagger.v3.oas.annotations.Operation;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;
import java.net.URI;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
public class ElectionsController {

    private final OpenElectionUseCase openElection;
    private final QueryElectionUseCase queryElection;
    private final CastVoteUseCase castVote;

    ElectionsController(OpenElectionUseCase openElection, QueryElectionUseCase queryElection,
                        CastVoteUseCase castVote) {
        this.openElection = openElection;
        this.queryElection = queryElection;
        this.castVote = castVote;
    }

    /** All fields optional — an empty body opens a default mayoral election now. */
    public record OpenElectionRequest(
            String office,
            Instant startsAt,
            @Min(1) @Max(86400) Integer nominatingWindowSeconds,
            @Min(1) @Max(86400) Integer votingWindowSeconds,
            List<UUID> candidateVillagerIds) {
    }

    public record CastVoteRequest(@NotNull UUID voterId, @NotNull UUID candidateId, String reason) {
    }

    @Operation(summary = "Open an election (the operator lever — the institution is seeded, the politics stay organic)")
    @PostMapping("/elections")
    public ResponseEntity<ElectionDto> open(@Valid @RequestBody(required = false) OpenElectionRequest request) {
        OpenElectionRequest body = request == null
                ? new OpenElectionRequest(null, null, null, null, null) : request;
        ElectionDetail detail = openElection.open(new OpenElectionUseCase.OpenElection(
                body.office(), body.startsAt(), body.nominatingWindowSeconds(),
                body.votingWindowSeconds(), body.candidateVillagerIds()));
        ElectionDto dto = ElectionDto.from(detail);
        return ResponseEntity
                .created(URI.create("/elections/" + dto.electionId()))
                .body(dto);
    }

    @Operation(summary = "Election detail: candidates and live tally; add include=votes for the individual votes with reasons")
    @GetMapping("/elections/{electionId}")
    public ElectionDto byId(
            @PathVariable UUID electionId,
            @RequestParam(name = "include", required = false) String include) {
        boolean includeVotes = "votes".equals(include);
        return queryElection.byId(electionId, includeVotes)
                .map(ElectionDto::from)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "no election " + electionId));
    }

    @Operation(summary = "Cast a vote — idempotent on (electionId, voterId): a repeat returns 200 with the existing vote, never double-counts")
    @PostMapping("/elections/{electionId}/votes")
    public ResponseEntity<ElectionDto.VoteDto> castVote(
            @PathVariable UUID electionId,
            @Valid @RequestBody CastVoteRequest request) {
        CastVoteUseCase.CastResult result = castVote.cast(
                electionId, request.voterId(), request.candidateId(), request.reason());
        ElectionDto.VoteDto dto = new ElectionDto.VoteDto(
                result.vote().id(), result.vote().candidateId(), result.vote().voterVillagerId(),
                result.vote().reason(), result.vote().castAt());
        return result.created()
                ? ResponseEntity.created(URI.create("/elections/" + electionId + "/votes/" + dto.voteId())).body(dto)
                : ResponseEntity.ok(dto);
    }
}
