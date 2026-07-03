"""SQLAlchemy model mirroring the memories DDL (docs/architecture/02-database.md).

The schema itself is owned by the Alembic migration (raw SQL, checks and HNSW
included); this model is the query-side mapping.
"""

import uuid
from datetime import datetime

from pgvector.sqlalchemy import Vector
from sqlalchemy import ARRAY, REAL, DateTime, Integer, Text, Uuid
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class Memory(Base):
    __tablename__ = "memories"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True)
    villager_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    memory_type: Mapped[str] = mapped_column(Text, nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    importance_score: Mapped[float] = mapped_column(REAL, nullable=False)
    sentiment_score: Mapped[float] = mapped_column(REAL, nullable=False, default=0.0)
    embedding: Mapped[list[float]] = mapped_column(Vector(768), nullable=False)
    embedding_model: Mapped[str] = mapped_column(Text, nullable=False)
    source_event_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)
    source_memory_ids: Mapped[list[uuid.UUID] | None] = mapped_column(ARRAY(Uuid), nullable=True)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    last_accessed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    access_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
