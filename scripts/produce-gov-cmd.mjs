// Dev tool: publish a GovernanceRequested command to commands.government via
// the compose Redpanda (sibling of produce-cmd.mjs — the world plane's tool).
// Usage:
//   node scripts/produce-gov-cmd.mjs <villagerId> <declare_candidacy|vote> <paramsJson> [commandId] [occurredAt]
// paramsJson per packages/events GovernanceRequested $defs, e.g.
//   vote:              '{"electionId":"...","candidateVillagerId":"...","reason":"..."}'
//   declare_candidacy: '{"electionId":"...","platform":"..."}'
// occurredAt override exists to exercise the freshness guard (STALE_COMMAND).
import { execFileSync } from 'node:child_process'
import { v7 as uuidv7 } from 'uuid'
import { containerName } from './lib/containers.mjs'

const [villagerId, action, paramsJson, commandIdArg, occurredAtArg] = process.argv.slice(2)
// || not ??: '' means "generate one" (callers pass '' to reach occurredAt)
const commandId = commandIdArg || uuidv7()
const envelope = {
  eventId: commandId,
  eventType: 'GovernanceRequested',
  schemaVersion: 1,
  occurredAt: occurredAtArg ?? new Date().toISOString(),
  source: 'agent-service',
  aggregateType: 'Villager',
  aggregateId: villagerId,
  correlationId: uuidv7(),
  causationId: null, // no DecisionMade parent = distinguishable from real deliberation
  payload: {
    commandId,
    villagerId,
    action,
    params: JSON.parse(paramsJson ?? '{}'),
  },
}
execFileSync(
  'docker',
  ['exec', '-i', containerName('redpanda'), 'rpk', 'topic', 'produce', 'commands.government', '-k', villagerId],
  { input: JSON.stringify(envelope) + '\n' },
)
console.log(`${action} command ${commandId} -> ${villagerId}`)
