// Dev tool: trim the live bot fleet DOWN to `keep` bodies — the mirror of
// spawn-fleet.mjs. Lowering VILLAGER_COUNT only changes how many villagers
// agent-service *ticks*; the surplus bot *bodies* live in minecraft-service
// (in-memory, auto-reconnecting) and must be told to leave. An intentional
// 'despawn' wins over auto-reconnect (BotSession.despawn), unlike an RCON kick.
// Despawns villagers.json[keep:] — the entries agent-service no longer drives,
// keeping the first `keep` in lockstep with VILLAGER_COUNT/list_alive ordering.
// Usage: node scripts/despawn-fleet.mjs <keep>   (e.g. 5 → despawn 6..N)
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { v7 as uuidv7 } from 'uuid'

const keep = Number(process.argv[2])
if (!Number.isInteger(keep) || keep < 0) {
  console.error('usage: node scripts/despawn-fleet.mjs <keep>   (non-negative integer)')
  process.exit(1)
}

const villagers = JSON.parse(
  readFileSync(new URL('../services/agent-service/seed/villagers.json', import.meta.url), 'utf8'),
).slice(keep)

if (villagers.length === 0) {
  console.log(`nothing to despawn (roster has <= ${keep} entries)`)
  process.exit(0)
}

const lines = villagers.map((v) => {
  const commandId = uuidv7()
  const envelope = {
    eventId: commandId,
    eventType: 'ActionRequested',
    schemaVersion: 1,
    occurredAt: new Date().toISOString(),
    source: 'agent-service',
    aggregateType: 'Villager',
    aggregateId: v.id,
    correlationId: uuidv7(),
    causationId: null,
    payload: {
      commandId,
      villagerId: v.id,
      action: 'despawn',
      params: {},
      timeoutMs: 30_000,
    },
  }
  return `${v.id} ${JSON.stringify(envelope)}`
})

execFileSync(
  'docker',
  ['exec', '-i', 'ai-civilization-engine-redpanda-1', 'rpk', 'topic', 'produce', 'commands.minecraft', '-f', '%k %v\\n'],
  { input: lines.join('\n') + '\n', stdio: ['pipe', 'inherit', 'inherit'] },
)
console.log(`${lines.length} despawn commands published (keeping first ${keep}, keyed by villagerId)`)
