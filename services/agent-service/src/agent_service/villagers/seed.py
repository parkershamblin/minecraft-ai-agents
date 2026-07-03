"""The seed flow: villagers.json -> agent_db rows -> VillagerCreated facts ->
spawn commands. Idempotent: existing villagers are skipped (and the executor's
spawn is itself a no-op for active bots)."""

import json
import uuid
from pathlib import Path
from typing import Any

from uuid6 import uuid7

from agent_service.events.envelope import TOPIC_AGENT, TOPIC_COMMANDS, build_envelope
from agent_service.kafka.producer import EventPublisher
from agent_service.logging import logger
from agent_service.villagers.repo import VillagerRepo


def find_seed_file(start: Path | None = None) -> Path:
    current = (start or Path(__file__)).resolve()
    for parent in [current, *current.parents]:
        candidate = parent / "seed" / "villagers.json"
        if candidate.is_file():
            return candidate
    raise FileNotFoundError("seed/villagers.json not found")


async def seed_villagers(
    repo: VillagerRepo,
    publisher: EventPublisher,
    count: int,
) -> dict[str, list[str]]:
    personas: list[dict[str, Any]] = json.loads(find_seed_file().read_text(encoding="utf-8"))[:count]
    seeded, existing = [], []

    for persona in personas:
        villager_id = uuid.UUID(persona["id"])
        correlation = uuid7()
        created = await repo.insert_if_absent(
            villager_id=villager_id,
            name=persona["name"],
            minecraft_username=persona["minecraftUsername"],
            personality=persona["personality"],
            backstory=persona["backstory"],
        )
        if created:
            await publisher.publish(
                TOPIC_AGENT,
                build_envelope(
                    "VillagerCreated",
                    villager_id,
                    {
                        "villagerId": str(villager_id),
                        "name": persona["name"],
                        "personality": persona["personality"],
                        "backstory": persona["backstory"],
                    },
                    correlation_id=correlation,
                ),
            )
            seeded.append(persona["name"])
        else:
            existing.append(persona["name"])

        # Spawn regardless — the executor treats an active session as a no-op,
        # so seeding after a restart re-embodies existing villagers.
        command_id = uuid7()
        await publisher.publish(
            TOPIC_COMMANDS,
            build_envelope(
                "ActionRequested",
                villager_id,
                {
                    "commandId": str(command_id),
                    "villagerId": str(villager_id),
                    "action": "spawn",
                    "params": {"minecraftUsername": persona["minecraftUsername"]},
                    "timeoutMs": 30_000,
                },
                correlation_id=correlation,
                event_id=command_id,
            ),
        )

    logger.info("seed complete", seeded=seeded, existing=existing)
    return {"seeded": seeded, "existing": existing}
