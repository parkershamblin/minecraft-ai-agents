// RB-2 attempt harness (ADR-10): run one honest, unattended Red-vs-Blue race
// to the first crafted iron pickaxe, with the enumerated pre-flight checklist
// executed and VERIFIED (never assumed), the attempt stamped in the ledger,
// a stall watchdog, and the honest-race deltas read from Prometheus.
//
// Usage:
//   node scripts/race-rb2.mjs [--label take-1] [--difficulty easy|normal]
//     [--red x,y,z] [--blue x,y,z] [--separation 300] [--stall-minutes 75]
//     [--practice]   (practice: skip the hard budget/tick preset checks)
//     [--mobs]       (restore hostile spawns — default is a mob-free race)
//
// Team posts default to world spawn ± separation/2 on the x axis. Exit code:
// 0 won · 2 stalled · 3 aborted/failed preflight.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const MC = 'http://localhost:8003'
const AGENT = 'http://localhost:8001'
const LEDGER = 'http://localhost:8081'

const args = process.argv.slice(2)
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : fallback
}
const has = (name) => args.includes(`--${name}`)

const label = flag('label', `rb2-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}`)
const wantDifficulty = flag('difficulty', 'easy')
const separation = Number(flag('separation', '300'))
// 75m default: attempt 3's wood age needed ~45m before its first milestone —
// 45m was nearly the whole bootstrap, so a slow-but-honest start read as a stall.
const stallMinutes = Number(flag('stall-minutes', '75'))
const practice = has('practice')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const rcon = (cmd) =>
  execFileSync('docker', ['exec', 'ai-civilization-engine-minecraft-1', 'rcon-cli', cmd], { encoding: 'utf8' }).trim()
const inContainer = (container, ...cmd) =>
  execFileSync('docker', ['exec', `ai-civilization-engine-${container}-1`, ...cmd], { encoding: 'utf8' }).trim()

const failures = []
const check = (ok, what, detail) => {
  console.log(`  [${ok ? '✓' : '✗'}] ${what}${detail ? ` — ${detail}` : ''}`)
  if (!ok) {
    failures.push(what)
  }
  return ok
}

async function metricValue(url, name, labelFilter = '') {
  const text = await (await fetch(url)).text()
  let sum = 0
  let found = false
  for (const line of text.split('\n')) {
    if (line.startsWith(name) && line.includes(labelFilter)) {
      const v = Number(line.trim().split(/\s+/).pop())
      if (!Number.isNaN(v)) {
        sum += v
        found = true
      }
    }
  }
  return found ? sum : 0
}

// ------------------------------------------------------------- the checklist
console.log(`— preflight checklist (label: ${label}) —`)

const villagers = JSON.parse(
  readFileSync(new URL('../services/agent-service/seed/villagers.json', import.meta.url), 'utf8'),
).filter((v) => v.team)
const teams = ['red', 'blue'].map((teamId) => ({
  teamId,
  members: villagers.filter((v) => v.team === teamId),
}))
check(
  teams.every((t) => t.members.length === 3),
  'rosters: 3v3 from villagers.json team fields',
  teams.map((t) => `${t.teamId}: ${t.members.map((m) => m.name).join('/')}`).join(' · '),
)

check((await (await fetch(`${MC}/healthz`)).json()).status === 'UP', 'minecraft-service healthy')
check((await (await fetch(`${AGENT}/healthz`).catch(() => ({ json: () => ({}) }))).json()).status !== undefined, 'agent-service healthy')

// connection-throttle -1: the reconnect-herd killer (CLAUDE.md).
const throttle = inContainer('minecraft', 'sh', '-c', 'grep connection-throttle /data/bukkit.yml')
check(throttle.includes('-1'), 'connection-throttle is -1', throttle.trim())

