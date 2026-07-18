// RB-2 fast brain drill (ADR-10) — the isolated single-bot honest race.
//
// The full 3v3 race takes 11-75 minutes because six brains bootstrap from
// scattered forests at a 10s tick with real Ollama contention, plus long
// walks. This drill keeps the race HONEST (real brain, fresh attempt, brain
// sees a true 0/5 checklist) but collapses the wall clock: ONE bot, everyone
// else despawned (no Ollama contention for its team's milestones), on a safe
// flat pad with wood + coal + stone + iron ALL within reach, so the ladder is
// pure decision-making with the walking and the danger removed.
//
// It answers the tuning question a live race answers — "does the race brain
// actually climb the ladder?" — in single-digit minutes instead of an hour.
// For pure prompt logic at an exact rung use the OFFLINE replay instead
// (services/agent-service: uv run python scripts/replay_race_brain.py), and
// for body/chain bugs mid-ladder use drill-rb1.mjs (raw commands, brain out).
//
// Usage:
//   node scripts/drill-rb2.mjs [--bot Elara] [--stall-minutes 8] [--label rb2-drill]
//
// Exit code: 0 won · 2 stalled · 3 preflight/staging failed.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { v7 as uuidv7 } from 'uuid'

const MC = 'http://localhost:8003'
const AGENT = 'http://localhost:8001'
const LEDGER = 'http://localhost:8081'

const args = process.argv.slice(2)
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : fallback
}
const botName = flag('bot', 'Elara')
const stallMinutes = Number(flag('stall-minutes', '8'))
const label = flag('label', 'rb2-drill')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const rcon = (cmd) =>
  execFileSync('docker', ['exec', 'ai-civilization-engine-minecraft-1', 'rcon-cli', cmd], { encoding: 'utf8' }).trim()

const villagers = JSON.parse(
  readFileSync(new URL('../services/agent-service/seed/villagers.json', import.meta.url), 'utf8'),
).filter((v) => v.team)
const drill = villagers.find((v) => v.name === botName)
if (!drill) {
  console.error(`${botName} has no team in villagers.json — pass a racer with --bot`)
  process.exit(3)
}
const teams = ['red', 'blue'].map((teamId) => ({
  teamId,
  villagerIds: villagers.filter((v) => v.team === teamId).map((v) => v.id),
}))

// Raw command producer (drill-rb1's pattern) — used only for spawn/despawn to
// SHAPE the world; the ladder itself is never commanded, the brain drives it.
function produce(villagerId, action, params, timeoutMs = 30_000) {
  const commandId = uuidv7()
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
    payload: { commandId, villagerId, action, params, timeoutMs },
  }
  execFileSync(
    'docker',
    ['exec', '-i', 'ai-civilization-engine-redpanda-1', 'rpk', 'topic', 'produce', 'commands.minecraft', '-k', villagerId],
    { input: JSON.stringify(envelope) + '\n', stdio: ['pipe', 'ignore', 'inherit'] },
  )
}

async function metricLines(url) {
  return (await (await fetch(url)).text()).split('\n')
}

// ---------------------------------------------------------------- preflight
console.log(`— RB-2 brain drill (bot: ${botName}) —`)
const health = await (await fetch(`${MC}/healthz`)).json()
if (health.status !== 'UP') {
  console.error('minecraft-service not healthy')
  process.exit(3)
}
const difficultyLine = rcon('difficulty')
const difficulty = (difficultyLine.match(/is (\w+)/)?.[1] ?? 'unknown').toLowerCase()
console.log(`difficulty ${difficulty} · service UP`)

// A stale attempt blocks start — close it honestly.
const stale = await (await fetch(`${MC}/internal/attempt`)).json()
if (stale.active) {
  console.log(`aborting stale attempt ${stale.attemptId}`)
  await fetch(`${MC}/internal/attempt/end`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ outcome: 'aborted', honestRace: { budgetTrippedDelta: 0, fakeProviderDelta: 0 } }),
  })
}

