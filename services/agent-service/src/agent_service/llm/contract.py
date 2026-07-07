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
        # REQUIRED-NULLABLE, not optional: OpenAI strict structured outputs
        # reject any property missing from `required` (M1 review blocker).
        "relationshipUpdates": {
            "type": ["array", "null"],
            "maxItems": 3,
            "items": {
                "type": "object",
                "properties": {
                    "villagerId": {"type": "string"},
                    "affinityDelta": {"type": "number", "minimum": -20, "maximum": 20},
                    "trustDelta": {"type": "number", "minimum": -20, "maximum": 20},
                    "reason": {"type": "string", "maxLength": 200},
                },
                "required": ["villagerId", "affinityDelta", "trustDelta", "reason"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["action", "params", "reasoning", "importance", "sentiment", "relationshipUpdates"],
    "additionalProperties": False,
}

_PARAMS_DEF_BY_ACTION = {
    "move": "MoveParams",
    "chat": "ChatParams",
    "follow": "FollowParams",
    "gather": "GatherParams",
}


class MalformedDecision(Exception):
    """The LLM's output violates the decision contract."""


# Tolerant-reader normalization: small models reliably drift toward these
# near-miss keys (observed live: llama3.1 emits params.villagerId for chat).
# Known-safe aliases are rewritten and counted; everything else stays strict.
_PARAM_ALIASES: dict[str, dict[str, str]] = {
    "chat": {"villagerId": "targetVillagerId"},
    "follow": {"villagerId": "targetVillagerId"},
}


# Decision-level keys are never legitimate params — small models duplicate
# them into params under nesting confusion (observed live, drift pattern #2).
_DECISION_LEVEL_KEYS = frozenset(["action", "reasoning", "importance", "sentiment", "relationshipUpdates"])


def _normalize_params(action: str, params: dict[str, Any]) -> tuple[dict[str, Any], bool]:
    normalized = dict(params)
    changed = False
    for junk in _DECISION_LEVEL_KEYS & normalized.keys():
        normalized.pop(junk)
        changed = True
    for wrong, right in _PARAM_ALIASES.get(action, {}).items():
        if wrong in normalized and right not in normalized:
            normalized[right] = normalized.pop(wrong)
            changed = True
    return normalized, changed


@dataclass(frozen=True)
class RelationshipUpdate:
    villager_id: str
    affinity_delta: float
    trust_delta: float
    reason: str


@dataclass(frozen=True)
class Decision:
    action: str
    params: dict[str, Any]
    reasoning: str
    importance: float
    sentiment: float
    relationship_updates: tuple[RelationshipUpdate, ...] = ()

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
    params, normalized = _normalize_params(action, data["params"])
    if normalized:
        from agent_service.metrics import llm_normalized_total

        llm_normalized_total.inc()
    params_validator = per_action.get(action)
    if params_validator:  # idle legitimately takes {}
        param_errors = sorted(params_validator.iter_errors(params), key=lambda e: e.json_path)
        if param_errors:
            raise MalformedDecision(
                f"params invalid for {action}: " + "; ".join(e.message for e in param_errors[:3])
            )
    return Decision(
        action=action,
        params=params,
        reasoning=data["reasoning"],
        importance=float(data["importance"]),
        sentiment=float(data["sentiment"]),
        relationship_updates=tuple(
            RelationshipUpdate(
                villager_id=u["villagerId"],
                affinity_delta=float(u["affinityDelta"]),
                trust_delta=float(u["trustDelta"]),
                reason=u["reason"],
            )
            for u in (data.get("relationshipUpdates") or [])
        ),
    )
