-- The append-only event store. Mirrors docs/architecture/02-database.md.
-- Runs as the event_db owner in compose; as the container superuser in
-- Testcontainers (where the guard below creates the role first).

DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'event_service') THEN
        CREATE ROLE event_service;
    END IF;
END $$;

CREATE TABLE events (
    event_id       uuid        PRIMARY KEY,         -- UUIDv7: time-ordered AND the idempotency key
    event_type     text        NOT NULL,            -- PascalCase: 'VillagerTalked', 'DecisionMade', ...
    schema_version integer     NOT NULL DEFAULT 1 CHECK (schema_version >= 1),
    occurred_at    timestamptz NOT NULL,            -- producer clock (from the envelope)
    recorded_at    timestamptz NOT NULL DEFAULT now(),  -- ingest clock (skew diagnostics)
    source         text        NOT NULL,            -- producing service name
    aggregate_type text        NOT NULL,            -- PascalCase: 'Villager', 'Election', ...
    aggregate_id   uuid        NOT NULL,            -- mirrors the Kafka partition key
    correlation_id uuid        NOT NULL,
    causation_id   uuid,
    topic          text        NOT NULL,            -- 'world.events', 'commands.minecraft', ...
    payload        jsonb       NOT NULL CHECK (jsonb_typeof(payload) = 'object')
);

-- Aggregate timeline / replay: "everything that happened to villager X, in order".
CREATE INDEX idx_events_aggregate ON events (aggregate_id, occurred_at);
-- Type-sliced timelines: "all BetrayalRecorded events last week".
CREATE INDEX idx_events_type ON events (event_type, occurred_at);
-- Trace a causal chain across services (structured logs carry the same id).
CREATE INDEX idx_events_correlation ON events (correlation_id);
-- Keyset pagination's exact total order.
CREATE INDEX idx_events_keyset ON events (occurred_at, event_id);

-- Timeline full-text search, Postgres-native — OpenSearch takes over at M2.
ALTER TABLE events ADD COLUMN search_text tsvector
    GENERATED ALWAYS AS (
        to_tsvector('english',
            event_type || ' ' || coalesce(payload->>'message', '') || ' ' || coalesce(payload->>'reason', ''))
    ) STORED;
CREATE INDEX idx_events_search ON events USING gin (search_text);

-- Append-only enforced in the database, not by convention: belt (privileges)...
REVOKE UPDATE, DELETE, TRUNCATE ON events FROM event_service;
-- ...and suspenders (trigger), so even the owner role cannot rewrite history.
CREATE OR REPLACE FUNCTION events_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'events is an append-only event store: % not allowed', TG_OP;
END $$;

CREATE TRIGGER trg_events_append_only
    BEFORE UPDATE OR DELETE ON events
    FOR EACH ROW EXECUTE FUNCTION events_append_only();
