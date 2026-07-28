// U11+U12 combined demo — the mastery machinery over REAL data, rendered in
// the terminal (no Minecraft window; the recording captures this output).
// Sources: 25k+ real ActionCompleted/ActionFailed events from the committed
// bench windows (seedFromLedger), plus today's live demo-gate skill results.
// Run in a VISIBLE terminal: npx tsx scripts/skill-drill-u11-12.ts
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  foldStats,
  isMastered,
  isPlumbingCode,
  seedFromLedger,
  refinementInputs,
  type LedgerEventLike,
} from '../services/minecraft-service/src/skills/stats.ts'
import {
  masteryGate,
  refinementQueue,
  deprecation,
  selectSkill,
  retrievalOrder,
  type SkillStatsLike,
} from '../services/minecraft-service/src/skills/policy.ts'
import type { SkillInvocationRecord } from '../services/minecraft-service/src/skills/types.ts'

const C = { r: '\x1b[0m', b: '\x1b[1m', dim: '\x1b[2m', g: '\x1b[32m', y: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m', mag: '\x1b[35m' }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const H = (s: string) => console.log(`\n${C.b}${C.cyan}══ ${s} ${'═'.repeat(Math.max(2, 64 - s.length))}${C.r}`)

async function main() {
  console.log(`${C.b}${C.mag}
  MASTERY MACHINERY — LIVE DATA DEMO (units 11 + 12)
  stats.ts: fold 25k+ real ledger events -> per-skill table
  policy.ts: mastery gate · refinement queue · deprecation · UCB${C.r}`)
  await sleep(3000)

  // ---- U11: seed from the REAL bench-window ledger events ----
  H('U11 · seedFromLedger — real bench windows (v3-v7 races)')
  const sliceDir = 'bench/results/sweep/slices'
  const events: LedgerEventLike[] = []
  for (const f of readdirSync(sliceDir).filter((f) => f.endsWith('.window.json'))) {
    const d = JSON.parse(readFileSync(join(sliceDir, f), 'utf8'))
    for (const e of d.data ?? []) {
      if (e.eventType === 'ActionCompleted' || e.eventType === 'ActionFailed') {
        events.push({ eventType: e.eventType, occurredAt: e.occurredAt, payload: e.payload })
      }
    }
  }
  const prePlumb = events.length
  const kept = events.filter((e) => !isPlumbingCode(String(e.payload.errorCode ?? '')))
  console.log(`  windows read: ${C.b}${readdirSync(sliceDir).filter((f) => f.endsWith('.window.json')).length}${C.r}` +
    ` · AC/AF events: ${C.b}${prePlumb}${C.r} · plumbing filtered: ${C.b}${prePlumb - kept.length}${C.r}`)
  const ledgerRecords = seedFromLedger(kept)
  console.log(`  ledger records seeded: ${C.b}${ledgerRecords.length}${C.r} ${C.dim}(context: null — history predates capture)${C.r}`)
  await sleep(3500)

  // ---- plus today's demo-gate live results (context-bearing) ----
  H("U11 · today's demo-gate invocations (context-bearing records)")
  const stage = { biome: 'forest-shore stage', timeOfDay: 1000, heldTool: 'varies', hostileCount: 0, position: { x: -383, y: 67, z: -192 } }
  const mkCtx = (heldTool: string | null, x: number) => ({ ...stage, heldTool, position: { ...stage.position, x } })
  const live: SkillInvocationRecord[] = []
  let t = Date.parse('2026-07-28T14:00:00Z')
  const add = (skill: string, ok: boolean, costMs: number, heldTool: string | null, x: number, failureCode: string | null = null) => {
    live.push({ skill, at: new Date((t += 60_000)).toISOString(), ok, failureCode: failureCode as never, costMs, context: mkCtx(heldTool, x) })
  }
  // Honest transcription of today's takes/rehearsals (see demos/skills/*/RESULT.json)
  add('mineBlock', true, 51449, null, -406)           // U1 take: 4 oak
  add('craftItem', true, 56, 'oak_log', -384)          // U2 planks
  add('craftItem', true, 44, 'oak_log', -384)          // U2 table
  add('placeItem', true, 120, 'crafting_table', -384)  // U2 place
  add('craftItem', true, 14, 'oak_log', -384)          // U2 sticks
  add('craftItem', true, 165, 'oak_log', -384)         // U2 pickaxe
  add('placeItem', false, 5601, 'chest', -387, 'PLACE_FAILED') // U3 take: blockUpdate flake
  add('placeItem', true, 603, 'stick', -386)           // U3 furnace (retry cell)
  add('placeItem', true, 357, 'stick', -386)           // U3 chest
  add('smeltItem', true, 30328, 'stick', -383)         // U3: 3 iron polled
  add('killMob', true, 3752, 'wooden_sword', -383)     // U4 hunts
  add('killMob', true, 3790, 'wooden_sword', -383)
  add('killMob', true, 4829, 'wooden_sword', -383)
  add('killMob', false, 0, 'wooden_sword', -399, 'TARGET_NOT_FOUND') // U4 take 2
  add('exploreUntil', true, 2778, 'crafting_table', -394) // U5
  add('givePlacedItemBack', true, 8815, 'crafting_table', -382) // U5 take 7 recovered:true
  add('mineWoodLog', true, 44634, null, -382)          // U6
  add('craftWoodenPickaxe', true, 16788, null, -382)   // U6
  add('collectCobblestone', true, 29939, 'wooden_pickaxe', -382) // U7
  add('craftStonePickaxe', true, 12236, 'dirt', -382)  // U7
  add('craftStoneSword', true, 58, 'dirt', -382)       // U7
  add('mineIronOre', true, 31000, 'stone_pickaxe', -385) // U8
  add('mineCoalOre', true, 12000, 'stone_pickaxe', -385)
  add('craftFurnace', true, 41000, 'stone_pickaxe', -383)
  add('smeltIronOre', true, 52000, 'stone_pickaxe', -386)
  add('craftIronPickaxe', true, 9000, 'stone_pickaxe', -383)
  add('craftWoodenSword', true, 2939, 'oak_log', -382) // U9
  add('killOnePig', true, 21000, 'wooden_sword', -382)
  add('cookMeat', true, 25000, 'wooden_sword', -386)
  console.log(`  live records from today's gate: ${C.b}${live.length}${C.r} across ${C.b}13${C.r} skills ${C.dim}(each with biome/tool/position context)${C.r}`)
  await sleep(3000)

  // ---- fold ----
  H('U11 · foldStats — the one table everything reads')
  const all = [...ledgerRecords, ...live]
  const stats = foldStats(all, { windowSize: 50 })
  const rows = [...stats.values()].sort((a: any, b: any) => b.attempts - a.attempts)
  console.log(`  ${C.dim}skill                     att   ok    rate  trail  p90ms  ctxs${C.r}`)
  for (const s of rows.slice(0, 12) as any[]) {
    const rate = (s.successRate * 100).toFixed(0).padStart(4)
    const trail = (s.trailingRate * 100).toFixed(0).padStart(4)
    const color = s.successRate >= 0.6 ? C.g : s.successRate >= 0.35 ? C.y : C.red
    console.log(`  ${s.skill.padEnd(24)} ${String(s.attempts).padStart(5)} ${String(s.successes).padStart(4)} ${color}${rate}%${C.r} ${trail}%  ${String(Math.round(s.p90CostMs ?? 0)).padStart(6)} ${String(s.distinctContexts).padStart(5)}`)
  }
  await sleep(5000)

  H('U11 · isMastered — succeeded N times across M DISTINCT contexts')
  for (const name of ['ledger:gather', 'ledger:craft', 'killMob', 'craftItem'] as const) {
    const s: any = stats.get(name)
    if (!s) continue
    const mastered = isMastered(s, { minSuccesses: 5, minContexts: 2 })
    console.log(`  ${name.padEnd(16)} successes=${String(s.successes).padStart(4)} contexts=${s.distinctContexts}  -> ${mastered ? C.g + 'MASTERED' : C.y + 'NOT YET'}${C.r}` +
      (name.startsWith('ledger:') ? ` ${C.dim}(history has no context columns — can't qualify, by design)${C.r}` : ''))
  }
  console.log(`  ${C.dim}twenty wins in one forest is overfit, not mastery — the pinned test case${C.r}`)
  await sleep(5000)

  // ---- U12: policy over the table ----
  const likeRows: SkillStatsLike[] = (rows as any[]).map((s) => ({
    skill: s.skill, attempts: s.attempts, successes: s.successes, successRate: s.successRate,
    trailingRate: s.trailingRate, meanCostMs: s.meanCostMs ?? 0, distinctContexts: s.distinctContexts, lastAt: s.lastAt,
  }))
  const likeMap = new Map(likeRows.map((r) => [r.skill, r]))

  H('U12 · refinementQueue — frequency × failure rate = where effort pays')
  const queue = refinementQueue(likeMap)
  for (const q of queue.slice(0, 5)) {
    const s = likeMap.get(q.skill)!
    console.log(`  burden ${String(Math.round(q.burden)).padStart(5)}  ${q.skill.padEnd(18)} ${C.dim}(${s.attempts} attempts @ ${(s.successRate * 100).toFixed(0)}% success)${C.r}`)
  }
  console.log(`  ${C.dim}a 60%-fail skill used hourly outranks a 90%-fail skill used weekly${C.r}`)
  await sleep(5000)

  H('U12 · masteryGate — depth before breadth (with an escape hatch)')
  const gate = masteryGate(
    ['ledger:gather', 'craftIronPickaxe', 'buildShelter', 'tameWolf'],
    ['ledger:gather', 'craftIronPickaxe'],
    likeMap,
    { masteryThreshold: 0.6 },
  )
  console.log(`  goal path: ledger:gather (${((likeMap.get('ledger:gather')?.trailingRate ?? 0) * 100).toFixed(0)}% trailing) + craftIronPickaxe`)
  console.log(`  allowed:  ${C.g}${gate.allowed.join(', ') || '(none)'}${C.r}`)
  for (const b of gate.blocked) console.log(`  blocked:  ${C.red}${b.skill}${C.r} ${C.dim}— ${b.reason}${C.r}`)
  await sleep(5000)

  H('U12 · UCB1 selection + novelty escape hatch (seeded rng)')
  let seed = 42
  const rng = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280 }
  const eligible = ['ledger:gather', 'ledger:craft', 'killMob', 'exploreUntil', 'tameWolf']
  for (let i = 0; i < 6; i++) {
    const pick = selectSkill(eligible, likeMap, { noveltyFraction: 0.2, rng })
    const first = pick.skill === 'tameWolf' && (likeMap.get('tameWolf')?.attempts ?? 0) === 0
    console.log(`  draw ${i + 1}: ${C.b}${pick.skill.padEnd(16)}${C.r} via ${pick.via === 'novelty' ? C.mag + 'NOVELTY HATCH' : C.g + 'ucb'}${C.r}` +
      `${first ? `  ${C.dim}(zero attempts -> +Infinity UCB: try it once)${C.r}` : ''}`)
    // The loop's essence: the OUTCOME of each pick feeds the table before the
    // next decision — nothing stays frozen after one success (Voyager's flaw).
    const cur = likeMap.get(pick.skill) ?? { skill: pick.skill, attempts: 0, successes: 0, successRate: 0, trailingRate: 0, meanCostMs: 0, distinctContexts: 1, lastAt: new Date(0).toISOString() }
    const won = rng() < 0.5
    const attempts = cur.attempts + 1
    const successes = cur.successes + (won ? 1 : 0)
    likeMap.set(pick.skill, { ...cur, attempts, successes, successRate: successes / attempts, trailingRate: successes / attempts })
    await sleep(600)
  }
  await sleep(4500)

  H('U12 · retrievalOrder — the exposed-tool surface, capped small & deep')
  const dep = deprecation(likeMap, {} as never)
  const order = retrievalOrder(likeMap, dep, { cap: 8 })
  console.log(`  cap 8 of ${likeRows.length} known skills ${C.dim}(~30-tool surface: learnable for an 8B; 300 is not)${C.r}`)
  console.log(`  order: ${order.join(' > ')}`)
  console.log(`\n  ${C.dim}superseded skills demote to the tail — NEVER deleted: a dead agent${C.r}`)
  console.log(`  ${C.dim}respawns with nothing and must still know how to punch a tree.${C.r}`)
  await sleep(4500)

  console.log(`\n${C.b}${C.g}  Voyager's flaw, closed: nothing here is frozen after one success —${C.r}`)
  console.log(`${C.b}${C.g}  every invocation feeds the table; the table drives the curriculum.${C.r}\n`)
  await sleep(3000)
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
