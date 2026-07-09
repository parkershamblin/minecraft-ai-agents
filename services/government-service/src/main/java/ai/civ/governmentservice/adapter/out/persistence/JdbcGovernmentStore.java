package ai.civ.governmentservice.adapter.out.persistence;

import ai.civ.governmentservice.application.port.out.GovernmentStorePort;
import ai.civ.governmentservice.domain.Government;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

@Repository
class JdbcGovernmentStore implements GovernmentStorePort {

    private static final RowMapper<Government> MAPPER = JdbcGovernmentStore::mapRow;

    private final JdbcClient jdbc;

    JdbcGovernmentStore(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    @Override
    public Optional<Government> activeGovernment(String governmentType) {
        return jdbc.sql("""
                        SELECT * FROM governments
                        WHERE government_type = :type AND dissolved_at IS NULL
                        ORDER BY established_at DESC, id DESC
                        LIMIT 1
                        """)
                .param("type", governmentType)
                .query(MAPPER)
                .optional();
    }

    @Override
    public void insertGovernment(Government g) {
        jdbc.sql("""
                        INSERT INTO governments (id, name, government_type, mayor_villager_id,
                                                 charter, established_at, dissolved_at)
                        VALUES (:id, :name, :type, :mayorVillagerId, :charter::jsonb, :establishedAt, :dissolvedAt)
                        """)
                .param("id", g.id())
                .param("name", g.name())
                .param("type", g.governmentType())
                .param("mayorVillagerId", g.mayorVillagerId())
                .param("charter", g.charterJson())
                .param("establishedAt", utc(g.establishedAt()))
                .param("dissolvedAt", utc(g.dissolvedAt()))
                .update();
    }

    @Override
    public void dissolve(UUID governmentId, Instant at) {
        jdbc.sql("UPDATE governments SET dissolved_at = :at WHERE id = :id AND dissolved_at IS NULL")
                .param("at", utc(at))
                .param("id", governmentId)
                .update();
    }

    private static OffsetDateTime utc(Instant instant) {
        return instant == null ? null : OffsetDateTime.ofInstant(instant, ZoneOffset.UTC);
    }

    private static Government mapRow(ResultSet rs, int rowNum) throws SQLException {
        OffsetDateTime dissolved = rs.getObject("dissolved_at", OffsetDateTime.class);
        return new Government(
                rs.getObject("id", UUID.class),
                rs.getString("name"),
                rs.getString("government_type"),
                rs.getObject("mayor_villager_id", UUID.class),
                rs.getString("charter"),
                rs.getObject("established_at", OffsetDateTime.class).toInstant(),
                dissolved == null ? null : dissolved.toInstant());
    }
}
