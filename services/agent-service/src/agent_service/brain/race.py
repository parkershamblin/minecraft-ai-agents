"""In-memory race state (RB-2) — the village's working memory of the
Red-vs-Blue attempt: the roster, which T1 ladder milestones each team has
crossed, and nothing else. The ledger (AttemptStarted/ProgressionMilestone/
AttemptEnded, minecraft-service's milestone mapper) is the durable record and
the authority on 'first'; this cache only feeds prompts.

The civics precedent applies verbatim: single-writer (the percept consumer
task), many readers (tick tasks), no awaits inside mutations — no locking.
Known limitation, accepted: an agent-service restart mid-attempt forgets the
race (offsets are committed, so the news never replays) — the race keeps
running in the world and the ledger; only the prompts go quiet. RB-2's
harness starts attempts while agent-service is up.
"""

from dataclasses import dataclass

# The T1 ladder in canonical order — the contract's milestone enum, verbatim.
MILESTONES = ("first_coal", "first_iron_ore", "furnace_placed", "first_ingot", "iron_pickaxe")


@dataclass(frozen=True)
class TeamEntry:
    team_id: str
    members: tuple[tuple[str, str], ...]  # (villagerId, name)


@dataclass(frozen=True)
class RaceView:
    """One villager's read of the race, ready for the prompt."""

    attempt_id: str
    your_team: str
    # teammate names, self excluded — the prompt says "you and Petra, Fen"
    teammates: tuple[str, ...]
    your_milestones: frozenset[str]
    # (teamId, crossed milestones) for every OTHER team
    rivals: tuple[tuple[str, frozenset[str]], ...]


@dataclass
class RaceState:
    _attempt_id: str | None = None
    _teams: tuple[TeamEntry, ...] = ()
    _crossed: dict[str, set[str]] | None = None  # teamId -> milestones
    _team_of: dict[str, str] | None = None  # villagerId -> teamId

    # --------------------------------------------------------- observers

    def attempt_started(self, payload: dict, name_of) -> None:
        try:
            teams = tuple(
                TeamEntry(
                    team_id=str(team["teamId"]),
                    members=tuple((str(v), name_of(str(v))) for v in team["villagerIds"]),
                )
                for team in payload["teams"]
            )
            attempt_id = str(payload["attemptId"])
        except (KeyError, TypeError):
            return  # malformed news is not a reason to crash the consumer
        self._attempt_id = attempt_id
        self._teams = teams
        self._crossed = {team.team_id: set() for team in teams}
        self._team_of = {v: team.team_id for team in teams for v, _ in team.members}

    def milestone(self, payload: dict) -> None:
        if self._attempt_id is None or str(payload.get("attemptId")) != self._attempt_id:
            return
        team_id = str(payload.get("teamId"))
        milestone = str(payload.get("milestone"))
        if self._crossed is not None and team_id in self._crossed and milestone in MILESTONES:
            self._crossed[team_id].add(milestone)

    def attempt_ended(self, payload: dict) -> None:
        if self._attempt_id is None or str(payload.get("attemptId")) != self._attempt_id:
            return
        self._attempt_id = None
        self._teams = ()
        self._crossed = None
        self._team_of = None

    # ----------------------------------------------------------- readers

    def team_of(self, villager_id: str) -> str | None:
        return (self._team_of or {}).get(str(villager_id))

    def participant_ids(self) -> tuple[str, ...]:
        return tuple((self._team_of or {}).keys())

    def snapshot(self, villager_id: str) -> RaceView | None:
        """None when no attempt runs or the villager isn't on a roster —
        spectators get no race section, deliberately."""
        if self._attempt_id is None or self._crossed is None:
            return None
        your_team = self.team_of(villager_id)
        if your_team is None:
            return None
        teammates = tuple(
            name
            for team in self._teams
            if team.team_id == your_team
            for v, name in team.members
            if v != str(villager_id)
        )
        rivals = tuple(
            (team.team_id, frozenset(self._crossed[team.team_id]))
            for team in self._teams
            if team.team_id != your_team
        )
        return RaceView(
            attempt_id=self._attempt_id,
            your_team=your_team,
            teammates=teammates,
            your_milestones=frozenset(self._crossed[your_team]),
            rivals=rivals,
        )
