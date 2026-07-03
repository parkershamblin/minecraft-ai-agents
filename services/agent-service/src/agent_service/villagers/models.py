"""agent_db mappings (schema owned by migrations_agent — raw SQL DDL)."""

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, Text, Uuid
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class AgentBase(DeclarativeBase):
    pass


class Villager(AgentBase):
    __tablename__ = "villagers"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    minecraft_username: Mapped[str] = mapped_column(Text, nullable=False)
    personality: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    backstory: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="alive")
    home_position: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
