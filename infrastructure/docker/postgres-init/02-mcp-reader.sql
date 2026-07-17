-- MCP Toolkit read-only access (Docker MCP database-server profile
-- ai-civ-engine). One role, SELECT only, for AI clients querying the ledger
-- and memory stream. Never grant it write: the ledger is append-only source
-- of truth, and a third-party MCP server holds these credentials.

CREATE ROLE mcp_reader LOGIN PASSWORD 'mcp_reader_dev';
-- Even a would-be write inside a granted table errors instead of landing.
ALTER ROLE mcp_reader SET default_transaction_read_only = on;

GRANT CONNECT ON DATABASE event_db  TO mcp_reader;
GRANT CONNECT ON DATABASE memory_db TO mcp_reader;

-- Tables don't exist yet at container init (services migrate on boot), so
-- the grant that matters is the DEFAULT privilege: every table the owning
-- role creates later auto-grants SELECT to mcp_reader.
\connect event_db
GRANT USAGE ON SCHEMA public TO mcp_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO mcp_reader;
ALTER DEFAULT PRIVILEGES FOR ROLE event_service IN SCHEMA public
    GRANT SELECT ON TABLES TO mcp_reader;

\connect memory_db
GRANT USAGE ON SCHEMA public TO mcp_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO mcp_reader;
ALTER DEFAULT PRIVILEGES FOR ROLE memory_service IN SCHEMA public
    GRANT SELECT ON TABLES TO mcp_reader;
