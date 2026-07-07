"""relationships: last_reason / last_reason_at — the *why* behind an edge,
so a villager's prompt can say "trust 56 — heard Bram say: …" and the read
path (GET /villagers/{id}/relationships) surfaces the latest cause.

Revision ID: 0002
Revises: 0001
Create Date: 2026-07-07
"""

from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE relationships ADD COLUMN last_reason    text")
    op.execute("ALTER TABLE relationships ADD COLUMN last_reason_at timestamptz")


def downgrade() -> None:
    op.execute("ALTER TABLE relationships DROP COLUMN last_reason_at")
    op.execute("ALTER TABLE relationships DROP COLUMN last_reason")
