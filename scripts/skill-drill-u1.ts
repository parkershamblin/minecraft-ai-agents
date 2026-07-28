// U1 demo drill — runs the REAL mineBlock primitive (services/minecraft-service/
// src/skills/primitives/mineBlock.ts) against the live world with real
// mineflayer deps. Run with: npx tsx scripts/skill-drill-u1.ts [blockName] [count]
// Defaults: tries wood log species in WOOD_LOGS order until one is present.
import mineflayer from 'mineflayer'
import mineflayerPathfinder from 'mineflayer-pathfinder'
import * as toolPkg from 'mineflayer-tool'
import minecraftData from 'minecraft-data'
import { Vec3 } from 'vec3'
import {
  mineBlock,
  type MineBlockDeps,
} from '../services/minecraft-service/src/skills/primitives/mineBlock.ts'
import { guardedBlock, WOOD_LOGS } from '../services/minecraft-service/src/skills/names.ts'
import type { SkillInvocationContext, SkillPosition } from '../services/minecraft-service/src/skills/types.ts'

const { pathfinder, Movements, goals } = mineflayerPathfinder
const toolPlugin = (toolPkg as any).plugin ?? (toolPkg as any).default ?? toolPkg

const argName = process.argv[2]
const argCount = Number(process.argv[3] ?? 3)

const log = (event: string, data: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data }))

const bot = mineflayer.createBot({
  host: 'localhost',
  port: 25565,
  username: 'skill_drill',
  version: '1.21.6',
  auth: 'offline',
})
bot.loadPlugin(pathfinder)
bot.loadPlugin(toolPlugin)

let collectedEvents = 0
bot.on('playerCollect', (collector) => {
  if (collector.id === bot.entity?.id) collectedEvents += 1
})

bot.once('spawn', async () => {
  const mcData = minecraftData(bot.version)
  log('spawned', { username: bot.username, version: bot.version })

  const movements = new Movements(bot)
  bot.pathfinder.setMovements(movements)

  const { mineflayer: mineflayerViewer } = await import('prismarine-viewer')
  mineflayerViewer(bot, { port: 3100, firstPerson: false, viewDistance: 5 })
  log('viewer_ready', { url: 'http://localhost:3100' })
  await new Promise((r) => setTimeout(r, 6000)) // let the viewer connect + camera settle

  const deps: MineBlockDeps = {
    resolveBlock: (name) => guardedBlock(mcData as any, name),
    findBlocks: (blockId, maxDistance, count) =>
      bot.findBlocks({ matching: blockId, maxDistance, count }).map((v) => ({ x: v.x, y: v.y, z: v.z })),
    gotoBlock: async (pos, timeoutMs) => {
      const goal = new goals.GoalLookAtBlock(new Vec3(pos.x, pos.y, pos.z), bot.world)
      let timer: NodeJS.Timeout | undefined
      try {
        const timeout = new Promise<'timeout'>((res) => {
          timer = setTimeout(() => {
            bot.pathfinder.stop()
            res('timeout')
          }, Math.max(1, timeoutMs))
        })
        const walk = bot.pathfinder.goto(goal).then(() => 'arrived' as const)
        const result = await Promise.race([walk, timeout])
        return result
      } catch (err: any) {
        return String(err?.name ?? err).includes('NoPath') ? 'path_not_found' : 'path_not_found'
      } finally {
        clearTimeout(timer)
      }
    },
    equipBestToolFor: async (pos) => {
      const block = bot.blockAt(new Vec3(pos.x, pos.y, pos.z))
      if (!block) return 'none_needed'
      if (!block.harvestTools) {
        // hand-harvestable — still equip the best tool for speed if we have one
        try { await (bot as any).tool.equipForBlock(block) } catch { /* fine */ }
        return 'none_needed'
      }
      try {
        await (bot as any).tool.equipForBlock(block, { requireHarvest: true })
        return 'equipped'
      } catch {
        return 'missing'
      }
    },
    dig: async (pos) => {
      const block = bot.blockAt(new Vec3(pos.x, pos.y, pos.z))
      if (!block || block.name === 'air') return 'blocked'
      try {
        await bot.dig(block)
        return 'dug'
      } catch {
        return 'blocked'
      }
    },
    collectNearbyDrops: async () => {
      const before = collectedEvents
      const items = Object.values(bot.entities).filter(
        (e: any) => e?.name === 'item' && e.position.distanceTo(bot.entity.position) < 8,
      )
      for (const item of items.slice(0, 4)) {
        try {
          await bot.pathfinder.goto(new goals.GoalNear(item.position.x, item.position.y, item.position.z, 0))
        } catch { /* drop may despawn or be unreachable */ }
      }
      await new Promise((r) => setTimeout(r, 1200)) // pickup latency
      return collectedEvents - before
    },
    now: () => Date.now(),
  }

  const ctx: SkillInvocationContext = {
    biome: (bot.blockAt(bot.entity.position) as any)?.biome?.name ?? null,
    timeOfDay: Math.round(bot.time.timeOfDay),
    heldTool: bot.heldItem?.name ?? null,
    hostileCount: Object.values(bot.entities).filter((e: any) => e?.kind === 'Hostile mobs').length,
    position: { x: Math.round(bot.entity.position.x), y: Math.round(bot.entity.position.y), z: Math.round(bot.entity.position.z) } as SkillPosition,
  }
  log('context_captured', { ...ctx })

  const namesToTry = argName ? [argName] : [...WOOD_LOGS]
  for (const name of namesToTry) {
    log('mineBlock_invoke', { name, count: argCount })
    const result = await mineBlock(deps, { name, count: argCount }, ctx)
    log('mineBlock_result', { name, ...result })
    if (result.ok || result.failureCode !== 'RESOURCE_NOT_FOUND') break
  }

  log('demo_complete', {
    inventory: bot.inventory.items().map((i) => `${i.name}x${i.count}`),
  })
  setTimeout(() => { bot.quit(); process.exit(0) }, 3000)
})

bot.on('kicked', (r) => { log('kicked', { reason: String(r) }); process.exit(1) })
bot.on('error', (e: any) => { log('bot_error', { error: String(e?.message ?? e) }); process.exit(1) })
