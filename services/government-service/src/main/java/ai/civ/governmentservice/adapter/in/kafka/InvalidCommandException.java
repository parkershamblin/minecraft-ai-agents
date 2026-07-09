package ai.civ.governmentservice.adapter.in.kafka;

/** A message on commands.government that is not a structurally valid GovernanceRequested envelope. */
class InvalidCommandException extends RuntimeException {

    InvalidCommandException(String message) {
        super(message);
    }

    InvalidCommandException(String message, Throwable cause) {
        super(message, cause);
    }
}
