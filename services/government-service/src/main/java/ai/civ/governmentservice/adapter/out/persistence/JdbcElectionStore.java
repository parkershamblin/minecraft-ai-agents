package ai.civ.governmentservice.adapter.out.persistence;

import ai.civ.governmentservice.application.port.out.ElectionStorePort;
import ai.civ.governmentservice.domain.Candidate;
import ai.civ.governmentservice.domain.Election;
import ai.civ.governmentservice.domain.ElectionStatus;
import ai.civ.governmentservice.domain.Vote;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

@Repository
class JdbcElectionStore implements ElectionStorePort {

    private static final RowMapper<Election> ELECTION_MAPPER = JdbcElectionStore::mapElection;
    private static final RowMapper<Candidate> CANDIDATE_MAPPER = JdbcElectionStore::mapCandidate;
    private static final RowMapper<Vote> VOTE_MAPPER = JdbcElectionStore::mapVote;

    private final JdbcClient jdbc;

    JdbcElectionStore(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    @Override
    public void insertElection(Election e) {
        jdbc.sql("""
                        INSERT INTO elections (id, government_id, office, status, starts_at,
                                               nominating_ends_at, ends_at, created_at)
                        VALUES (:id, :governmentId, :office, :status, :startsAt,
                                :nominatingEndsAt, :endsAt, :createdAt)
                        """)
                .param("id", e.id())
                .param("governmentId", e.governmentId())
                .param("office", e.office())
                .param("status", e.status().db())
                .param("startsAt", utc(e.startsAt()))
                .param("nominatingEndsAt", utc(e.nominatingEndsAt()))
                .param("endsAt", utc(e.endsAt()))
                .param("createdAt", utc(e.createdAt()))
                .update();
    }

    @Override
    public void insertCandidate(Candidate c) {
        jdbc.sql("""
                        INSERT INTO candidates (id, election_id, villager_id, platform, registered_at)
                        VALUES (:id, :electionId, :villagerId, :platform::jsonb, :registeredAt)
                        """)
                .param("id", c.id())
                .param("electionId", c.electionId())
                .param("villagerId", c.villagerId())
                .param("platform", c.platformJson())
                .param("registeredAt", utc(c.registeredAt()))
                .update();
    }

    @Override
    public Optional<Election> findElection(UUID electionId) {
        return jdbc.sql("SELECT * FROM elections WHERE id = :id")
                .param("id", electionId)
                .query(ELECTION_MAPPER)
                .optional();
    }

    @Override
    public Optional<Election> lockElection(UUID electionId) {
        return jdbc.sql("SELECT * FROM elections WHERE id = :id FOR UPDATE")
                .param("id", electionId)
                .query(ELECTION_MAPPER)
                .optional();
    }

    @Override
    public List<Election> findActiveElections() {
        return jdbc.sql("""
                        SELECT * FROM elections
                        WHERE status IN ('scheduled', 'nominating', 'voting')
                        ORDER BY created_at, id
                        """)
                .query(ELECTION_MAPPER)
                .list();
    }

    @Override
    public void updateStatus(UUID electionId, ElectionStatus to) {
        jdbc.sql("UPDATE elections SET status = :status WHERE id = :id")
                .param("status", to.db())
                .param("id", electionId)
                .update();
    }

    @Override
    public void annul(UUID electionId, String reason) {
        jdbc.sql("UPDATE elections SET status = 'annulled', annulled_reason = :reason WHERE id = :id")
                .param("reason", reason)
                .param("id", electionId)
                .update();
    }

    @Override
    public void decideWinner(UUID electionId, UUID winnerCandidateId) {
        jdbc.sql("UPDATE elections SET status = 'decided', winner_candidate_id = :winner WHERE id = :id")
                .param("winner", winnerCandidateId)
                .param("id", electionId)
                .update();
    }

    @Override
    public List<Candidate> candidatesOf(UUID electionId) {
        return jdbc.sql("""
                        SELECT * FROM candidates WHERE election_id = :electionId
                        ORDER BY registered_at, id
                        """)
                .param("electionId", electionId)
                .query(CANDIDATE_MAPPER)
                .list();
    }

    @Override
    public boolean insertVoteIfAbsent(Vote v) {
        // The natural key is the arbiter (08-m2-plan ruling 5): at-least-once
        // delivery, REST retries and races all collapse to one stored fact.
        int inserted = jdbc.sql("""
                        INSERT INTO votes (id, election_id, candidate_id, voter_villager_id, reason, cast_at)
                        VALUES (:id, :electionId, :candidateId, :voterVillagerId, :reason, :castAt)
                        ON CONFLICT (election_id, voter_villager_id) DO NOTHING
                        """)
                .param("id", v.id())
                .param("electionId", v.electionId())
                .param("candidateId", v.candidateId())
                .param("voterVillagerId", v.voterVillagerId())
                .param("reason", v.reason())
                .param("castAt", utc(v.castAt()))
                .update();
        return inserted == 1;
    }

    @Override
    public Optional<Vote> findVote(UUID electionId, UUID voterVillagerId) {
        return jdbc.sql("""
                        SELECT * FROM votes
                        WHERE election_id = :electionId AND voter_villager_id = :voterVillagerId
                        """)
                .param("electionId", electionId)
                .param("voterVillagerId", voterVillagerId)
                .query(VOTE_MAPPER)
                .optional();
    }

    @Override
    public Map<UUID, Long> voteCounts(UUID electionId) {
        Map<UUID, Long> counts = new HashMap<>();
        jdbc.sql("SELECT candidate_id, count(*) AS votes FROM votes WHERE election_id = :electionId GROUP BY candidate_id")
                .param("electionId", electionId)
                .query(rs -> {
                    counts.put(rs.getObject("candidate_id", UUID.class), rs.getLong("votes"));
                });
        return counts;
    }

    @Override
    public List<Vote> votesOf(UUID electionId) {
        return jdbc.sql("SELECT * FROM votes WHERE election_id = :electionId ORDER BY cast_at, id")
                .param("electionId", electionId)
                .query(VOTE_MAPPER)
                .list();
    }

    // ------------------------------------------------------------- mapping

    private static OffsetDateTime utc(Instant instant) {
        return instant == null ? null : OffsetDateTime.ofInstant(instant, ZoneOffset.UTC);
    }

    private static Instant instant(ResultSet rs, String column) throws SQLException {
        OffsetDateTime value = rs.getObject(column, OffsetDateTime.class);
        return value == null ? null : value.toInstant();
    }

    private static Election mapElection(ResultSet rs, int rowNum) throws SQLException {
        return new Election(
                rs.getObject("id", UUID.class),
                rs.getObject("government_id", UUID.class),
                rs.getString("office"),
                ElectionStatus.fromDb(rs.getString("status")),
                rs.getObject("winner_candidate_id", UUID.class),
                instant(rs, "starts_at"),
                instant(rs, "nominating_ends_at"),
                instant(rs, "ends_at"),
                rs.getString("annulled_reason"),
                instant(rs, "created_at"));
    }

    private static Candidate mapCandidate(ResultSet rs, int rowNum) throws SQLException {
        return new Candidate(
                rs.getObject("id", UUID.class),
                rs.getObject("election_id", UUID.class),
                rs.getObject("villager_id", UUID.class),
                rs.getString("platform"),
                instant(rs, "registered_at"));
    }

    private static Vote mapVote(ResultSet rs, int rowNum) throws SQLException {
        return new Vote(
                rs.getObject("id", UUID.class),
                rs.getObject("election_id", UUID.class),
                rs.getObject("candidate_id", UUID.class),
                rs.getObject("voter_villager_id", UUID.class),
                rs.getString("reason"),
                instant(rs, "cast_at"));
    }
}
