"""agent_db Phase-1 tables: villagers, villager_goals, relationships
(docs/architecture/02-database.md)

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
    op.execute(
        """
        CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
            NEW.updated_at := now();
            RETURN NEW;
        END $$
        """
    )

    op.execute(
        """
        CREATE TABLE villagers (
            id                 uuid        PRIMARY KEY,                 -- UUIDv7, app-generated
            name               text        NOT NULL UNIQUE,
            minecraft_username text        NOT NULL UNIQUE,             -- bot login name (online-mode=false)
            personality        jsonb       NOT NULL DEFAULT '{}'::jsonb
                               CHECK (jsonb_typeof(personality) = 'object'),
            backstory          text,
            status             text        NOT NULL DEFAULT 'alive'
                               CHECK (status IN ('alive', 'dead', 'despawned')),
            home_position      jsonb,
            created_at         timestamptz NOT NULL DEFAULT now(),
            updated_at         timestamptz NOT NULL DEFAULT now()
        )
        """
    )
    op.execute(
        """
        CREATE TRIGGER trg_villagers_updated_at
            BEFORE UPDATE ON villagers
            FOR EACH ROW EXECUTE FUNCTION set_updated_at()
        """
    )

    op.execute(
        """
        CREATE TABLE villager_goals (
            id             uuid        PRIMARY KEY,
            villager_id    uuid        NOT NULL REFERENCES villagers (id) ON DELETE CASCADE,
            parent_goal_id uuid        REFERENCES villager_goals (id) ON DELETE CASCADE,
            description    text        NOT NULL,
            goal_type      text        NOT NULL
                           CHECK (goal_type IN ('survival', 'social', 'resource', 'exploration', 'personal')),
            priority       smallint    NOT NULL DEFAULT 5 CHECK (priority BETWEEN 1 AND 10),
            is_current     boolean     NOT NULL DEFAULT false,
            status         text        NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active', 'completed', 'abandoned', 'blocked')),
            created_at     timestamptz NOT NULL DEFAULT now(),
            completed_at   timestamptz,
            CONSTRAINT goals_completed_at_consistent
                CHECK (completed_at IS NULL OR status = 'completed'),
            CONSTRAINT goals_current_must_be_active
                CHECK (NOT is_current OR status = 'active')
        )
        """
    )
    op.execute(
        "CREATE INDEX idx_villager_goals_villager_status ON villager_goals (villager_id, status, priority DESC)"
    )
    op.execute(
        "CREATE UNIQUE INDEX idx_villager_goals_one_current ON villager_goals (villager_id) WHERE is_current"
    )

    op.execute(
        """
        CREATE TABLE relationships (
            id                  uuid        PRIMARY KEY,
            villager_id         uuid        NOT NULL REFERENCES villagers (id) ON DELETE CASCADE,
            target_villager_id  uuid        NOT NULL REFERENCES villagers (id) ON DELETE CASCADE,
            affinity            smallint    NOT NULL DEFAULT 0  CHECK (affinity BETWEEN -100 AND 100),
            trust               smallint    NOT NULL DEFAULT 50 CHECK (trust    BETWEEN 0    AND 100),
            interaction_count   integer     NOT NULL DEFAULT 0  CHECK (interaction_count >= 0),
            last_interaction_at timestamptz,
            created_at          timestamptz NOT NULL DEFAULT now(),
            updated_at          timestamptz NOT NULL DEFAULT now(),
            CONSTRAINT relationships_no_self_edge  CHECK (villager_id <> target_villager_id),
            CONSTRAINT relationships_directed_uniq UNIQUE (villager_id, target_villager_id)
        )
        """
    )
    op.execute(
        """
        CREATE TRIGGER trg_relationships_updated_at
            BEFORE UPDATE ON relationships
            FOR EACH ROW EXECUTE FUNCTION set_updated_at()
        """
    )
    op.execute("CREATE INDEX idx_relationships_target ON relationships (target_villager_id, affinity DESC)")


def downgrade() -> None:
    op.execute("DROP TABLE relationships")
    op.execute("DROP TABLE villager_goals")
    op.execute("DROP TABLE villagers")
    op.execute("DROP FUNCTION set_updated_at")
