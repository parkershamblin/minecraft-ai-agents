-- The REST `aggregate-type` filter (EventsController -> JdbcEventStore.query)
-- had no matching index and full-scanned events. Mirror the other timeline
-- indexes: filter column first, then occurred_at for the ORDER BY.
CREATE INDEX idx_events_aggregate_type ON events (aggregate_type, occurred_at);
