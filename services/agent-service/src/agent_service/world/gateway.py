"""Perception's read side: the WorldSnapshot contract at world:{villagerId}
(written by minecraft-service, schema in packages/events/schemas/state) and
the percept queues filled by the perception consumer."""

import json
import uuid
from typing import Any

import redis.asyncio as aioredis


class WorldGateway:
    def __init__(self, redis: aioredis.Redis):
        self._redis = redis

    async def snapshot(self, villager_id: uuid.UUID) -> dict[str, Any] | None:
        raw = await self._redis.get(f"world:{villager_id}")
        return json.loads(raw) if raw else None

    async def drain_percepts(self, villager_id: uuid.UUID, max_items: int = 10) -> list[dict[str, Any]]:
        raw_items = await self._redis.lpop(f"percepts:{villager_id}", max_items)
        if not raw_items:
            return []
        return [json.loads(item) for item in raw_items]
