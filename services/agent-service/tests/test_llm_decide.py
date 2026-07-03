from agent_service.llm.decide import decide_safely
from agent_service.llm.providers import FakeProvider, LLMResponse
from agent_service.metrics import llm_malformed_total


class GarbageProvider:
    name = "garbage"
    model = "garbage-1"

    def __init__(self, text: str):
        self._text = text

    async def complete(self, system: str, user: str) -> LLMResponse:
        return LLMResponse(
            text=self._text, tokens_in=10, tokens_out=5, latency_seconds=0.01, provider=self.name, model=self.model
        )


async def test_valid_decision_flows_through():
    outcome = await decide_safely(FakeProvider(), "system", "user")
    assert outcome.error is False
    assert outcome.decision.action in ("chat", "move", "idle")
    assert outcome.provider == "fake"


async def test_garbage_falls_back_to_idle_with_error_flag():
    before = llm_malformed_total._value.get()
    outcome = await decide_safely(GarbageProvider("I refuse to answer in JSON."), "s", "u")
    assert outcome.error is True
    assert outcome.decision.action == "idle"
    assert "malformed" in outcome.decision.reasoning
    assert llm_malformed_total._value.get() == before + 1


async def test_schema_violating_json_also_falls_back():
    outcome = await decide_safely(GarbageProvider('{"action":"fly","params":{}}'), "s", "u")
    assert outcome.error is True
    assert outcome.decision.action == "idle"
    assert outcome.tokens_in == 10  # usage still recorded — the tokens were spent
