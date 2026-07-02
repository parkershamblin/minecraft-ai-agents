# API Design

REST is the synchronous **query/admin plane**; all runtime behavior flows through Kafka (commands + events). Cross-service REST is limited to exactly two sanctioned paths: the dashboard-service BFF (read aggregation for the browser) and agent-service → memory-service (the Cognition/Memory Customer–Supplier seam, which is synchronous by nature — deliberation blocks on retrieval). Everything else flows through Kafka.

Canonical local ports (single source of truth — compose and docs must match): Next.js dashboard `:3000`, dashboard-service BFF `:8080`, event-service `:8081`, government-service `:8082`, analytics-service `:8083`, agent-service `:8001`, memory-service `:8002`, minecraft-service `:8003` (health/metrics only).

## Per-Service Endpoints

### agent-service (`:8001`)

| Method | Path | Purpose | Notable params |
|---|---|---|---|
| GET | `/villagers` | List villagers | `status` (alive/dead/despawned), `cursor`, `limit` (≤100, default 25). A `civilization-id` filter arrives with multi-civilization support in P5 |
| GET | `/villagers/{id}` | Villager detail: personality, current goal, status | `include=goals,relationships` (sparse fieldset expansion) |
| POST | `/villagers` | Spawn a villager (creates row, emits `VillagerCreated`, triggers bot join via `commands.minecraft`) | body: name, personality traits, spawn hint |
| PATCH | `/villagers/{id}` | Admin edits (personality tweak, pause/resume agent loop) | JSON Merge Patch (RFC 7386) |
| GET | `/villagers/{id}/relationships` | Directed edge list with affinity + trust scores | `min-affinity`, `min-trust`, `cursor` |
| POST | `/villagers/{id}/goals` | Inject a goal (admin/story steering; emits `GoalChanged`) | body: description, priority, source=`operator` |
| POST | `/internal/villagers/{id}/decision-cycle` | Trigger one perceive→deliberate→act tick. Called by the Redis tick scheduler; **not routed by the gateway** | `202 Accepted` — async execution; idempotent per tick via `tickId` body field |

`/internal/*` prefix marks endpoints excluded from the BFF route table and OpenAPI aggregation — a cheap trust-boundary convention until real authn exists.

### memory-service (`:8002`)

| Method | Path | Purpose | Notable params |
|---|---|---|---|
| POST | `/memories` | Ingest a memory (embeds, scores importance/sentiment). Called by agent-service's reflect node over REST — the Customer/Supplier seam | `Idempotency-Key` header (dedupes retries — **idempotent write**) |
| GET | `/villagers/{id}/memories` | Chronological memory stream | `since`, `until`, `min-importance`, `kind` (observation/reflection), `cursor` |
| POST | `/villagers/{id}/memories/search` | Semantic retrieval: recency × importance × relevance scoring over pgvector | body: `query`, `k` (default 10), `weights` override; POST because the query text doesn't belong in a URL |
| POST | `/villagers/{id}/reflections` | Force a reflection pass (summarize recent memories via LLM, emit `ReflectionCreated`) | `202 Accepted`; normally cron-scheduled, endpoint is the manual/demo lever |

### event-service (`:8081`)

| Method | Path | Purpose | Notable params |
|---|---|---|---|
| GET | `/events` | Query the append-only event store | `type` (repeatable), `aggregate-type`, `aggregate-id`, `correlation-id`, `since`/`until` (ISO-8601), `cursor`, `limit` |
| GET | `/events/{eventId}` | Single event by UUIDv7 | — |
| GET | `/timeline` | Human-readable timeline: rendered summaries. Postgres-backed in P1; OpenSearch takes over full-text search (`q`) at M2 | `q` (full-text, M2+), `villager-id`, `since`/`until`, `cursor` |
| POST | `/replays` | Create a replay job: re-emit filtered historical events to a `replay.{replayId}` topic at a chosen speed (**event sourcing — the store is the source of truth**). Contract frozen now; implemented in M1 alongside analytics-service's first projection rebuild | body: filters (as `/events`), `speed` (1x–64x); returns `202` + job resource |
| GET | `/replays/{id}` | Replay job status/progress (M1) | — |

