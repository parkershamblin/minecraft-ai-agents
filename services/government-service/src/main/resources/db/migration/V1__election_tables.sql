-- The election substrate, and ONLY the election substrate. laws, factions and
-- faction_members are designed in docs/architecture/02-database.md but are
-- deliberately NOT created here (08-m2-plan ruling 8: designed != built;
-- laws are M3, factions are M4). Mirrors the 02-database column sketch, plus
-- the boundaries the state machine needs (nominating_ends_at, annulled_reason).
--
-- Cross-service references (villager ids) are logical refs, never FKs —
-- government_db cannot see agent_db (database-per-service).

CREATE TABLE governments (
    id                uuid        PRIMARY KEY,
    name              text        NOT NULL,
    government_type   text        NOT NULL,   -- P2: 'mayoralty'; later council, theocracy
    mayor_villager_id uuid,                   -- logical ref into agent_db villagers
    charter           jsonb,                  -- P3+ (living law); NULL for the P2 mayoralty
    established_at    timestamptz NOT NULL,
    dissolved_at      timestamptz             -- one active government per type at a time
);

CREATE TABLE elections (
    id                  uuid        PRIMARY KEY,
    government_id       uuid        REFERENCES governments(id),  -- incumbent at open; NULL for the village's first
    office              text        NOT NULL,                    -- P2: 'mayor'
    status              text        NOT NULL
        CHECK (status IN ('scheduled', 'nominating', 'voting', 'decided', 'annulled')),
    winner_candidate_id uuid,                                    -- FK added below (candidates not created yet)
    starts_at           timestamptz NOT NULL,                    -- nominating opens
    nominating_ends_at  timestamptz NOT NULL,                    -- voting opens
    ends_at             timestamptz NOT NULL,                    -- voting closes
    annulled_reason     text,                                    -- 'no_candidates' | 'no_votes'
    created_at          timestamptz NOT NULL DEFAULT now(),
    CHECK (starts_at <= nominating_ends_at AND nominating_ends_at <= ends_at)
);

CREATE TABLE candidates (
    id            uuid        PRIMARY KEY,
    election_id   uuid        NOT NULL REFERENCES elections(id),
    villager_id   uuid        NOT NULL,       -- logical ref
    platform      jsonb,                      -- LLM campaign promises (M2-7 declare_candidacy)
    registered_at timestamptz NOT NULL,
    -- One candidacy per villager per election (08-m2-plan ruling 5).
    CONSTRAINT candidates_one_per_villager UNIQUE (election_id, villager_id)
);

ALTER TABLE elections ADD CONSTRAINT fk_elections_winner
    FOREIGN KEY (winner_candidate_id) REFERENCES candidates(id);

CREATE TABLE votes (
    id                 uuid        PRIMARY KEY,
    election_id        uuid        NOT NULL REFERENCES elections(id),
    candidate_id       uuid        NOT NULL REFERENCES candidates(id),
    voter_villager_id  uuid        NOT NULL,  -- logical ref
    reason             text,                  -- LLM rationale — episode gold
    cast_at            timestamptz NOT NULL,
    -- THE vote-idempotency natural key (08-m2-plan ruling 5): a redelivered or
    -- re-decided vote is a silent no-op returning the existing fact.
    CONSTRAINT votes_one_per_voter UNIQUE (election_id, voter_villager_id)
);

CREATE INDEX idx_candidates_election ON candidates (election_id);
CREATE INDEX idx_votes_election ON votes (election_id);
-- The scheduled clock's scan: only non-terminal elections are ever due.
CREATE INDEX idx_elections_active ON elections (status)
    WHERE status IN ('scheduled', 'nominating', 'voting');
