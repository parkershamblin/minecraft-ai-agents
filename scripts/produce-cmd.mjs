// Dev tool: publish an ActionRequested command to commands.minecraft via the
// compose Redpanda. Usage:
//   node scripts/produce-cmd.mjs <villagerId> <action> <paramsJson> [timeoutMs] [commandId]
import { execFileSync } from 'node:child_process'
import { v7 as uuidv7 } from 'uuid'
import { containerName } from './lib/containers.mjs'

const [villagerId, action, paramsJson, timeoutArg, commandIdArg] = process.argv.slice(2)
const commandId = commandIdArg ?? uuidv7()
const envelope = {
  eventId: commandId,
  eventType: 'ActionRequested',
  schemaVersion: 1,
  occurredAt: new Date().toISOString(),
  source: 'agent-service',
  aggregateType: 'Villager',
  aggregateId: villagerId,
  correlationId: uuidv7(),
  causationId: null,
  payload: {
    commandId,
    villagerId,
    action,
    params: JSON.parse(paramsJson ?? '{}'),
    timeoutMs: Number(timeoutArg ?? 30000),
  },
}
execFileSync(
  'docker',
  ['exec', '-i', containerName('redpanda'), 'rpk', 'topic', 'produce', 'commands.minecraft', '-k', villagerId],
  { input: JSON.stringify(envelope) + '\n' },
)
console.log(`${action} command ${commandId} -> ${villagerId}`)
