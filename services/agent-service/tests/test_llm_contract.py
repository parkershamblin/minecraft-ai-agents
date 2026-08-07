import json

import pytest

from agent_service.llm.contract import Decision, MalformedDecision, validate_decision


def decision(**overrides) -> str:
    base = {
        "action": "chat",
        "params": {"message": "Hello, Bram."},
        "reasoning": "Being friendly.",
        "importance": 2,
        "sentiment": 0.5,
        "relationshipUpdates": None,  # required-nullable (OpenAI strict mode)
        "governanceAction": None,  # required-nullable (M2-7)
    }
    base.update(overrides)
    return json.dumps(base)


class TestValidDecisions:
    def test_chat(self):
        parsed = validate_decision(decision())
        assert parsed.action == "chat"
        assert parsed.params["message"] == "Hello, Bram."

    def test_move_params_validate_against_the_real_contract(self):
        parsed = validate_decision(decision(action="move", params={"to": {"x": 1, "y": 64, "z": -3}, "range": 2}))
        assert parsed.params["to"]["z"] == -3

    def test_follow(self):
        parsed = validate_decision(
            decision(action="follow", params={"targetVillagerId": "019f8e2a-0000-7000-8000-0000000b2a44"})
        )
        assert parsed.action == "follow"

    def test_idle_and_gather_take_empty_params(self):
        assert validate_decision(decision(action="idle", params={})).action == "idle"
        assert validate_decision(decision(action="gather", params={})).action == "gather"

    def test_craft_iron_sword(self):
        # The guard arc's blade (additive enum growth, same chain as the pickaxe).
        parsed = validate_decision(decision(action="craft", params={"item": "iron_sword"}))
        assert parsed.params["item"] == "iron_sword"


class TestMalformedDecisions:
    def test_not_json(self):
        with pytest.raises(MalformedDecision, match="not JSON"):
            validate_decision("I think I shall walk to the pond.")

    def test_spawn_is_not_a_villager_choice(self):
        with pytest.raises(MalformedDecision):
            validate_decision(decision(action="spawn", params={"minecraftUsername": "Imposter"}))

    def test_unknown_action(self):
        with pytest.raises(MalformedDecision):
            validate_decision(decision(action="fly", params={}))

    def test_chat_without_message(self):
        with pytest.raises(MalformedDecision, match="params invalid for chat"):
            validate_decision(decision(action="chat", params={}))

    def test_move_with_bad_coordinates(self):
        with pytest.raises(MalformedDecision, match="params invalid for move"):
            validate_decision(decision(action="move", params={"to": {"x": "north", "y": 64, "z": 0}}))

    def test_importance_out_of_range(self):
        with pytest.raises(MalformedDecision):
            validate_decision(decision(importance=11))

    def test_missing_reasoning(self):
        raw = json.loads(decision())
        del raw["reasoning"]
        with pytest.raises(MalformedDecision):
            validate_decision(json.dumps(raw))


def test_idle_factory_is_always_contract_valid():
    fallback = Decision.idle("something went wrong")
    assert validate_decision(
        json.dumps(
            {
                "action": fallback.action,
                "params": fallback.params,
                "reasoning": fallback.reasoning,
                "importance": fallback.importance,
                "sentiment": fallback.sentiment,
                "relationshipUpdates": None,
                "governanceAction": None,
            }
        )
    )


class TestRelationshipUpdates:
    def test_valid_updates_parse(self):
        parsed = validate_decision(
            decision(
                relationshipUpdates=[
                    {
                        "villagerId": "019f8e2a-0000-7000-8000-0000000b2a44",
                        "affinityDelta": -12,
                        "trustDelta": -5,
                        "reason": "He lied about the diamonds.",
                    }
                ]
            )
        )
        assert parsed.relationship_updates[0].affinity_delta == -12
        assert parsed.relationship_updates[0].reason == "He lied about the diamonds."

    def test_null_means_no_updates(self):
        assert validate_decision(decision(relationshipUpdates=None)).relationship_updates == ()

    def test_missing_field_is_malformed_now(self):
        raw = json.loads(decision())
        del raw["relationshipUpdates"]
        with pytest.raises(MalformedDecision):
            validate_decision(json.dumps(raw))

    def test_delta_out_of_range_is_malformed(self):
        with pytest.raises(MalformedDecision):
            validate_decision(
                decision(
                    relationshipUpdates=[
                        {"villagerId": "x", "affinityDelta": 50, "trustDelta": 0, "reason": "too much"}
                    ]
                )
            )

    def test_more_than_three_is_malformed(self):
        update = {"villagerId": "x", "affinityDelta": 1, "trustDelta": 1, "reason": "r"}
        with pytest.raises(MalformedDecision):
            validate_decision(decision(relationshipUpdates=[update] * 4))


