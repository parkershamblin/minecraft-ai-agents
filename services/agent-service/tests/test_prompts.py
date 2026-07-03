from agent_service.brain.prompts import system_prompt, user_prompt


def test_system_prompt_carries_the_persona():
    prompt = system_prompt(
        "Elara",
        {"traits": ["warm", "nosy"], "values": ["community"], "speechStyle": "friendly and direct"},
        "Raised by the miller.",
    )
    assert "You are Elara" in prompt
    assert "warm, nosy" in prompt
    assert "friendly and direct" in prompt
    assert "Raised by the miller." in prompt
    assert "ONE next action" in prompt


def test_user_prompt_renders_snapshot_percepts_and_memories():
    snapshot = {
        "position": {"x": 1, "y": 64, "z": 2},
        "health": 20,
        "food": 18,
        "timeOfDay": 1000,
        "inventory": [{"item": "bread", "count": 3}],
        "nearbyVillagers": [{"villagerId": "abc", "name": "Bram", "distance": 5.0}],
    }
    percepts = [{"type": "ActionFailed", "action": "move", "detail": {"errorCode": "TIMEOUT"}}]
    prompt = user_prompt(snapshot, percepts, [])
    assert "Bram" in prompt
    assert "3 bread" in prompt
    assert "FAILED" in prompt and "TIMEOUT" in prompt
    assert prompt.endswith("What do you do next?")


def test_blind_prompt_when_no_snapshot():
    prompt = user_prompt(None, [], [])
    assert "cannot sense the world" in prompt
