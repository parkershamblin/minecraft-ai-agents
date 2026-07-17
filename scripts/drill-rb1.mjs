// RB-1 exit drill (ADR-10): drive one bot through mine → smelt → craft
// iron_pickaxe end-to-end on the live stack, with the full T1 milestone
// ladder landing in the ledger under one attempt. This is a RIG TEST of the
// race machinery — the world is staged via RCON (ores set, tools given), the
// mining/smelting/crafting is real bot work through the real command plane.
//
// The drill villager is Fen: on the blue roster but OUTSIDE the ticked fleet
// (VILLAGER_COUNT=5), so no brain tick can claim the body mid-drill.
//
// Usage: node scripts/drill-rb1.mjs
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { v7 as uuidv7 } from 'uuid'

const MC = 'http://localhost:8003'
const LEDGER = 'http://localhost:8081'
const DRILL_NAME = 'Fen'

const villagers = JSON.parse(
  readFileSync(new URL('../services/agent-service/seed/villagers.json', import.meta.url), 'utf8'),
).filter((v) => v.team)
const drill = villagers.find((v) => v.name === DRILL_NAME)
if (!drill) {
  throw new Error(`${DRILL_NAME} has no team in villagers.json`)
}
const teams = ['red', 'blue'].map((teamId) => ({
  teamId,
  villagerIds: villagers.filter((v) => v.team === teamId).map((v) => v.id),
}))

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const rcon = (cmd) =>
  execFileSync('docker', ['exec', 'ai-civilization-engine-minecraft-1', 'rcon-cli', cmd], { encoding: 'utf8' }).trim()

function produce(action, params, timeoutMs) {
  const commandId = uuidv7()
  const envelope = {
    eventId: commandId,
    eventType: 'ActionRequested',
    schemaVersion: 1,
    occurredAt: new Date().toISOString(),
    source: 'agent-service',
    aggregateType: 'Villager',
    aggregateId: drill.id,
    correlationId: uuidv7(),
    causationId: null,
    payload: { commandId, villagerId: drill.id, action, params, timeoutMs },
  }
  execFileSync(
    'docker',
    ['exec', '-i', 'ai-civilization-engine-redpanda-1', 'rpk', 'topic', 'produce', 'commands.minecraft', '-k', drill.id],
    { input: JSON.stringify(envelope) + '\n', stdio: ['pipe', 'ignore', 'inherit'] },
  )
  console.log(`  -> ${action} ${JSON.stringify(params)} (command ${commandId})`)
  return commandId
}

async function attemptStatus() {
  return (await fetch(`${MC}/internal/attempt`)).json()
}

async function waitForMilestone(name, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const status = await attemptStatus()
    if ((status.milestones ?? []).some((m) => m.endsWith(`:${name}`))) {
      console.log(`  ✓ milestone ${name}`)
      return true
    }
    await sleep(2_000)
  }
  return false
}

/** One ladder step with a retry: the body's failures are honest and often
 *  retryable (placement flake, reflex bounce) — a rig test re-asks. Every
 *  expected milestone gets its own window before any retry decision (an
 *  early break once retried a craft whose WIN milestone had already fired,
 *  because the furnace one hadn't). */
async function step(action, params, timeoutMs, milestones) {
  for (let tries = 0; tries < 3; tries++) {
    produce(action, params, timeoutMs)
    const missing = []
    for (const name of milestones) {
      if (!(await waitForMilestone(name, 100_000))) {
        missing.push(name)
      }
    }
    if (missing.length === 0) {
      return
    }
    console.log(`  … ${action} left ${missing.join('+')} unlanded — retrying`)
  }
  throw new Error(`${action} never landed ${milestones.join('+')} after 3 tries`)
}

// ---------------------------------------------------------------- preflight
console.log('— preflight —')
const health = await (await fetch(`${MC}/healthz`)).json()
if (health.status !== 'UP') {
  throw new Error('minecraft-service is not healthy')
}
const difficultyLine = rcon('difficulty')
const difficulty = (difficultyLine.match(/is (\w+)/)?.[1] ?? 'unknown').toLowerCase()
console.log(`difficulty: ${difficulty} · service UP`)

