"""M1-1: ChatObserved fanout rules, unit-tested against a fake Redis."""

import json

from agent_service.kafka.percepts import PerceptConsumer

ELARA = "019f8e2a-0000-7000-8000-0000000e1a2a"
BRAM = "019f8e2a-0000-7000-8000-0000000b2a44"
WREN = "019f8e2a-0000-7000-8000-0000000c3e55"


class FakePipeline:
    def __init__(self, store):
        self._store = store
        self._ops = []

    def rpush(self, key, value):
        self._ops.append(("rpush", key, value))

    def ltrim(self, key, start, stop):
        pass

    def expire(self, key, ttl):
        pass

    async def execute(self):
        for op, key, value in self._ops:
            self._store.setdefault(key, []).append(value)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


class FakeRedis:
    def __init__(self):
        self.store: dict[str, list[str]] = {}

    def pipeline(self, transaction=True):
        return FakePipeline(self.store)


def _bare(redis) -> PerceptConsumer:
    """A consumer with no Kafka — handle() is driven directly."""
    consumer = PerceptConsumer.__new__(PerceptConsumer)
    consumer._redis = redis
    consumer.on_chat_percept = None
    return consumer


def chat_envelope(speaker_id, heard_by, message="the harvest looks thin"):
    return {
        "eventId": "019f8e2b-1111-7000-8000-000000000001",
        "eventType": "ChatObserved",
        "correlationId": "019f8e2b-1111-7000-8000-00000000c0de",
        "occurredAt": "2026-07-07T10:00:00Z",
        "payload": {
            "villagerId": speaker_id,
            "speakerUsername": "Elara",
            "message": message,
            "heardByIds": heard_by,
        },
    }


async def test_one_percept_per_hearer_speaker_excluded():
    redis = FakeRedis()
    consumer = _bare(redis)

    await consumer.handle(chat_envelope(ELARA, [ELARA, BRAM, WREN]))

    assert f"percepts:{ELARA}" not in redis.store  # self-filter
    for hearer in (BRAM, WREN):
        [raw] = redis.store[f"percepts:{hearer}"]
        percept = json.loads(raw)
        assert percept["type"] == "ChatObserved"
        assert percept["speakerVillagerId"] == ELARA
        # the identity thread that makes conversations ledger-traceable
        assert percept["sourceEventId"] == "019f8e2b-1111-7000-8000-000000000001"
        assert percept["correlationId"] == "019f8e2b-1111-7000-8000-00000000c0de"


async def test_player_speech_fans_out_with_null_speaker():
    redis = FakeRedis()
    consumer = _bare(redis)

    await consumer.handle(chat_envelope(None, [BRAM]))

    [raw] = redis.store[f"percepts:{BRAM}"]
    assert json.loads(raw)["speakerVillagerId"] is None


async def test_chat_percept_requests_reactive_tick():
    redis = FakeRedis()
    consumer = _bare(redis)
    requests = []
    consumer.on_chat_percept = lambda villager_id, cause: requests.append((villager_id, cause)) or True

    await consumer.handle(chat_envelope(ELARA, [BRAM, WREN]))

    assert (BRAM, "019f8e2b-1111-7000-8000-000000000001") in requests
    assert (WREN, "019f8e2b-1111-7000-8000-000000000001") in requests


async def test_action_percepts_carry_identity_thread_too():
    redis = FakeRedis()
    consumer = _bare(redis)

    await consumer.handle(
        {
            "eventId": "019f8e2b-2222-7000-8000-000000000002",
            "eventType": "ActionCompleted",
            "correlationId": "019f8e2b-2222-7000-8000-00000000c0de",
            "occurredAt": "2026-07-07T10:00:01Z",
            "payload": {"villagerId": ELARA, "action": "move", "result": {"blocksTraveled": 5}},
        }
    )

    [raw] = redis.store[f"percepts:{ELARA}"]
    percept = json.loads(raw)
    assert percept["sourceEventId"] == "019f8e2b-2222-7000-8000-000000000002"
    assert percept["action"] == "move"


async def test_unknown_event_types_are_ignored():
    redis = FakeRedis()
    consumer = _bare(redis)
    await consumer.handle({"eventType": "SomethingNew", "payload": {"villagerId": ELARA}})
    assert redis.store == {}


async def test_stale_events_never_become_percepts():
    """A redeploy drains committed-offset backlog — history is not perception."""
    redis = FakeRedis()
    consumer = _bare(redis)
    stale = chat_envelope(ELARA, [BRAM])
    stale["occurredAt"] = "2026-07-01T00:00:00Z"  # days old
    await consumer.handle(stale)
    assert redis.store == {}
