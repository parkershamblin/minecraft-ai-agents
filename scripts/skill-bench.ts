// Skill-chain benchmark — instruction step 3: run the race course through the
// PORTED SKILLS and let version drift surface as failures. Cold start per
// run: fresh spawn spot, EMPTY inventory, no staged materials, no RCON gifts.
// Chain runs through the ASSEMBLED registry (src/skills/registry.ts) — this
// is the assembly's first integration exercise. Zero LLM calls.
// The T1 metric: time to iron_pickaxe.
// Run: npx tsx scripts/skill-bench.ts [runs]
import mineflayer from 'mineflayer'
import mineflayerPathfinderPkg from 'mineflayer-pathfinder'
import * as toolPkg from 'mineflayer-tool'
import * as collectPkg from 'mineflayer-collectblock'
import { plugin as pvpPlugin } from 'mineflayer-pvp'
import minecraftData from 'minecraft-data'
import { writeFileSync, mkdirSync } from 'node:fs'
import { createSkillRegistry } from '../services/minecraft-service/src/skills/registry.ts'
import { foldStats, refinementInputs } from '../services/minecraft-service/src/skills/stats.ts'
import type { SkillInvocationRecord } from '../services/minecraft-service/src/skills/types.ts'

const { pathfinder, Movements } = mineflayerPathfinderPkg
const toolPlugin = (toolPkg as any).plugin ?? (toolPkg as any).default ?? toolPkg
const collectPlugin = (collectPkg as any).plugin ?? (collectPkg as any).default ?? collectPkg

const RUNS = Number(process.argv[2] ?? 3)
const RUN_CAP_MS = 12 * 60_000
const log = (event: string, data: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data }))

interface StepOutcome { skill: string; ok: boolean; failureCode?: string; detail?: string; costMs: number; recovered?: boolean }
interface RunOutcome { run: number; won: boolean; totalMs: number; ironPickaxe: boolean; steps: StepOutcome[]; endReason: string }

