"""memories table — the append-mostly memory stream (docs/architecture/02-database.md)

Revision ID: 0001
Revises:
Create Date: 2026-07-02
"""

from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    # No-op when the compose init script already created it (checks existence
    # first, so no superuser needed); fails fast on a DB where nobody did.
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")

    op.execute(
        """
        CREATE TABLE memories (
            id                uuid        PRIMARY KEY,      -- UUIDv7, app-generated
            villager_id       uuid        NOT NULL,         -- logical ref to agent_db.villagers: NO cross-DB FK
            memory_type       text        NOT NULL
                              CHECK (memory_type IN ('observation', 'conversation', 'action', 'reflection')),
            content           text        NOT NULL,
            importance_score  real        NOT NULL CHECK (importance_score BETWEEN 0 AND 10),
            sentiment_score   real        NOT NULL DEFAULT 0 CHECK (sentiment_score BETWEEN -1 AND 1),
            embedding         vector(768) NOT NULL,
            embedding_model   text        NOT NULL,         -- 'text-embedding-3-small@768' | 'nomic-embed-text' | 'fake'
            source_event_id   uuid,                         -- causation link into the event store (logical ref)
            source_memory_ids uuid[],                       -- reflections: which memories were distilled
            occurred_at       timestamptz NOT NULL,
            created_at        timestamptz NOT NULL DEFAULT now(),
            last_accessed_at  timestamptz NOT NULL DEFAULT now(),  -- recency term; access metadata is the
            access_count      integer     NOT NULL DEFAULT 0,      --   one mutable part of a memory
            CONSTRAINT memories_reflection_provenance
                -- NULL-proof: CHECKs pass on NULL (three-valued logic), so the
                -- reflection branch must assert IS NOT NULL explicitly.
                CHECK (
                    (memory_type <> 'reflection' AND source_memory_ids IS NULL)
                    OR
                    (memory_type = 'reflection' AND source_memory_ids IS NOT NULL
                     AND array_length(source_memory_ids, 1) >= 1)
                )
        )
        """
    )

    # Recency scans + reflection triggers ("sum of importance since last reflection").
    op.execute("CREATE INDEX idx_memories_villager_time ON memories (villager_id, occurred_at DESC)")

    # ANN index for the relevance term (recency x importance x relevance).
    op.execute(
        """
        CREATE INDEX idx_memories_embedding_hnsw
            ON memories USING hnsw (embedding vector_cosine_ops)
            WITH (m = 16, ef_construction = 64)
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE memories")
