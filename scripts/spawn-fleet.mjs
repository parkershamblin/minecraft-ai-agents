// Dev tool: re-embody the bot fleet after a minecraft-service recreate — bot
// sessions are in-memory and die with the container (CLAUDE.md). `task seed`
// covers this only when agent-service runs with a nonzero VILLAGER_COUNT; on
// the zero-pollution preset (VILLAGER_COUNT=0, no ticks) use this instead.
// One keyed spawn command per villagers.json entry, single rpk produce.
// Usage: node scripts/spawn-fleet.mjs [count]   (default: every entry)
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { v7 as uuidv7 } from 'uuid'
import { containerName } from './lib/containers.mjs'

const count = Number(process.argv[2] ?? Infinity)
const villagers = JSON.parse(
  readFileSync(new URL('../services/agent-service/seed/villagers.json', import.meta.url), 'utf8'),
).slice(0, count)

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
      action: 'spawn',
      params: { minecraftUsername: v.minecraftUsername },
      timeoutMs: 30_000,
    },
  }
  return `${v.id} ${JSON.stringify(envelope)}`
})

execFileSync(
  'docker',
  ['exec', '-i', containerName('redpanda'), 'rpk', 'topic', 'produce', 'commands.minecraft', '-f', '%k %v\\n'],
  { input: lines.join('\n') + '\n', stdio: ['pipe', 'inherit', 'inherit'] },
)
console.log(`${lines.length} spawn commands published (keyed by villagerId)`)
