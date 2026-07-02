package ai.civ.eventservice.adapter.out.sse;

import ai.civ.eventservice.adapter.in.rest.EventDto;
import ai.civ.eventservice.application.port.out.LiveEventStream;
import ai.civ.eventservice.domain.StoredEvent;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import java.io.IOException;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.MediaType;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

/**
 * Sprint 1's stand-in for the dashboard-service WebSocket fan-out: a plain SSE
 * broadcaster. Live view is lossy by contract (a dead client is dropped, not
 * buffered); the event store is the durable truth a client backfills from.
 */
@Component
public class SseBroadcaster implements LiveEventStream {

    private static final Logger log = LoggerFactory.getLogger(SseBroadcaster.class);

    private final List<SseEmitter> emitters = new CopyOnWriteArrayList<>();
    private final ObjectMapper json;
    private final long timeoutMs;

    SseBroadcaster(ObjectMapper json,
                   MeterRegistry metrics,
                   @Value("${civ.sse.timeout-ms:1800000}") long timeoutMs) {
        this.json = json;
        this.timeoutMs = timeoutMs;
        Gauge.builder("civ_sse_clients", emitters, List::size)
                .description("Connected SSE live-feed clients")
                .register(metrics);
    }

    public SseEmitter subscribe() {
        SseEmitter emitter = new SseEmitter(timeoutMs);
        emitter.onCompletion(() -> emitters.remove(emitter));
        emitter.onTimeout(() -> emitters.remove(emitter));
        emitter.onError(t -> emitters.remove(emitter));
        emitters.add(emitter);
        try {
            emitter.send(SseEmitter.event().comment("connected: events.live"));
        } catch (IOException e) {
            emitters.remove(emitter);
        }
        return emitter;
    }

    @Override
    public void publish(StoredEvent event) {
        if (emitters.isEmpty()) {
            return;
        }
        String data;
        try {
            data = json.writeValueAsString(EventDto.from(event));
        } catch (IOException e) {
            log.error("failed to serialize event {} for SSE", event.eventId(), e);
            return;
        }
        for (SseEmitter emitter : emitters) {
            try {
                emitter.send(SseEmitter.event().name("event").data(data, MediaType.APPLICATION_JSON));
            } catch (Exception e) {
                // Slow or gone client: drop it. It can never stall the Kafka
                // consumer or other clients (load shedding over buffering).
                emitters.remove(emitter);
            }
        }
    }

    /** Keep-alive so proxies and browsers don't reap quiet connections. */
    @Scheduled(fixedRateString = "${civ.sse.heartbeat-ms:15000}")
    void heartbeat() {
        for (SseEmitter emitter : emitters) {
            try {
                emitter.send(SseEmitter.event().comment("ping"));
            } catch (Exception e) {
                emitters.remove(emitter);
            }
        }
    }
}
