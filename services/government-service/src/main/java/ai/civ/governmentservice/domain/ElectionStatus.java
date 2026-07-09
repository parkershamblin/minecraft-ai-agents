package ai.civ.governmentservice.domain;

/**
 * The strict election state machine (08-m2-plan ruling 2):
 * scheduled -> nominating -> voting -> decided, with annulled as the
 * failure terminal (no candidates by voting time, or no votes by close).
 * Values are lowercase in the database and over REST.
 */
public enum ElectionStatus {
    SCHEDULED,
    NOMINATING,
    VOTING,
    DECIDED,
    ANNULLED;

    public boolean terminal() {
        return this == DECIDED || this == ANNULLED;
    }

    public String db() {
        return name().toLowerCase();
    }

    public static ElectionStatus fromDb(String value) {
        return valueOf(value.toUpperCase());
    }
}