### government-service (`:8082`) — Phase 2+, contract frozen now

| Method | Path | Purpose | Notable params |
|---|---|---|---|
| POST | `/elections` | Open an election (emits `ElectionStarted`) | body: office, candidate villager IDs, closes-at |
| GET | `/elections/{id}` | Election detail: candidates, tally, status | `include=votes` |
| POST | `/elections/{id}/votes` | Cast a vote. **Idempotency via natural key** `(election_id, voter_id)` — replays/retries return `200` with the existing vote, never double-count; emits `VoteCast` once | body: `voterId`, `candidateId` |
| POST | `/laws` | Propose a law (emits `LawProposed`; enactment by the seated government emits `LawEnacted`) | body: title, text, proposed-by |
| GET | `/laws` | List laws | `status` (proposed/enacted/repealed/vetoed), `government-id`, `cursor` |
| POST | `/factions` | Register a faction (emits `FactionCreated`) | body: name, founder villager ID, ideology |

### analytics-service (`:8083`)

Read-only projections rebuilt from Kafka — the **CQRS read side**; no writes, no cross-service calls.

| Method | Path | Purpose | Notable params |
|---|---|---|---|
| GET | `/leaderboard` | Ranked villagers by projection | `metric` (required: `popular`\|`hated`\|`lawful`\|`chaotic`\|`influential`), `limit` (default 10) |
| GET | `/reports/episodes/{id}` | Episode report for video production: arc summary, key events, clip markers | `format=json\|markdown` |
| GET | `/stats/villagers/{id}` | Per-villager stats: decisions, conversations, resources gathered, sentiment trend | `since`/`until` |
| GET | `/approval-ratings` | Approval time series (mayor/government) | `subject-id`, `bucket` (`hour`\|`day`), `since`/`until` |

### minecraft-service (`:8003`)

No domain REST API by design — all writes arrive as `ActionRequested` on `commands.minecraft` (**CQRS command topic**). Exposes only `GET /healthz` and `GET /internal/bots` (live bot connection states, debug only).

### dashboard-service (`:8080`) — gateway route table

BFF pattern: the browser talks to exactly one origin; the gateway rewrites `/api/{service}/*` → backing service, forwarding `X-Correlation-Id`.

| Gateway route | Backing service | Notes |
|---|---|---|
| `/api/villagers/**` | agent-service | includes `/relationships`, `/goals` subresources |
| `/api/memories/**`, `/api/villagers/{id}/memories/**` | memory-service | search proxied as-is |
| `/api/events/**`, `/api/timeline`, `/api/replays/**` | event-service | |
| `/api/elections/**`, `/api/laws/**`, `/api/factions/**` | government-service | 404s until P2 |
| `/api/leaderboard`, `/api/reports/**`, `/api/stats/**`, `/api/approval-ratings` | analytics-service | |
| `/api/overview` | aggregated (concurrent fan-out to agent + analytics + event) | the one composed endpoint; powers the Overview page in a single round trip |
| `/ws` | — | WebSocket upgrade, see below |
| `/api/docs/**` | all | aggregated Swagger UI |

Anything under `/internal/*` on any service is deliberately unroutable through the gateway.

## Conventions

