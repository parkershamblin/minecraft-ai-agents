"""The feedback loop: a world.events + government.events consumer (group
agent-service.perception) that turns facts into percepts on Redis lists.

M1-1: ChatObserved fans out one percept per hearer (speaker excluded — the
echo-loop guard again), carrying the source envelope's eventId+correlationId —
the identity thread that makes conversation chains ledger-traceable. A chat
percept may also request a reactive tick via the scheduler hook (M1-2).

M2-8: the government.events leg. Election news (ElectionStarted,
CandidateNominated, ElectionDecided) BROADCASTS to every villager in the
injected roster; GovernanceRejected goes only to its actor (the teaching
loop); VoteCast updates the civic cache ONLY — no percept, deliberately: 20
villagers x 20 votes would evict the chat drama from the 20-cap queues, and
ballots should influence through results, not herd signals. Civic events
never request reactive ticks (an ElectionStarted waking 20 minds at once is
a GPU stampede; the scheduled cadence carries the news within a tick).
Cache ingestion is CONTENT-gated and happens even for stale deliveries —
see brain/civics.py; the percept fanout stays behind the freshness guard
(ruling 7).

Hazard percepts (powder snow): HazardEncountered goes only to the villager
whose body met the hazard. The trapped phase also requests a reactive tick —
being buried in freezing snow should interrupt a train of thought; escaped
and escape_failed just queue for the next scheduled turn.
"""

import asyncio
import json
from datetime import UTC, datetime
from typing import Callable

import redis.asyncio as aioredis
from aiokafka import AIOKafkaConsumer

from agent_service.logging import logger

_ACTION_TYPES = {"ActionCompleted", "ActionFailed"}
_CIVIC_TYPES = {
    "ElectionStarted",
    "CandidateNominated",
    "VoteCast",
    "ElectionDecided",
    "GovernanceRejected",
}
_QUEUE_CAP = 20
_QUEUE_TTL_SECONDS = 600
# Committed group offsets survive restarts, so a redeploy drains the backlog —
# without this guard, days-old chat replays as fresh percepts (observed live:
# Elara 'heard' a Wren line from a previous session).
_MAX_PERCEPT_AGE_SECONDS = 600


def _is_stale(occurred_at: str | None) -> bool:
    if not occurred_at:
        return False
    try:
        occurred = datetime.fromisoformat(occurred_at.replace("Z", "+00:00"))
    except ValueError:
        return False
    return (datetime.now(UTC) - occurred).total_seconds() > _MAX_PERCEPT_AGE_SECONDS


