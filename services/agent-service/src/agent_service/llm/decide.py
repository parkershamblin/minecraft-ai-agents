"""decide_safely — the tick loop's only entry point to the LLM.

Whatever the model does, the caller gets a decision: contract violations
become idle + error=True + a metric, never an exception. The tick loop
never dies at this seam.
"""

from dataclasses import dataclass

from agent_service.llm.contract import Decision, MalformedDecision, validate_decision
from agent_service.llm.providers import LLMProvider
from agent_service.logging import logger
from agent_service.metrics import llm_malformed_total


@dataclass(frozen=True)
class DecisionOutcome:
    decision: Decision
    error: bool
    provider: str
    model: str
    tokens_in: int
    tokens_out: int
    latency_seconds: float


async def decide_safely(provider: LLMProvider, system: str, user: str) -> DecisionOutcome:
    response = await provider.complete(system, user)
    try:
        decision = validate_decision(response.text)
        error = False
    except MalformedDecision as exc:
        llm_malformed_total.inc()
        logger.warning(
            "malformed LLM decision — falling back to idle",
            error=str(exc),
            provider=response.provider,
            raw=response.text[:200],
        )
        decision = Decision.idle(f"(malformed deliberation: {exc})")
        error = True
    return DecisionOutcome(
        decision=decision,
        error=error,
        provider=response.provider,
        model=response.model,
        tokens_in=response.tokens_in,
        tokens_out=response.tokens_out,
        latency_seconds=response.latency_seconds,
    )
