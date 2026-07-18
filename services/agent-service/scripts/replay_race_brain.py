"""Offline race-brain replay — the seconds-long prompt-tuning loop (ADR-10).

The RB-2 race takes 11-75 minutes to reach an outcome, so watching a live race
is the WRONG feedback unit for tuning the brain's decisions. This harness feeds
the real system+user prompts (at a chosen rung) to the real Ollama model N times
and prints the decision histogram — NO Minecraft, NO docker, NO tick clock.

If 15/20 decisions at the `bare` rung are `move`/`hunt` instead of a craft toward
the pickaxe, the RACE DISCIPLINE prompt tuning failed — and you learn that in
20 seconds instead of after a 45-minute wood age. Edit prompts.py, rerun.

Usage (from services/agent-service):
  uv run python scripts/replay_race_brain.py --rung bare --n 20
  uv run python scripts/replay_race_brain.py --rung iron --n 30 --model llama3.1:8b
  uv run python scripts/replay_race_brain.py --rung all           (sweep every rung)

Rungs are named by the NEXT milestone the villager must cross; each stages an
inventory that makes crossing genuinely possible, so a bad decision is a brain
defect, not an impossible ask. Exit code 0 always — this is a measurement, not
a gate (read the histogram).
"""

import argparse
import asyncio
import json
import sys
from collections import Counter
from pathlib import Path

import httpx

# The histogram bars + rung banners are non-cp1252 — force UTF-8 so a Windows
# console (default cp1252) prints them instead of crashing on encode.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from agent_service.brain.prompts import system_prompt, user_prompt
from agent_service.brain.race import MILESTONES, RaceState
from agent_service.llm.decide import decide_safely
from agent_service.llm.providers import build_llm_provider
from agent_service.settings import Settings

ATTEMPT = "019fb100-0000-7000-8000-00000000c000"
RED_1, RED_2, RED_3 = "red-1", "red-2", "red-3"
BLUE_1, BLUE_2, BLUE_3 = "blue-1", "blue-2", "blue-3"
NAMES = {RED_1: "Elara", RED_2: "Bram", RED_3: "Wren", BLUE_1: "Ansel", BLUE_2: "Petra", BLUE_3: "Fen"}

# The real racer persona (so the system prompt matches a live tick, not a stub).
_SEED = json.loads((Path(__file__).parent.parent / "seed" / "villagers.json").read_text())
_ELARA = next((v for v in _SEED if v.get("name") == "Elara"), {})
STARTED = {
    "attemptId": ATTEMPT,
    "label": "replay",
    "difficulty": "easy",
    "teams": [
        {"teamId": "red", "villagerIds": [RED_1, RED_2, RED_3]},
        {"teamId": "blue", "villagerIds": [BLUE_1, BLUE_2, BLUE_3]},
    ],
}

# Each rung = (milestones red has already crossed, the pack it carries). The
# pack is deliberately sufficient to cross the NEXT rung — so a move/hunt/chat
# decision is a discipline failure, not a resource-starved bot doing its best.
RUNGS = {
    "bare": ([], []),  # wood bootstrap: nothing carried, should craft toward wooden_pickaxe
    # The 2026-07-18 drill defect, frozen as a rung: Elara held 6 logs' worth of
    # wood, coal was tool-gated, and the brain crafted planks FOUR times without
    # ever chaining to sticks → crafting_table → wooden_pickaxe. At this pack the
    # only good decisions are craft sticks / craft crafting_table / craft
    # wooden_pickaxe — craft planks (16 carried!) or gather wood is the thrash.
    "chain": ([], [{"item": "oak_planks", "count": 16}, {"item": "oak_log", "count": 2}]),
    "coal": ([], [{"item": "wooden_pickaxe", "count": 1}]),  # has a pickaxe, no ore yet — should gather coal, not re-tool
    # Drill №2's thrash, frozen: wooden pick + banked cobble/sticks, iron
    # tool-gated. Only good decision: craft stone_pickaxe (live brain crafted a
    # stone_AXE and looped gather stone / fail iron for minutes).
    "stonechain": (["first_coal"], [{"item": "wooden_pickaxe", "count": 1}, {"item": "cobblestone", "count": 8}, {"item": "oak_planks", "count": 7}, {"item": "stick", "count": 2}]),
    "iron": (["first_coal"], [{"item": "stone_pickaxe", "count": 1}]),
    "furnace": (["first_coal", "first_iron_ore"], [{"item": "iron_ore", "count": 3}, {"item": "coal", "count": 2}, {"item": "cobblestone", "count": 8}]),
    "ingot": (["first_coal", "first_iron_ore", "furnace_placed"], [{"item": "iron_ore", "count": 3}, {"item": "coal", "count": 2}, {"item": "furnace", "count": 1}]),
    # Drill №3's beaching, frozen: raw iron + planks carried, ZERO sticks (both
    # pickaxe crafts spent them). Only good decision: craft sticks — the win
    # craft is unreachable without them and the arena has nothing left to gather.
    "smeltstuck": (["first_coal", "first_iron_ore", "furnace_placed"], [{"item": "raw_iron", "count": 3}, {"item": "oak_planks", "count": 7}, {"item": "cobblestone", "count": 5}]),
    "win": (["first_coal", "first_iron_ore", "furnace_placed", "first_ingot"], [{"item": "iron_ingot", "count": 3}, {"item": "stick", "count": 2}, {"item": "crafting_table", "count": 1}]),
}


