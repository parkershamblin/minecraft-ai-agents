"""The LLM port — ports-and-adapters seam for deliberation.

Chain: openai -> ollama -> fake (boot-probed); a daily token budget circuit
breaker wraps whichever provider wins. The decision contract binds LLM output
to the same packages/events schema the wire uses.
"""

from agent_service.llm.contract import Decision, MalformedDecision, validate_decision
from agent_service.llm.decide import DecisionOutcome, decide_safely
from agent_service.llm.providers import build_llm_provider

__all__ = [
    "Decision",
    "MalformedDecision",
    "validate_decision",
    "DecisionOutcome",
    "decide_safely",
    "build_llm_provider",
]
