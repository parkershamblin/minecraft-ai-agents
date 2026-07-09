"""Action awareness — remember each villager's previous decision so the next
tick's prompt can pair it with its observed outcome (Project Sid's #1
progression lever: agents that don't know what they just did repeat it).

Deliberately in-memory: a restart forgets, and that's fine — the ledger and
memory stream carry the durable record; this is working memory, not truth.
"""

import uuid
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class LastDecision:
    action: str
    params: dict[str, Any]


class ActionAwareness:
    def __init__(self) -> None:
        self._last: dict[uuid.UUID, LastDecision] = {}

    def remember(self, villager_id: uuid.UUID, action: str, params: dict[str, Any]) -> None:
        self._last[villager_id] = LastDecision(action=action, params=params)

    def recall(self, villager_id: uuid.UUID) -> LastDecision | None:
        return self._last.get(villager_id)

    def forget(self, villager_id: uuid.UUID) -> None:
        self._last.pop(villager_id, None)
