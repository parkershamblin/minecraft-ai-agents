package ai.civ.governmentservice.adapter.in.kafka;

import ai.civ.governmentservice.application.port.in.HandleGovernanceCommandUseCase.GovernanceCommand;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.OffsetDateTime;
import java.time.format.DateTimeParseException;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.springframework.stereotype.Component;

/**
 * GovernanceRequested envelope JSON -> GovernanceCommand, hand-mapped in the
 * EnvelopeMapper style (event-service precedent; no Java codegen, ruling 6).
 * Structural gate only: envelope fields, uuid ids, the action enum. Params
 * CONTENT (missing electionId etc.) is the use case's job — those earn an
 * honest INVALID_PARAMS rejection; structural garbage is parked instead
 * (a non-contract message deserves no contract outcome).
 */
@Component
class GovernanceCommandMapper {

    private static final List<String> REQUIRED_ENVELOPE = List.of(
            "eventId", "eventType", "occurredAt", "correlationId", "payload");
    private static final Set<String> ACTIONS = Set.of("declare_candidacy", "vote");

    private final ObjectMapper json;

    GovernanceCommandMapper(ObjectMapper json) {
        this.json = json;
    }

    GovernanceCommand toCommand(String message) {
        JsonNode node;
        try {
            node = json.readTree(message);
        } catch (Exception e) {
            throw new InvalidCommandException("not JSON: " + e.getMessage(), e);
        }
        if (node == null || !node.isObject()) {
            throw new InvalidCommandException("envelope must be a JSON object");
        }
        for (String field : REQUIRED_ENVELOPE) {
            if (!node.hasNonNull(field)) {
                throw new InvalidCommandException("missing required envelope field: " + field);
            }
        }
        if (!"GovernanceRequested".equals(node.get("eventType").asText())) {
            throw new InvalidCommandException("not a GovernanceRequested: " + node.get("eventType").asText());
        }
        JsonNode payload = node.get("payload");
        if (!payload.isObject()) {
            throw new InvalidCommandException("payload must be a JSON object");
        }
        for (String field : List.of("commandId", "villagerId", "action")) {
            if (!payload.hasNonNull(field)) {
                throw new InvalidCommandException("missing required payload field: " + field);
            }
        }
        String action = payload.get("action").asText();
        if (!ACTIONS.contains(action)) {
            // Off-enum actions (the M3 propose_law temptation) are parked, not
            // rejected: GovernanceRejected.action could not carry them validly.
            throw new InvalidCommandException("unknown governance action: " + action);
        }

        JsonNode params = payload.path("params");
        try {
            return new GovernanceCommand(
                    UUID.fromString(payload.get("commandId").asText()),
                    UUID.fromString(payload.get("villagerId").asText()),
                    action,
                    text(params, "electionId"),
                    text(params, "candidateVillagerId"),
                    text(params, "reason"),
                    text(params, "platform"),
                    OffsetDateTime.parse(node.get("occurredAt").asText()).toInstant(),
                    UUID.fromString(node.get("correlationId").asText()));
        } catch (IllegalArgumentException | DateTimeParseException e) {
            throw new InvalidCommandException("malformed envelope field: " + e.getMessage(), e);
        }
    }

    private static String text(JsonNode params, String field) {
        return params.hasNonNull(field) ? params.get(field).asText() : null;
    }
}