ELECTION_ID = "019f8e2a-0000-7000-8000-0000e1ec0001"
BRAM_ID = "019f8e2a-0000-7000-8000-0000000b2a44"


def governance(**overrides):
    base = {
        "action": "vote",
        "electionId": ELECTION_ID,
        "candidateVillagerId": BRAM_ID,
        "reason": "He shared his bread.",
        "platform": None,
    }
    base.update(overrides)
    return base


class TestGovernanceAction:
    def test_null_means_no_civic_action(self):
        assert validate_decision(decision(governanceAction=None)).governance_action is None

    def test_missing_field_is_malformed(self):
        raw = json.loads(decision())
        del raw["governanceAction"]
        with pytest.raises(MalformedDecision):
            validate_decision(json.dumps(raw))

    def test_vote_maps_to_wire_params(self):
        parsed = validate_decision(decision(governanceAction=governance()))
        assert parsed.governance_action.action == "vote"
        assert parsed.governance_action.params == {
            "electionId": ELECTION_ID,
            "candidateVillagerId": BRAM_ID,
            "reason": "He shared his bread.",
        }

    def test_vote_without_reason_omits_the_key(self):
        parsed = validate_decision(decision(governanceAction=governance(reason=None)))
        assert "reason" not in parsed.governance_action.params

    def test_declare_candidacy_maps_platform(self):
        parsed = validate_decision(
            decision(
                governanceAction=governance(
                    action="declare_candidacy",
                    candidateVillagerId=None,
                    reason=None,
                    platform="Grain tallies posted at dawn.",
                )
            )
        )
        assert parsed.governance_action.action == "declare_candidacy"
        assert parsed.governance_action.params == {
            "electionId": ELECTION_ID,
            "platform": "Grain tallies posted at dawn.",
        }

    def test_unknown_civic_action_is_malformed(self):
        # propose_law is the M3 temptation — the outer enum rejects it whole.
        with pytest.raises(MalformedDecision):
            validate_decision(decision(governanceAction=governance(action="propose_law")))

    def test_vote_without_candidate_is_dropped_not_fatal(self):
        parsed = validate_decision(decision(governanceAction=governance(candidateVillagerId=None)))
        assert parsed.governance_action is None  # civic add-on dropped...
        assert parsed.action == "chat"  # ...but the world action survives

    def test_hallucinated_election_id_is_dropped_not_fatal(self):
        parsed = validate_decision(
            decision(governanceAction=governance(electionId="the-big-election"))
        )
        assert parsed.governance_action is None
        assert parsed.action == "chat"


class TestToleranReaderNormalization:
    def test_chat_villagerid_alias_normalizes(self):
        parsed = validate_decision(
            decision(params={"villagerId": "abc", "message": "hello"})
        )
        assert parsed.params == {"targetVillagerId": "abc", "message": "hello"}

    def test_decision_level_keys_stripped_from_params(self):
        parsed = validate_decision(
            decision(params={"message": "hi", "importance": 5, "sentiment": 0.25})
        )
        assert parsed.params == {"message": "hi"}

    def test_genuinely_unknown_params_still_rejected(self):
        with pytest.raises(MalformedDecision):
            validate_decision(decision(params={"message": "hi", "flightSpeed": 9000}))

    def test_null_optional_param_is_stripped_not_fatal(self):
        # llama's signature drift: "maxDistance": null means "use the default".
        parsed = validate_decision(decision(action="gather", params={"resource": "wood", "maxDistance": None}))
        assert parsed.action == "gather"
        assert parsed.params == {"resource": "wood"}

    def test_all_null_params_normalize_to_empty(self):
        parsed = validate_decision(decision(action="gather", params={"resource": None, "maxDistance": None}))
        assert parsed.params == {}

    def test_null_required_param_still_malformed(self):
        # stripping turns a null message into a MISSING message — still caught.
        with pytest.raises(MalformedDecision, match="params invalid for chat"):
            validate_decision(decision(action="chat", params={"message": None}))