class PerceptConsumer:
    def __init__(self, brokers: str, redis: aioredis.Redis):
        self._consumer = AIOKafkaConsumer(
            "world.events",
            "government.events",
            bootstrap_servers=brokers,
            group_id="agent-service.perception",
            auto_offset_reset="latest",  # stale outcomes are not fresh percepts
            enable_auto_commit=True,
        )
        self._redis = redis
        self._task: asyncio.Task | None = None
        # Set after scheduler construction (main.py): (villager_id, cause_event_id) -> bool.
        self.on_chat_percept: Callable[[str, str], bool] | None = None
        # M2-8 injections (main.py, refreshed on seed): the civic cache and the
        # broadcast roster — villagerId -> name, doubling as the fanout target
        # list and the name resolver for candidate/mayor percepts.
        self.civics = None  # CivicState-shaped: election_started(payload), ...
        self.roster: dict[str, str] = {}

    async def start(self) -> None:
        await self._consumer.start()
        self._task = asyncio.create_task(self._run(), name="percept-consumer")
        logger.info("percept consumer running", group="agent-service.perception")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
        await self._consumer.stop()

    async def _run(self) -> None:
        async for message in self._consumer:
            try:
                envelope = json.loads(message.value)
            except json.JSONDecodeError:
                continue
            await self.handle(envelope)

    async def handle(self, envelope: dict) -> None:
        """One envelope -> zero or more percepts. Extracted from the Kafka
        loop so the fanout rules are unit-testable."""
        event_type = envelope.get("eventType")
        payload = envelope.get("payload", {})

        if event_type in _CIVIC_TYPES:
            # Cache BEFORE the staleness gate: a late-delivered election is
            # still a live institution if its own clock says so (content
            # gating lives in CivicState). Percepts stay delivery-fresh.
            self._ingest_civic(event_type, payload)
            if _is_stale(envelope.get("occurredAt")):
                return
            await self._fanout_civic(event_type, envelope, payload)
            return

        if _is_stale(envelope.get("occurredAt")):
            return  # backlog drain after a redeploy — history is not perception

        if event_type in _ACTION_TYPES:
            villager_id = payload.get("villagerId")
            if not villager_id:
                return
            await self._push(
                villager_id,
                {
                    "type": event_type,
                    "action": payload.get("action"),
                    "detail": payload.get("result")
                    or {"errorCode": payload.get("errorCode"), "errorMessage": payload.get("errorMessage")},
                    "sourceEventId": envelope.get("eventId"),
                    "correlationId": envelope.get("correlationId"),
                    "occurredAt": envelope.get("occurredAt"),
                },
            )

        elif event_type == "HazardEncountered":
            villager_id = payload.get("villagerId")
            if not villager_id:
                return
            await self._push(
                villager_id,
                {
                    "type": "HazardEncountered",
                    "hazardType": payload.get("hazardType"),
                    "phase": payload.get("phase"),
                    "position": payload.get("position"),
                    "detail": payload.get("detail"),
                    "sourceEventId": envelope.get("eventId"),
                    "correlationId": envelope.get("correlationId"),
                    "occurredAt": envelope.get("occurredAt"),
                },
            )
            if payload.get("phase") == "trapped" and self.on_chat_percept:
                # The generic wake lever (named for its first caller): a body
                # sinking in freezing snow must not wait for the cadence.
                self.on_chat_percept(villager_id, envelope.get("eventId"))

        elif event_type == "ChatObserved":
            speaker_id = payload.get("villagerId")  # null when a player spoke
            percept = {
                "type": "ChatObserved",
                "speakerName": payload.get("speakerUsername"),
                "speakerVillagerId": speaker_id,
                "message": payload.get("message"),
                "sourceEventId": envelope.get("eventId"),
                "correlationId": envelope.get("correlationId"),
                "occurredAt": envelope.get("occurredAt"),
            }
            for hearer_id in payload.get("heardByIds", []):
                if hearer_id == speaker_id:
                    continue  # a villager never perceives their own utterance
                await self._push(hearer_id, percept)
                if self.on_chat_percept:
                    self.on_chat_percept(hearer_id, envelope.get("eventId"))

    # ------------------------------------------------------------ M2-8 civic

    def _name(self, villager_id: str | None) -> str:
        if not villager_id:
            return "someone"
        return self.roster.get(str(villager_id)) or f"villager {str(villager_id)[:8]}"

    def _ingest_civic(self, event_type: str, payload: dict) -> None:
        if self.civics is None:
            return
        if event_type == "ElectionStarted":
            self.civics.election_started(payload)
        elif event_type == "CandidateNominated":
            self.civics.candidate_nominated(payload, self._name(payload.get("villagerId")))
        elif event_type == "VoteCast":
            self.civics.vote_cast(payload)
        elif event_type == "ElectionDecided":
            self.civics.election_decided(payload, self._name(payload.get("winnerVillagerId")))
        # GovernanceRejected carries no institutional state — percept only.

    async def _fanout_civic(self, event_type: str, envelope: dict, payload: dict) -> None:
        thread = {
            "sourceEventId": envelope.get("eventId"),
            "correlationId": envelope.get("correlationId"),
            "occurredAt": envelope.get("occurredAt"),
        }

        if event_type == "GovernanceRejected":
            # Private teaching, not village news: only the actor perceives it.
            villager_id = payload.get("villagerId")
            if villager_id:
                await self._push(
                    str(villager_id),
                    {
                        "type": "GovernanceRejected",
                        "action": payload.get("action"),
                        "errorCode": payload.get("errorCode"),
                        "message": payload.get("message"),
                        **thread,
                    },
                )
            return

        if event_type == "VoteCast":
            return  # cache-only, deliberately (module docstring)

        if event_type == "ElectionStarted":
            percept = {
                "type": "ElectionStarted",
                "office": payload.get("office", "mayor"),
                **thread,
            }
            for villager_id in self.roster:
                await self._push(villager_id, percept)

        elif event_type == "CandidateNominated":
            candidate_id = str(payload.get("villagerId"))
            base = {
                "type": "CandidateNominated",
                "candidateVillagerId": candidate_id,
                "candidateName": self._name(candidate_id),
                "platform": payload.get("platform"),
                **thread,
            }
            for villager_id in self.roster:
                # Personalized at fanout — prompts have no self-id to compare.
                await self._push(villager_id, {**base, "you": villager_id == candidate_id})

        elif event_type == "ElectionDecided":
            winner_id = str(payload.get("winnerVillagerId"))
            base = {
                "type": "ElectionDecided",
                "winnerVillagerId": winner_id,
                "winnerName": self._name(winner_id),
                **thread,
            }
            for villager_id in self.roster:
                await self._push(villager_id, {**base, "you": villager_id == winner_id})

    async def _push(self, villager_id: str, percept: dict) -> None:
        key = f"percepts:{villager_id}"
        async with self._redis.pipeline(transaction=True) as pipe:
            pipe.rpush(key, json.dumps(percept))
            pipe.ltrim(key, -_QUEUE_CAP, -1)
            pipe.expire(key, _QUEUE_TTL_SECONDS)
            await pipe.execute()
