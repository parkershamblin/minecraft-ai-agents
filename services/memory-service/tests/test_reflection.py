"""Offline tests for the reflection mechanism: the prompt, tolerant output
parsing, the hourly cap, and the envelope builder against the shared
packages/events contract."""

import json
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import jsonschema

from memory_service.envelope import build_envelope
from memory_service.reflection import HourlyCap, build_reflection_prompt, parse_insights

IDS = [uuid.uuid4() for _ in range(3)]


class TestPrompt:
    def test_numbers_memories_oldest_first(self):
        prompt = build_reflection_prompt(["first thing", "second thing"])
        assert "1. first thing" in prompt and "2. second thing" in prompt


class TestParseInsights:
    def _text(self, insights):
        return json.dumps({"insights": insights})

    def test_maps_one_based_indices_to_ids(self):
        parsed = parse_insights(self._text([{"insight": "x", "sourceIndices": [1, 3]}]), IDS)
        assert parsed == [("x", [IDS[0], IDS[2]])]

    def test_dedupes_and_drops_out_of_range_indices(self):
        parsed = parse_insights(self._text([{"insight": "x", "sourceIndices": [2, 2, 9]}]), IDS)
        assert parsed == [("x", [IDS[1]])]

    def test_insight_with_no_surviving_citation_is_dropped(self):
        parsed = parse_insights(
            self._text([{"insight": "orphan", "sourceIndices": [9]}, {"insight": "kept", "sourceIndices": [1]}]),
            IDS,
        )
        assert [content for content, _ in parsed] == ["kept"]

    def test_malformed_json_rejected(self):
        assert parse_insights("the model rambled instead of emitting JSON", IDS) == []

    def test_off_schema_rejected(self):
        assert parse_insights(json.dumps({"insights": [{"insight": "no citations"}]}), IDS) == []

    def test_blank_insight_dropped(self):
        assert parse_insights(self._text([{"insight": "   ", "sourceIndices": [1]}]), IDS) == []


class Clock:
    def __init__(self):
        self.now = datetime(2026, 7, 7, 12, 30, tzinfo=UTC)

    def __call__(self):
        return self.now


class TestHourlyCap:
    def test_blocks_at_cap_and_rolls_with_the_hour(self):
        clock = Clock()
        cap = HourlyCap(2, clock)
        assert cap.try_acquire()
        assert cap.try_acquire()
        assert not cap.try_acquire()
        clock.now += timedelta(hours=1)
        assert cap.try_acquire()


def _find_contracts_dir() -> Path:
    current = Path(__file__).resolve()
    for parent in current.parents:
        candidate = parent / "packages" / "events"
        if (candidate / "schemas").is_dir():
            return candidate
    raise FileNotFoundError("packages/events not found above tests/")


class TestEnvelope:
    def test_reflection_created_envelope_matches_the_contracts(self):
        contracts = _find_contracts_dir()
        envelope_schema = json.loads((contracts / "schemas" / "envelope.schema.json").read_text())
        payload_schema = json.loads(
            (contracts / "schemas" / "agent" / "ReflectionCreated.v1.schema.json").read_text()
        )
        villager = uuid.uuid4()
        envelope = build_envelope(
            "ReflectionCreated",
            villager,
            {
                "villagerId": str(villager),
                "reflectionId": str(uuid.uuid4()),
                "summary": "Bram keeps turning up wherever bread is.",
                "sourceMemoryIds": [str(uuid.uuid4())],
            },
        )
        checker = jsonschema.FormatChecker()
        jsonschema.validate(envelope, envelope_schema, format_checker=checker)
        jsonschema.validate(envelope["payload"], payload_schema, format_checker=checker)
        assert envelope["source"] == "memory-service"
        assert envelope["causationId"] is None  # a job-triggered reflection is a root event