class TestBoundsRepair:
    """Bounds live in the schema but no decode channel can close them: params
    is free-form in DECISION_SCHEMA, and the strict wire strips min/max/
    maxLength. Post-parse rejection therefore threw away 10.86% of live
    deliberations (191/1758 over 6h on 2026-08-07) over one out-of-range
    scalar. These pin the repair — and, just as load-bearing, pin what is
    still REFUSED so the tolerance can't quietly grow into inventing params.
    """

    # The exact values gemma3:12b emitted live, with their observed counts.
    @pytest.mark.parametrize("emitted", [10, 100, 16, 1000, 20, 0])
    def test_move_range_outside_the_enum_falls_to_the_default(self, emitted):
        parsed = validate_decision(
            decision(action="move", params={"to": {"x": 1, "y": 64, "z": -3}, "range": emitted})
        )
        assert parsed.action == "move", "the tick must survive, not fall back to idle"
        # NOT the nearest member (8) — 8 is the most no-op-prone value a move
        # can carry, which is the bug PR #113 fixed. The schema default walks.
        assert parsed.params["range"] == 1

    def test_follow_range_falls_to_its_own_default_not_moves(self):
        parsed = validate_decision(
            decision(action="follow", params={"targetVillagerId": "abc", "range": 50})
        )
        assert parsed.params["range"] == 2  # FollowParams declares default 2

    def test_repair_reads_the_default_per_field_not_a_constant(self):
        # Store/RetrieveParams.count default to 16 ("as much as fits"), so the
        # same rule must NOT drag them down to move's 1.
        parsed = validate_decision(
            decision(action="store", params={"item": "wood", "count": 999})
        )
        assert parsed.params["count"] == 16

    def test_in_bounds_values_are_left_exactly_alone(self):
        parsed = validate_decision(
            decision(action="move", params={"to": {"x": 1, "y": 64, "z": -3}, "range": 3})
        )
        assert parsed.params["range"] == 3

    def test_min_max_numbers_clamp_too(self):
        # R5 class (cardinality > 16): gather.maxDistance is 4..64.
        parsed = validate_decision(decision(action="gather", params={"resource": "wood", "maxDistance": 500}))
        assert parsed.params["maxDistance"] == 64
        parsed = validate_decision(decision(action="gather", params={"resource": "wood", "maxDistance": 1}))
        assert parsed.params["maxDistance"] == 4

    def test_over_long_chat_is_truncated_to_the_cap(self):
        long_line = "Hah! " + ("the forge runs hot and the iron runs thin " * 12)
        assert len(long_line) > 256
        parsed = validate_decision(decision(action="chat", params={"message": long_line}))
        assert len(parsed.params["message"]) <= 256
        assert parsed.params["message"].endswith("…")
        assert parsed.params["message"].startswith("Hah! the forge")

    def test_truncation_lands_on_a_word_boundary(self):
        parsed = validate_decision(decision(action="chat", params={"message": "word " * 200}))
        assert "  " not in parsed.params["message"]
        assert parsed.params["message"].endswith("word…")

    def test_message_exactly_at_the_cap_is_untouched(self):
        exact = "x" * 256
        parsed = validate_decision(decision(action="chat", params={"message": exact}))
        assert parsed.params["message"] == exact

    # --- what repair must NEVER do -------------------------------------
    def test_wrong_type_is_still_malformed(self):
        # "ten" is a misunderstanding of the verb, not a scalar outside a
        # window — coercing it would invent an intent the model never had.
        with pytest.raises(MalformedDecision, match="params invalid for move"):
            validate_decision(decision(action="move", params={"to": {"x": 1, "y": 64, "z": -3}, "range": "ten"}))

    def test_empty_message_is_still_malformed(self):
        # minLength 1 — there is no honest repair for "said nothing".
        with pytest.raises(MalformedDecision, match="params invalid for chat"):
            validate_decision(decision(action="chat", params={"message": ""}))

    def test_missing_required_param_is_still_malformed(self):
        with pytest.raises(MalformedDecision, match="params invalid for move"):
            validate_decision(decision(action="move", params={"range": 2}))

    def test_repair_does_not_rescue_an_unknown_param(self):
        with pytest.raises(MalformedDecision):
            validate_decision(decision(params={"message": "hi", "flightSpeed": 9000}))


def test_every_bounded_contract_param_is_repairable():
    """Drift tripwire. The repair table is DERIVED from the contract $defs, so
    a bound added to the schema later is repaired for free — this asserts that
    derivation actually reaches every bounded param of every verb, and fails
    loud if a verb's params stop resolving (a $ref rename, a moved $def)."""
    from agent_service.llm.contract import (
        _PARAMS_DEF_BY_ACTION,
        _action_defs,
        _bounded_props,
        _resolve_refs,
    )

    defs = _action_defs()
    for action, def_name in _PARAMS_DEF_BY_ACTION.items():
        resolved = _resolve_refs(defs[def_name], defs)
        expected = {
            name
            for name, spec in resolved.get("properties", {}).items()
            if isinstance(spec, dict) and ({"enum", "minimum", "maximum", "maxLength"} & spec.keys())
        }
        assert {name for name, _ in _bounded_props(action)} == expected, action

    # The two that cost the live ticks must be in there by name.
    assert "range" in {name for name, _ in _bounded_props("move")}
    assert "message" in {name for name, _ in _bounded_props("chat")}