// The LLM must be real: an honest race has zero fake-provider decisions.
const agentEnv = inContainer('agent-service', 'printenv')
const provider = (agentEnv.match(/^LLM_PROVIDER=(.*)$/m) ?? [])[1] ?? 'auto'
check(provider !== 'fake', `LLM_PROVIDER is real (${provider})`)
const budget = Number((agentEnv.match(/^LLM_DAILY_TOKEN_BUDGET=(.*)$/m) ?? [])[1] ?? 0)
check(practice || budget >= 100_000_000, 'LLM_DAILY_TOKEN_BUDGET at the Ollama race preset (>=1e8)', String(budget))
const villagerCount = Number((agentEnv.match(/^VILLAGER_COUNT=(.*)$/m) ?? [])[1] ?? 0)
check(villagerCount >= 6, 'VILLAGER_COUNT covers both rosters (>=6)', String(villagerCount))
const tick = Number((agentEnv.match(/^TICK_INTERVAL_SECONDS=(.*)$/m) ?? [])[1] ?? 0)
check(practice || tick <= 30, 'race tick (TICK_INTERVAL_SECONDS <= 30)', String(tick))

// Gamerules: set, then read back — level.dat can override assumptions.
rcon('gamerule keepInventory true')
rcon('gamerule doInsomnia false')
rcon('gamerule mobGriefing false') // protects placed furnaces from creepers
check(rcon('gamerule keepInventory').includes('true'), 'keepInventory true (lossless respawn)')
check(rcon('gamerule doInsomnia').includes('false'), 'doInsomnia false (no phantom swarms)')
check(rcon('gamerule mobGriefing').includes('false'), 'mobGriefing false (furnaces survive creepers)')

// Hostiles: OFF by default. Attempt-4 measured the threat tax: 254 commands
// failed SELF_DEFENSE_IN_PROGRESS in 32 minutes — the fleet spent more wall
// time fleeing than mining. A race measures the resource ladder, not mob
// dodging; pass --mobs to restore hostiles for the flagship's realism.
if (has('mobs')) {
  rcon('gamerule doMobSpawning true')
  check(rcon('gamerule doMobSpawning').includes('true'), 'doMobSpawning true (--mobs: flagship realism)')
} else {
  rcon('gamerule doMobSpawning false')
  for (const type of [
    'zombie', 'skeleton', 'creeper', 'spider', 'cave_spider', 'witch', 'drowned', 'enderman',
    'phantom', 'pillager', 'zombie_villager', 'creaking', 'slime', 'husk', 'stray', 'bogged',
  ]) {
    rcon(`kill @e[type=${type}]`)
  }
  check(rcon('gamerule doMobSpawning').includes('false'), 'doMobSpawning false (mob-free race — --mobs restores them)')
}

// Difficulty: set → save-all → verify (the in-memory-until-save trap).
rcon(`difficulty ${wantDifficulty}`)
rcon('save-all')
const difficultyLine = rcon('difficulty')
const difficulty = (difficultyLine.match(/is (\w+)/)?.[1] ?? 'unknown').toLowerCase()
check(difficulty === wantDifficulty, `difficulty verified via RCON (${wantDifficulty})`, difficultyLine)

if (failures.length > 0) {
  console.error(`\npreflight FAILED: ${failures.join(' · ')}`)
  process.exit(3)
}

// ------------------------------------------------------- seed + far spawns
console.log('— seeding + stationing —')
await fetch(`${AGENT}/internal/seed`, { method: 'POST' })
for (let i = 0; i < 40; i++) {
  await sleep(3_000)
  const online = rcon('list')
  if (villagers.every((v) => online.includes(v.minecraftUsername))) {
    break
  }
  if (i === 39) {
    console.error('not all 6 racers came online')
    process.exit(3)
  }
}
console.log('all 6 racers online')

