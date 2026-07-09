# Runbook: Kafka topic partition migration (drain → recreate → offset reset)

**When you need this:** `task topics` failed with `MISMATCH` — an existing
topic's partition count differs from the map in
`scripts/provision-topics.mjs`. (Anything else — missing topic, wrong
retention — the task converges in place; only partition counts land here.)

**Why recreate instead of `rpk topic add-partitions`:** partition assignment
is `hash(key) % partitionCount`. Changing the count rehashes every key, so
one villager's commands would straddle old and new partitions and consumers
would see them out of order — exactly the per-villager ordering the
villagerId key exists to guarantee. A delete + recreate is a clean break: the
new topic starts empty, every key hashes consistently from message one.
Losing the in-flight window is by design — **Kafka is transport, not
storage** (03-events-kafka.md); facts live forever in the event ledger, and
commands older than `COMMAND_MAX_AGE_SECONDS` (600) are dropped by the
executor's freshness guard anyway.

## Consumer inventory (keep current — check before every run)

| Group | Topics | Container | Offset behavior on empty topic |
|---|---|---|---|
| `minecraft-service.command-executor` | `commands.minecraft` | minecraft-service | kafkajs `fromBeginning: false` → latest; freshness guard drops stale |
| `event-service.event-store` | all `*.events` + `commands.*` (CIV_TOPICS) | event-service | `auto-offset-reset: earliest`; ledger dedupes by eventId PK |
| `agent-service.perception` | `world.events` | agent-service | `auto_offset_reset: latest`; 10-min percept freshness guard |

## Steps

1. **Drain.** Quiesce traffic (no tick loops running, or accept the loss
   consciously), then confirm every group touching the affected topics shows
   `TOTAL-LAG 0`:

   ```powershell
   docker exec ai-civilization-engine-redpanda-1 rpk group describe `
     minecraft-service.command-executor event-service.event-store agent-service.perception
   ```

   `event-service.event-store` lag 0 is the one that matters most — it is the
   archival guarantee that nothing in Kafka exists only in Kafka.

2. **Stop every consumer of the affected topics** (producers too if traffic
   isn't already zero):

   ```powershell
   docker compose -f infrastructure/docker/docker-compose.yml --env-file .env `
     --profile infra --profile app stop minecraft-service event-service agent-service
   ```

   ⚠️ Stopping minecraft-service drops **all bot sessions** (in-memory,
   CLAUDE.md gotcha) — plan the respawn in step 5.

3. **Delete and recreate** at the mapped shape:

   ```powershell
   docker exec ai-civilization-engine-redpanda-1 rpk topic delete <topic> [<topic>…]
   task topics
   ```

4. **Reset consumer group offsets.** Committed offsets now point past the
   end of the empty recreated topics. Every client has *some* out-of-range
   recovery behavior, but a runbook doesn't lean on three different client
   defaults — delete the groups while their members are stopped and let each
   consumer start fresh (all reset policies converge at offset 0 on an empty
   topic; the ledger's eventId primary key absorbs any replay):

   ```powershell
   docker exec ai-civilization-engine-redpanda-1 rpk group delete `
     minecraft-service.command-executor
   # repeat for each group whose topics were recreated
   ```

   `GROUP_ID_NOT_FOUND` here is success, not an error: deleting a topic also
   removes the group's committed offsets for it, and a memberless group with
   no offsets left can be garbage-collected before you get to it (observed
   on 2 of 3 groups in the 2026-07-08 run). What matters is that the group
   is *gone* either way.

5. **Restart and re-embody:**

   ```powershell
   docker compose -f infrastructure/docker/docker-compose.yml --env-file .env `
     --profile infra --profile app up -d --wait   # add --build if code rides along
   task seed   # or hand-published spawn commands — bot sessions do not survive
   ```

6. **Verify:**

   ```powershell
   docker exec ai-civilization-engine-redpanda-1 rpk topic describe commands.minecraft
   docker exec ai-civilization-engine-redpanda-1 rpk group describe minecraft-service.command-executor
   ```

   Expect the mapped partition count, all groups `Stable`, lag 0. Then push a
   canary through the whole seam: `node scripts/produce-cmd.mjs <villagerId>
   idle '{}'` for two or three villagers, confirm commands land on
   *different* partitions (`rpk topic consume commands.minecraft
   --offset start -f '%p %k\n'`), execute in-game, and arrive in the ledger
   (`ActionCompleted` events; hand-published canaries carry
   `causationId: null` — distinguishable from real deliberation, accepted
   practice since M2-1).

## Executed migrations

- **2026-07-08 (M2-4, first run):** all four auto-created 1-partition topics
  (`world.events`, `agent.events`, `social.events`, `commands.minecraft`)
  migrated to the mapped counts (6/6/3/6) and `government.events` +
  `commands.government` (3/6) provisioned ahead of their first producer.
  All three groups deleted and re-formed clean. Bot fleet respawned 20/20.
