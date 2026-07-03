"""The decision contract — the single most failure-prone seam in the system.

The LLM must return JSON matching DECISION_SCHEMA; params are then validated
against the per-action $defs from the REAL ActionRequested contract in
packages/events, so a deliberation can never produce a command the executor
would reject. Malformed output raises MalformedDecision; the tick loop maps
that to DecisionMade{error:true} + idle — never a crash.
"""

import json
from dataclasses import dataclass
from functools import cache
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator

# Villagers may not spawn/despawn themselves — those are platform commands.
DELIBERATE_ACTIONS = ("move", "gather", "chat", "follow", "idle")

# The outer shape handed to structured-output modes (OpenAI json_schema /
# Ollama format). params stays free-form here — strict mode dislikes
# conditionals — and is enforced per-action by validate_decision below.
DECISION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "action": {"type": "string", "enum": list(DELIBERATE_ACTIONS)},
        "params": {"type": "object"},
        "reasoning": {"type": "string", "maxLength": 600},
        "importance": {"type": "number", "minimum": 0, "maximum": 10},
        "sentiment": {"type": "number", "minimum": -1, "maximum": 1},
    },
    "required": ["action", "params", "reasoning", "importance", "sentiment"],
    "additionalProperties": False,
}

_PARAMS_DEF_BY_ACTION = {"move": "MoveParams", "chat": "ChatParams", "follow": "FollowParams"}


class MalformedDecision(Exception):
    """The LLM's output violates the decision contract."""


@dataclass(frozen=True)
class Decision:
    action: str
    params: dict[str, Any]
    reasoning: str
    importance: float
    sentiment: float

    @staticmethod
    def idle(reasoning: str) -> "Decision":
        return Decision(action="idle", params={}, reasoning=reasoning, importance=1.0, sentiment=0.0)


def find_contracts_dir(start: Path | None = None) -> Path:
    """Walk up to the monorepo root; in containers packages/events is COPY'd
    alongside the service, so the same walk finds it."""
    current = (start or Path(__file__)).resolve()
    for parent in [current, *current.parents]:
        candidate = parent / "packages" / "events" / "schemas"
        if candidate.is_dir():
            return candidate
    raise FileNotFoundError("packages/events/schemas not found walking up from " + str(current))


@cache
def _validators() -> tuple[Draft202012Validator, dict[str, Draft202012Validator]]:
    contract_path = find_contracts_dir() / "commands" / "ActionRequested.v1.schema.json"
    contract = json.loads(contract_path.read_text(encoding="utf-8"))
    defs = contract["$defs"]
    outer = Draft202012Validator(DECISION_SCHEMA)
    per_action = {
        action: Draft202012Validator({**defs[def_name], "$defs": defs})
        for action, def_name in _PARAMS_DEF_BY_ACTION.items()
    }
    return outer, per_action


def validate_decision(raw_text: str) -> Decision:
    """Parse + validate one LLM response against the contract."""
    try:
        data = json.loads(raw_text)
    except json.JSONDecodeError as exc:
        raise MalformedDecision(f"not JSON: {exc}") from exc

    outer, per_action = _validators()
    errors = sorted(outer.iter_errors(data), key=lambda e: e.json_path)
    if errors:
        raise MalformedDecision("; ".join(e.message for e in errors[:3]))

    action = data["action"]
    params_validator = per_action.get(action)
    if params_validator:  # gather/idle legitimately take {}
        param_errors = sorted(params_validator.iter_errors(data["params"]), key=lambda e: e.json_path)
        if param_errors:
            raise MalformedDecision(
                f"params invalid for {action}: " + "; ".join(e.message for e in param_errors[:3])
            )
    return Decision(
        action=action,
        params=data["params"],
        reasoning=data["reasoning"],
        importance=float(data["importance"]),
        sentiment=float(data["sentiment"]),
    )