// Posts are explicit (--red/--blue) or auto-located: the nearest FOREST to a
// symmetric anchor on each side of the origin. Attempt-1 lesson: blind
// ±separation/2 posts landed both teams on treeless mountainside — "no wood
// within 48 blocks" strangles the bootstrap before the first milestone. A
// race needs trees more than it needs geometric purity; symmetry is
// approximate (both teams get the nearest forest to equal-distance anchors).
function locateForest(anchorX, anchorZ) {
  const out = rcon(`execute positioned ${anchorX} 100 ${anchorZ} run locate biome #minecraft:is_forest`)
  const m = out.match(/\[(-?\d+), (~|-?\d+), (-?\d+)\]/)
  if (!m) {
    console.error(`could not locate a forest near ${anchorX},${anchorZ}: ${out}`)
    process.exit(3)
  }
  return [Number(m[1]), null, Number(m[3])]
}
const posts = {
  red: flag('red') ? flag('red').split(',').map(Number) : locateForest(-separation / 2, 0),
  blue: flag('blue') ? flag('blue').split(',').map(Number) : locateForest(separation / 2, 0),
}
{
  const [rx, , rz] = posts.red
  const [bx, , bz] = posts.blue
  const apart = Math.round(Math.hypot(rx - bx, rz - bz))
  console.log(`  posts: red ${rx},${rz} · blue ${bx},${bz} · ${apart} blocks apart`)
  if (apart < separation / 3) {
    console.error(`  posts landed too close (${apart} < ${Math.round(separation / 3)}) — both anchors found the same forest; pass --red/--blue explicitly`)
    process.exit(3)
  }
}
// Stationing is VERIFIED, then made sticky by a state-reset respawn.
// Attempt-2 lesson: a tp lands, but a racer mid-pathfind keeps its
// in-flight goal (computed at the old position) and WALKS 150 blocks back
// off the post — both early attempts silently raced on the barren spawn
// mountain. So: spreadplayers with distance verification and retry, anchor
// the spawnpoint at the verified post, clear the pack, then `kill` — with
// nothing carried the respawn is lossless and resets every in-flight goal
// at the post. A racer that can't be stationed fails the launch loudly.
const posOf = (name) => {
  // matchAll + capture group: .match(/…d/g) returns the FULL match with the
  // trailing 'd', and Number('-152.5d') is NaN — that one letter cost a take.
  const m = [...rcon(`data get entity ${name} Pos`).matchAll(/(-?\d+(?:\.\d+)?)d/g)]
  return m.length === 3 ? m.map((match) => Math.floor(Number(match[1]))) : null
}
for (const { teamId, members } of teams) {
  const [x, y, z] = posts[teamId]
  for (const m of members) {
    let stationed = false
    for (let attempt = 0; attempt < 5 && !stationed; attempt++) {
      if (y !== null) {
        rcon(`tp ${m.minecraftUsername} ${x} ${y} ${z}`)
      } else {
        // Growing radius: under dense canopy (dark forest) small radii can
        // find no legal surface and fail — the output says so, so log it.
        const radius = 8 * (attempt + 1)
        const out = rcon(`spreadplayers ${x} ${z} 0 ${radius} false ${m.minecraftUsername}`)
        if (!out.startsWith('Spread')) {
          console.log(`  spreadplayers r=${radius} for ${m.minecraftUsername}: ${out}`)
        }
      }
      await sleep(1_500)
      const at = posOf(m.minecraftUsername)
      if (!at || Math.hypot(at[0] - x, at[2] - z) > 24) {
        console.log(`  station check ${m.minecraftUsername} try ${attempt + 1}: at ${JSON.stringify(at)} vs post ${x},${z}`)
      }
      if (at && Math.hypot(at[0] - x, at[2] - z) <= 24) {
        rcon(`spawnpoint ${m.minecraftUsername} ${at[0]} ${at[1]} ${at[2]}`)
        rcon(`clear ${m.minecraftUsername}`)
        rcon(`kill ${m.minecraftUsername}`) // nothing carried; the respawn resets pathfinding at the post
        stationed = true
      }
    }
    if (!stationed) {
      console.error(`  could not station ${m.minecraftUsername} at ${x},${z}`)
      process.exit(3)
    }
  }
  console.log(`  team ${teamId} stationed at x=${x} z=${z} (verified), packs cleared, spawnpoints anchored`)
}
// Post-respawn verification: every racer back online AND standing at its
// post. At the 10s race tick a brain can fire DURING this wait and walk its
// bot off the post before we read it (Wren drifted 54 blocks on the first
// 10s-tick attempt) — a walker is not a stationing failure, so correct with
// a tp and re-verify instead of aborting the take.
await sleep(8_000)
for (const { teamId, members } of teams) {
  const [x, , z] = posts[teamId]
  for (const m of members) {
    let atPost = false
    for (let attempt = 0; attempt < 4 && !atPost; attempt++) {
      const at = posOf(m.minecraftUsername)
      if (at && Math.hypot(at[0] - x, at[2] - z) <= 32) {
        atPost = true
        break
      }
      console.log(`  ${m.minecraftUsername} wandered off the ${teamId} post (${at}) — spread back (try ${attempt + 1})`)
      // spreadplayers, not tp: it finds a legal SURFACE spot at the post —
      // a raw tp to the wanderer's y-level could bury them in a hillside.
      rcon(`spreadplayers ${x} ${z} 0 8 false ${m.minecraftUsername}`)
      await sleep(1_500)
    }
    if (!atPost) {
      console.error(`  ${m.minecraftUsername} cannot be kept at the ${teamId} post`)
      process.exit(3)
    }
  }
}
console.log('  respawn verification: all 6 racers standing at their posts')

