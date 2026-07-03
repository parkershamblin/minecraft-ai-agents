import json

import pytest

from agent_service.llm.contract import Decision, MalformedDecision, validate_decision


def decision(**overrides) -> str:
    base = {
        "action": "chat",
        "params": {"message": "Hello, Bram."},
        "reasoning": "Being friendly.",
        "importance": 2.0,
        "sentiment": 0.4,
    }
    base.update(overrides)
    return json.dumps(base)


class TestValidDecisions:
    def test_chat(self):
        parsed = validate_decision(decision())
        assert parsed.action == "chat"
        assert parsed.params["message"] == "Hello, Bram."

    def test_move_params_validate_against_the_real_contract(self):
        parsed = validate_decision(decision(action="move", params={"to": {"x": 1, "y": 64, "z": -3}, "range": 2}))
        assert parsed.params["to"]["z"] == -3

    def test_follow(self):
        parsed = validate_decision(
            decision(action="follow", params={"targetVillagerId": "019f8e2a-0000-7000-8000-0000000b2a44"})
        )
        assert parsed.action == "follow"

    def test_idle_and_gather_take_empty_params(self):
        assert validate_decision(decision(action="idle", params={})).action == "idle"
        assert validate_decision(decision(action="gather", params={})).action == "gather"


class TestMalformedDecisions:
    def test_not_json(self):
        with pytest.raises(MalformedDecision, match="not JSON"):
            validate_decision("I think I shall walk to the pond.")

    def test_spawn_is_not_a_villager_choice(self):
        with pytest.raises(MalformedDecision):
            validate_decision(decision(action="spawn", params={"minecraftUsername": "Imposter"}))

    def test_unknown_action(self):
        with pytest.raises(MalformedDecision):
            validate_decision(decision(action="fly", params={}))

    def test_chat_without_message(self):
        with pytest.raises(MalformedDecision, match="params invalid for chat"):
            validate_decision(decision(action="chat", params={}))

    def test_move_with_bad_coordinates(self):
        with pytest.raises(MalformedDecision, match="params invalid for move"):
            validate_decision(decision(action="move", params={"to": {"x": "north", "y": 64, "z": 0}}))

    def test_importance_out_of_range(self):
        with pytest.raises(MalformedDecision):
            validate_decision(decision(importance=11))

    def test_missing_reasoning(self):
        raw = json.loads(decision())
        del raw["reasoning"]
        with pytest.raises(MalformedDecision):
            validate_decision(json.dumps(raw))


def test_idle_factory_is_always_contract_valid():
    fallback = Decision.idle("something went wrong")
    assert validate_decision(
        json.dumps(
            {
                "action": fallback.action,
                "params": fallback.params,
                "reasoning": fallback.reasoning,
                "importance": fallback.importance,
                "sentiment": fallback.sentiment,
            }
        )
    )
