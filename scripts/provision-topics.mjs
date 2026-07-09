// Explicit topic provisioning (M2-4): the executable topic map. Replaces
// auto-creation-at-default-1 — auto-create stays ON in Redpanda dev mode as a
// safety net, but `task up`/`up:all` run this before the app profile starts,
// so mapped topics always exist with their documented shape first.
//
// Idempotent: creates missing topics, converges retention.ms in place on
// existing ones. A PARTITION-count mismatch cannot be fixed in place without
// breaking per-villager key ordering (add-partitions rehashes keys) — the
// script fails loud and points at the runbook instead.
//
// Source of truth mirrored here: docs/architecture/03-events-kafka.md §1.
// Usage: node scripts/provision-topics.mjs   (or `task topics`)
import { execFileSync } from 'node:child_process'

const CONTAINER = process.env.REDPANDA_CONTAINER ?? 'ai-civilization-engine-redpanda-1'

const DAY_MS = 24 * 60 * 60 * 1000
const TOPICS = [
  // Facts: 7-day retention — Kafka is transport, not storage; the ledger keeps forever.
  { name: 'world.events', partitions: 6, retentionMs: 7 * DAY_MS },
  { name: 'agent.events', partitions: 6, retentionMs: 7 * DAY_MS },
  { name: 'social.events', partitions: 3, retentionMs: 7 * DAY_MS },
  { name: 'government.events', partitions: 3, retentionMs: 7 * DAY_MS },
  // Commands: 24h — intent goes stale fast (executor freshness guard drops at 600s anyway).
  { name: 'commands.minecraft', partitions: 6, retentionMs: DAY_MS },
  { name: 'commands.government', partitions: 6, retentionMs: DAY_MS },
]

function rpk(...args) {
  return execFileSync('docker', ['exec', CONTAINER, 'rpk', ...args], { encoding: 'utf8' })
}

// `rpk topic list` prints: NAME  PARTITIONS  REPLICAS
const existing = new Map(
  rpk('topic', 'list')
    .trim()
    .split('\n')
    .slice(1)
    .filter(Boolean)
    .map((line) => {
      const [name, partitions] = line.trim().split(/\s+/)
      return [name, Number(partitions)]
    }),
)

const mismatches = []
for (const { name, partitions, retentionMs } of TOPICS) {
  const current = existing.get(name)
  if (current === undefined) {
    rpk('topic', 'create', name, '-p', String(partitions), '-r', '1', '-c', `retention.ms=${retentionMs}`)
    console.log(`created  ${name} (partitions=${partitions}, retention.ms=${retentionMs})`)
  } else if (current !== partitions) {
    mismatches.push({ name, current, wanted: partitions })
    console.error(`MISMATCH ${name}: ${current} partitions, map says ${partitions}`)
  } else {
    rpk('topic', 'alter-config', name, '--set', `retention.ms=${retentionMs}`)
    console.log(`ok       ${name} (partitions=${partitions}, retention.ms converged)`)
  }
}

if (mismatches.length > 0) {
  console.error(
    '\nPartition counts cannot be changed in place without breaking per-villager',
  )
  console.error(
    'key ordering. Follow docs/runbooks/kafka-topic-migration.md (drain -> recreate -> offset reset).',
  )
  process.exit(1)
}
console.log('topic map converged')
