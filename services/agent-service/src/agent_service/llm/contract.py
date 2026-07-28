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
# craft + hunt joined with the survival cluster (there is deliberately NO eat
# verb — eating is a body reflex; acquisition is the mind's job).
DELIBERATE_ACTIONS = ("move", "gather", "chat", "follow", "idle", "craft", "hunt")

# The civic verbs (M2-7). Laws (M3) and factions (M4) are deliberately absent.
GOVERNANCE_ACTIONS = ("declare_candidacy", "vote")

# The outer shape handed to structured-output modes (OpenAI json_schema /
# Ollama format). params stays free-form in this BASE — the provider-facing
# variant with the per-verb union is decision_schema() below; validate_decision
# enforces per-action shapes either way.
#
# PROPERTY ORDER IS LOAD-BEARING (2026-07-27): grammar-constrained decoding
# (Ollama format → llama.cpp grammar; OpenAI strict) emits keys in schema
# order, so the schema's order IS the model's generation order. reasoning
# comes FIRST so the model deliberates before committing to an action —
# action-first is post-hoc rationalization, and brief-reason-then-pick cut
# wrong-function selection 30.5%→1.5% in small-model evals (arXiv 2604.02155;
# "reason free, constrain late" — docs/reports/function-calling-research-
# 2026-07-27.md).
DECISION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "reasoning": {"type": "string", "maxLength": 600},
        "action": {"type": "string", "enum": list(DELIBERATE_ACTIONS)},
        "params": {"type": "object"},
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
            "description": (
                "null unless the prompt's VILLAGE AFFAIRS section names a live election "
                "and its electionId — never invent one"
            ),
            "properties": {
                "action": {"type": "string", "enum": list(GOVERNANCE_ACTIONS)},
                "electionId": {"type": "string", "description": "the exact electionId quoted in the prompt"},
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
        "reasoning",
        "action",
        "params",
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
    "craft": "CraftParams",
    "hunt": "HuntParams",
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
def _action_defs() -> dict[str, Any]:
    contract_path = find_contracts_dir() / "commands" / "ActionRequested.v1.schema.json"
    return json.loads(contract_path.read_text(encoding="utf-8"))["$defs"]


@cache
def _validators() -> tuple[Draft202012Validator, dict[str, Draft202012Validator]]:
    defs = _action_defs()
    outer = Draft202012Validator(DECISION_SCHEMA)
    per_action = {
        action: Draft202012Validator({**defs[def_name], "$defs": defs})
        for action, def_name in _PARAMS_DEF_BY_ACTION.items()
    }
    return outer, per_action


def _resolve_refs(node: Any, defs: dict[str, Any]) -> Any:
    """Inline '#/$defs/X' refs so a def can be embedded in a document with a
    different root (the decode schema handed to providers)."""
    if isinstance(node, dict):
        if "$ref" in node:
            name = str(node["$ref"]).rsplit("/", 1)[-1]
            resolved = _resolve_refs(defs[name], defs)
            extra = {k: _resolve_refs(v, defs) for k, v in node.items() if k != "$ref"}
            return {**resolved, **extra}
        return {key: _resolve_refs(value, defs) for key, value in node.items()}
    if isinstance(node, list):
        return [_resolve_refs(item, defs) for item in node]
    return node


def _strictify(schema: dict[str, Any]) -> dict[str, Any]:
    """OpenAI strict-mode discipline, applied recursively: every object closed
    with every property required; previously-optional properties become
    nullable (nullable enums gain null as a member) so 'omit' stays
    expressible — _normalize_params strips explicit nulls before wire
    validation, so decode-side null and wire-side absence agree. Annotation-
    only `default` is dropped (strict mode rejects unknown keywords)."""
    out = {k: v for k, v in schema.items() if k != "default"}
    if isinstance(out.get("properties"), dict):
        originally_required = set(out.get("required", []))
        props: dict[str, Any] = {}
        for key, sub in out["properties"].items():
            if isinstance(sub, dict):
                sub = _strictify(sub)
                if key not in originally_required:
                    t = sub.get("type")
                    if isinstance(t, str) and t != "null":
                        sub = {**sub, "type": [t, "null"]}
                    elif isinstance(t, list) and "null" not in t:
                        sub = {**sub, "type": [*t, "null"]}
                    if isinstance(sub.get("enum"), list) and None not in sub["enum"]:
                        sub = {**sub, "enum": [*sub["enum"], None]}
            props[key] = sub
        out["properties"] = props
        out["required"] = list(props)
        out["additionalProperties"] = False
    if isinstance(out.get("items"), dict):
        out["items"] = _strictify(out["items"])
    for keyword in ("anyOf", "oneOf", "allOf"):
        if isinstance(out.get(keyword), list):
            out[keyword] = [_strictify(s) if isinstance(s, dict) else s for s in out[keyword]]
    return out


@cache
def decision_schema(strict: bool = False) -> dict[str, Any]:
    """The provider-facing decision shape: DECISION_SCHEMA with `params`
    tightened from free-form to a union of the REAL per-verb shapes from
    ActionRequested.v1 (refs inlined; idle = the empty object). The decode
    grammar then cannot produce params that no verb accepts — action↔params
    pairing stays validate_decision's post-parse job, where the error
    messages are better.

    strict=True applies OpenAI strict-mode discipline on top — the `params`
    reshape CLAUDE.md has demanded before any OpenAI run (strict mode rejects
    free-form objects; this path 400'd from M1-3 until 2026-07-27). Reshaped,
    NOT yet verified against the live API — do a one-call smoke before any
    OpenAI filming run.

    Falls back to the free-form base when packages/events is unreachable —
    never true in service images (they COPY packages/events in).
    """
    schema = json.loads(json.dumps(DECISION_SCHEMA))  # deep copy, cache-safe
    try:
        defs = _action_defs()
    except FileNotFoundError:
        defs = None
    if defs is not None:
        branches = [
            _resolve_refs(defs[_PARAMS_DEF_BY_ACTION[action]], defs)
            for action in DELIBERATE_ACTIONS
            if action in _PARAMS_DEF_BY_ACTION
        ]
        branches.append({"type": "object", "properties": {}, "additionalProperties": False})  # idle
        schema["properties"]["params"] = {"anyOf": branches}
    if strict:
        schema = _strictify(schema)
    return schema


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
