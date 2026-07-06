"""HTTP client for memory-service — same shape as the old in-process module
(store/search/reflect), so the brain's TickDeps wiring didn't change when the
network boundary appeared (Sprint 2 extraction)."""

import uuid
from dataclasses import dataclass
from datetime import datetime

import httpx


@dataclass(frozen=True)
class MemoryRecord:
    id: uuid.UUID
    villager_id: uuid.UUID
    memory_type: str
    content: str
    importance: float
    sentiment: float
    occurred_at: datetime
    embedding_model: str


@dataclass(frozen=True)
class RetrievedMemory:
    record: MemoryRecord
    relevance: float
    recency: float
    score: float


@dataclass(frozen=True)
class RetrievalWeights:
    recency: float = 1.0
    importance: float = 1.0
    relevance: float = 1.0


def _record(data: dict) -> MemoryRecord:
    return MemoryRecord(
        id=uuid.UUID(data["id"]),
        villager_id=uuid.UUID(data["villagerId"]),
        memory_type=data["memoryType"],
        content=data["content"],
        importance=data["importance"],
        sentiment=data["sentiment"],
        occurred_at=datetime.fromisoformat(data["occurredAt"]),
        embedding_model=data["embeddingModel"],
    )


class MemoryClient:
    def __init__(self, base_url: str, client: httpx.AsyncClient):
        self._base = base_url.rstrip("/")
        self._client = client

    async def store(
        self,
        villager_id: uuid.UUID,
        content: str,
        memory_type: str = "observation",
        occurred_at: datetime | None = None,
        importance: float | None = None,
        sentiment: float | None = None,
        source_event_id: uuid.UUID | None = None,
        source_memory_ids: list[uuid.UUID] | None = None,
    ) -> MemoryRecord:
        response = await self._client.post(
            f"{self._base}/memories",
            json={
                "villagerId": str(villager_id),
                "content": content,
                "memoryType": memory_type,
                "occurredAt": occurred_at.isoformat() if occurred_at else None,
                "importance": importance,
                "sentiment": sentiment,
                "sourceEventId": str(source_event_id) if source_event_id else None,
                "sourceMemoryIds": [str(m) for m in source_memory_ids] if source_memory_ids else None,
            },
            timeout=15.0,
        )
        response.raise_for_status()
        return _record(response.json())

    async def search(
        self,
        villager_id: uuid.UUID,
        query: str,
        k: int = 10,
        weights: RetrievalWeights | None = None,
    ) -> list[RetrievedMemory]:
        body: dict = {"query": query, "k": k}
        if weights:
            body["weights"] = {
                "recency": weights.recency,
                "importance": weights.importance,
                "relevance": weights.relevance,
            }
        response = await self._client.post(
            f"{self._base}/villagers/{villager_id}/memories/search", json=body, timeout=15.0
        )
        response.raise_for_status()
        return [
            RetrievedMemory(
                record=_record(item["record"]),
                relevance=item["relevance"],
                recency=item["recency"],
                score=item["score"],
            )
            for item in response.json()["results"]
        ]

    async def reflect(self, villager_id: uuid.UUID):
        response = await self._client.post(f"{self._base}/villagers/{villager_id}/reflections", timeout=60.0)
        if response.status_code == 501:
            raise NotImplementedError("reflection ships in M1")
        response.raise_for_status()
        return response.json()
