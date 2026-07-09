package ai.civ.governmentservice.application.port.out;

import java.util.UUID;

/**
 * The exactly-one-outcome ledger for consumed governance commands. claim()
 * runs INSIDE the handling transaction: a redelivered commandId fails the
 * claim and the handler emits nothing — the outcome already happened once.
 */
public interface ProcessedCommandsPort {

    /** true iff this commandId was claimed now (first delivery). */
    boolean claim(UUID commandId, UUID villagerId, String action);

    /** Record what the claimed command became (same transaction as claim). */
    void complete(UUID commandId, String outcome);
}
