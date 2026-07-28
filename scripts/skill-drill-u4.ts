// U4 demo drill — REAL killMob primitive over live mineflayer-pvp.
// Shell summons pigs near the bot; killMob finds, engages via bot.pvp,
// confirms the kill, sweeps drops. pvpStop on every exit path.
// Run: npx tsx scripts/skill-drill-u4.ts [mobName] [kills]
import mineflayer from 'mineflayer'
import mineflayerPathfinder from 'mineflayer-pathfinder'
import { plugin as pvpPlugin } from 'mineflayer-pvp'
import {
  killMob,
  type KillMobDeps,
} from '../services/minecraft-service/src/skills/primitives/killMob.ts'
import type { SkillInvocationContext } from '../services/minecraft-service/src/skills/types.ts'
import mineflayerPathfinderPkg from 'mineflayer-pathfinder'
const { pathfinder, Movements, goals } = mineflayerPathfinderPkg

const mobName = process.argv[2] ?? 'pig'
const kills = Number(process.argv[3] ?? 2)

const log = (event: string, data: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data }))

const bot = mineflayer.createBot({
  host: 'localhost', port: 25565, username: 'skill_drill', version: '1.21.6', auth: 'offline',
})
bot.loadPlugin(pathfinder)
bot.loadPlugin(pvpPlugin as any)

let collectedEvents = 0
bot.on('playerCollect', (collector) => {
  if (collector.id === bot.entity?.id) collectedEvents += 1
})

bot.once('spawn', async () => {
  log('spawned', { username: bot.username })
  bot.pathfinder.setMovements(new Movements(bot))
  await new Promise((r) => setTimeout(r, 8000)) // settle + stock window

  const deps: KillMobDeps = {
    findNearestMob: (name, maxDistance) => {
      const e = bot.nearestEntity(
        (ent: any) => ent?.name === name && ent.position.distanceTo(bot.entity.position) <= maxDistance,
      )
      return e ? { id: e.id, position: { x: e.position.x, y: e.position.y, z: e.position.z } } : null
    },
    pvpAttack: async (mobId) => {
      const e = bot.entities[mobId]
      if (!e) throw new Error('mob vanished before engagement')
      ;(bot as any).pvp.attack(e)
    },
    pvpStop: async () => { await (bot as any).pvp.stop() },
    mobGone: (mobId) => !bot.entities[mobId],
    collectNearbyDrops: async () => {
      const before = collectedEvents
      const items = Object.values(bot.entities).filter(
        (e: any) => e?.name === 'item' && e.position.distanceTo(bot.entity.position) < 10,
      )
      for (const item of items.slice(0, 4)) {
        try {
          await bot.pathfinder.goto(new goals.GoalNear(item.position.x, item.position.y, item.position.z, 0))
        } catch { /* drop unreachable */ }
      }
      await new Promise((r) => setTimeout(r, 1200))
      return collectedEvents - before
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  }

  const ctx: SkillInvocationContext = {
    biome: null,
    timeOfDay: Math.round(bot.time.timeOfDay),
    heldTool: bot.heldItem?.name ?? null,
    hostileCount: 0,
    position: {
      x: Math.round(bot.entity.position.x),
      y: Math.round(bot.entity.position.y),
      z: Math.round(bot.entity.position.z),
    },
  }

  // Equip the sword the shell gave us — visible combat beats fists.
  const sword = bot.inventory.items().find((i) => i.name.endsWith('_sword'))
  if (sword) { await bot.equip(sword, 'hand'); log('equipped', { item: sword.name }) }

  for (let k = 0; k < kills; k++) {
    log('killMob_invoke', { mobName, attempt: k + 1 })
    const result = await killMob(deps, { mobName, timeoutMs: 60_000 }, ctx)
    log('killMob_result', { attempt: k + 1, ...result })
    if (!result.ok) break
    await new Promise((r) => setTimeout(r, 2500))
  }

  log('demo_complete', { inventory: bot.inventory.items().map((i) => `${i.name}x${i.count}`) })
  setTimeout(() => { bot.quit(); process.exit(0) }, 3000)
})

bot.on('kicked', (r) => { log('kicked', { reason: String(r) }); process.exit(1) })
bot.on('error', (e: any) => { log('bot_error', { error: String(e?.message ?? e) }); process.exit(1) })