// A stale attempt (a previous drill that died mid-run) blocks start — close
// it honestly as aborted.
const stale = await attemptStatus()
if (stale.active) {
  console.log(`aborting stale attempt ${stale.attemptId}`)
  await fetch(`${MC}/internal/attempt/end`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ outcome: 'aborted', honestRace: { budgetTrippedDelta: 0, fakeProviderDelta: 0 } }),
  })
}

// Fen may not be embodied (outside the ticked fleet) — spawn is idempotent.
produce('spawn', { minecraftUsername: drill.minecraftUsername }, 30_000)
for (let i = 0; i < 15; i++) {
  await sleep(2_000)
  if (rcon('list').includes(drill.minecraftUsername)) {
    break
  }
  if (i === 14) {
    throw new Error(`${drill.minecraftUsername} never appeared in the player list`)
  }
}
console.log(`${drill.minecraftUsername} is in the world`)

// ------------------------------------------------------------------ staging
// First drill run taught this the hard way: Fen spawned on a powder-snow
// mountain at dusk among five skeletons — the gather bounced off the combat
// reflex and Fen fled into the snow (reflexes 1, drill 0). The rig is a
// calm, flat dirt pad above the terrain: no mobs, no snow, no slopes. The
// drill tests the race machinery, not survival.
console.log('— staging (RCON) —')
rcon('time set day')
rcon('weather clear')
rcon('gamerule doMobSpawning false')
for (const hostile of ['skeleton', 'zombie', 'creeper', 'spider', 'stray', 'phantom', 'drowned', 'witch']) {
  rcon(`kill @e[type=minecraft:${hostile}]`)
}

const posRaw = rcon(`data get entity ${drill.minecraftUsername} Pos`)
const [x, groundY, z] = [...posRaw.matchAll(/(-?\d+(?:\.\d+)?)d/g)].map((m) => Math.floor(Number(m[1])))
const PAD_Y = 220 // above any local terrain
console.log(`building the staging pad at (${x}, ${PAD_Y}, ${z})`)
// Second drill run taught THIS the hard way: ores embedded in a one-block
// floor turn the dig site into a trapdoor — Fen mined the coal, stepped
// onto the hole to collect, and fell 85 blocks into the very powder snow
// the pad was built to escape. Thick floor; ores sit ON the pad like
// surface boulders, so digging them never breaches the deck.
rcon(`fill ${x - 5} ${PAD_Y - 3} ${z - 5} ${x + 5} ${PAD_Y - 1} ${z + 5} minecraft:dirt`)
rcon(`fill ${x - 5} ${PAD_Y} ${z - 5} ${x + 5} ${PAD_Y + 3} ${z + 5} minecraft:air`)
rcon(`tp ${drill.minecraftUsername} ${x} ${PAD_Y} ${z}`)
await sleep(4_000) // let the client's chunk cache catch up with the fills

// A clean pack is part of the rig: five drill iterations of kits plus
// spawn-area scavenging once handed Fen enough loose iron ingots to craft
// the pickaxe WITHOUT smelting — a polluted pack tests nothing.
console.log('  ' + rcon(`clear ${drill.minecraftUsername}`))

// One coal boulder and three iron, standing on the deck beside the bot.
const ores = [
  { dx: 3, dz: 0, block: 'coal_ore' },
  { dx: 4, dz: 1, block: 'iron_ore' },
  { dx: 4, dz: -1, block: 'iron_ore' },
  { dx: 5, dz: 0, block: 'iron_ore' },
]
for (const { dx, dz, block } of ores) {
  console.log('  ' + (rcon(`setblock ${x + dx} ${PAD_Y} ${z + dz} minecraft:${block}`) || `setblock ${block}`))
}
// The kit: tools + chain inputs the earlier ladder would have produced. The
// smelt fuel is the coal the bot is about to MINE — not given.
for (const item of ['stone_pickaxe 1', 'stick 2', 'crafting_table 1', 'furnace 1']) {
  console.log('  ' + rcon(`give ${drill.minecraftUsername} minecraft:${item}`))
}

