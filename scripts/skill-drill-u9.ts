// U9 demo drill — food + combat composed skills over live primitives:
// craftWoodenSword -> killOnePig (live bot.pvp) -> cookMeat (porkchop at the
// standing furnace). Camera: spectator demo-cam (combat demo, U4's stage).
// Run: npx tsx scripts/skill-drill-u9.ts
import mineflayer from 'mineflayer'
import mineflayerPathfinderPkg from 'mineflayer-pathfinder'
import { plugin as pvpPlugin } from 'mineflayer-pvp'
import minecraftData from 'minecraft-data'
import { Vec3 } from 'vec3'
import { craftItem as craftItemPrimitive, type CraftItemDeps, type Recipe } from '../services/minecraft-service/src/skills/primitives/craftItem.ts'
import { killMob as killMobPrimitive, type KillMobDeps } from '../services/minecraft-service/src/skills/primitives/killMob.ts'
import { smeltItem as smeltItemPrimitive, type SmeltItemDeps, type FurnaceHandle } from '../services/minecraft-service/src/skills/primitives/smeltItem.ts'
import { killOnePig, type KillOnePigPrimitives } from '../services/minecraft-service/src/skills/library/killOnePig.ts'
import { cookMeat, type CookMeatPrimitives } from '../services/minecraft-service/src/skills/library/cookMeat.ts'
import { craftWoodenSword, type CraftWoodenSwordPrimitives } from '../services/minecraft-service/src/skills/library/craftWoodenSword.ts'
import { guardedItem } from '../services/minecraft-service/src/skills/names.ts'
import { skillFail } from '../services/minecraft-service/src/skills/types.ts'
import type { SkillInvocationContext } from '../services/minecraft-service/src/skills/types.ts'

const { pathfinder, Movements, goals } = mineflayerPathfinderPkg

const log = (event: string, data: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data }))

const bot = mineflayer.createBot({
  host: 'localhost', port: 25565, username: 'skill_drill', version: '1.21.6', auth: 'offline',
})
bot.loadPlugin(pathfinder)
bot.loadPlugin(pvpPlugin as any)

const pickupCounts = new Map<string, number>()
bot.on('playerCollect', (c, collected: any) => {
  if (c.id !== bot.entity?.id) return
  const name = collected?.getDroppedItem?.()?.name ?? 'unknown'
  pickupCounts.set(name, (pickupCounts.get(name) ?? 0) + 1)
})