def _snapshot(inventory: list[dict]) -> dict:
    return {
        "position": {"x": -150, "y": 72, "z": 0},
        "health": 20,
        "food": 18,  # above the ≤10 hunger tier — a fed racer, so hunger never explains a hunt
        "timeOfDay": 1000,  # day
        "nearbyVillagers": [],
        "inventory": inventory,
    }


def _state(crossed: list[str]) -> RaceState:
    state = RaceState()
    state.attempt_started(STARTED, lambda v: NAMES.get(v, v))
    for m in crossed:
        state.milestone({"attemptId": ATTEMPT, "teamId": "red", "villagerId": RED_1, "milestone": m, "detail": None})
    return state


async def _one(provider, system: str, user: str):
    outcome = await decide_safely(provider, system, user)
    d = outcome.decision
    return {
        "action": d.action,
        "params": d.params,
        "reasoning": (d.reasoning or "")[:100],
        "error": outcome.error,
        "latency": outcome.latency_seconds,
    }


async def replay_rung(provider, rung: str, n: int) -> None:
    crossed, inventory = RUNGS[rung]
    state = _state(crossed)
    system = system_prompt("Elara", _ELARA.get("personality", {}), _ELARA.get("backstory"))
    user = user_prompt(_snapshot(inventory), [], [], race=state.snapshot(RED_1))

    results = await asyncio.gather(*[_one(provider, system, user) for _ in range(n)])

    next_rung = next((m for m in MILESTONES if m not in crossed), "iron_pickaxe (WIN)")
    verbs = Counter(r["action"] for r in results)
    errors = sum(1 for r in results if r["error"])
    mean_latency = sum(r["latency"] for r in results) / max(1, len(results))

    print(f"\n═══ rung '{rung}' — crossed {crossed or '[]'} · next: {next_rung} ═══")
    print(f"pack: {', '.join(f'{i['count']} {i['item']}' for i in inventory) or 'empty'}")
    print(f"{n} decisions · mean latency {mean_latency:.2f}s · {errors} malformed/idle-fallback")
    for verb, count in verbs.most_common():
        bar = "█" * count
        print(f"  {verb:<10} {count:>3}  {bar}")
    # A few concrete decisions so params/reasoning are inspectable, not just counts.
    print("  samples:")
    for r in results[:4]:
        print(f"    {r['action']} {json.dumps(r['params'])}  — {r['reasoning']}")


async def main() -> None:
    parser = argparse.ArgumentParser(description="Offline race-brain decision replay against real Ollama.")
    parser.add_argument("--rung", default="bare", help=f"one of {list(RUNGS)} or 'all'")
    parser.add_argument("--n", type=int, default=20, help="decisions to sample per rung")
    parser.add_argument("--model", default=None, help="override Ollama model (default: settings/env)")
    parser.add_argument("--base-url", default="http://localhost:11434", help="Ollama base URL (host, not container)")
    args = parser.parse_args()

    rungs = list(RUNGS) if args.rung == "all" else [args.rung]
    for r in rungs:
        if r not in RUNGS:
            raise SystemExit(f"unknown rung '{r}' — choose from {list(RUNGS)} or 'all'")

    overrides = {"llm_provider": "ollama", "ollama_base_url": args.base_url}
    if args.model:
        overrides["llm_model_ollama"] = args.model
    settings = Settings(**overrides)

    async with httpx.AsyncClient() as client:
        provider = await build_llm_provider(settings, client)
        print(f"replay: provider={settings.llm_provider} model={settings.llm_model_ollama} @ {args.base_url} · n={args.n}")
        for r in rungs:
            await replay_rung(provider, r, args.n)


if __name__ == "__main__":
    asyncio.run(main())
