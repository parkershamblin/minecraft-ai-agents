package ai.civ.eventservice.adapter.in.rest;

import ai.civ.eventservice.adapter.out.sse.SseBroadcaster;
import ai.civ.eventservice.application.port.in.QueryEventsUseCase;
import ai.civ.eventservice.application.query.Cursor;
import ai.civ.eventservice.application.query.EventFilter;
import ai.civ.eventservice.application.query.EventPage;
import io.swagger.v3.oas.annotations.Operation;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

@RestController
public class EventsController {

    private final QueryEventsUseCase queryEvents;
    private final SseBroadcaster broadcaster;

    EventsController(QueryEventsUseCase queryEvents, SseBroadcaster broadcaster) {
        this.queryEvents = queryEvents;
        this.broadcaster = broadcaster;
    }

    public record EventPageDto(List<EventDto> data, String nextCursor) {
    }

    @Operation(summary = "Query the append-only event store (cursor/keyset pagination, ordered by occurredAt)")
    @GetMapping("/events")
    public EventPageDto list(
            @RequestParam(name = "type", required = false) List<String> types,
            @RequestParam(name = "aggregate-type", required = false) String aggregateType,
            @RequestParam(name = "aggregate-id", required = false) UUID aggregateId,
            @RequestParam(name = "correlation-id", required = false) UUID correlationId,
            @RequestParam(name = "since", required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) OffsetDateTime since,
            @RequestParam(name = "until", required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) OffsetDateTime until,
            @RequestParam(name = "cursor", required = false) String cursor,
            @RequestParam(name = "limit", defaultValue = "" + EventFilter.DEFAULT_LIMIT) int limit) {
        EventFilter filter = new EventFilter(
                types, aggregateType, aggregateId, correlationId, since, until,
                cursor == null ? null : Cursor.decode(cursor), limit);
        EventPage page = queryEvents.list(filter);
        return new EventPageDto(page.data().stream().map(EventDto::from).toList(), page.nextCursor());
    }

    @Operation(summary = "Fetch a single event by its UUIDv7 eventId")
    @GetMapping("/events/{eventId}")
    public EventDto byId(@PathVariable UUID eventId) {
        return queryEvents.byId(eventId)
                .map(EventDto::from)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "no event " + eventId));
    }

    @Operation(summary = "Live event feed (SSE) — Sprint 1's stand-in for the dashboard-service WebSocket")
    @GetMapping(value = "/events/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter stream() {
        return broadcaster.subscribe();
    }
}
