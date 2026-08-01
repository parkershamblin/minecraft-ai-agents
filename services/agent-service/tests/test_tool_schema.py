"""decision_tool_schema(): the forced-tool parameters for frontier providers.

Property order is generation order under constrained decoding (reasoning
first is test-pinned — reordering is a behavior change, not a cleanup), the
params union must reject shapes no verb accepts, the whole document must
satisfy strict-mode structural rules (objects closed, everything required,
no constraint keywords), and DECISION_SCHEMA — the Ollama decode grammar —
must stay byte-identical (the no-configVersion-churn guarantee).
"""

import json

from jsonschema import Draft202012Validator

from agent_service.llm.contract import (
    _STRICT_UNSUPPORTED_KEYWORDS,
    DECISION_SCHEMA,
    DELIBERATE_ACTIONS,
    _action_defs,
    decision_tool_schema,
)


def _decision(action="gather", params=None, **overrides):
    base = {
        "reasoning": "the woods are close and the pack is empty",
        "action": action,
        "params": params if params is not None else {"resource": "wood", "count": 2},
        "importance": 4,
        "sentiment": 0.0,
        "relationshipUpdates": None,
        "governanceAction": None,
    }
    base.update(overrides)
    return base


def test_reasoning_is_the_first_property():
    assert next(iter(decision_tool_schema()["properties"])) == "reasoning"


def test_base_decision_schema_keeps_its_shape():
    # Structural invariants of the Ollama grammar path: params stays free-form
    # (per-action $defs enforce it after the parse) and action stays first.
    assert next(iter(DECISION_SCHEMA["properties"])) == "action"
    assert DECISION_SCHEMA["properties"]["params"] == {"type": "object"}


def test_bounded_ratings_are_enums_not_open_ranges():
    # Unit-10 rule R4. This IS a decode-grammar change — it rode the one
    # configVersion bump that unit 10 is allowed, deliberately, because it is
    # the fix for the measured failure class: 92.2% of malformed local
    # decisions were numeric-bounds violations, and bounds are enforced by no
    # channel at decode time (the grammar cannot express them; the strict
    # frontier wire strips them). An enum is enforced by both.
    importance = DECISION_SCHEMA["properties"]["importance"]
    sentiment = DECISION_SCHEMA["properties"]["sentiment"]
    assert importance["enum"] == [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    assert sentiment["enum"] == [-1.0, -0.75, -0.5, -0.25, 0.0, 0.25, 0.5, 0.75, 1.0]
    for field in (importance, sentiment):
        assert "minimum" not in field and "maximum" not in field


def test_arrival_ranges_are_bounded_enums():
    """The no-op move class. An unbounded `range` is not a loose constraint —
    a pathfinder goal is satisfied the moment the body is ALREADY within range,
    so a large value cancels the walk and still reports success. Measured on
    the v8 deploy with the model asking for range 100/128/1000: a 21-command
    sample travelled 6.4 blocks in TOTAL, ~0.3 per command. Folded into the
    same bump before any v8 race."""
    defs = _action_defs()
    for params in ("MoveParams", "FollowParams"):
        field = defs[params]["properties"]["range"]
        assert field["enum"] == [1, 2, 3, 4, 5, 6, 7, 8], params
        assert "maximum" not in field and "minimum" not in field, params


def test_params_union_accepts_every_verb_and_idle():
    # Cases are written the way a strict-mode model actually emits them:
    # every branch property present, omissions as explicit nulls
    # (_normalize_params strips those before wire validation).
    v = Draft202012Validator(decision_tool_schema())
    cases = {
        "move": {"to": {"x": 1, "y": 64, "z": -3}, "range": None},
        "gather": {"resource": "iron_ore", "maxDistance": None, "count": 3},
        "chat": {"message": "hello", "targetVillagerId": None},
        "follow": {"targetVillagerId": "3f2504e0-4f89-41d3-9a0c-0305e82c3301", "range": None},
        "craft": {"item": "planks"},
        "hunt": {"animal": "cow", "maxDistance": None},
        # Unit-10 skill verbs.
        "place": {"item": "crafting_table", "position": None},
        "store": {"item": "stone", "count": 12},
        "retrieve": {"item": "raw_iron", "count": None},
        "idle": {},
    }
    # "every verb" has to MEAN every verb, or a new one ships unexercised.
    assert set(cases) - {"idle"} == set(DELIBERATE_ACTIONS) - {"idle"}
    for action, params in cases.items():
        errors = list(v.iter_errors(_decision(action=action, params=params)))
        assert errors == [], f"{action}: {[e.message for e in errors]}"


def test_params_union_rejects_shapeless_junk():
    v = Draft202012Validator(decision_tool_schema())
    assert list(v.iter_errors(_decision(params={"garbage": 12})))
    assert list(v.iter_errors(_decision(params={"to": "not-a-position"})))


def _walk(node, path="$"):
    if isinstance(node, dict):
        yield path, node
        for key, value in node.items():
            yield from _walk(value, f"{path}.{key}")
    elif isinstance(node, list):
        for i, item in enumerate(node):
            yield from _walk(item, f"{path}[{i}]")


def test_satisfies_strict_mode_structural_rules():
    # Objects closed + all-required (both providers), and no constraint
    # keywords: Anthropic strict rejects numeric/string bounds outright, and
    # one conservative shape serves both providers — bounds stay enforced by
    # validate_decision post-parse.
    for path, node in _walk(decision_tool_schema()):
        for keyword in _STRICT_UNSUPPORTED_KEYWORDS:
            assert keyword not in node, f"{path} carries {keyword}"
        if isinstance(node.get("properties"), dict):
            assert node.get("additionalProperties") is False, path
            assert set(node.get("required", [])) == set(node["properties"]), path
        types = node.get("type")
        types = [types] if isinstance(types, str) else (types or [])
        if "object" in types:
            # No free-form objects anywhere (the exact shape of the M1-3 400).
            assert "properties" in node, path


def test_validates_a_full_decision_with_explicit_nulls():
    # Previously-optional params arrive as explicit nulls under strict
    # required-nullable; _normalize_params strips them before wire validation.
    v = Draft202012Validator(decision_tool_schema())
    decision = _decision(params={"resource": "iron_ore", "maxDistance": None, "count": 3})
    errors = list(v.iter_errors(decision))
    assert errors == [], [e.message for e in errors]


def test_union_branches_carry_no_unresolved_refs():
    assert "$ref" not in json.dumps(decision_tool_schema()["properties"]["params"])
