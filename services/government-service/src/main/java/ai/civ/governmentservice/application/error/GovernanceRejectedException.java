package ai.civ.governmentservice.application.error;

/**
 * A governance request the state machine refuses, with a machine-readable
 * errorCode. The codes deliberately pre-echo M2-7's GovernanceRejected.v1
 * errorCode enum — the REST plane and the command plane speak the same
 * vocabulary, so rejection percepts and problem+json bodies match.
 */
public class GovernanceRejectedException extends RuntimeException {

    public enum ErrorCode {
        UNKNOWN_ELECTION,
        WINDOW_CLOSED,
        NOT_A_CANDIDATE,
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
