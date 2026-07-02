# @civ/events — the Published Language

Single source of truth for every message on every Kafka topic (plus the one
shared-state contract). Services never share code or databases — they share
**these schemas**. Contract tests bind every producer and consumer to them.

```
schemas/
  envelope.schema.json      the wrapper on every message (eventId UUIDv7, causation chain, ...)
  world/                    facts from minecraft-service      → world.events
  agent/                    facts from agent-service          → agent.events
  commands/                 ActionRequested (intent, not fact) → commands.minecraft
  state/                    WorldSnapshot — the Redis world:{villagerId} contract (NOT Kafka)
fixtures/                   one valid example per schema + fixtures/invalid/ (must fail)
codegen/                    gen-ts.mjs; Python via uvx datamodel-code-generator
generated/                  committed output (ts/, py/) — CI fails if stale vs schemas
test/validate.mjs           the contract gate: fixtures validate, invalid fixtures fail,
                            every schema has a fixture
```

Commands: `npm test` (contract tests) · `npm run gen` (regenerate TS + Python).
From the repo root: `task test` / `task gen`.

## Rules

- **Additive-only within a version**: new optional fields only. Renames,
  removals, or type changes bump the `.vN` in the filename and the
  `schemaVersion` on the wire. Published versions are never edited in place.
- **Payloads are strict** (`additionalProperties: false`) because the monorepo
  shares one schema version; consumers still treat unknown fields as ignorable
  at runtime (tolerant reader).
- **Java codegen is deliberately absent until P2** — event-service persists
  envelopes generically (typed columns + JSONB payload) and validates against
  these files with a generic JSON Schema validator. jsonschema2pojo arrives
  with government-service, the first Java service that deserializes payloads.

## v1 deviations from the design-doc catalog (recorded, not accidental)

- `pos` fields are `number`, not `int` — Minecraft entity coordinates are
  doubles; an `int` schema would reject the first real event.
- `ChatObserved` adds `speakerUsername` (always present) and makes
  `villagerId` nullable — human players can speak near villagers, and the
  roster can only resolve villagers.
- `DecisionMade` has an optional `error` flag — the CIV-7 malformed-LLM-output
  fallback is part of the contract, not an afterthought.
