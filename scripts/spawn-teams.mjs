// RB-1 team spawn (ADR-10): embody the race rosters — every villagers.json
// entry with a `team` field — and optionally station each team at its spawn.
// Spawn commands go through the normal command plane (same as spawn-fleet);
// stationing is RCON tp + spawnpoint per bot, so keepInventory deaths respawn
// bots at their team's post, not the world spawn.
//
// Usage: node scripts/spawn-teams.mjs [--station "red:x,y,z" --station "blue:x,y,z"]
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { v7 as uuidv7 } from 'uuid'
import { containerName } from './lib/containers.mjs'

const villagers = JSON.parse(
  readFileSync(new URL('../services/agent-service/seed/villagers.json', import.meta.url), 'utf8'),
).filter((v) => v.team)

if (villagers.length === 0) {
  console.error('no villagers.json entries carry a team field — nothing to spawn')
  process.exit(1)
}

const stations = new Map()
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--station') {
    const spec = process.argv[++i] ?? ''
    const [team, coords] = spec.split(':')
    const [x, y, z] = (coords ?? '').split(',').map(Number)
    if (!team || [x, y, z].some(Number.isNaN)) {
      console.error(`bad --station '${spec}' — expected "team:x,y,z"`)
      process.exit(1)
    }
    stations.set(team, { x, y, z })
  }
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
const roster = villagers.map((v) => `${v.minecraftUsername}(${v.team})`).join(', ')
console.log(`${lines.length} spawn commands published: ${roster}`)

if (stations.size > 0) {
  // Give the herd a moment to connect before stationing (connection-throttle
  // should be -1; if bots are missing, rerun with --station only).
  const rcon = (cmd) =>
    execFileSync('docker', ['exec', containerName('minecraft'), 'rcon-cli', cmd], { encoding: 'utf8' }).trim()
  await new Promise((resolve) => setTimeout(resolve, 8_000))
  for (const v of villagers) {
    const post = stations.get(v.team)
    if (!post) {
      continue
    }
    const at = `${post.x} ${post.y} ${post.z}`
    console.log(`stationing ${v.minecraftUsername} (${v.team}) at ${at}`)
    console.log('  ' + rcon(`tp ${v.minecraftUsername} ${at}`))
    console.log('  ' + rcon(`spawnpoint ${v.minecraftUsername} ${at}`))
  }
}
