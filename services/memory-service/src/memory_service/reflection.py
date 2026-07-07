"""The reflection mechanism (generative agents): when enough importance has
accumulated since a villager's last reflection, distill the unreflected
memories into 1-3 higher-level insights stored as provenance-linked
reflection memories. The LLM call itself lives behind llm.py; this module
owns the trigger arithmetic, the prompt, output parsing, the hourly cap,
and the background job."""

import asyncio
import json
import uuid
from collections.abc import Callable
from datetime import UTC, datetime

import jsonschema
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import async_sessionmaker

from memory_service.llm import REFLECTION_SCHEMA
from memory_service.logging import logger
from memory_service.models import Memory
from memory_service.settings import Settings


class ReflectionUnavailable(RuntimeError):
    """No real LLM is armed (chain landed on nothing, or reflections are off)."""


REFLECTION_SYSTEM_PROMPT = (
    "You are the inner voice of a villager thinking back over recent days. "
    "You will receive the villager's recent memories as a numbered list, oldest "
    "first. Distill them into 1-3 higher-level insights — realizations about "
    "people, places, habits, or dangers that the individual memories only hint "
    "at. Write each insight in the first person, one or two sentences, concrete "
    "and specific. For each insight, cite the numbers of the memories it draws on."
)


def build_reflection_prompt(contents: list[str]) -> str:
    lines = [f"{i}. {content}" for i, content in enumerate(contents, start=1)]
    return "My recent memories:\n" + "\n".join(lines) + "\n\nWhat do these add up to?"


def parse_insights(text: str, candidate_ids: list[uuid.UUID]) -> list[tuple[str, list[uuid.UUID]]]:
    """Tolerant reader for the summarizer's output: schema-validate, then map
    1-based sourceIndices onto the candidate memory ids. Out-of-range indices
    are dropped; an insight whose citations don't survive is dropped whole
    (the memories_reflection_provenance CHECK would reject it anyway)."""
    try:
        body = json.loads(text)
        jsonschema.validate(body, REFLECTION_SCHEMA)
    except (json.JSONDecodeError, jsonschema.ValidationError):
        return []

    insights: list[tuple[str, list[uuid.UUID]]] = []
    for item in body["insights"]:
        content = item["insight"].strip()
        # dict.fromkeys: dedupe while keeping the model's citation order
        ids = [candidate_ids[i - 1] for i in dict.fromkeys(item["sourceIndices"]) if 1 <= i <= len(candidate_ids)]
        if content and ids:
            insights.append((content, ids))
    return insights


class HourlyCap:
    """Global fixed-window cap (UTC hour) on reflection LLM runs — bounds GPU
    load on the Ollama path no matter how many villagers build up pressure."""

    def __init__(self, per_hour: int, clock: Callable[[], datetime] = lambda: datetime.now(UTC)):
        self._per_hour = per_hour
        self._clock = clock
        self._hour = self._current_hour()
        self._count = 0

    def _current_hour(self) -> datetime:
        return self._clock().replace(minute=0, second=0, microsecond=0)

    def try_acquire(self) -> bool:
        hour = self._current_hour()
        if hour != self._hour:
            self._hour = hour
            self._count = 0
        if self._count >= self._per_hour:
            return False
        self._count += 1
        return True


async def villagers_due_for_reflection(
    session_factory: async_sessionmaker, threshold: float
) -> list[tuple[uuid.UUID, float]]:
    """Villagers whose unreflected importance has piled past the threshold:
    SUM(importance) of non-reflection memories created since the villager's
    last reflection. Reflections themselves are excluded from the pressure —
    they floor at importance 7, so counting them would let reflections beget
    reflections."""
    last_reflection = (
        select(Memory.villager_id, func.max(Memory.created_at).label("last_at"))
        .where(Memory.memory_type == "reflection")
        .group_by(Memory.villager_id)
        .subquery()
    )
    query = (
        select(Memory.villager_id, func.sum(Memory.importance_score).label("pressure"))
        .outerjoin(last_reflection, last_reflection.c.villager_id == Memory.villager_id)
        .where(Memory.memory_type != "reflection")
        .where(or_(last_reflection.c.last_at.is_(None), Memory.created_at > last_reflection.c.last_at))
        .group_by(Memory.villager_id)
        .having(func.sum(Memory.importance_score) > threshold)
    )
    async with session_factory() as session:
        rows = (await session.execute(query)).all()
    return [(row.villager_id, float(row.pressure)) for row in rows]


class ReflectionJob:
    """Background trigger loop: every interval, every villager over the
    pressure threshold gets one reflection pass. Sequential on purpose — the
    hourly cap and budget breaker inside reflect() are the load governors,
    not this loop."""

    def __init__(self, service, session_factory: async_sessionmaker, settings: Settings):
        self._service = service
        self._sessions = session_factory
        self._settings = settings
        self._task: asyncio.Task | None = None

    def start(self) -> None:
        self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)

    async def _run(self) -> None:
        while True:
            await asyncio.sleep(self._settings.reflection_interval_seconds)
            try:
                due = await villagers_due_for_reflection(
                    self._sessions, self._settings.reflection_importance_threshold
                )
                for villager_id, pressure in due:
                    logger.info(
                        "reflection triggered", villager_id=str(villager_id), pressure=round(pressure, 1)
                    )
                    await self._service.reflect(villager_id)
            except Exception as exc:  # noqa: BLE001 — the job must outlive any single pass
                logger.error("reflection pass failed", error=str(exc))
