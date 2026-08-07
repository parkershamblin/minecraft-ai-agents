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
# place/store/retrieve joined with unit 10 — the first verbs the executor
# serves out of the ported skill library instead of a bespoke path.
DELIBERATE_ACTIONS = (
    "move",
    "gather",
    "chat",
    "follow",
    "idle",
    "craft",
    "hunt",
    "place",
    "store",
    "retrieve",
)

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
        # ENUMS, not minimum/maximum (unit-10 rule R4 + its rider). A bounded
        # small range is the ONE numeric constraint class every decode channel
        # enforces: the Ollama grammar closes an enum at decode time, and enum
        # survives the strict-tool strip (_STRICT_UNSUPPORTED_KEYWORDS) that
        # removes minimum/maximum for the frontier wire. Bounds were therefore
        # enforced by no channel at decode time and only caught post-parse —
        # 92.2% of malformed local decisions were bounds violations, and these
        # two plus GatherParams.count are the bounded fields a grammar can
        # actually close. Quarter steps are exact in binary floating point, so
        # enum membership never turns into a float-equality trap; sentiment
        # feeds memory scoring, which loses nothing at that resolution.
        "importance": {"type": "integer", "enum": [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]},
        "sentiment": {"type": "number", "enum": [-1.0, -0.75, -0.5, -0.25, 0.0, 0.25, 0.5, 0.75, 1.0]},
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
    "craft": "CraftParams",
    "hunt": "HuntParams",
    "place": "PlaceParams",
    "store": "StoreParams",
    "retrieve": "RetrieveParams",
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


# ------------------------------------------------------- bounds repair (R4/R5)
# Rules R4/R5 put bounds in the schema source, but NEITHER decode channel can
# close them where they actually live: `params` is free-form in
# DECISION_SCHEMA by design (strict mode dislikes conditionals), so the Ollama
# grammar never sees MoveParams.range's enum, and _STRICT_UNSUPPORTED_KEYWORDS
# strips maxLength/minimum/maximum for the frontier wire. The bound was
# therefore enforced only post-parse — and post-parse enforcement REJECTED the
# whole decision, throwing away a sound action, its reasoning and a full
# deliberation over one out-of-range scalar.
#
# Measured live 2026-08-07 (6h, gemma3:12b, 6 villagers): 191 of 1758
# deliberations discarded = 10.86%, of which 133 were `range` outside 1-8
# (the model emitting 10, 16, 20, 100, 1000 despite the prompt stating the
# bound) and 55 were chat messages over the 256-char cap. Each cost ~4s of
# GPU and booked an idle tick.
#
# So repair instead of reject, in the same tolerant-reader spirit as the alias
# table above: clamp a number into its bound, truncate an over-long string,
# and let the tick proceed. Repairs are counted per field
# (civ_llm_repaired_total) so the model's true violation rate stays visible —
# the point is to stop paying for the violation, not to stop seeing it.
#
# Deliberately NOT repaired: wrong TYPES (range: "ten"), missing required
# params, and empty strings under minLength. Those are real misunderstandings
# of the verb rather than a scalar landing outside a window the model was
# never shown, and inventing a value would put words in the villager's mouth.
def _clamp_to_enum(value: float, members: list[Any]) -> Any | None:
    """Nearest enum member; ties go to the smaller (a range of 0 means 1)."""
    ints = [m for m in members if isinstance(m, int) and not isinstance(m, bool)]
    if not ints or value in ints:
        return None
    return min(ints, key=lambda member: (abs(member - value), member))


def _truncate(text: str, cap: int) -> str:
    """Cut to the cap on a word boundary where one is close enough, so a
    clipped chat line still reads as a sentence on camera rather than mid-word.
    The ellipsis is part of the budget, never an overflow of it."""
    head = text[: cap - 1]
    boundary = head.rfind(" ")
    if boundary >= (cap - 1) * 0.6:
        head = head[:boundary]
    return head.rstrip(" ,;:.!?-—") + "…"


def _repair_value(value: Any, spec: dict[str, Any]) -> Any | None:
    """The repaired value, or None when the value is already in bounds or is
    of a kind we refuse to invent."""
    kind = spec.get("type")
    is_number = isinstance(value, (int, float)) and not isinstance(value, bool)

    if kind == "integer" and is_number and (members := spec.get("enum")):
        return _clamp_to_enum(value, members)

    if kind in ("number", "integer") and is_number and "enum" not in spec:
        low, high = spec.get("minimum"), spec.get("maximum")
        clamped = value
        if low is not None:
            clamped = max(clamped, low)
        if high is not None:
            clamped = min(clamped, high)
        return clamped if clamped != value else None

    if kind == "string" and isinstance(value, str) and (cap := spec.get("maxLength")):
        return _truncate(value, cap) if len(value) > cap else None

    return None


@cache
def _bounded_props(action: str) -> tuple[tuple[str, dict[str, Any]], ...]:
    """The params of one verb that carry a repairable bound, read from the
    contract $defs — so a bound added to the schema later is repaired without
    touching this module, and no hand-kept list can drift from it."""
    def_name = _PARAMS_DEF_BY_ACTION.get(action)
    if def_name is None:
        return ()
    defs = _action_defs()
    resolved = _resolve_refs(defs[def_name], defs)
    return tuple(
        (name, spec)
        for name, spec in resolved.get("properties", {}).items()
        if isinstance(spec, dict)
        and ({"enum", "minimum", "maximum", "maxLength"} & spec.keys())
    )