// ------------------------------------------------------------------ isolate
// Despawn every OTHER racer so only this bot's team can cross a milestone and
// so its ticks don't queue behind five other deliberations at the LLM. Their
// brains still tick (VILLAGER_COUNT is env), but bodiless commands fail
// harmlessly — for a still-faster loop set VILLAGER_COUNT=1 and recreate
// agent-service (see HANDOFF fast-cycle notes).
console.log('— isolating the drill bot —')
for (const v of villagers) {
  if (v.id !== drill.id) {
    produce(v.id, 'despawn', {})
  }
}
produce(drill.id, 'spawn', { minecraftUsername: drill.minecraftUsername })
for (let i = 0; i < 15; i++) {
  await sleep(2_000)
  if (rcon('list').includes(drill.minecraftUsername)) {
    break
  }
  if (i === 14) {
    console.error(`${drill.minecraftUsername} never appeared in the world`)
    process.exit(3)
  }
}
console.log(`${drill.minecraftUsername} is in the world; others despawned`)

// -------------------------------------------------------------- dense arena
// A calm, flat, resource-dense pad (drill-rb1's staging lessons: thick floor
// so mined ores never trapdoor the deck; day + no mobs + no snow — the drill
// tests the ladder, not survival). Everything the ladder needs sits within a
// few blocks: logs (wood + planks + sticks + table), coal, a stone slab (the
// stone-tier gate + the furnace's cobblestone), and three iron ore. The bot
// is GIVEN nothing — an honest bootstrap from a fresh 0/5 checklist.
console.log('— dense arena (RCON) —')
rcon('time set day')
rcon('weather clear')
rcon('gamerule doMobSpawning false')
rcon('gamerule keepInventory true')
for (const hostile of ['skeleton', 'zombie', 'creeper', 'spider', 'stray', 'phantom', 'drowned', 'witch', 'enderman']) {
  rcon(`kill @e[type=minecraft:${hostile}]`)
}

const posRaw = rcon(`data get entity ${drill.minecraftUsername} Pos`)
const [x, groundY, z] = [...posRaw.matchAll(/(-?\d+(?:\.\d+)?)d/g)].map((m) => Math.floor(Number(m[1])))
const PAD_Y = 220
console.log(`building the arena at (${x}, ${PAD_Y}, ${z})`)
rcon(`fill ${x - 8} ${PAD_Y - 3} ${z - 8} ${x + 8} ${PAD_Y - 1} ${z + 8} minecraft:dirt`)
rcon(`fill ${x - 8} ${PAD_Y} ${z - 8} ${x + 8} ${PAD_Y + 4} ${z + 8} minecraft:air`)
rcon(`tp ${drill.minecraftUsername} ${x} ${PAD_Y} ${z}`)
await sleep(3_000) // let the client's chunk cache catch up with the fills
console.log('  ' + rcon(`clear ${drill.minecraftUsername}`)) // an honest, empty pack
rcon(`spawnpoint ${drill.minecraftUsername} ${x} ${PAD_Y} ${z}`)

// A stone slab for the tier gate + furnace, plus resource boulders on the deck.
rcon(`fill ${x - 6} ${PAD_Y} ${z + 3} ${x - 3} ${PAD_Y + 1} ${z + 6} minecraft:stone`)
// Slack matters (drill №3 lesson): the exact-minimum pad left zero margin, so
// one wasted craft (a second furnace) plus the two picks' stick spend beached
// the smelt rung with nothing left to gather. The real race has forests and
// caves; density is for compressing WALKING, not for rationing.
const resources = [
  { dx: 2, dz: 0, block: 'oak_log' }, { dx: 3, dz: 0, block: 'oak_log' },
  { dx: 2, dz: 1, block: 'oak_log' }, { dx: 3, dz: 1, block: 'oak_log' },
  { dx: 2, dz: -1, block: 'oak_log' }, { dx: 3, dz: -1, block: 'oak_log' },
  { dx: 2, dz: 2, block: 'oak_log' }, { dx: 3, dz: 2, block: 'oak_log' },
  { dx: 2, dz: -2, block: 'oak_log' }, { dx: 3, dz: -2, block: 'oak_log' },
  { dx: 5, dz: 0, block: 'coal_ore' }, { dx: 5, dz: 1, block: 'coal_ore' },
  { dx: 5, dz: -1, block: 'coal_ore' }, { dx: 5, dz: 2, block: 'coal_ore' },
  { dx: 6, dz: 0, block: 'iron_ore' }, { dx: 6, dz: 1, block: 'iron_ore' },
  { dx: 6, dz: -1, block: 'iron_ore' }, { dx: 6, dz: 2, block: 'iron_ore' },
]
for (const { dx, dz, block } of resources) {
  rcon(`setblock ${x + dx} ${PAD_Y} ${z + dz} minecraft:${block}`)
}
console.log(`  staged: 10 oak_log · 4 coal_ore · 4 iron_ore · a stone slab — all within 8 blocks`)

