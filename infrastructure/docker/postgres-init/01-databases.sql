-- Runs once at first Postgres container init (docker-entrypoint-initdb.d),
-- as superuser. One role + one logical DB per data-owning service:
-- database-per-service, faked on one instance. Postgres refuses cross-database
-- queries within a connection, so the isolation is enforced, not aspirational.
-- In production these become separate instances with zero schema changes.

CREATE ROLE agent_service      LOGIN PASSWORD 'agent_service_dev';
CREATE ROLE memory_service     LOGIN PASSWORD 'memory_service_dev';
CREATE ROLE event_service      LOGIN PASSWORD 'event_service_dev';
CREATE ROLE government_service LOGIN PASSWORD 'government_service_dev';
CREATE ROLE analytics_service  LOGIN PASSWORD 'analytics_service_dev';

CREATE DATABASE agent_db      OWNER agent_service;
CREATE DATABASE memory_db     OWNER memory_service;
CREATE DATABASE event_db      OWNER event_service;
CREATE DATABASE government_db OWNER government_service;
CREATE DATABASE analytics_db  OWNER analytics_service;

-- Extension creation is a superuser operation — it happens HERE, never in a
-- service migration (service roles are not superuser). Alembic migrations
-- assert the extension exists and fail fast if not.
\connect memory_db
CREATE EXTENSION IF NOT EXISTS vector;