| Concern | Decision |
|---|---|
| Pagination | **Cursor (keyset) only, never offset.** Cursor = opaque base64 of the sort key (UUIDv7 `id`, which is time-ordered). Offset pagination on an append-heavy event store means O(n) scans and page drift as new rows land mid-scroll; keyset is O(log n) and stable. Response: `{ "data": [...], "nextCursor": "..." \| null }`. |
| Errors | **RFC 7807 `application/problem+json`** everywhere: `{ "type", "title", "status", "detail", "instance", "correlationId" }`. Spring: `ProblemDetail`; FastAPI: exception handler producing the same shape. |
| Correlation | `X-Correlation-Id` header accepted on every request (generated if absent), echoed in responses, stamped into logs and into the `correlationId` field of any event the request causes — one trace from HTTP call → Kafka event → downstream projection. |
| Idempotency | Unsafe POSTs that can be retried accept `Idempotency-Key`; domain writes with a natural unique key (votes) enforce it in the schema instead. |
| Versioning | None in MVP (single consumer we own). Event `schemaVersion` carries evolution; REST gets `/v2` prefixes only when a breaking change actually ships — **don't over-engineer**. |
| Auth (MVP) | None — everything binds to localhost inside Docker Compose. |
| Auth (future viewer APIs) | API keys (`X-Api-Key`, hashed at rest in a dashboard-service `api_keys` table) checked at the gateway only; per-key **token-bucket rate limit in Redis** (e.g. 60 req/min, burst 10), `429` + `Retry-After` on exhaustion. Internal services stay auth-free behind the gateway — perimeter enforcement, single choke point. |

## WebSocket Protocol (dashboard-service `/ws`)

**Phasing note:** dashboard-service ships in M1/M2 when there is genuinely something to aggregate. In Sprint 1 the live feed is a ~30-line `GET /events/stream` SSE endpoint (Spring MVC `SseEmitter`) on event-service — it already consumes every topic — consumed by the browser's native `EventSource`. The protocol below is the target-state contract.

Single endpoint; multiplexed channels over one connection (one socket per browser tab, not per widget).

**Channels:** `events.live` (firehose of all envelopes), `villagers.{id}` (events where `aggregateId` = that villager), `government.live` (government.events topic only).

Client → server:

```json
{ "op": "subscribe", "channels": ["events.live", "villagers.0197f3a2-8c1d-7e4b-9a01-3f2e5d6c7b8a"] }
```

`{ "op": "unsubscribe", ... }` and `{ "op": "ping" }` complete the client vocabulary.

Server → client — the standard event envelope wrapped with routing metadata:

```json
{
  "channel": "events.live",
  "seq": 4187,
  "event": {
    "eventId": "0197f3b1-2a44-7c90-b3d5-1e2f3a4b5c6d",
    "eventType": "VillagerTalked",
    "schemaVersion": 1,
    "occurredAt": "2026-07-02T18:41:07.312Z",
    "source": "agent-service",
    "aggregateType": "Villager",
    "aggregateId": "0197f3a2-8c1d-7e4b-9a01-3f2e5d6c7b8a",
    "correlationId": "0197f3b0-9911-7a02-8def-aabbccdd0011",
    "causationId": "0197f3b0-8802-7c15-9a3e-556677889900",
    "payload": {
      "speakerId": "0197f3a2-8c1d-7e4b-9a01-3f2e5d6c7b8a",
      "speakerName": "Brynn",
      "listenerIds": ["0197f3a2-9d2e-7f5c-8b12-4a3b6c7d8e9f"],
      "message": "The harvest is thin this season.",
      "topic": "farming",
      "sentiment": -0.3,
      "location": { "x": 112, "y": 64, "z": -348 }
    }
  }
}
```

**Backpressure — drop-oldest, per client:** each session gets a bounded ring buffer (512 messages, an `ArrayBlockingQueue` per session on plain Spring MVC + `spring-boot-starter-websocket` — a reactive stack is not required to tell this story). A slow browser overflows its own buffer and silently loses the *oldest* live messages; it never slows the Kafka consumer or other clients (**load shedding over buffering**). The per-channel `seq` counter lets clients detect gaps and backfill via `GET /api/events?cursor=…` — live view is lossy by contract, the event store is the durable truth.

## OpenAPI

Java services expose specs via **springdoc-openapi** (`/v3/api-docs`), Python services via FastAPI's built-in generator (`/openapi.json`) — zero hand-written spec files, docs generated from the code that actually runs. dashboard-service hosts an aggregated Swagger UI at `/api/docs` using springdoc's multi-URL config pointing at each service's spec through the gateway routes, so one browser tab documents the whole system; CI snapshots each spec as a build artifact so contract drift shows up in diffs.