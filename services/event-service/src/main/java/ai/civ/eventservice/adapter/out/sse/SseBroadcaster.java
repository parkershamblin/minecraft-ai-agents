package ai.civ.eventservice.adapter.out.sse;

import ai.civ.eventservice.adapter.in.rest.EventDto;
import ai.civ.eventservice.application.port.out.LiveEventStream;
import ai.civ.eventservice.domain.StoredEvent;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import jakarta.annotation.PreDestroy;
import java.io.IOException;
import java.util.List;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
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
 *
 * Fan-out runs on a dedicated single thread, never the Kafka consumer thread:
 * publish() enqueues and returns immediately, so a slow client's socket can
 * only slow other SSE clients, never ingest. Because the feed is lossy by
 * contract, the queue is bounded and drops the OLDEST pending event under
 * pressure (fresh events beat stale ones on a live view).
 */
@Component
public class SseBroadcaster implements LiveEventStream {

    private static final Logger log = LoggerFactory.getLogger(SseBroadcaster.class);

    private final List<SseEmitter> emitters = new CopyOnWriteArrayList<>();
    private final ObjectMapper json;
    private final long timeoutMs;
    private final ExecutorService fanout;

    SseBroadcaster(ObjectMapper json,
                   MeterRegistry metrics,
                   @Value("${civ.sse.timeout-ms:1800000}") long timeoutMs,
                   @Value("${civ.sse.fanout-queue-capacity:1024}") int fanoutQueueCapacity) {
        this.json = json;
        this.timeoutMs = timeoutMs;
        this.fanout = new ThreadPoolExecutor(1, 1, 0L, TimeUnit.MILLISECONDS,
                new ArrayBlockingQueue<>(fanoutQueueCapacity),
                r -> {
                    Thread t = new Thread(r, "sse-fanout");
                    t.setDaemon(true);
                    return t;
                },
                new ThreadPoolExecutor.DiscardOldestPolicy());
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
        fanout.execute(() -> broadcast(event));
    }

    private void broadcast(StoredEvent event) {
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

    @PreDestroy
    void shutdown() {
        fanout.shutdownNow();
    }
}