// ------------------------------------------------------------------ attempt
console.log('— attempt (brain-driven, zero commands from here) —')
const startRes = await fetch(`${MC}/internal/attempt/start`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ label, difficulty, teams }),
})
const started = await startRes.json()
if (!startRes.ok) {
  console.error(`attempt/start refused: ${JSON.stringify(started)}`)
  process.exit(3)
}
console.log(`attempt ${started.attemptId} STARTED — watching ${drill.name}'s ladder, stall watchdog ${stallMinutes}m`)

const startedAt = Date.now()
let lastMilestoneAt = Date.now()
const seenMilestones = new Set()
let outcome = null

// Decision histogram for the drill bot, so a stall is diagnosable ("40 moves,
// 0 gathers" reads the brain's failure at a glance) — pulled from the ledger.
async function verbHistogram() {
  // The ledger caps limit at 100 (a 200 comes back as a 400 problem-json —
  // cost two drills a silent `{}` histogram); a 10m drill stays well under it.
  const since = encodeURIComponent(new Date(startedAt).toISOString())
  const res = await fetch(
    `${LEDGER}/events?aggregate-type=Villager&aggregate-id=${drill.id}&type=DecisionMade&since=${since}&limit=100`,
  )
  const page = await res.json()
  if (!res.ok) {
    console.error(`  (histogram query failed: ${page.detail ?? res.status})`)
    return {}
  }
  const verbs = {}
  for (const e of (page.data ?? [])) {
    const verb = (e.payload.decision ?? '').split(' ')[0] || 'idle'
    verbs[verb] = (verbs[verb] ?? 0) + 1
  }
  return verbs
}

while (true) {
  await sleep(15_000)
  const status = await (await fetch(`${MC}/internal/attempt`)).json()
  for (const m of (status.milestones ?? [])) {
    if (!seenMilestones.has(m)) {
      seenMilestones.add(m)
      console.log(`  [${Math.round((Date.now() - startedAt) / 60000)}m] milestone: ${m}`)
      lastMilestoneAt = Date.now()
    }
  }
  if (status.win) {
    outcome = 'won'
    console.log(`WIN recorded: ${JSON.stringify(status.win)}`)
    break
  }
  if (Date.now() - lastMilestoneAt > stallMinutes * 60_000) {
    outcome = 'stalled'
    console.log(`stall watchdog: no new milestone in ${stallMinutes}m`)
    break
  }
}

const verbs = await verbHistogram()
await fetch(`${MC}/internal/attempt/end`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    outcome,
    honestRace: { budgetTrippedDelta: 0, fakeProviderDelta: 0 },
  }),
})

// ------------------------------------------------------------------ cleanup
rcon('gamerule doMobSpawning true')
rcon(`tp ${drill.minecraftUsername} ${x} ${groundY} ${z}`)
rcon(`fill ${x - 8} ${PAD_Y - 3} ${z - 8} ${x + 8} ${PAD_Y + 4} ${z + 8} minecraft:air`)

console.log('\n— drill result —')
console.log(`outcome: ${outcome.toUpperCase()} in ${Math.round((Date.now() - startedAt) / 60000)}m`)
console.log(`milestones crossed: ${[...seenMilestones].sort().join(', ') || 'none'}`)
console.log(`${drill.name}'s decisions this attempt: ${JSON.stringify(verbs)}`)
console.log('mob spawning restored, arena removed. Re-embody the fleet with: node scripts/spawn-fleet.mjs')
process.exit(outcome === 'won' ? 0 : 2)
