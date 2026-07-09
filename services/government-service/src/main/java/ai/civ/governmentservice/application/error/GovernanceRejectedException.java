package ai.civ.governmentservice.application.error;

/**
 * A governance request the state machine refuses, with a machine-readable
 * errorCode. Since M2-7 the enum IS the GovernanceRejected.v1 errorCode
 * vocabulary — the REST plane (problem+json) and the command plane
 * (GovernanceRejected events, which become percepts) speak identically.
 * REST throws only a subset; the command executor uses them all.
 */
public class GovernanceRejectedException extends RuntimeException {

    public enum ErrorCode {
        WINDOW_CLOSED,
        ALREADY_VOTED,
        ALREADY_A_CANDIDATE,
        NOT_A_CANDIDATE,
        UNKNOWN_ELECTION,
        STALE_COMMAND,
        INVALID_PARAMS,
    }

    private final ErrorCode errorCode;

    public GovernanceRejectedException(ErrorCode errorCode, String message) {
        super(message);
        this.errorCode = errorCode;
    }

    public ErrorCode errorCode() {
        return errorCode;
    }
}
