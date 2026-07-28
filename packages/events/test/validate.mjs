// Contract test: every fixture must validate (envelope + payload schema chosen
// by its eventType/schemaVersion), and every fixture under fixtures/invalid/
// must FAIL validation. This same script is the CI contract gate.
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const ajv = new Ajv2020.default({ allErrors: true, strict: true })
addFormats.default(ajv)

// --- compile all schemas, keyed by "<EventType>.v<N>" ---------------------
const schemasDir = join(root, 'schemas')
const validators = new Map()
const schemaIds = new Map() // "<EventType>.v<N>" -> $id, for $defs subschema lookups
let envelopeValidate = null

for (const entry of readdirSync(schemasDir, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.schema.json')) continue
  const schema = JSON.parse(readFileSync(join(entry.parentPath, entry.name), 'utf8'))
  const validate = ajv.compile(schema)
  if (entry.name === 'envelope.schema.json') envelopeValidate = validate
  else {
    const key = basename(entry.name, '.schema.json') // e.g. "VillagerSpawned.v1"
    validators.set(key, validate)
    schemaIds.set(key, schema.$id)
  }
}

if (!envelopeValidate) throw new Error('envelope.schema.json not found')
console.log(`compiled envelope + ${validators.size} payload/state schemas`)

// Command `params` is free-form on the wire by design — producers validate
// against the per-action $defs at their seam before publishing. Fixtures are
// the canonical examples, so hold THEM to those $defs here; otherwise a
// fixture can drift from the very shape it exists to demonstrate. Keep these
// maps in step with the seam maps (_PARAMS_DEF_BY_ACTION /
// _GOVERNANCE_DEF_BY_ACTION in agent-service llm/contract.py); null = takes {}.
const PARAMS_DEF_BY_ACTION = {
  'ActionRequested.v1': {
    spawn: 'SpawnParams',
    move: 'MoveParams',
    chat: 'ChatParams',
    follow: 'FollowParams',
    gather: 'GatherParams',
    craft: 'CraftParams',
    hunt: 'HuntParams',
    despawn: null,
    idle: null,
  },
  'GovernanceRequested.v1': {
    declare_candidacy: 'DeclareCandidacyParams',
    vote: 'VoteParams',
  },
}
const emptyParamsValidate = ajv.compile({ type: 'object', additionalProperties: false })

// --- helpers ---------------------------------------------------------------
const fmt = (errors) => errors.map((e) => `    ${e.instancePath || '/'} ${e.message}`).join('\n')

function check(fixture) {
  // Envelope-wrapped event vs raw state contract (WorldSnapshot has no eventId).
  if (fixture.eventId !== undefined) {
    if (!envelopeValidate(fixture)) {
      return { ok: false, detail: `envelope invalid:\n${fmt(envelopeValidate.errors)}` }
    }
    const key = `${fixture.eventType}.v${fixture.schemaVersion}`
    const payloadValidate = validators.get(key)
    if (!payloadValidate) return { ok: false, detail: `no payload schema for ${key}` }
    if (!payloadValidate(fixture.payload)) {
      return { ok: false, detail: `payload invalid vs ${key}:\n${fmt(payloadValidate.errors)}` }
    }
    const actionMap = PARAMS_DEF_BY_ACTION[key]
    if (actionMap) {
      // Loud, not silent: a new verb whose fixture reaches here without a map
      // entry means a contract commit forgot to wire its params shape in.
      if (!(fixture.payload.action in actionMap)) {
        return { ok: false, detail: `${key} action '${fixture.payload.action}' has no PARAMS_DEF_BY_ACTION entry — map it to its $defs shape` }
      }
      const defName = actionMap[fixture.payload.action]
      const paramsValidate = defName ? ajv.getSchema(`${schemaIds.get(key)}#/$defs/${defName}`) : emptyParamsValidate
      if (!paramsValidate) return { ok: false, detail: `no $defs/${defName} in ${key}` }
      if (!paramsValidate(fixture.payload.params)) {
        return { ok: false, detail: `params invalid vs ${key} $defs/${defName}:\n${fmt(paramsValidate.errors)}` }
      }
    }
    return { ok: true }
  }
  const snapshotValidate = validators.get('WorldSnapshot.v1')
  if (!snapshotValidate(fixture)) {
    return { ok: false, detail: `WorldSnapshot invalid:\n${fmt(snapshotValidate.errors)}` }
  }
  return { ok: true }
}

// --- run -------------------------------------------------------------------
const fixturesDir = join(root, 'fixtures')
let failures = 0

for (const entry of readdirSync(fixturesDir, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.json')) continue
  const path = join(entry.parentPath, entry.name)
  const fixture = JSON.parse(readFileSync(path, 'utf8'))
  const mustFail = entry.parentPath.includes('invalid')
  const { ok, detail } = check(fixture)

  if (mustFail && ok) {
    console.error(`✗ ${entry.name} — expected INVALID but it validated (the negative test is broken)`)
    failures++
  } else if (!mustFail && !ok) {
    console.error(`✗ ${entry.name}\n${detail}`)
    failures++
  } else {
    console.log(`✓ ${entry.name}${mustFail ? ' (correctly rejected)' : ''}`)
  }
}

// Every payload schema must have at least one fixture exercising it.
const exercised = new Set(
  readdirSync(fixturesDir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.json') && !e.parentPath.includes('invalid'))
    .map((e) => e.name.replace(/\.json$/, ''))
)
for (const key of validators.keys()) {
  if (!exercised.has(key)) {
    console.error(`✗ schema ${key} has no fixture`)
    failures++
  }
}

if (failures > 0) {
  console.error(`\nCONTRACT TESTS FAILED: ${failures} problem(s)`)
  process.exit(1)
}
console.log('\nall contract tests passed')
