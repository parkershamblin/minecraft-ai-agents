"""M1-1: ChatObserved fanout rules, unit-tested against a fake Redis."""

import json
from datetime import UTC, datetime

from agent_service.kafka.percepts import PerceptConsumer


def _now() -> str:
    """Envelopes must be freshly stamped: the consumer's 10-minute freshness
    guard treats hardcoded timestamps as a time bomb (they pass until the
    wall clock catches up, then everything reads as stale backlog)."""
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")

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
    consumer.civics = None
    consumer.race = None
    consumer.roster = {}
    return consumer


def chat_envelope(speaker_id, heard_by, message="the harvest looks thin"):
    return {
        "eventId": "019f8e2b-1111-7000-8000-000000000001",
        "eventType": "ChatObserved",
        "correlationId": "019f8e2b-1111-7000-8000-00000000c0de",
        "occurredAt": _now(),
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
            "occurredAt": _now(),
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


# ------------------------------------------------------------------- hazards


def hazard_envelope(phase="trapped", villager_id=ELARA, detail=None, occurred_at=None):
    return {
        "eventId": "019f8e2b-4444-7000-8000-000000000004",
        "eventType": "HazardEncountered",
        "correlationId": "019f8e2b-4444-7000-8000-00000000c0de",
        "occurredAt": occurred_at or _now(),
        "payload": {
            "villagerId": villager_id,
            "hazardType": "powder_snow",
            "phase": phase,
            "position": {"x": 42.3, "y": 143.0, "z": -212.6},
            "detail": detail,
        },
    }


async def test_hazard_percept_reaches_only_its_villager():
    redis = FakeRedis()
    consumer = _bare(redis)  # on_chat_percept=None: trapped must queue, not crash

    await consumer.handle(hazard_envelope("trapped", detail="chest-deep in the drift"))

    assert list(redis.store) == [f"percepts:{ELARA}"]  # no broadcast
    [raw] = redis.store[f"percepts:{ELARA}"]
    percept = json.loads(raw)
    assert percept["type"] == "HazardEncountered"
    assert percept["hazardType"] == "powder_snow"
    assert percept["phase"] == "trapped"
    assert percept["position"] == {"x": 42.3, "y": 143.0, "z": -212.6}
    assert percept["detail"] == "chest-deep in the drift"
    assert percept["sourceEventId"] == "019f8e2b-4444-7000-8000-000000000004"
    assert percept["correlationId"] == "019f8e2b-4444-7000-8000-00000000c0de"


async def test_trapped_hazard_requests_a_reactive_tick():
    """Being buried in freezing snow must not wait for the scheduled cadence."""
    redis = FakeRedis()
    consumer = _bare(redis)
    requests = []
    consumer.on_chat_percept = lambda villager_id, cause: requests.append((villager_id, cause)) or True

    await consumer.handle(hazard_envelope("trapped"))

    assert requests == [(ELARA, "019f8e2b-4444-7000-8000-000000000004")]
    assert f"percepts:{ELARA}" in redis.store  # queued as well as woken


async def test_resolved_hazard_phases_queue_without_waking():
    redis = FakeRedis()
    consumer = _bare(redis)
    requests = []
    consumer.on_chat_percept = lambda villager_id, cause: requests.append((villager_id, cause)) or True

    await consumer.handle(hazard_envelope("escaped"))
    await consumer.handle(hazard_envelope("escape_failed"))

    assert requests == []
    assert len(redis.store[f"percepts:{ELARA}"]) == 2


async def test_stale_hazard_never_becomes_a_percept():
    redis = FakeRedis()
    consumer = _bare(redis)
    await consumer.handle(hazard_envelope("trapped", occurred_at="2026-07-01T00:00:00Z"))
    assert redis.store == {}


async def test_hazard_without_villager_id_is_ignored():
    redis = FakeRedis()
    consumer = _bare(redis)
    await consumer.handle(hazard_envelope("trapped", villager_id=None))
    await consumer.handle(hazard_envelope("trapped", villager_id=""))
    assert redis.store == {}


def threat_envelope(phase, *, response="flee", villager_id=ELARA, occurred_at=None):
    return {
        "eventId": "019f8e2b-5555-7000-8000-000000000005",
        "eventType": "ThreatEncountered",
        "correlationId": "019f8e2b-5555-7000-8000-00000000c0de",
        "occurredAt": occurred_at or _now(),
        "payload": {
            "villagerId": villager_id,
            "threatType": "zombie",
            "phase": phase,
            "response": response,
            "count": 1,
            "distance": 9.4,
            "position": {"x": -131, "y": 92, "z": 18},
            "detail": None,
        },
    }


async def test_threat_percepts_reach_only_the_victim_with_the_full_shape():
    redis = FakeRedis()
    consumer = _bare(redis)

    await consumer.handle(threat_envelope("engaged"))

    assert list(redis.store) == [f"percepts:{ELARA}"]  # victim-only, never broadcast
    [raw] = redis.store[f"percepts:{ELARA}"]
    percept = json.loads(raw)
    assert percept["type"] == "ThreatEncountered"
    assert percept["threatType"] == "zombie"
    assert percept["phase"] == "engaged"
    assert percept["response"] == "flee"
    assert percept["sourceEventId"] == "019f8e2b-5555-7000-8000-000000000005"


async def test_spotted_and_overwhelmed_wake_the_mind_other_phases_ride_the_cadence():
    """spotted = the one moment the mind can preempt; overwhelmed = the one
    moment only the mind can change the plan. Everything else queueing
    quietly is the GPU guard — a siege must not wake 20 minds per swing."""
    redis = FakeRedis()
    consumer = _bare(redis)
    requests = []
    consumer.on_chat_percept = lambda villager_id, cause: requests.append((villager_id, cause)) or True

    await consumer.handle(threat_envelope("spotted", response=None))
    await consumer.handle(threat_envelope("engaged"))
    await consumer.handle(threat_envelope("killed", response="fight"))
    await consumer.handle(threat_envelope("escaped"))
    await consumer.handle(threat_envelope("overwhelmed"))

    assert len(requests) == 2  # spotted + overwhelmed only
    assert len(redis.store[f"percepts:{ELARA}"]) == 5  # every phase queued


async def test_stale_threats_never_become_percepts():
    redis = FakeRedis()
    consumer = _bare(redis)
    await consumer.handle(threat_envelope("spotted", occurred_at="2026-07-01T00:00:00Z"))
    assert redis.store == {}


# ---------------------------------------------------------------- M2-8 civic


class RecordingCivics:
    """CivicState-shaped recorder — fanout tests only care that the right
    observer fired; the cache's own rules live in test_civics.py."""

    def __init__(self):
        self.calls = []

    def election_started(self, payload):
        self.calls.append(("started", payload.get("electionId")))

    def candidate_nominated(self, payload, name):
        self.calls.append(("candidate", payload.get("villagerId"), name))

    def vote_cast(self, payload):
        self.calls.append(("vote", payload.get("voterId")))

    def election_decided(self, payload, winner_name):
        self.calls.append(("decided", payload.get("winnerVillagerId"), winner_name))


def civic_envelope(event_type, payload, occurred_at=None):
    return {
        "eventId": "019f8e2b-3333-7000-8000-000000000003",
        "eventType": event_type,
        "correlationId": "019f8e2b-3333-7000-8000-00000000c0de",
        "occurredAt": occurred_at or _now(),
        "payload": payload,
    }


def _civic(redis) -> tuple[PerceptConsumer, RecordingCivics]:
    consumer = _bare(redis)
    consumer.civics = RecordingCivics()
    consumer.roster = {ELARA: "Elara", BRAM: "Bram", WREN: "Wren"}
    return consumer, consumer.civics


async def test_election_news_broadcasts_to_the_whole_roster():
    redis = FakeRedis()
    consumer, civics = _civic(redis)
    reactive = []
    consumer.on_chat_percept = lambda *args: reactive.append(args) or True

    await consumer.handle(civic_envelope("ElectionStarted", {"electionId": "e1", "office": "mayor"}))

    for villager in (ELARA, BRAM, WREN):
        [raw] = redis.store[f"percepts:{villager}"]
        percept = json.loads(raw)
        assert percept["type"] == "ElectionStarted"
        assert percept["office"] == "mayor"
        assert percept["sourceEventId"] == "019f8e2b-3333-7000-8000-000000000003"
    assert ("started", "e1") in civics.calls
    assert reactive == []  # civic news never stampedes 20 minds at once


async def test_candidacy_percepts_are_personalized_at_fanout():
    redis = FakeRedis()
    consumer, _ = _civic(redis)

    await consumer.handle(civic_envelope(
        "CandidateNominated",
        {"electionId": "e1", "candidateId": "c1", "villagerId": BRAM, "platform": "Honest tallies."},
    ))

    bram = json.loads(redis.store[f"percepts:{BRAM}"][0])
    elara = json.loads(redis.store[f"percepts:{ELARA}"][0])
    assert bram["you"] is True
    assert elara["you"] is False
    assert elara["candidateName"] == "Bram"
    assert elara["platform"] == "Honest tallies."


async def test_rejections_reach_only_their_actor():
    redis = FakeRedis()
    consumer, _ = _civic(redis)

    await consumer.handle(civic_envelope(
        "GovernanceRejected",
        {"commandId": "k1", "villagerId": WREN, "action": "vote",
         "electionId": "e1", "errorCode": "ALREADY_VOTED",
         "message": "you already voted in this election"},
    ))

    [raw] = redis.store[f"percepts:{WREN}"]
    percept = json.loads(raw)
    assert percept["type"] == "GovernanceRejected"
    assert percept["errorCode"] == "ALREADY_VOTED"
    assert f"percepts:{ELARA}" not in redis.store
    assert f"percepts:{BRAM}" not in redis.store


async def test_votes_update_the_cache_but_never_the_queues():
    """Ballots influence through results, not herd signals — and 20x20 vote
    percepts would evict the chat drama from the 20-cap queues."""
    redis = FakeRedis()
    consumer, civics = _civic(redis)

    await consumer.handle(civic_envelope(
        "VoteCast",
        {"electionId": "e1", "voterId": ELARA, "candidateId": "c1",
         "candidateVillagerId": BRAM, "reason": "the bread"},
    ))

    assert redis.store == {}
    assert ("vote", ELARA) in civics.calls


async def test_stale_civic_news_feeds_the_cache_but_not_the_queues():
    """Ruling 7 split: percepts age by delivery, institutions by content.
    The cache decides for itself whether stale-delivered news is still live."""
    redis = FakeRedis()
    consumer, civics = _civic(redis)

    await consumer.handle(civic_envelope(
        "ElectionStarted", {"electionId": "e1", "office": "mayor"},
        occurred_at="2026-07-01T00:00:00Z",
    ))

    assert redis.store == {}  # no percepts from the backlog
    assert ("started", "e1") in civics.calls  # the cache still heard it


async def test_civic_events_without_wiring_are_safe():
    redis = FakeRedis()
    consumer = _bare(redis)  # civics=None, roster={} — pre-M2-8 shape

    await consumer.handle(civic_envelope("ElectionStarted", {"electionId": "e1"}))
    await consumer.handle(civic_envelope("ElectionDecided", {"winnerVillagerId": BRAM}))

    assert redis.store == {}  # nobody to tell, nothing to crash


# ----------------------------------------------------- consumer supervision


async def test_consumer_crash_calls_the_exit_hook():
    """The 2026-07-22 wedge: an exception in the consume loop (live case: a
    snappy batch without the codec) killed the task silently while heartbeats
    kept the group Stable — perception dead, nothing logged, nothing restarted.
    The done-callback must turn that death into a process exit."""
    import asyncio

    exits: list[int] = []
    consumer = PerceptConsumer("broker:9092", FakeRedis(), exit_fn=exits.append)

    async def doomed():
        raise RuntimeError("UnsupportedCodecError: snappy")

    task = asyncio.get_running_loop().create_task(doomed())
    try:
        await task
    except RuntimeError:
        pass
    consumer._on_consumer_done(task)

    assert exits == [1]


async def test_clean_consumer_end_does_not_exit():
    import asyncio

    exits: list[int] = []
    consumer = PerceptConsumer("broker:9092", FakeRedis(), exit_fn=exits.append)

    async def clean():
        return None

    task = asyncio.get_running_loop().create_task(clean())
    await task
    consumer._on_consumer_done(task)

    assert exits == []


async def test_cancelled_consumer_does_not_exit():
    """stop() cancels the task — orderly shutdown must not exit(1)."""
    import asyncio

    exits: list[int] = []
    consumer = PerceptConsumer("broker:9092", FakeRedis(), exit_fn=exits.append)

    async def forever():
        await asyncio.sleep(3600)

    task = asyncio.get_running_loop().create_task(forever())
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    consumer._on_consumer_done(task)

    assert exits == []
