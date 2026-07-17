"""reflection-scan index — villagers_due_for_reflection filters and joins on
(villager_id, memory_type, created_at), but 0001 only indexed
(villager_id, occurred_at DESC), so every trigger pass aggregated the whole
table.

Revision ID: 0002
Revises: 0001
Create Date: 2026-07-17
"""

from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "CREATE INDEX idx_memories_villager_type_created ON memories (villager_id, memory_type, created_at)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX idx_memories_villager_type_created")
