package ai.civ.governmentservice.application.port.out;

import ai.civ.governmentservice.domain.Candidate;
import ai.civ.governmentservice.domain.Election;
import java.util.Map;
import java.util.UUID;

/**
 * The emission seam for government facts. M2-6 wires a structured-logging
 * adapter ONLY — no Kafka producer ships before the government/* schemas +
 * fixtures land in packages/events with M2-7 (contract-first: no event shape
 * on the wire without a schema; sequencing ruling recorded in HANDOFF).
 * M2-7 swaps in the Kafka adapter behind this exact interface.
 */
public interface GovernmentEventsPort {

    void electionStarted(Election election);

    void electionDecided(Election election, Candidate winner, Map<UUID, Long> votesByCandidateId);
}