async function benchRun(run: number, allRecords: SkillInvocationRecord[]): Promise<RunOutcome> {
  const bot = mineflayer.createBot({
    host: 'localhost', port: 25565, username: 'skill_bench', version: '1.21.6', auth: 'offline',
  })
  bot.loadPlugin(pathfinder)
  bot.loadPlugin(toolPlugin)
  bot.loadPlugin(collectPlugin)
  bot.loadPlugin(pvpPlugin as any)

  const steps: StepOutcome[] = []
  const started = Date.now()
  let endReason = 'completed'

  const done = new Promise<void>((resolve) => {
    bot.once('spawn', async () => {
      const mcData = minecraftData(bot.version) as any
      bot.pathfinder.setMovements(new Movements(bot))
      // Cold-start staging: the shell teleports each run to fresh forest.
      // Wait for that jump (>20 blocks) before racing the chain against it.
      const spawnPos = bot.entity.position.clone()
      const stagedBy = Date.now() + 30_000
      while (Date.now() < stagedBy && bot.entity.position.distanceTo(spawnPos) < 20) {
        await new Promise((r) => setTimeout(r, 500))
      }
      log('staged', { run, jumped: Math.round(bot.entity.position.distanceTo(spawnPos)) })
      await new Promise((r) => setTimeout(r, 2500))
      const reg = createSkillRegistry(bot, mcData, (rec) => allRecords.push(rec))

      const invoke = async (name: string, params: Record<string, unknown> = {}): Promise<StepOutcome> => {
        const r: any = await reg.invoke(name, params)
        const step: StepOutcome = { skill: name, ok: r.ok, costMs: r.costMs }
        if (!r.ok) { step.failureCode = r.failureCode; step.detail = String(r.detail).slice(0, 160) }
        steps.push(step)
        log('step', { run, ...step })
        return step
      }

      // Library-composed prospecting: when an ore skill can't see its ore,
      // exploreUntil legs outward with a find-predicate, then the miner
      // retries — the library answering its own gap, as a caller would.
      const withProspecting = async (mineSkill: string, oreNames: string[], count: number): Promise<StepOutcome> => {
        let step = await invoke(mineSkill, { count })
        if (step.ok || step.failureCode !== 'RESOURCE_NOT_FOUND') return step
        const ids = oreNames.map((n) => mcData.blocksByName[n]?.id).filter(Boolean)
        for (const direction of [{ x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, { x: -1, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }]) {
          const explored: any = await reg.invoke('exploreUntil', {
            direction, maxTimeMs: 45_000,
            predicate: () => {
              const found = bot.findBlocks({ matching: ids, maxDistance: 24, count: 1 })
              return found.length > 0 ? { at: found[0] } : null
            },
          })
          steps.push({ skill: 'exploreUntil', ok: explored.ok, costMs: explored.costMs, ...(explored.ok ? {} : { failureCode: explored.failureCode }) })
          if (explored.ok) {
            step = await invoke(mineSkill, { count })
            step.recovered = step.ok
            if (step.ok) return step
          }
        }
        return step
      }

      const capTimer = setTimeout(() => { endReason = 'RUN_CAP'; bot.quit() }, RUN_CAP_MS)
      try {
        // THE RACE COURSE, skills only. Treeless spawns (2/6 in the first
        // sweeps) get the same library-composed answer as ore: explore, retry.
        const logIds = Object.keys(mcData.blocksByName)
          .filter((n) => n.endsWith('_log') || n === 'bamboo_block')
          .map((n) => mcData.blocksByName[n].id)
        let wood = await invoke('mineWoodLog', { count: 4 })
        if (!wood.ok && wood.failureCode === 'RESOURCE_NOT_FOUND') {
          for (const direction of [{ x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, { x: -1, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }]) {
            const explored: any = await reg.invoke('exploreUntil', {
              direction, maxTimeMs: 45_000,
              predicate: () => (bot.findBlocks({ matching: logIds, maxDistance: 24, count: 1 }).length > 0 ? { trees: true } : null),
            })
            steps.push({ skill: 'exploreUntil', ok: explored.ok, costMs: explored.costMs, ...(explored.ok ? {} : { failureCode: explored.failureCode }) })
            if (explored.ok) {
              wood = await invoke('mineWoodLog', { count: 4 })
              if (wood.ok) { wood.recovered = true; break }
            }
          }
        }
        if (!wood.ok) { endReason = `wood:${wood.failureCode}`; return }
        const wpick = await invoke('craftWoodenPickaxe', {})
        if (!wpick.ok) { endReason = `wpick:${wpick.failureCode}`; return }
        const cobble = await invoke('collectCobblestone', { count: 3 })
        if (!cobble.ok) { endReason = `cobble:${cobble.failureCode}`; return }
        const spick = await invoke('craftStonePickaxe', {})
        if (!spick.ok) { endReason = `spick:${spick.failureCode}`; return }
        const iron = await withProspecting('mineIronOre', ['iron_ore', 'deepslate_iron_ore'], 3)
        if (!iron.ok) { endReason = `iron:${iron.failureCode}`; return }
        const coal = await withProspecting('mineCoalOre', ['coal_ore', 'deepslate_coal_ore'], 2)
        if (!coal.ok) { endReason = `coal:${coal.failureCode}`; return }
        const furnace = await invoke('craftFurnace', {})
        if (!furnace.ok) { endReason = `furnace:${furnace.failureCode}`; return }
        const smelt = await invoke('smeltIronOre', { count: 3, fuelName: 'coal' })
        if (!smelt.ok) { endReason = `smelt:${smelt.failureCode}`; return }
        const ipick = await invoke('craftIronPickaxe', {})
        if (!ipick.ok) { endReason = `ipick:${ipick.failureCode}`; return }
      } finally {
        clearTimeout(capTimer)
        resolve()
      }
    })
    bot.on('kicked', (r) => { endReason = `kicked:${String(r).slice(0, 60)}`; resolve() })
    bot.on('error', (e: any) => { endReason = `error:${String(e?.message ?? e).slice(0, 60)}`; resolve() })
  })

  await done
  const ironPickaxe = bot.inventory?.items?.().some((i) => i.name === 'iron_pickaxe') ?? false
  const totalMs = Date.now() - started
  try { bot.quit() } catch { /* gone */ }
  return { run, won: ironPickaxe, totalMs, ironPickaxe, steps, endReason }
}

async function main() {
  const runs: RunOutcome[] = []
  const allRecords: SkillInvocationRecord[] = []
  for (let i = 1; i <= RUNS; i++) {
    log('run_start', { run: i, of: RUNS })
    const outcome = await benchRun(i, allRecords)
    runs.push(outcome)
    log('run_end', { run: i, won: outcome.won, totalMs: outcome.totalMs, endReason: outcome.endReason })
    await new Promise((r) => setTimeout(r, 3000))
  }

  const stats = foldStats(allRecords, { windowSize: 50 })
  const refine = refinementInputs(stats)
  const summary = {
    benchedAt: new Date().toISOString(),
    branch: 'demo-sprint',
    runs: RUNS,
    wins: runs.filter((r) => r.won).length,
    winTimesMs: runs.filter((r) => r.won).map((r) => r.totalMs),
    endReasons: runs.map((r) => r.endReason),
    llmCalls: 0,
    perSkill: [...stats.values()].map((s: any) => ({
      skill: s.skill, attempts: s.attempts, successes: s.successes,
      successRate: Number(s.successRate.toFixed(2)), meanCostMs: Math.round(s.meanCostMs ?? 0),
      failures: Object.fromEntries(s.failureCounts ?? []),
    })),
    refinementQueueTop: refine.slice(0, 3),
    runsDetail: runs,
  }
  mkdirSync('bench/results/skills', { recursive: true })
  const file = `bench/results/skills/skill-bench-${Date.now()}.json`
  writeFileSync(file, JSON.stringify(summary, null, 2))
  log('bench_complete', { file, wins: summary.wins, of: RUNS, winTimesMs: summary.winTimesMs, endReasons: summary.endReasons })
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