bot.once('spawn', async () => {
  const mcData = minecraftData(bot.version) as any
  log('spawned', { username: bot.username })
  bot.pathfinder.setMovements(new Movements(bot))
  await new Promise((r) => setTimeout(r, 8000))

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

  const reachGuardGoto = async (pos: { x: number; y: number; z: number }, timeoutMs: number): Promise<boolean> => {
    const center = new Vec3(pos.x + 0.5, pos.y + 0.5, pos.z + 0.5)
    if (bot.entity.position.distanceTo(center) <= 4) {
      try { await bot.lookAt(center) } catch { /* fine */ }
      return true
    }
    try {
      let timer: NodeJS.Timeout | undefined
      const t = new Promise<boolean>((res) => { timer = setTimeout(() => { bot.pathfinder.stop(); res(false) }, Math.max(1, timeoutMs)) })
      const w = bot.pathfinder.goto(new goals.GoalLookAtBlock(new Vec3(pos.x, pos.y, pos.z), bot.world)).then(() => true)
      const r = await Promise.race([w, t]); clearTimeout(timer); return r
    } catch { return false }
  }

  const recipeMap = new Map<Recipe, any>()
  const tableId = mcData.blocksByName.crafting_table.id
  const findTableBlock = (maxDistance: number) => bot.findBlock({ matching: tableId, maxDistance }) ?? null
  const craftDeps: CraftItemDeps = {
    resolveItem: (name) => guardedItem(mcData, name),
    recipesFor: (itemId, tableNearby) => {
      const mfRecipes = (bot as any).recipesAll(itemId, null, tableNearby ? true : null)
      return mfRecipes.map((mf: any) => {
        const ingredients = (mf.delta as Array<{ id: number; count: number }>)
          .filter((d) => d.count < 0)
          .map((d) => ({ itemId: d.id, name: mcData.items[d.id]?.name ?? String(d.id), count: -d.count }))
        const structural: Recipe = { requiresTable: Boolean(mf.requiresTable), ingredients }
        recipeMap.set(structural, mf)
        return structural
      })
    },
    craft: async (recipe, count) => {
      const mf = recipeMap.get(recipe)
      if (!mf) return 'failed'
      try {
        const table = recipe.requiresTable ? findTableBlock(32) : null
        await bot.craft(mf, count, table ?? undefined)
        return 'crafted'
      } catch (err: any) { log('craft_throw', { error: String(err?.message ?? err) }); return 'failed' }
    },
    countInventory: (itemId) => bot.inventory.count(itemId, null),
    findCraftingTable: (maxDistance) => {
      const b = findTableBlock(maxDistance)
      return b ? { x: b.position.x, y: b.position.y, z: b.position.z } : null
    },
    gotoBlock: async (pos, timeoutMs) => (await reachGuardGoto(pos, timeoutMs)) ? 'arrived' : 'failed',
    now: () => Date.now(),
  }

  const killDeps: KillMobDeps = {
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
      const before = pickupCounts.get('porkchop') ?? 0
      await new Promise((r) => setTimeout(r, 900))
      const items = Object.values(bot.entities).filter(
        (e: any) => e?.name === 'item' && e.position.distanceTo(bot.entity.position) < 10,
      )
      for (const item of items.slice(0, 3)) {
        // Promise.race the walk — an unreachable drop must not wedge the hunt
        // (the executor's watchdog lesson, in miniature).
        try {
          let timer: NodeJS.Timeout | undefined
          const t = new Promise((res) => { timer = setTimeout(() => { bot.pathfinder.stop(); res(null) }, 8000) })
          await Promise.race([bot.pathfinder.goto(new goals.GoalNear(item.position.x, item.position.y, item.position.z, 0)), t])
          clearTimeout(timer)
        } catch { /* gone */ }
      }
      await new Promise((r) => setTimeout(r, 1500))
      return Math.max(0, (pickupCounts.get('porkchop') ?? 0) - before)
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  }

  const smeltDeps: SmeltItemDeps = {
    resolveItem: (name) => guardedItem(mcData, name),
    findFurnace: (maxDistance) => {
      const b = bot.findBlock({ matching: mcData.blocksByName.furnace.id, maxDistance })
      return b ? { x: b.position.x, y: b.position.y, z: b.position.z } : null
    },
    gotoBlock: reachGuardGoto,
    openFurnace: async (pos) => {
      try {
        const block = bot.blockAt(new Vec3(pos.x, pos.y, pos.z))
        if (!block) return null
        const furnace: any = await bot.openFurnace(block)
        const handle: FurnaceHandle = {
          putInput: async (itemId, count) => { await furnace.putInput(itemId, null, count) },
          putFuel: async (itemId, count) => {
            try { await furnace.putFuel(itemId, null, count) } catch (err: any) { log('putFuel_note', { note: String(err?.message ?? err) }) }
          },
          outputCount: () => furnace.outputItem()?.count ?? 0,
          takeOutput: async () => { await furnace.takeOutput() },
          close: async () => { furnace.close() },
        }
        return handle
      } catch { return null }
    },
    countInventory: (itemId) => bot.inventory.count(itemId, null),
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  }

  const recipeYieldFor = (itemId: number): number => {
    const mf = (bot as any).recipesAll(itemId, null, true)[0]
    return mf?.result?.count ?? 1
  }

  const primitives: KillOnePigPrimitives & CookMeatPrimitives & CraftWoodenSwordPrimitives = {
    killMob: (params) => killMobPrimitive(killDeps, params, ctx),
    smeltItem: async ({ itemName, count, fuelName }) =>
      smeltItemPrimitive(smeltDeps, { itemName, fuelName: fuelName ?? 'oak_planks', count }, ctx),
    craftItem: async ({ itemName, count }) => {
      const lookup = guardedItem(mcData, itemName)
      if (!lookup.ok) return skillFail(lookup.failureCode, lookup.detail, 0, ctx)
      const items = Math.max(1, Math.floor(count ?? 1))
      const applications = Math.max(1, Math.ceil(items / recipeYieldFor(lookup.value.id)))
      const r = await craftItemPrimitive(craftDeps, { name: itemName, count: applications }, ctx)
      // Inventory packets settle asynchronously after a craft — without this,
      // the NEXT step's countInventory reads stale totals (live-take race).
      await new Promise((res) => setTimeout(res, 600))
      return r
    },
  }

  const invoke = async (label: string, fn: () => Promise<unknown>) => {
    log(`${label}_invoke`, {})
    await new Promise((r) => setTimeout(r, 2500))
    const result = await fn()
    log(`${label}_result`, result as Record<string, unknown>)
    await new Promise((r) => setTimeout(r, 1500))
    return result as any
  }

  const sword = await invoke('craftWoodenSword', () => craftWoodenSword(primitives, {}, ctx))
  if (!sword.ok) return finish()
  const s = bot.inventory.items().find((i) => i.name === 'wooden_sword')
  if (s) await bot.equip(s, 'hand')

  const pig = await invoke('killOnePig', () => killOnePig(primitives, {}, ctx))
  if (!pig.ok) return finish()

  await invoke('cookMeat', () => cookMeat(primitives, { meat: 'porkchop', count: 1 }, ctx))

  finish()
  function finish() {
    log('demo_complete', { inventory: bot.inventory.items().map((i) => `${i.name}x${i.count}`) })
    setTimeout(() => { bot.quit(); process.exit(0) }, 3000)
  }
})

bot.on('kicked', (r) => { log('kicked', { reason: String(r) }); process.exit(1) })
bot.on('error', (e: any) => { log('bot_error', { error: String(e?.message ?? e) }); process.exit(1) })