// ------------------------------------------------------------------ attempt
console.log('— attempt —')
const startRes = await fetch(`${MC}/internal/attempt/start`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ label: 'rb1-exit-drill', difficulty, teams }),
})
const started = await startRes.json()
if (!startRes.ok) {
  throw new Error(`attempt/start refused: ${JSON.stringify(started)}`)
}
console.log(`attempt ${started.attemptId} started`)

console.log('— the ladder —')
await step('gather', { resource: 'coal', maxDistance: 16, count: 1 }, 60_000, ['first_coal'])
await step('gather', { resource: 'iron_ore', maxDistance: 16, count: 3 }, 60_000, ['first_iron_ore'])
await step('craft', { item: 'iron_pickaxe' }, 60_000, ['furnace_placed', 'first_ingot', 'iron_pickaxe'])

const status = await attemptStatus()
console.log(`win recorded: ${JSON.stringify(status.win)}`)

// honestRace deltas: the drill stack runs no deliberation for Fen and no
// breaker can trip in a two-minute rig test — RB-2's harness computes these
// from Prometheus for real races; the drill records the honest zeros.
const endRes = await fetch(`${MC}/internal/attempt/end`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ outcome: 'won', honestRace: { budgetTrippedDelta: 0, fakeProviderDelta: 0 } }),
})
const ended = await endRes.json()
if (!endRes.ok) {
  throw new Error(`attempt/end refused: ${JSON.stringify(ended)}`)
}
console.log(`attempt ended: ${JSON.stringify(ended.payload)}`)

// ------------------------------------------------------- ledger verification
console.log('— ledger verification (event-service) —')
await sleep(3_000) // let the consumer drain
const page = await (
  await fetch(`${LEDGER}/events?aggregate-type=Attempt&aggregate-id=${started.attemptId}&limit=50`)
).json()
const byType = {}
for (const event of page.data) {
  byType[event.eventType] = (byType[event.eventType] ?? 0) + 1
}
console.log(`attempt ${started.attemptId} in the ledger: ${JSON.stringify(byType)}`)
const milestones = page.data
  .filter((e) => e.eventType === 'ProgressionMilestone')
  .map((e) => `${e.payload.milestone} (${e.payload.teamId}, causation ${e.causationId})`)
console.log(milestones.map((m) => `  ${m}`).join('\n'))

const expected = ['first_coal', 'first_iron_ore', 'furnace_placed', 'first_ingot', 'iron_pickaxe']
const present = page.data.filter((e) => e.eventType === 'ProgressionMilestone').map((e) => e.payload.milestone)
const missing = expected.filter((m) => !present.includes(m))
if (byType.AttemptStarted !== 1 || byType.AttemptEnded !== 1 || missing.length > 0) {
  throw new Error(`ledger incomplete — missing: ${missing.join(', ') || 'lifecycle events'}`)
}
const winEvent = page.data.find((e) => e.eventType === 'AttemptEnded')
console.log(`winningEventId ${winEvent.payload.winningEventId} — fetching the proof…`)
const proof = await (await fetch(`${LEDGER}/events/${winEvent.payload.winningEventId}`)).json()
console.log(
  `  proof: ${proof.eventType}{action:${proof.payload.action}, item:${proof.payload.result?.item}, crafted:${proof.payload.result?.crafted}, smelted:${proof.payload.result?.smelted}}`,
)

// ------------------------------------------------------------------ cleanup
rcon('gamerule doMobSpawning true')
rcon(`tp ${drill.minecraftUsername} ${x} ${groundY} ${z}`) // off the pad first, then remove it
rcon(`fill ${x - 5} ${PAD_Y - 3} ${z - 5} ${x + 5} ${PAD_Y + 3} ${z + 5} minecraft:air`)
console.log('cleanup done (mob spawning restored, pad removed)')

console.log('\nRB-1 EXIT DRILL PASSED — full T1 ladder in the ledger, replayable by attemptId.')
