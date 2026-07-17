package ai.civ.eventservice.adapter.out.persistence;

import ai.civ.eventservice.application.port.out.EventStorePort;
import ai.civ.eventservice.application.query.Cursor;
import ai.civ.eventservice.application.query.EventFilter;
import ai.civ.eventservice.application.query.EventPage;
import ai.civ.eventservice.domain.StoredEvent;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

@Repository
class JdbcEventStore implements EventStorePort {

    private static final RowMapper<StoredEvent> ROW_MAPPER = JdbcEventStore::mapRow;

    /** Exactly what mapRow reads — never SELECT * (it would drag the search_text tsvector over the wire). */
    private static final String COLUMNS = "event_id, event_type, schema_version, occurred_at, recorded_at, "
            + "source, aggregate_type, aggregate_id, correlation_id, causation_id, topic, payload";

    private final JdbcClient jdbc;

    JdbcEventStore(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    @Override
    public Set<UUID> appendAll(List<StoredEvent> events) {
        if (events.isEmpty()) {
            return new HashSet<>();
        }
        // One multi-row INSERT per poll batch. ON CONFLICT DO NOTHING: the
        // UUIDv7 PK doubles as the idempotency key, making persistence safe
        // under Kafka's at-least-once redelivery — RETURNING tells us which
        // rows were genuinely new. A single statement is also atomic, so a
        // failed batch inserts nothing and can be retried wholesale.
        // Param count stays comfortably under Postgres's 65535 limit: 11 per
        // row x max.poll.records (default 500) = 5500.
        StringBuilder sql = new StringBuilder("""
                INSERT INTO events (event_id, event_type, schema_version, occurred_at, source,
                                    aggregate_type, aggregate_id, correlation_id, causation_id, topic, payload)
                VALUES """);
        for (int i = 0; i < events.size(); i++) {
            if (i > 0) {
                sql.append(",\n       ");
            }
            sql.append(("(:eventId%1$d, :eventType%1$d, :schemaVersion%1$d, :occurredAt%1$d, :source%1$d, "
                    + ":aggregateType%1$d, :aggregateId%1$d, :correlationId%1$d, :causationId%1$d, "
                    + ":topic%1$d, :payload%1$d::jsonb)").formatted(i));
        }
        sql.append("\nON CONFLICT (event_id) DO NOTHING RETURNING event_id");

        JdbcClient.StatementSpec spec = jdbc.sql(sql.toString());
        for (int i = 0; i < events.size(); i++) {
            StoredEvent e = events.get(i);
            spec = spec.param("eventId" + i, e.eventId())
                    .param("eventType" + i, e.eventType())
                    .param("schemaVersion" + i, e.schemaVersion())
                    .param("occurredAt" + i, e.occurredAt())
                    .param("source" + i, e.source())
                    .param("aggregateType" + i, e.aggregateType())
                    .param("aggregateId" + i, e.aggregateId())
                    .param("correlationId" + i, e.correlationId())
                    .param("causationId" + i, e.causationId())
                    .param("topic" + i, e.topic())
                    .param("payload" + i, e.payloadJson());
        }
        return new HashSet<>(spec.query((rs, rowNum) -> rs.getObject("event_id", UUID.class)).list());
    }

    @Override
    public EventPage query(EventFilter f) {
        StringBuilder sql = new StringBuilder("SELECT " + COLUMNS + " FROM events WHERE 1=1");
        Map<String, Object> params = new HashMap<>();

        if (f.types() != null && !f.types().isEmpty()) {
            sql.append(" AND event_type IN (:types)");
            params.put("types", f.types());
        }
        if (f.aggregateType() != null) {
            sql.append(" AND aggregate_type = :aggregateType");
            params.put("aggregateType", f.aggregateType());
        }
        if (f.aggregateId() != null) {
            sql.append(" AND aggregate_id = :aggregateId");
            params.put("aggregateId", f.aggregateId());
        }
        if (f.correlationId() != null) {
            sql.append(" AND correlation_id = :correlationId");
            params.put("correlationId", f.correlationId());
        }
        if (f.since() != null) {
            sql.append(" AND occurred_at >= :since");
            params.put("since", f.since());
        }
        if (f.until() != null) {
            sql.append(" AND occurred_at <= :until");
            params.put("until", f.until());
        }
        if (f.cursor() != null) {
            // Keyset continuation over the same total order as ORDER BY.
            sql.append(" AND (occurred_at, event_id) > (:cursorOccurredAt, :cursorEventId)");
            params.put("cursorOccurredAt", f.cursor().occurredAt());
            params.put("cursorEventId", f.cursor().eventId());
        }
        sql.append(" ORDER BY occurred_at, event_id LIMIT :limit");
        params.put("limit", f.limit() + 1); // one extra row decides hasNextPage

        JdbcClient.StatementSpec spec = jdbc.sql(sql.toString());
        for (Map.Entry<String, Object> p : params.entrySet()) {
            spec = spec.param(p.getKey(), p.getValue());
        }
        List<StoredEvent> rows = new ArrayList<>(spec.query(ROW_MAPPER).list());

        String nextCursor = null;
        if (rows.size() > f.limit()) {
            rows.removeLast();
            StoredEvent last = rows.getLast();
            nextCursor = new Cursor(last.occurredAt(), last.eventId()).encode();
        }
        return new EventPage(rows, nextCursor);
    }

    @Override
    public Optional<StoredEvent> findById(UUID eventId) {
        return jdbc.sql("SELECT " + COLUMNS + " FROM events WHERE event_id = :id")
                .param("id", eventId)
                .query(ROW_MAPPER)
                .optional();
    }

    private static StoredEvent mapRow(ResultSet rs, int rowNum) throws SQLException {
        UUID causationId = rs.getObject("causation_id", UUID.class);
        return new StoredEvent(
                rs.getObject("event_id", UUID.class),
                rs.getString("event_type"),
                rs.getInt("schema_version"),
                rs.getObject("occurred_at", OffsetDateTime.class),
                rs.getObject("recorded_at", OffsetDateTime.class),
                rs.getString("source"),
                rs.getString("aggregate_type"),
                rs.getObject("aggregate_id", UUID.class),
                rs.getObject("correlation_id", UUID.class),
                causationId,
                rs.getString("topic"),
                rs.getString("payload"));
    }
}
