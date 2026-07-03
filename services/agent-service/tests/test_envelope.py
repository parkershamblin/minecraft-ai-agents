import json
from pathlib import Path

from jsonschema import Draft202012Validator

from agent_service.events.envelope import build_envelope
from agent_service.llm.contract import find_contracts_dir


def test_envelopes_validate_against_the_contract_schema():
    schema = json.loads((find_contracts_dir() / "envelope.schema.json").read_text(encoding="utf-8"))
    validator = Draft202012Validator(schema)

    envelope = build_envelope(
        "DecisionMade",
        "019f8e2a-0000-7000-8000-0000000e1a2a",
        {"villagerId": "019f8e2a-0000-7000-8000-0000000e1a2a"},
    )
    errors = list(validator.iter_errors(envelope))
    assert errors == []


def test_event_ids_are_time_ordered_uuid7():
    a = build_envelope("X", "019f8e2a-0000-7000-8000-0000000e1a2a", {})
    b = build_envelope("X", "019f8e2a-0000-7000-8000-0000000e1a2a", {})
    assert a["eventId"] < b["eventId"]
