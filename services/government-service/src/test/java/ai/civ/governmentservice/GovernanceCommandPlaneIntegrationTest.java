package ai.civ.governmentservice;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import ai.civ.governmentservice.application.port.in.AdvanceElectionsUseCase;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.UUID;
import org.apache.kafka.clients.consumer.KafkaConsumer;
import org.apache.kafka.clients.producer.KafkaProducer;
import org.apache.kafka.clients.producer.ProducerRecord;
import org.apache.kafka.common.serialization.StringDeserializer;
import org.apache.kafka.common.serialization.StringSerializer;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
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
import org.testcontainers.redpanda.RedpandaContainer;
import org.testcontainers.utility.DockerImageName;

/**
 * The M2-7 acceptance proof: the governance command plane against REAL
 * Redpanda + Postgres. Every consumed GovernanceRequested terminates in
 * exactly one outcome on government.events — the fact on success, a
 * GovernanceRejected with the right errorCode otherwise, and NOTHING on a
 * redelivered commandId. The freshness guard (ruling 7) is exercised the
 * runtime-stamped way (the CLAUDE.md hardcoded-occurredAt time bomb).
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = "civ.election.clock-ms=3600000")
@Testcontainers
class GovernanceCommandPlaneIntegrationTest {

    @Container
    static final PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>(
            DockerImageName.parse("pgvector/pgvector:0.8.0-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("government_db");

    @Container
    static final RedpandaContainer redpanda = new RedpandaContainer(
            "docker.redpanda.com/redpandadata/redpanda:v24.2.7");

    @DynamicPropertySource
    static void wire(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", postgres::getJdbcUrl);
        registry.add("spring.datasource.username", postgres::getUsername);
        registry.add("spring.datasource.password", postgres::getPassword);
        registry.add("spring.kafka.bootstrap-servers", redpanda::getBootstrapServers);
    }

    static final ObjectMapper json = new ObjectMapper();
    static KafkaProducer<String, String> producer;
    static KafkaConsumer<String, String> observer;
    static final List<JsonNode> observed = new ArrayList<>();

    @Autowired
    TestRestTemplate rest;

    @Autowired
    AdvanceElectionsUseCase clock;

    @Autowired
    JdbcClient jdbc;

    static final UUID ELARA = UUID.fromString("019f8e2a-0000-7000-8000-0000000e1a2a");
    static final UUID BRAM = UUID.fromString("019f8e2a-0000-7000-8000-0000000b2a44");
    static final UUID WREN = UUID.fromString("019f8e2a-0000-7000-8000-0000000c3e55");

    @BeforeAll
    static void kafkaClients() {
        Properties producerProps = new Properties();
        producerProps.put("bootstrap.servers", redpanda.getBootstrapServers());
        producerProps.put("key.serializer", StringSerializer.class.getName());
        producerProps.put("value.serializer", StringSerializer.class.getName());
        producer = new KafkaProducer<>(producerProps);

        Properties observerProps = new Properties();
        observerProps.put("bootstrap.servers", redpanda.getBootstrapServers());
        observerProps.put("group.id", "test-observer");
        observerProps.put("auto.offset.reset", "earliest");
        observerProps.put("key.deserializer", StringDeserializer.class.getName());
        observerProps.put("value.deserializer", StringDeserializer.class.getName());
        observer = new KafkaConsumer<>(observerProps);
        observer.subscribe(List.of("government.events"));
    }

    @AfterAll
    static void closeClients() {
        producer.close();
        observer.close();
    }

    // ------------------------------------------------------------- helpers

    private void drain() {
        observer.poll(Duration.ofMillis(250)).forEach(record -> {
            try {
                observed.add(json.readTree(record.value()));
            } catch (Exception e) {
                throw new AssertionError("non-JSON on government.events: " + record.value(), e);
            }
        });
    }

    private List<JsonNode> byType(String eventType) {
        return observed.stream().filter(e -> e.get("eventType").asText().equals(eventType)).toList();
    }

    private List<JsonNode> awaitEvents(String eventType, int atLeast) {
        await().atMost(Duration.ofSeconds(30)).pollInSameThread().until(() -> {
            drain();
            return byType(eventType).size() >= atLeast;
        });
        return byType(eventType);
    }

    private UUID publishCommand(UUID villagerId, String action, Map<String, String> params,
                                Instant occurredAt, UUID commandId) {
        ObjectNode envelope = json.createObjectNode();
        envelope.put("eventId", commandId.toString());
        envelope.put("eventType", "GovernanceRequested");
        envelope.put("schemaVersion", 1);
        envelope.put("occurredAt", occurredAt.toString());
        envelope.put("source", "agent-service");
        envelope.put("aggregateType", "Villager");
        envelope.put("aggregateId", villagerId.toString());
        envelope.put("correlationId", UUID.randomUUID().toString());
        envelope.putNull("causationId");
        ObjectNode payload = envelope.putObject("payload");
        payload.put("commandId", commandId.toString());
        payload.put("villagerId", villagerId.toString());
        payload.put("action", action);
        ObjectNode paramsNode = payload.putObject("params");
        params.forEach(paramsNode::put);
        producer.send(new ProducerRecord<>("commands.government", villagerId.toString(), envelope.toString()));
        producer.flush();
        return commandId;
    }

    private UUID publishCommand(UUID villagerId, String action, Map<String, String> params) {
        return publishCommand(villagerId, action, params, Instant.now(), UUID.randomUUID());
    }

    private JsonNode awaitRejection(UUID commandId, String errorCode) {
        await().atMost(Duration.ofSeconds(30)).pollInSameThread().until(() -> {
            drain();
            return byType("GovernanceRejected").stream()
                    .anyMatch(e -> e.get("payload").get("commandId").asText().equals(commandId.toString()));
        });
        JsonNode rejection = byType("GovernanceRejected").stream()
                .filter(e -> e.get("payload").get("commandId").asText().equals(commandId.toString()))
                .findFirst().orElseThrow();
        assertThat(rejection.get("payload").get("errorCode").asText()).isEqualTo(errorCode);
        assertThat(rejection.get("causationId").asText()).isEqualTo(commandId.toString());
        assertThat(rejection.get("aggregateType").asText()).isEqualTo("Villager");
        assertThat(rejection.get("payload").get("message").asText()).isNotBlank();
        return rejection;
    }

    // ----------------------------------------------------------------- test

    @Test
    void everyCommandTerminatesInExactlyOneOutcome() throws Exception {
        // ---- open (REST): ElectionStarted lands on the topic ----------------
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        ResponseEntity<String> opened = rest.postForEntity("/elections",
                new HttpEntity<>("{\"nominatingWindowSeconds\": 600, \"votingWindowSeconds\": 900}", headers),
                String.class);
        assertThat(opened.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        JsonNode election = json.readTree(opened.getBody());
        UUID electionId = UUID.fromString(election.get("electionId").asText());
        Instant startsAt = Instant.parse(election.get("startsAt").asText());
        Instant nominatingEndsAt = Instant.parse(election.get("nominatingEndsAt").asText());
        Instant endsAt = Instant.parse(election.get("endsAt").asText());

        JsonNode started = awaitEvents("ElectionStarted", 1).getFirst();
        assertThat(started.get("aggregateType").asText()).isEqualTo("Election");
        assertThat(started.get("aggregateId").asText()).isEqualTo(electionId.toString());
        assertThat(started.hasNonNull("causationId")).isFalse(); // operator root
        assertThat(started.get("payload").get("nominatingEndsAt").asText()).isNotBlank();

        clock.advance(startsAt); // -> nominating

        // ---- organic candidacy: the fact carries the command's causation ----
        UUID declareCmd = publishCommand(BRAM, "declare_candidacy", Map.of(
                "electionId", electionId.toString(),
                "platform", "Grain tallies posted at dawn."));
        JsonNode nominated = awaitEvents("CandidateNominated", 1).getFirst();
        assertThat(nominated.get("causationId").asText()).isEqualTo(declareCmd.toString());
        assertThat(nominated.get("payload").get("villagerId").asText()).isEqualTo(BRAM.toString());
        assertThat(nominated.get("payload").get("platform").asText()).isEqualTo("Grain tallies posted at dawn.");

        // ---- a second filing is refused, machine-readably --------------------
        UUID refile = publishCommand(BRAM, "declare_candidacy", Map.of("electionId", electionId.toString()));
        awaitRejection(refile, "ALREADY_A_CANDIDATE");

        // ---- REDELIVERY of the first filing emits NOTHING --------------------
        publishCommand(BRAM, "declare_candidacy", Map.of(
                        "electionId", electionId.toString(),
                        "platform", "Grain tallies posted at dawn."),
                Instant.now(), declareCmd); // same commandId = same delivery

        // ---- votes before the window are taught, not executed ----------------
        UUID earlyVote = publishCommand(ELARA, "vote", Map.of(
                "electionId", electionId.toString(),
                "candidateVillagerId", BRAM.toString()));
        awaitRejection(earlyVote, "WINDOW_CLOSED");
        // the sentinel: the redelivered filing above was consumed before this
        // rejection, and still only ONE CandidateNominated exists
        assertThat(byType("CandidateNominated")).hasSize(1);

        clock.advance(nominatingEndsAt); // -> voting

        // ---- the vote lands: DoD #2's causation link --------------------------
        UUID voteCmd = publishCommand(ELARA, "vote", Map.of(
                "electionId", electionId.toString(),
                "candidateVillagerId", BRAM.toString(),
                "reason", "He shared his bread when the pantry ran low."));
        JsonNode voteCast = awaitEvents("VoteCast", 1).getFirst();
        assertThat(voteCast.get("causationId").asText()).isEqualTo(voteCmd.toString());
        assertThat(voteCast.get("payload").get("voterId").asText()).isEqualTo(ELARA.toString());
        assertThat(voteCast.get("payload").get("candidateVillagerId").asText()).isEqualTo(BRAM.toString());
        assertThat(voteCast.get("payload").get("reason").asText()).contains("shared his bread");

        // ---- re-vote (new commandId): ALREADY_VOTED, the first vote stands ---
        UUID revote = publishCommand(ELARA, "vote", Map.of(
                "electionId", electionId.toString(),
                "candidateVillagerId", BRAM.toString()));
        awaitRejection(revote, "ALREADY_VOTED");

        // ---- voting for a non-candidate ---------------------------------------
        UUID phantom = publishCommand(WREN, "vote", Map.of(
                "electionId", electionId.toString(),
                "candidateVillagerId", ELARA.toString()));
        awaitRejection(phantom, "NOT_A_CANDIDATE");

        // ---- the freshness guard (ruling 7): dead intents never execute -------
        UUID stale = publishCommand(WREN, "vote", Map.of(
                        "electionId", electionId.toString(),
                        "candidateVillagerId", BRAM.toString()),
                Instant.now().minusSeconds(7200), UUID.randomUUID());
        awaitRejection(stale, "STALE_COMMAND");

        // ---- unknown election --------------------------------------------------
        UUID ghost = publishCommand(WREN, "vote", Map.of(
                "electionId", UUID.randomUUID().toString(),
                "candidateVillagerId", BRAM.toString()));
        awaitRejection(ghost, "UNKNOWN_ELECTION");

        // ---- REST votes emit VoteCast too (causation null — operator plane) ---
        ResponseEntity<String> restVote = rest.postForEntity(
                "/elections/" + electionId + "/votes",
                new HttpEntity<>("{\"voterId\":\"" + WREN + "\",\"candidateId\":\""
                        + nominated.get("payload").get("candidateId").asText() + "\"}", headers),
                String.class);
        assertThat(restVote.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        List<JsonNode> votes = awaitEvents("VoteCast", 2);
        assertThat(votes.get(1).hasNonNull("causationId")).isFalse();

        // ---- decided: ElectionDecided with villager-keyed, zero-filled tally --
        clock.advance(endsAt);
        JsonNode decided = awaitEvents("ElectionDecided", 1).getFirst();
        assertThat(decided.get("payload").get("winnerVillagerId").asText()).isEqualTo(BRAM.toString());
        assertThat(decided.get("payload").get("voteCounts").get(BRAM.toString()).asLong()).isEqualTo(2);
        assertThat(decided.get("payload").get("totalVotes").asLong()).isEqualTo(2);
        assertThat(decided.hasNonNull("causationId")).isFalse(); // clock root

        // ---- exactly-one-outcome, accounted ------------------------------------
        // 8 distinct commandIds were published (declare, refile, earlyVote,
        // vote, revote, phantom, stale, ghost); the redelivery reused declare's
        // id and claimed nothing. 8 claims: 2 facts + 6 rejections.
        Long claims = jdbc.sql("SELECT count(*) FROM processed_commands").query(Long.class).single();
        assertThat(claims).isEqualTo(8);
        Long rejectedClaims = jdbc.sql(
                        "SELECT count(*) FROM processed_commands WHERE outcome LIKE 'rejected:%'")
                .query(Long.class).single();
        assertThat(rejectedClaims).isEqualTo(6);

        // no stray outcomes beyond what this script asserted
        assertThat(byType("CandidateNominated")).hasSize(1);
        assertThat(byType("VoteCast")).hasSize(2);
        assertThat(byType("GovernanceRejected")).hasSize(6);
    }
}
