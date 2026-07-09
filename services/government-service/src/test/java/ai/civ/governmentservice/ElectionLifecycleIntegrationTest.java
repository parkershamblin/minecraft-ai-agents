package ai.civ.governmentservice;

import static org.assertj.core.api.Assertions.assertThat;

import ai.civ.governmentservice.application.port.in.AdvanceElectionsUseCase;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Instant;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * The M2-6 acceptance proof against REAL Postgres (same image as compose):
 * a full election walks scheduled -> nominating -> voting -> decided under a
 * deterministically stepped clock, the tally lands, ElectionDecided seats the
 * mayor's governments row, the vote natural key no-ops duplicates, and the
 * no-candidates / no-votes paths annul. The real scheduled clock is parked
 * (clock-ms = 1h) so tests own time via the use case.
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = {
                "civ.election.clock-ms=3600000",
                // Broker-less boot (the M2-6 shape): REST + state machine only.
                // The Kafka wiring has its own integration test.
                "civ.governance.kafka-enabled=false",
        })
@Testcontainers
class ElectionLifecycleIntegrationTest {

    @Container
    static final PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>(
            DockerImageName.parse("pgvector/pgvector:0.8.0-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("government_db");

    @DynamicPropertySource
    static void wire(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", postgres::getJdbcUrl);
        registry.add("spring.datasource.username", postgres::getUsername);
        registry.add("spring.datasource.password", postgres::getPassword);
    }

    static final ObjectMapper json = new ObjectMapper();

    @Autowired
    TestRestTemplate rest;

    @Autowired
    AdvanceElectionsUseCase clock;

    @Autowired
    JdbcClient jdbc;

    // ------------------------------------------------------------- helpers

    private ResponseEntity<String> post(String path, String body) {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        return rest.postForEntity(path, new HttpEntity<>(body, headers), String.class);
    }

    private JsonNode getElection(UUID id, boolean includeVotes) throws Exception {
        ResponseEntity<String> response = rest.getForEntity(
                "/elections/" + id + (includeVotes ? "?include=votes" : ""), String.class);
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        return json.readTree(response.getBody());
    }

    private JsonNode openElection(String body) throws Exception {
        ResponseEntity<String> response = post("/elections", body);
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        JsonNode election = json.readTree(response.getBody());
        assertThat(response.getHeaders().getLocation().toString())
                .isEqualTo("/elections/" + election.get("electionId").asText());
        return election;
    }

    private ResponseEntity<String> castVote(UUID electionId, UUID voter, UUID candidateId, String reason) {
        return post("/elections/" + electionId + "/votes",
                "{\"voterId\":\"" + voter + "\",\"candidateId\":\"" + candidateId + "\""
                        + (reason == null ? "" : ",\"reason\":\"" + reason + "\"") + "}");
    }

    private static UUID uuidOf(JsonNode node, String field) {
        return UUID.fromString(node.get(field).asText());
    }

    private JsonNode candidateOf(JsonNode election, UUID villagerId) {
        for (JsonNode candidate : election.get("candidates")) {
            if (candidate.get("villagerId").asText().equals(villagerId.toString())) {
                return candidate;
            }
        }
        throw new AssertionError("no candidate for villager " + villagerId);
    }

    private long activeMayoralties() {
        return jdbc.sql("SELECT count(*) FROM governments WHERE government_type = 'mayoralty' AND dissolved_at IS NULL")
                .query(Long.class).single();
    }

    private UUID activeMayor() {
        return jdbc.sql("SELECT mayor_villager_id FROM governments WHERE government_type = 'mayoralty' AND dissolved_at IS NULL")
                .query(UUID.class).single();
    }

    // --------------------------------------------------------------- tests

    @Test
    void fullElectionLifecycle() throws Exception {
        UUID villagerA = UUID.randomUUID();
        UUID villagerB = UUID.randomUUID();

        // ---- open: operator lever; duplicate seeded candidate is deduped ----
        JsonNode opened = openElection("""
                {"office": "mayor",
                 "nominatingWindowSeconds": 600, "votingWindowSeconds": 900,
                 "candidateVillagerIds": ["%s", "%s", "%s"]}
                """.formatted(villagerA, villagerB, villagerA));
        UUID electionId = uuidOf(opened, "electionId");
        assertThat(opened.get("status").asText()).isEqualTo("scheduled");
        assertThat(opened.get("candidates")).hasSize(2);
        assertThat(opened.get("totalVotes").asLong()).isZero();

        Instant startsAt = Instant.parse(opened.get("startsAt").asText());
        Instant nominatingEndsAt = Instant.parse(opened.get("nominatingEndsAt").asText());
        Instant endsAt = Instant.parse(opened.get("endsAt").asText());
        assertThat(nominatingEndsAt).isEqualTo(startsAt.plusSeconds(600));
        assertThat(endsAt).isEqualTo(nominatingEndsAt.plusSeconds(900));

        UUID candidateA = uuidOf(candidateOf(opened, villagerA), "candidateId");
        UUID candidateB = uuidOf(candidateOf(opened, villagerB), "candidateId");

        // ---- votes outside the voting window are rejected, machine-readably --
        ResponseEntity<String> early = castVote(electionId, UUID.randomUUID(), candidateA, null);
        assertThat(early.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        JsonNode earlyProblem = json.readTree(early.getBody());
        assertThat(earlyProblem.get("errorCode").asText()).isEqualTo("WINDOW_CLOSED");
        assertThat(earlyProblem.get("correlationId").asText()).isNotBlank();
        assertThat(early.getHeaders().getContentType().toString()).contains("problem+json");

        // ---- the clock, stepped deterministically --------------------------
        clock.advance(startsAt); // inclusive boundary
        assertThat(getElection(electionId, false).get("status").asText()).isEqualTo("nominating");

        clock.advance(nominatingEndsAt);
        assertThat(getElection(electionId, false).get("status").asText()).isEqualTo("voting");

        // ---- voting: 201 on first cast, live tally over GET -----------------
        UUID voter1 = UUID.randomUUID();
        UUID voter2 = UUID.randomUUID();
        UUID voter3 = UUID.randomUUID();
        assertThat(castVote(electionId, voter1, candidateA, "keeps the pantry honest").getStatusCode())
                .isEqualTo(HttpStatus.CREATED);
        assertThat(castVote(electionId, voter2, candidateA, "steady hands").getStatusCode())
                .isEqualTo(HttpStatus.CREATED);
        assertThat(castVote(electionId, voter3, candidateB, null).getStatusCode())
                .isEqualTo(HttpStatus.CREATED);

        // ---- idempotency: a re-vote (even for another candidate!) no-ops ----
        ResponseEntity<String> replay = castVote(electionId, voter1, candidateB, "changed my mind");
        assertThat(replay.getStatusCode()).isEqualTo(HttpStatus.OK); // 200, not 201
        assertThat(json.readTree(replay.getBody()).get("candidateId").asText())
                .isEqualTo(candidateA.toString()); // the first vote stands

        // ---- rejections carry the M2-7 errorCode vocabulary ------------------
        ResponseEntity<String> phantom = castVote(electionId, UUID.randomUUID(), UUID.randomUUID(), null);
        assertThat(phantom.getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat(json.readTree(phantom.getBody()).get("errorCode").asText()).isEqualTo("NOT_A_CANDIDATE");

        ResponseEntity<String> ghost = castVote(UUID.randomUUID(), UUID.randomUUID(), candidateA, null);
        assertThat(ghost.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(json.readTree(ghost.getBody()).get("errorCode").asText()).isEqualTo("UNKNOWN_ELECTION");

        // ---- live tally + include=votes (the reasons are the episode gold) --
        JsonNode inFlight = getElection(electionId, false);
        assertThat(inFlight.get("totalVotes").asLong()).isEqualTo(3);
        assertThat(candidateOf(inFlight, villagerA).get("votes").asLong()).isEqualTo(2);
        assertThat(candidateOf(inFlight, villagerB).get("votes").asLong()).isEqualTo(1);
        assertThat(inFlight.path("votes").isNull() || inFlight.path("votes").isMissingNode())
                .as("votes only render under include=votes").isTrue();

        JsonNode withVotes = getElection(electionId, true);
        assertThat(withVotes.get("votes")).hasSize(3);
        assertThat(withVotes.get("votes").findValuesAsText("reason"))
                .contains("keeps the pantry honest", "steady hands");

        // ---- decided: plurality winner, governments row seated ---------------
        clock.advance(endsAt);
        JsonNode decided = getElection(electionId, false);
        assertThat(decided.get("status").asText()).isEqualTo("decided");
        assertThat(decided.get("winnerCandidateId").asText()).isEqualTo(candidateA.toString());
        assertThat(decided.get("winnerVillagerId").asText()).isEqualTo(villagerA.toString());

        assertThat(activeMayoralties()).isEqualTo(1);
        assertThat(activeMayor()).isEqualTo(villagerA);

        // ---- after the close: replays still 200, new votes still rejected ----
        ResponseEntity<String> lateReplay = castVote(electionId, voter1, candidateA, null);
        assertThat(lateReplay.getStatusCode()).isEqualTo(HttpStatus.OK);
        ResponseEntity<String> lateNew = castVote(electionId, UUID.randomUUID(), candidateA, null);
        assertThat(lateNew.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);

        // ---- the clock is idempotent past the end ----------------------------
        clock.advance(endsAt.plusSeconds(3600));
        assertThat(getElection(electionId, false).get("status").asText()).isEqualTo("decided");
        assertThat(activeMayoralties()).isEqualTo(1);
    }

    @Test
    void noCandidatesAnnuls_andALateClockCascadesSafely() throws Exception {
        JsonNode opened = openElection("{\"nominatingWindowSeconds\": 60, \"votingWindowSeconds\": 60}");
        UUID electionId = uuidOf(opened, "electionId");
        Instant nominatingEndsAt = Instant.parse(opened.get("nominatingEndsAt").asText());

        // One advance far past the nominating close: scheduled -> nominating ->
        // (voting due, but nobody ran) -> annulled, all in a single pass.
        clock.advance(nominatingEndsAt.plusSeconds(30));

        JsonNode annulled = getElection(electionId, false);
        assertThat(annulled.get("status").asText()).isEqualTo("annulled");
        assertThat(annulled.get("annulledReason").asText()).isEqualTo("no_candidates");
        assertThat(annulled.get("winnerCandidateId").isNull()).isTrue();
    }

    @Test
    void candidatesButNoVotesAnnuls() throws Exception {
        UUID villagerC = UUID.randomUUID();
        JsonNode opened = openElection("""
                {"nominatingWindowSeconds": 60, "votingWindowSeconds": 60,
                 "candidateVillagerIds": ["%s"]}
                """.formatted(villagerC));
        UUID electionId = uuidOf(opened, "electionId");
        Instant endsAt = Instant.parse(opened.get("endsAt").asText());

        clock.advance(endsAt); // cascades all the way; zero votes -> annulled
        JsonNode annulled = getElection(electionId, false);
        assertThat(annulled.get("status").asText()).isEqualTo("annulled");
        assertThat(annulled.get("annulledReason").asText()).isEqualTo("no_votes");
    }

    @Test
    void reElectionSeatsTheNewMayorAndDissolvesTheIncumbent() throws Exception {
        UUID villagerD = UUID.randomUUID();
        UUID villagerE = UUID.randomUUID();

        decideElectionFor(villagerD);
        assertThat(activeMayoralties()).isEqualTo(1);
        assertThat(activeMayor()).isEqualTo(villagerD);

        UUID second = decideElectionFor(villagerE);
        assertThat(activeMayoralties()).as("a village has one mayor").isEqualTo(1);
        assertThat(activeMayor()).isEqualTo(villagerE);

        // The second election recorded the incumbent it ran under.
        JsonNode secondElection = getElection(second, false);
        assertThat(secondElection.get("governmentId").isNull()).isFalse();
    }

    private UUID decideElectionFor(UUID villager) throws Exception {
        JsonNode opened = openElection("""
                {"nominatingWindowSeconds": 60, "votingWindowSeconds": 60,
                 "candidateVillagerIds": ["%s"]}
                """.formatted(villager));
        UUID electionId = uuidOf(opened, "electionId");
        UUID candidateId = uuidOf(opened.get("candidates").get(0), "candidateId");
        clock.advance(Instant.parse(opened.get("nominatingEndsAt").asText()));
        assertThat(castVote(electionId, UUID.randomUUID(), candidateId, "the only name on the ballot")
                .getStatusCode()).isEqualTo(HttpStatus.CREATED);
        clock.advance(Instant.parse(opened.get("endsAt").asText()));
        assertThat(getElection(electionId, false).get("status").asText()).isEqualTo("decided");
        return electionId;
    }

    @Test
    void validationRejectsNonsense() throws Exception {
        // zero-length window
        ResponseEntity<String> zeroWindow = post("/elections", "{\"nominatingWindowSeconds\": 0}");
        assertThat(zeroWindow.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);

        // vote body missing voterId
        ResponseEntity<String> noVoter = post("/elections/" + UUID.randomUUID() + "/votes",
                "{\"candidateId\":\"" + UUID.randomUUID() + "\"}");
        assertThat(noVoter.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(noVoter.getHeaders().getContentType().toString()).contains("problem+json");

        // unknown election on GET is a problem+json 404 with correlationId
        ResponseEntity<String> missing = rest.getForEntity("/elections/" + UUID.randomUUID(), String.class);
        assertThat(missing.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(json.readTree(missing.getBody()).get("correlationId").asText()).isNotBlank();
    }
}
