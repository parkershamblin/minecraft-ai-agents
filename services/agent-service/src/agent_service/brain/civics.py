"""In-memory civic state — what the village currently knows about its
government: the running election (phase, candidates, deadlines), who has
already voted or declared, and the seated mayor.

Deliberately in-memory (the M2-3 awareness precedent): the ledger and
government_db are the durable record; this is the village's working memory.
Known limitation, accepted: an agent-service restart mid-election forgets it
(consumer offsets are committed, so the news never replays) — open elections
while agent-service is up. The standing mayor line survives restarts one
election late (the next ElectionDecided reseats it).

Ingestion is CONTENT-gated, not delivery-gated: an ElectionStarted that
arrives 15 minutes late still describes a live election if its endsAt is in
the future, so the cache accepts it even when the percept freshness guard
(ruling 7) rightly refuses to fan it out as "news". Percepts age by delivery;
institutions age by their own clocks.
"""

from dataclasses import dataclass, replace
from datetime import UTC, datetime

# An election whose ends_at passed this long ago without an ElectionDecided
# is treated as annulled and forgotten. There is deliberately no
# ElectionAnnulled event in the contracts — silence IS the annulment signal.
_DECIDE_GRACE_SECONDS = 300.0


def _parse(iso: str) -> datetime:
    return datetime.fromisoformat(iso.replace("Z", "+00:00"))


def _now() -> datetime:
    return datetime.now(UTC)


@dataclass(frozen=True)
class CandidateEntry:
    villager_id: str
    name: str
    platform: str | None


@dataclass(frozen=True)
class Mayor:
    villager_id: str
    name: str


@dataclass(frozen=True)
class ElectionCampaign:
    election_id: str
    office: str
    starts_at: datetime
    nominating_ends_at: datetime
    ends_at: datetime
    candidates: tuple[CandidateEntry, ...] = ()
    voters: frozenset[str] = frozenset()

    def phase(self, now: datetime) -> str:
        """Advisory clock math for prompt gating — government-service is the
        authority; a request racing a boundary earns an honest
        GovernanceRejected percept, which is itself teaching material."""
        if now < self.starts_at:
            return "scheduled"
        if now < self.nominating_ends_at:
            return "nominating"
        if now < self.ends_at:
            return "voting"
        return "closed"


@dataclass(frozen=True)
class CivicView:
    """One villager's read of village affairs, ready for the prompt."""

    campaign: ElectionCampaign | None
    phase: str | None  # scheduled | nominating | voting (closed -> campaign dropped)
    you_declared: bool
    you_voted: bool
    mayor: Mayor | None
    you_are_mayor: bool = False


@dataclass
class CivicState:
    _campaign: ElectionCampaign | None = None
    _mayor: Mayor | None = None
    # Single-writer (the percept consumer task), many readers (tick tasks) —
    # one asyncio loop, no awaits inside mutations: no locking needed.

    # --------------------------------------------------------- observers

    def election_started(self, payload: dict) -> None:
        try:
            campaign = ElectionCampaign(
                election_id=str(payload["electionId"]),
                office=str(payload.get("office", "mayor")),
                starts_at=_parse(payload["startsAt"]),
                nominating_ends_at=_parse(payload["nominatingEndsAt"]),
                ends_at=_parse(payload["endsAt"]),
            )
        except (KeyError, ValueError, TypeError):
            return  # malformed news is not a reason to crash the consumer
        if campaign.ends_at <= _now():
            return  # already over — backlog history, not a live institution
        self._campaign = campaign  # latest live election wins (one at a time)

    def candidate_nominated(self, payload: dict, name: str) -> None:
        campaign = self._campaign
        if campaign is None or str(payload.get("electionId")) != campaign.election_id:
            return
        villager_id = str(payload.get("villagerId"))
        if any(c.villager_id == villager_id for c in campaign.candidates):
            return  # idempotent under redelivery
        entry = CandidateEntry(
            villager_id=villager_id, name=name, platform=payload.get("platform")
        )
        self._campaign = replace(campaign, candidates=campaign.candidates + (entry,))

    def vote_cast(self, payload: dict) -> None:
        campaign = self._campaign
        if campaign is None or str(payload.get("electionId")) != campaign.election_id:
            return
        self._campaign = replace(
            campaign, voters=campaign.voters | {str(payload.get("voterId"))}
        )

    def election_decided(self, payload: dict, winner_name: str) -> None:
        # Seat the mayor even when the campaign is unknown (a restart may have
        # forgotten it) — the standing line matters more than the arc's state.
        self._mayor = Mayor(
            villager_id=str(payload.get("winnerVillagerId")), name=winner_name
        )
        campaign = self._campaign
        if campaign is not None and str(payload.get("electionId")) == campaign.election_id:
            self._campaign = None  # the arc is over; the mayor line remains

    # ----------------------------------------------------------- readers

    def snapshot(self, villager_id: str) -> CivicView | None:
        now = _now()
        campaign = self._campaign
        if campaign is not None and campaign.phase(now) == "closed":
            if (now - campaign.ends_at).total_seconds() > _DECIDE_GRACE_SECONDS:
                self._campaign = None  # no ElectionDecided came: annulled, forgotten
            campaign = None  # closed-but-in-grace renders nothing either way
        if campaign is None and self._mayor is None:
            return None
        return CivicView(
            campaign=campaign,
            phase=campaign.phase(now) if campaign else None,
            you_declared=any(c.villager_id == villager_id for c in campaign.candidates)
            if campaign
            else False,
            you_voted=villager_id in campaign.voters if campaign else False,
            mayor=self._mayor,
            you_are_mayor=self._mayor is not None and self._mayor.villager_id == villager_id,
        )
