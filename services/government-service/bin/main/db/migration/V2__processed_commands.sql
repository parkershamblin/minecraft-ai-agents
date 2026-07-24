-- Exactly-one-outcome under Kafka's at-least-once delivery: every consumed
-- GovernanceRequested claims its commandId here INSIDE the handling
-- transaction (INSERT .. ON CONFLICT DO NOTHING). A redelivery conflicts,
-- claims nothing, and emits nothing — the outcome was already produced once.
-- Stronger than the Redis mark-before-execute the world plane uses: the claim
-- commits or rolls back atomically with the state change it guards.

CREATE TABLE processed_commands (
    command_id   uuid        PRIMARY KEY,
    villager_id  uuid        NOT NULL,
    action       text        NOT NULL,
    outcome      text        NOT NULL,   -- 'candidate_nominated' | 'vote_cast' | 'rejected:<ERROR_CODE>'
    processed_at timestamptz NOT NULL DEFAULT now()
);
