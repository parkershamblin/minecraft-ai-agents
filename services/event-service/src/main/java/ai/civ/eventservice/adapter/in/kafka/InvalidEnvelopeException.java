package ai.civ.eventservice.adapter.in.kafka;

/** The message is not a well-formed event envelope — parked, never retried. */
public class InvalidEnvelopeException extends RuntimeException {

    public InvalidEnvelopeException(String message) {
        super(message);
    }

    public InvalidEnvelopeException(String message, Throwable cause) {
        super(message, cause);
    }
}
