package ai.civ.eventservice;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.HashSet;
import java.util.Properties;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentLinkedQueue;
import org.apache.kafka.clients.producer.KafkaProducer;
import org.apache.kafka.clients.producer.ProducerRecord;
import org.apache.kafka.common.serialization.StringSerializer;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.redpanda.RedpandaContainer;
import org.testcontainers.utility.DockerImageName;

/**
 * The CIV-3 acceptance proof, against REAL infrastructure: the same Postgres
 * image compose uses, a real Redpanda broker, and the real fixtures from
 * packages/events. Publish -> row appears with every envelope field intact;
 * redelivery inserts nothing; the SSE stream carries the live event.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@Testcontainers
class EventStoreIntegrationTest {

    @Container
    static final PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>(
            DockerImageName.parse("pgvector/pgvector:0.8.0-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("event_db");

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

    static KafkaProducer<String, String> producer;
    static final ObjectMapper json = new ObjectMapper();

    @Autowired
    TestRestTemplate rest;

    @LocalServerPort
    int port;

    @BeforeAll
    static void createProducer() {
        Properties props = new Properties();
        props.put("bootstrap.servers", redpanda.getBootstrapServers());
        props.put("key.serializer", StringSerializer.class.getName());
        props.put("value.serializer", StringSerializer.class.getName());
        producer = new KafkaProducer<>(props);
    }

    @AfterAll
    static void closeProducer() {
        producer.close();
    }

    static String fixture(String name) throws IOException {
        return Files.readString(Path.of("..", "..", "packages", "events", "fixtures", name));
    }

    void publish(String topic, String envelopeJson) throws IOException {
        String key = json.readTree(envelopeJson).get("aggregateId").asText();
        producer.send(new ProducerRecord<>(topic, key, envelopeJson));
        producer.flush();
    }

    JsonNode getEvents(String query) throws IOException {
        ResponseEntity<String> response = rest.getForEntity("/events" + query, String.class);
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        return json.readTree(response.getBody());
    }

    @Test
    void fullLedgerScenario() throws Exception {
        // ---- 1. SSE subscriber first, so it observes the live inserts -------
        ConcurrentLinkedQueue<String> sseLines = new ConcurrentLinkedQueue<>();
        HttpClient sseClient = HttpClient.newHttpClient();
        sseClient.sendAsync(
                HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/events/stream")).build(),
                HttpResponse.BodyHandlers.fromLineSubscriber(new java.util.concurrent.Flow.Subscriber<String>() {
                    public void onSubscribe(java.util.concurrent.Flow.Subscription s) { s.request(Long.MAX_VALUE); }
                    public void onNext(String line) { sseLines.add(line); }
                    public void onError(Throwable t) { }
                    public void onComplete() { }
                }));

        // ---- 2. ingest: a world fact AND a command (archived, never acted on)
        publish("world.events", fixture("VillagerSpawned.v1.json"));
        publish("commands.minecraft", fixture("ActionRequested.v1.json"));

        await().atMost(Duration.ofSeconds(30)).untilAsserted(() ->
                assertThat(getEvents("?limit=100").get("data")).hasSize(2));

        // ---- 3. every envelope field survives the round trip ----------------
        JsonNode spawned = getEvents("?type=VillagerSpawned").get("data").get(0);
        JsonNode expected = json.readTree(fixture("VillagerSpawned.v1.json"));
        assertThat(spawned.get("eventId").asText()).isEqualTo(expected.get("eventId").asText());
        assertThat(spawned.get("eventType").asText()).isEqualTo("VillagerSpawned");
        assertThat(spawned.get("schemaVersion").asInt()).isEqualTo(1);
        assertThat(spawned.get("source").asText()).isEqualTo("minecraft-service");
        assertThat(spawned.get("aggregateType").asText()).isEqualTo("Villager");
        assertThat(spawned.get("aggregateId").asText()).isEqualTo(expected.get("aggregateId").asText());
        assertThat(spawned.get("correlationId").asText()).isEqualTo(expected.get("correlationId").asText());
        assertThat(spawned.get("causationId").isNull()).isTrue();
        assertThat(spawned.get("topic").asText()).isEqualTo("world.events");
        assertThat(spawned.get("recordedAt").asText()).isNotBlank();
        assertThat(spawned.get("payload")).isEqualTo(expected.get("payload"));

        // commands are archived with their causation link intact
        JsonNode command = getEvents("?type=ActionRequested").get("data").get(0);
        assertThat(command.get("topic").asText()).isEqualTo("commands.minecraft");
        assertThat(command.get("causationId").asText())
                .isEqualTo(json.readTree(fixture("DecisionMade.v1.json")).get("eventId").asText());

        // ---- 4. idempotent consumer: redelivery inserts zero duplicates -----
        publish("world.events", fixture("VillagerSpawned.v1.json")); // exact redelivery
        publish("agent.events", fixture("MemoryFormed.v1.json"));     // sentinel: proves the dup was processed

        await().atMost(Duration.ofSeconds(30)).untilAsserted(() ->
                assertThat(getEvents("?type=MemoryFormed").get("data")).hasSize(1));
        assertThat(getEvents("?limit=100").get("data")).hasSize(3); // not 4 — the duplicate vanished

        // ---- 5. the SSE stream carried the live events (and not the dup) ----
        String spawnedId = expected.get("eventId").asText();
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() ->
                assertThat(sseLines.stream().filter(l -> l.contains(spawnedId)).count()).isEqualTo(1));
        sseClient.shutdownNow();

        // ---- 6. keyset pagination walks the total order without overlap -----
        Set<UUID> seen = new HashSet<>();
        String cursor = null;
        int pages = 0;
        do {
            JsonNode page = getEvents("?limit=1" + (cursor == null ? "" : "&cursor=" + cursor));
            for (JsonNode event : page.get("data")) {
                assertThat(seen.add(UUID.fromString(event.get("eventId").asText())))
                        .as("cursor pagination must never return the same event twice")
                        .isTrue();
            }
            cursor = page.get("nextCursor").isNull() ? null : page.get("nextCursor").asText();
            pages++;
        } while (cursor != null && pages < 10);
        assertThat(seen).hasSize(3);

        // ---- 7. problem+json on a miss ---------------------------------------
        ResponseEntity<String> missing = rest.getForEntity("/events/" + UUID.randomUUID(), String.class);
        assertThat(missing.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(missing.getHeaders().getContentType().toString()).contains("problem+json");
        assertThat(json.readTree(missing.getBody()).get("correlationId").asText()).isNotBlank();

        // ---- 8. correlation filter reconstructs one causal chain -------------
        // ActionRequested and MemoryFormed share Elara's tick correlationId;
        // VillagerSpawned belongs to the seed correlation and must not appear.
        String tickCorrelation = json.readTree(fixture("ActionRequested.v1.json"))
                .get("correlationId").asText();
        JsonNode chain = getEvents("?correlation-id=" + tickCorrelation);
        assertThat(chain.get("data")).hasSize(2);
        for (JsonNode event : chain.get("data")) {
            assertThat(event.get("correlationId").asText()).isEqualTo(tickCorrelation);
        }
    }
}