// --------------------------------------------------------------- the attempt
console.log('— attempt —')
const fakeBefore = await metricValue(`${AGENT}/metrics`, 'civ_llm_latency_seconds_count', 'provider="fake"')
let budgetTrippedSeen = 0

const stale = await (await fetch(`${MC}/internal/attempt`)).json()
if (stale.active) {
  await fetch(`${MC}/internal/attempt/end`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ outcome: 'aborted', honestRace: { budgetTrippedDelta: 0, fakeProviderDelta: 0 } }),
  })
  console.log(`stale attempt ${stale.attemptId} aborted`)
}

const startRes = await fetch(`${MC}/internal/attempt/start`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    label,
    difficulty,
    teams: teams.map((t) => ({ teamId: t.teamId, villagerIds: t.members.map((m) => m.id) })),
  }),
})
const started = await startRes.json()
if (!startRes.ok) {
  console.error(`attempt/start refused: ${JSON.stringify(started)}`)
  process.exit(3)
}
console.log(`attempt ${started.attemptId} STARTED — ${teams.map((t) => t.teamId).join(' vs ')}, ${difficulty}, stall watchdog ${stallMinutes}m`)
console.log('zero human intervention from here — watching the ledger.')

const startedAt = Date.now()
let lastMilestoneAt = Date.now()
const seenMilestones = new Set()
let outcome = null

while (true) {
  await sleep(20_000)
  const status = await (await fetch(`${MC}/internal/attempt`)).json()
  const tripped = await metricValue(`${AGENT}/metrics`, 'civ_llm_budget_tripped')
  if (tripped > 0) {
    budgetTrippedSeen = 1
  }
  // status.milestones is a SORTED set, not an append-log — a slice(seenCount)
  // tail re-prints old rungs and swallows new ones that sort into the middle
  // (attempt 6 printed red:first_coal twice and blue:first_iron_ore never).
  // Diff against a seen-set instead.
  const milestones = status.milestones ?? []
  for (const m of milestones) {
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

const fakeAfter = await metricValue(`${AGENT}/metrics`, 'civ_llm_latency_seconds_count', 'provider="fake"')
const honestRace = { budgetTrippedDelta: budgetTrippedSeen, fakeProviderDelta: Math.max(0, fakeAfter - fakeBefore) }
const endRes = await fetch(`${MC}/internal/attempt/end`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ outcome, honestRace }),
})
const ended = await endRes.json()
console.log(`attempt ENDED: ${JSON.stringify(ended.payload ?? ended)}`)

// --------------------------------------------------------------- the receipt
const page = await (
  await fetch(`${LEDGER}/events?aggregate-type=Attempt&aggregate-id=${started.attemptId}&limit=50`)
).json()
console.log(`ledger slice (${page.data.length} events):`)
for (const e of page.data) {
  const p = e.payload
  const line =
    e.eventType === 'ProgressionMilestone'
      ? `${p.milestone} — ${p.teamId} (${p.detail ?? ''})`
      : e.eventType === 'AttemptEnded'
        ? `${p.outcome}${p.winningTeamId ? ` by ${p.winningTeamId}` : ''} in ${p.durationSeconds}s, honest ${JSON.stringify(p.honestRace)}`
        : `${p.difficulty} · ${(p.teams ?? []).map((t) => t.teamId).join(' vs ')}`
  console.log(`  ${e.occurredAt} ${e.eventType}: ${line}`)
}
const honest = honestRace.budgetTrippedDelta === 0 && honestRace.fakeProviderDelta === 0
console.log(`\nRACE ${outcome.toUpperCase()} — honest-race assertion: ${honest ? 'CLEAN' : 'POLLUTED'} ${JSON.stringify(honestRace)}`)
process.exit(outcome === 'won' ? 0 : 2)
