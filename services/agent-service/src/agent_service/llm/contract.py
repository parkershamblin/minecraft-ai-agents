"""The decision contract — the single most failure-prone seam in the system.

The LLM must return JSON matching DECISION_SCHEMA; params are then validated
against the per-action $defs from the REAL ActionRequested contract in
packages/events, so a deliberation can never produce a command the executor
would reject. Malformed output raises MalformedDecision; the tick loop maps
that to DecisionMade{error:true} + idle — never a crash.
"""

import json
import uuid as _uuid
from dataclasses import dataclass
from functools import cache
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator

# Villagers may not spawn/despawn themselves — those are platform commands.
DELIBERATE_ACTIONS = ("move", "gather", "chat", "follow", "idle")

# The civic verbs (M2-7). Laws (M3) and factions (M4) are deliberately absent.
GOVERNANCE_ACTIONS = ("declare_candidacy", "vote")

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
        # Civic action (M2-7), same required-nullable discipline. DELIBERATELY
        # FLAT — no nested params object: every field explicit and nullable,
        # which is both OpenAI-strict-safe by construction and kinder to small
        # models than nesting. null = no civic action this tick (the default
        # whenever no election context is in the prompt). Mapped to the
        # GovernanceRequested wire shape and validated against its $defs
        # before anything is published.
        "governanceAction": {
            "type": ["object", "null"],
            "properties": {
                "action": {"type": "string", "enum": list(GOVERNANCE_ACTIONS)},
                "electionId": {"type": "string"},
                "candidateVillagerId": {
                    "type": ["string", "null"],
                    "description": "vote: whom to vote for; null for declare_candidacy",
                },
                "reason": {"type": ["string", "null"], "maxLength": 300},
                "platform": {
                    "type": ["string", "null"],
                    "maxLength": 300,
                    "description": "declare_candidacy: the campaign promise; null for vote",
                },
            },
            "required": ["action", "electionId", "candidateVillagerId", "reason", "platform"],
            "additionalProperties": False,
        },
    },
    "required": [
        "action",
        "params",
        "reasoning",
        "importance",
        "sentiment",
        "relationshipUpdates",
        "governanceAction",
    ],
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
    # llama writes explicit nulls for params it means to OMIT ("maxDistance":
    # null was ~7% of ticks) — the wire contract wants them absent, and the
    # executor applies its own defaults. A required param sent as null still
    # fails validation below, now as "required" instead of a type error.
    for key in [key for key, value in normalized.items() if value is None]:
        normalized.pop(key)
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
class GovernanceAction:
    """A civic intent, already mapped to the GovernanceRequested wire params
    and validated against its $defs — safe to publish as-is."""

    action: str
    params: dict[str, Any]


@dataclass(frozen=True)
class Decision:
    action: str
    params: dict[str, Any]
    reasoning: str
    importance: float
    sentiment: float
    relationship_updates: tuple[RelationshipUpdate, ...] = ()
    governance_action: GovernanceAction | None = None

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


_GOVERNANCE_DEF_BY_ACTION = {
    "declare_candidacy": "DeclareCandidacyParams",
    "vote": "VoteParams",
}


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


@cache
def _governance_validators() -> dict[str, Draft202012Validator]:
    """Per-action validators over the REAL GovernanceRequested $defs — the
    same seam discipline as world params: nothing reaches the wire that the
    executor's contract would reject."""
    contract_path = find_contracts_dir() / "commands" / "GovernanceRequested.v1.schema.json"
    defs = json.loads(contract_path.read_text(encoding="utf-8"))["$defs"]
    return {
        action: Draft202012Validator({**defs[def_name], "$defs": defs})
        for action, def_name in _GOVERNANCE_DEF_BY_ACTION.items()
    }


def _parse_governance(raw: dict[str, Any] | None) -> GovernanceAction | None:
    """Map the flat decision-level governanceAction onto GovernanceRequested
    wire params and validate against the contract $defs. Unlike world params,
    a bad civic add-on never fails the whole decision: it is DROPPED (logged +
    counted) and the tick proceeds — a mangled vote just doesn't happen.
    Semantic rejections (wrong window, double vote) are the executor's job and
    come back as GovernanceRejected percepts; this seam only guards syntax."""
    if raw is None:
        return None

    from agent_service.logging import logger
    from agent_service.metrics import llm_governance_dropped_total

    action = raw["action"]  # enum-enforced by the outer schema

    def dropped(why: str) -> None:
        llm_governance_dropped_total.inc()
        logger.warning("governanceAction dropped", action=action, reason=why)

    for uuid_field in ("electionId", "candidateVillagerId"):
        value = raw.get(uuid_field)
        if value is not None:
            try:
                _uuid.UUID(str(value))
            except ValueError:
                # `format: uuid` is annotation-only in JSON Schema — parse for
                # real, or hallucinated ids become INVALID_PARAMS wire noise.
                dropped(f"{uuid_field} is not a uuid: {value!r}")
                return None

    params: dict[str, Any] = {"electionId": raw["electionId"]}
    if action == "vote":
        if raw.get("candidateVillagerId") is None:
            dropped("vote without candidateVillagerId")
            return None
        params["candidateVillagerId"] = raw["candidateVillagerId"]
        if raw.get("reason"):
            params["reason"] = raw["reason"]
    else:  # declare_candidacy
        if raw.get("platform"):
            params["platform"] = raw["platform"]

    validator = _governance_validators()[action]
    errors = sorted(validator.iter_errors(params), key=lambda e: e.json_path)
    if errors:
        dropped("; ".join(e.message for e in errors[:3]))
        return None
    return GovernanceAction(action=action, params=params)


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
        governance_action=_parse_governance(data.get("governanceAction")),
    )
