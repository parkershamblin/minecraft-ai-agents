"""Action awareness — remember each villager's previous decision so the next
tick's prompt can pair it with its observed outcome (Project Sid's #1
progression lever: agents that don't know what they just did repeat it).

Also the failure-streak ledger (2026-07-27, Voyager's abandon-and-repropose):
greedy decoding re-asks a refused intent forever — the outcome line alone
proved too weak a deterrent once the same failure repeated. Streaks count
consecutive substantive refusals of the SAME intent and surface as a standing
"change course" prompt section at the abandon threshold.

Deliberately in-memory: a restart forgets, and that's fine — the ledger and
memory stream carry the durable record; this is working memory, not truth.
"""

import uuid
from dataclasses import dataclass, field
from typing import Any

# Failure codes that say nothing about the INTENT itself: the queue superseded
# it, the body was busy, the bot wasn't in the world. Counting these toward
# abandonment would teach a villager to give up on ideas the world never
# actually refused.
_PLUMBING_CODES = {
    "SUPERSEDED",
    "STALE_COMMAND",
    "BODY_BUSY",
    "HAZARD_ESCAPE_IN_PROGRESS",
    "SELF_DEFENSE_IN_PROGRESS",
    "BOT_DISCONNECTED",
    # The harness cancelled a skill mid-flight (shutdown, supersede, reflex
    # preemption). Added in the same commit that let it reach the wire, per
    # the unit-10 rule: a plumbing code must never arrive at awareness before
    # its classification does, or it books streaks against innocent intents.
    "ABORTED",
    # mineflayer-pathfinder's A* ran out of its own thinking budget. Added in
    # the same commit that lets it reach the wire (the ABORTED rule). Before
    # the split these arrived as INTERNAL — 12,067 of them in the ledger, each
    # one counting toward an abandonment streak against an intent the world
    # never refused. PATH_NOT_FOUND (no route exists) stays SUBSTANTIVE: that
    # one is the world's verdict and repeating it verbatim cannot help.
    "PATH_SEARCH_EXHAUSTED",
}

# A streak that goes this many note_outcomes() calls (≈ ticks) without a fresh
# failure expires: the world changes — the villager walked elsewhere, crafted
# the missing tool — and a permanent ban on e.g. 'gather iron_ore' could block
# the very goal the abandonment was meant to serve.
_STREAK_TTL_TICKS = 10


@dataclass(frozen=True)
class LastDecision:
    action: str
    params: dict[str, Any]


@dataclass(frozen=True)
class FailureStreak:
    intent: str  # human prose, e.g. "gather iron_ore" — rendered verbatim
    count: int


@dataclass
class _Streak:
    prose: str
    count: int
    idle_ticks: int = field(default=0)


def _intent_identity(action: str, params: dict[str, Any]) -> tuple[str, str]:
    """(key, prose) for what makes a retry 'the same ask'. Keyed by the salient
    target, not the full params: gather 3 iron_ore and gather 4 iron_ore are
    one idea; move targets are the same ask within a rounded block."""
    if action == "gather":
        salient = str(params.get("resource") or "?")
        return f"gather:{salient}", f"gather {salient}"
    if action == "move":
        to = params.get("to")
        if isinstance(to, dict):
            try:
                x = round(float(to.get("x", 0)))
                z = round(float(to.get("z", 0)))
            except (TypeError, ValueError):
                return "move:?", "move (malformed target)"
            return f"move:{x},{z}", f"move to ({x}, {z})"
        return "move:?", "move (malformed target)"
    if action == "craft":
        salient = str(params.get("item") or "?")
        return f"craft:{salient}", f"craft {salient}"
    if action == "hunt":
        salient = str(params.get("animal") or "any")
        return f"hunt:{salient}", f"hunt {salient}"
    if action == "follow":
        salient = str(params.get("targetVillagerId") or "?")
        return f"follow:{salient}", f"follow villager {salient}"
    # Unit-10 skill verbs. Each MUST key on its item, not fall through to the
    # generic bucket below: an unkeyed verb merges distinct intents ("place a
    # chest" vs "place a furnace") into one streak, so three refusals spread
    # across different items would abandon all of them at once.
    if action == "place":
        salient = str(params.get("item") or "?")
        return f"place:{salient}", f"place {salient}"
    if action == "store":
        salient = str(params.get("item") or "?")
        return f"store:{salient}", f"store {salient}"
    if action == "retrieve":
        salient = str(params.get("item") or "?")
        return f"retrieve:{salient}", f"retrieve {salient}"
    return f"{action}:", action


class ActionAwareness:
    def __init__(self, abandon_after: int = 3) -> None:
        self._last: dict[uuid.UUID, LastDecision] = {}
        self._streaks: dict[uuid.UUID, dict[str, _Streak]] = {}
        self._abandon_after = abandon_after

    def remember(self, villager_id: uuid.UUID, action: str, params: dict[str, Any]) -> None:
        self._last[villager_id] = LastDecision(action=action, params=params)

    def recall(self, villager_id: uuid.UUID) -> LastDecision | None:
        return self._last.get(villager_id)

    def forget(self, villager_id: uuid.UUID) -> None:
        self._last.pop(villager_id, None)
        self._streaks.pop(villager_id, None)

    def note_outcomes(
        self, villager_id: uuid.UUID, percepts: list[dict[str, Any]]
    ) -> list[FailureStreak]:
        """Fold this tick's Action outcome percepts into per-intent failure
        streaks; return every streak at/above the abandon threshold. The
        return is a STANDING section (like civics) — hot until a success
        clears it or expiry ages it out — so a pending-trip tick with no new
        outcome doesn't silently lift the advice.

        Pairing is loose by design, the same rule user_prompt uses: an outcome
        percept matching the last decision's ACTION is attributed to that
        decision's intent — outcome events don't carry params, so the last
        decision is the only source of the target.
        """
        streaks = self._streaks.setdefault(villager_id, {})
        last = self._last.get(villager_id)

        refreshed_key: str | None = None
        if last is not None:
            for percept in percepts:
                if percept.get("action") != last.action:
                    continue
                kind = percept.get("type")
                if kind == "ActionCompleted":
                    key, _ = _intent_identity(last.action, last.params)
                    streaks.pop(key, None)
                    refreshed_key = key  # settled this tick either way
                    break
                if kind == "ActionFailed":
                    detail = percept.get("detail") or {}
                    if str(detail.get("errorCode")) in _PLUMBING_CODES:
                        continue  # the world never refused the intent itself
                    key, prose = _intent_identity(last.action, last.params)
                    entry = streaks.get(key)
                    if entry is None:
                        streaks[key] = _Streak(prose=prose, count=1)
                    else:
                        entry.count += 1
                        entry.idle_ticks = 0
                    refreshed_key = key
                    break

        for key in list(streaks):
            if key == refreshed_key:
                continue
            entry = streaks[key]
            entry.idle_ticks += 1
            if entry.idle_ticks >= _STREAK_TTL_TICKS:
                del streaks[key]

        hot = [
            FailureStreak(intent=entry.prose, count=entry.count)
            for entry in streaks.values()
            if entry.count >= self._abandon_after
        ]
        hot.sort(key=lambda s: (-s.count, s.intent))
        return hot
