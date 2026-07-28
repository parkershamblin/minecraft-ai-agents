"""decision_schema(): the provider-facing decode shape. Property order is
generation order under grammar-constrained decoding, the params union must
reject shapes no verb accepts, and the strict variant must satisfy OpenAI
strict-mode structural rules (the M1-3 latent 400)."""

from agent_service.llm.contract import DECISION_SCHEMA, decision_schema
from jsonschema import Draft202012Validator


def _decision(action="gather", params=None, **overrides):
    base = {
        "reasoning": "the woods are close and the pack is empty",
        "action": action,
        "params": params if params is not None else {"resource": "wood", "count": 2},
        "importance": 4,
        "sentiment": 0.1,
        "relationshipUpdates": None,
        "governanceAction": None,
    }
    base.update(overrides)
    return base


def test_reasoning_is_the_first_property():
    # Grammar-constrained decode emits keys in schema order: reasoning first
    # means the model deliberates BEFORE committing to an action. Reordering
    # this is a behavior change, not a cleanup.
    assert next(iter(DECISION_SCHEMA["properties"])) == "reasoning"
    assert next(iter(decision_schema()["properties"])) == "reasoning"
    assert next(iter(decision_schema(strict=True)["properties"])) == "reasoning"


def test_params_union_accepts_every_verb_and_idle():
    v = Draft202012Validator(decision_schema())
    cases = {
        "move": {"to": {"x": 1, "y": 64, "z": -3}},
        "gather": {"resource": "iron_ore", "count": 3},
        "chat": {"message": "hello"},
        "follow": {"targetVillagerId": "3f2504e0-4f89-41d3-9a0c-0305e82c3301"},
        "craft": {"item": "planks"},
        "hunt": {"animal": "cow"},
        "idle": {},
    }
    for action, params in cases.items():
        errors = list(v.iter_errors(_decision(action=action, params=params)))
        assert errors == [], f"{action}: {[e.message for e in errors]}"


def test_params_union_rejects_shapeless_junk():
    # The base schema's free-form params accepted anything; the union must
    # not — junk keys match no closed branch (all $defs carry
    # additionalProperties: false, and the idle branch has no properties).
    v = Draft202012Validator(decision_schema())
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


def test_strict_variant_satisfies_openai_strict_rules():
    strict = decision_schema(strict=True)
    for path, node in _walk(strict):
        # No annotation-only defaults (strict mode rejects them).
        assert "default" not in node, path
        if isinstance(node.get("properties"), dict):
            # Every object closed, every property required.
            assert node.get("additionalProperties") is False, path
            assert set(node.get("required", [])) == set(node["properties"]), path
        types = node.get("type")
        types = [types] if isinstance(types, str) else (types or [])
        if "object" in types and path != "$.properties.params":
            # No free-form objects anywhere (the exact shape of the M1-3 400).
            assert "properties" in node, path


def test_strict_variant_validates_a_full_decision_with_nulls():
    # Previously-optional params arrive as explicit nulls under strict
    # required-nullable; _normalize_params strips them before wire validation.
    v = Draft202012Validator(decision_schema(strict=True))
    decision = _decision(
        params={"resource": "iron_ore", "maxDistance": None, "count": 3},
    )
    errors = list(v.iter_errors(decision))
    assert errors == [], [e.message for e in errors]


def test_union_branches_carry_no_unresolved_refs():
    import json

    assert "$ref" not in json.dumps(decision_schema()["properties"]["params"])
