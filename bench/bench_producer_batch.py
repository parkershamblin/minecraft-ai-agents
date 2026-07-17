"""#5 (Medium) — Kafka producer batching in agent-service.

Report: "agent-service: 4-8 serial send_and_wait round-trips per tick ... each an
awaited broker round-trip with no linger_ms. Fix: fire-and-forget send() per event,
one flush() per tick" (bottleneck-report §5, producer.py:26,33).

We drive the REAL shipped `EventPublisher.publish()` / `flush()` (kafka/producer.py)
with a fake in-memory producer, and compare it against a faithful reconstruction of
the OLD per-event `send_and_wait` path. Only the transport is faked; the batching
logic under test is the real code.

Metric that matters: awaited broker round-trips per tick. Each fake round-trip costs
RTT_MS of wall time, so wall_ms is round_trips x RTT to first order — the count is the
deterministic, noise-free headline; the wall time shows what it costs a tick.
"""

from __future__ import annotations

import asyncio

from agent_service.kafka.producer import EventPublisher

from runner import BenchSpec

EVENTS_PER_TICK = 8   # DecisionMade, ActionRequested, N x RelationshipChanged, VillagerTalked, MemoryFormed
RTT_MS = 2.0          # one broker round-trip (localhost Redpanda ballpark)


def _envelopes(n: int) -> list[dict]:
    return [
        {
            "aggregateId": "019f8e2a-0000-7000-8000-0000000e1a2a",
            "eventId": f"evt-{i}",
            "eventType": "BenchEvent",
            "correlationId": "corr-1",
        }
        for i in range(n)
    ]


class _FakeBatchingProducer:
    """Models aiokafka: send() buffers cheaply and returns a resolved delivery
    future; flush() pays ONE broker round-trip for whatever is buffered."""

    def __init__(self) -> None:
        self.sends = 0
        self.flushes = 0
        self.round_trips = 0
        self._buffered = 0

    async def send(self, topic, key, value):
        self.sends += 1
        self._buffered += 1
        fut: asyncio.Future = asyncio.get_event_loop().create_future()
        fut.set_result(None)
        return fut

    async def flush(self):
        self.flushes += 1
        if self._buffered:
            self.round_trips += 1
            self._buffered = 0


class _FakeSyncProducer:
    """Models the OLD path: every event is its own awaited round-trip."""

    def __init__(self) -> None:
        self.round_trips = 0

    async def send_and_wait(self, topic, key, value):
        self.round_trips += 1


class _OldEventPublisher:
    """Faithful pre-fix reconstruction: publish() awaits delivery per event."""

    def __init__(self) -> None:
        self._producer = _FakeSyncProducer()

    async def publish(self, topic: str, envelope: dict) -> None:
        await self._producer.send_and_wait(topic, key=envelope["aggregateId"], value=envelope)

    async def flush(self) -> None:
        pass  # nothing buffered — every send already blocked


async def _baseline() -> dict[str, float]:
    pub = _OldEventPublisher()
    for env in _envelopes(EVENTS_PER_TICK):
        await pub.publish("topic", env)
    await pub.flush()
    rt = pub._producer.round_trips
    # modeled_tick_ms: the awaited-round-trip count is exact; this translates it to
    # a per-tick latency at RTT_MS/round-trip (not a wall-clock measurement — sub-tick
    # sleeps are unreliable under Windows' ~15ms timer granularity).
    return {"awaited_round_trips": float(rt), "modeled_tick_ms": rt * RTT_MS}


async def _treatment() -> dict[str, float]:
    pub = EventPublisher.__new__(EventPublisher)  # skip real AIOKafkaProducer construction
    fake = _FakeBatchingProducer()
    pub._producer = fake
    for env in _envelopes(EVENTS_PER_TICK):
        await pub.publish("topic", env)  # real publish(): buffers, adds done-callback
    await pub.flush()                     # real flush(): the once-per-tick seam
    return {"awaited_round_trips": float(fake.round_trips), "modeled_tick_ms": fake.round_trips * RTT_MS}


async def _correctness() -> tuple[bool, str]:
    """Every event still reaches the producer exactly once, and delivery is
    still awaited (via flush) before the tick returns — batching must not drop
    or duplicate events."""
    pub = EventPublisher.__new__(EventPublisher)
    fake = _FakeBatchingProducer()
    pub._producer = fake
    for env in _envelopes(EVENTS_PER_TICK):
        await pub.publish("topic", env)
    await pub.flush()
    ok = fake.sends == EVENTS_PER_TICK and fake.flushes == 1 and fake.round_trips == 1
    return ok, (
        f"sends={fake.sends} (want {EVENTS_PER_TICK}), flushes={fake.flushes} (want 1), "
        f"round_trips={fake.round_trips} (want 1)"
    )


def spec() -> BenchSpec:
    return BenchSpec(
        key="producer_batch",
        title="Kafka producer batching (agent-service #5)",
        description=(
            f"{EVENTS_PER_TICK} events/tick. Baseline = send_and_wait per event; "
            "treatment = real EventPublisher (buffered send() + one flush())."
        ),
        report_ref="bottleneck-report §5 / producer.py:26,33 (fire-and-forget + one flush)",
        primary_metric="awaited_round_trips",
        lower_is_better=True,
        iters=50,
        warmup=10,
        arms={"baseline": _baseline, "treatment": _treatment},
        correctness=_correctness,
    )