def _repair_bounds(action: str, params: dict[str, Any]) -> tuple[str, ...]:
    """Repair out-of-bounds params IN PLACE; returns the names repaired."""
    repaired: list[str] = []
    for name, spec in _bounded_props(action):
        if name not in params:
            continue
        fixed = _repair_value(params[name], spec)
        if fixed is not None:
            params[name] = fixed
            repaired.append(name)
    return tuple(repaired)


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
    # After aliasing (so a repaired param is counted under its contract name)
    # and before validation (so the repair is what gets validated — a repair
    # that does not satisfy the schema must still fail loudly).
    for repaired_param in _repair_bounds(action, params):
        from agent_service.metrics import llm_repaired_total

        llm_repaired_total.labels(action=action, param=repaired_param).inc()
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


# ------------------------------------------------------------- native tools
# The frontier-provider tool parameters (owner decision 2026-07-27): OpenAI
# and Anthropic call a single forced 'decide' tool under strict mode, while
# the local Ollama grammar path keeps DECISION_SCHEMA byte-identical — no
# decode-grammar change for local models, so no benchmark configVersion
# churn. Strict tool grammars reject free-form objects and constraint
# keywords, so this shape tightens `params` to a union of the REAL per-verb
# $defs and strips the bounds for the wire; validate_decision still enforces
# the full contract post-parse, where the error messages are better.

# Keywords the strict grammars (OpenAI strict tools / Anthropic strict tool
# use) reject or ignore — dropped for the wire only; bounds stay enforced
# locally by validate_decision.
_STRICT_UNSUPPORTED_KEYWORDS = frozenset(
    {
        "default",
        "minimum",
        "maximum",
        "exclusiveMinimum",
        "exclusiveMaximum",
        "multipleOf",
        "minLength",
        "maxLength",
        "pattern",
        "format",
        "minItems",
        "maxItems",
    }
)


@cache
def _action_defs() -> dict[str, Any]:
    contract_path = find_contracts_dir() / "commands" / "ActionRequested.v1.schema.json"
    return json.loads(contract_path.read_text(encoding="utf-8"))["$defs"]


def _resolve_refs(node: Any, defs: dict[str, Any]) -> Any:
    """Inline '#/$defs/X' refs so a def can be embedded in a document with a
    different root (the tool parameters handed to providers)."""
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
    """Strict-mode discipline, applied recursively: every object closed with
    every property required; previously-optional properties become nullable
    (nullable enums gain null as a member) so 'omit' stays expressible —
    _normalize_params strips explicit nulls before wire validation, so
    decode-side null and wire-side absence agree."""
    out = {k: v for k, v in schema.items() if k not in _STRICT_UNSUPPORTED_KEYWORDS}
    if isinstance(out.get("properties"), dict):
        originally_required = set(out.get("required", []))
        props: dict[str, Any] = {}
        for key, sub in out["properties"].items():
            if isinstance(sub, dict):
                sub = _strictify(sub)
                if key not in originally_required:
                    if isinstance(sub.get("enum"), list):
                        # Nullable ENUM must be anyOf(enum, null): Anthropic's
                        # strict validator 400s on a type array paired with
                        # enum members ("Enum value 'wood' does not match
                        # declared type ['string','null']" — live smoke,
                        # 2026-07-27). anyOf reads the same to both providers.
                        sub = {"anyOf": [sub, {"type": "null"}]}
                    else:
                        t = sub.get("type")
                        if isinstance(t, str) and t != "null":
                            sub = {**sub, "type": [t, "null"]}
                        elif isinstance(t, list) and "null" not in t:
                            sub = {**sub, "type": [*t, "null"]}
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
def decision_tool_schema() -> dict[str, Any]:
    """The `input_schema`/`parameters` for the single forced 'decide' tool on
    the frontier providers (Anthropic's own guidance for many related actions
    is literally "group them into a single tool with an action parameter").

    - reasoning FIRST: constrained decoding emits keys in schema order, and
      deciding before rationalizing was the measured failure mode (brief
      CoT-first cut wrong-function selection 30.5%%->1.5%%, arXiv 2604.02155).
    - params tightens from free-form to an anyOf union of the real per-verb
      shapes from ActionRequested.v1 (refs inlined; idle = the closed empty
      object) — strict mode rejects free-form objects (the M1-3 latent 400).
    - strictified: objects closed, everything required-nullable, constraint
      keywords stripped for the wire.

    The Ollama grammar path deliberately does NOT use this schema — its
    decode grammar stays byte-identical to DECISION_SCHEMA.
    """
    schema = json.loads(json.dumps(DECISION_SCHEMA))  # deep copy, cache-safe
    props = schema["properties"]
    schema["properties"] = {"reasoning": props.pop("reasoning"), **props}
    try:
        defs = _action_defs()
    except FileNotFoundError:
        defs = None  # never true in service images (packages/events is COPY'd in)
    if defs is not None:
        branches = [
            _resolve_refs(defs[_PARAMS_DEF_BY_ACTION[action]], defs)
            for action in DELIBERATE_ACTIONS
            if action in _PARAMS_DEF_BY_ACTION
        ]
        branches.append({"type": "object", "properties": {}, "additionalProperties": False})  # idle
        schema["properties"]["params"] = {"anyOf": branches}
    return _strictify(schema)
