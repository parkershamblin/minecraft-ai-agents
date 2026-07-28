// U2 demo drill — runs the REAL craftItem + placeItem primitives against the
// live world. Chain: oak logs -> planks -> crafting_table -> PLACE the table
// -> sticks -> wooden_pickaxe (table-required recipe: walks to the placed
// table). Run: npx tsx scripts/skill-drill-u2.ts
import mineflayer from 'mineflayer'
import mineflayerPathfinder from 'mineflayer-pathfinder'
import minecraftData from 'minecraft-data'
import { Vec3 } from 'vec3'
import {
  craftItem,
  type CraftItemDeps,
  type Recipe,
} from '../services/minecraft-service/src/skills/primitives/craftItem.ts'
import {
  placeItem,
  type PlaceItemDeps,
} from '../services/minecraft-service/src/skills/primitives/placeItem.ts'
import { guardedItem } from '../services/minecraft-service/src/skills/names.ts'
import type { SkillInvocationContext, SkillPosition } from '../services/minecraft-service/src/skills/types.ts'

const { pathfinder, Movements, goals } = mineflayerPathfinder

const log = (event: string, data: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data }))

const bot = mineflayer.createBot({
  host: 'localhost', port: 25565, username: 'skill_drill', version: '1.21.6', auth: 'offline',
})
bot.loadPlugin(pathfinder)

bot.once('spawn', async () => {
  const mcData = minecraftData(bot.version)
  log('spawned', { username: bot.username })
  bot.pathfinder.setMovements(new Movements(bot))

  const { mineflayer: mineflayerViewer } = await import('prismarine-viewer')
  mineflayerViewer(bot, { port: 3100, firstPerson: true, viewDistance: 5 })
  log('viewer_ready', {})
  await new Promise((r) => setTimeout(r, 10000))

  const tableId = (mcData as any).blocksByName.crafting_table.id
  const findTableBlock = (maxDistance: number) =>
    bot.findBlock({ matching: tableId, maxDistance }) ?? null

  // structural Recipe -> mineflayer recipe, per recipesFor call
  const recipeMap = new Map<Recipe, any>()
  const craftDeps: CraftItemDeps = {
    resolveItem: (name) => guardedItem(mcData as any, name),
    recipesFor: (itemId, tableNearby) => {
      const mfRecipes = (bot as any).recipesAll(itemId, null, tableNearby ? true : null)
      return mfRecipes.map((mf: any) => {
        const ingredients = (mf.delta as Array<{ id: number; count: number }>)
          .filter((d) => d.count < 0)
          .map((d) => ({
            itemId: d.id,
            name: (mcData as any).items[d.id]?.name ?? String(d.id),
            count: -d.count,
          }))
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
      } catch (err: any) {
        log('craft_throw', { error: String(err?.message ?? err) })
        return 'failed'
      }
    },
    countInventory: (itemId) => bot.inventory.count(itemId, null),
    findCraftingTable: (maxDistance) => {
      const b = findTableBlock(maxDistance)
      return b ? { x: b.position.x, y: b.position.y, z: b.position.z } : null
    },
    gotoBlock: async (pos, timeoutMs) => {
      try {
        let timer: NodeJS.Timeout | undefined
        const timeout = new Promise<'failed'>((res) => {
          timer = setTimeout(() => { bot.pathfinder.stop(); res('failed') }, Math.max(1, timeoutMs))
        })
        const walk = bot.pathfinder
          .goto(new goals.GoalLookAtBlock(new Vec3(pos.x, pos.y, pos.z), bot.world))
          .then(() => 'arrived' as const)
        const result = await Promise.race([walk, timeout])
        clearTimeout(timer)
        return result
      } catch { return 'failed' }
    },
    now: () => Date.now(),
  }

  const placeDeps: PlaceItemDeps = {
    resolveItem: (name) => guardedItem(mcData as any, name),
    hasItem: (itemId) => bot.inventory.count(itemId, null) > 0,
    findReferenceBlock: (near) => {
      const target = new Vec3(near.x, near.y, near.z)
      const faces = [
        new Vec3(0, -1, 0), new Vec3(0, 1, 0),
        new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
        new Vec3(0, 0, 1), new Vec3(0, 0, -1),
      ]
      for (const face of faces) {
        const refPos = target.plus(face)
        const refBlock = bot.blockAt(refPos)
        if (refBlock && refBlock.boundingBox === 'block') {
          const back = face.scaled(-1)
          return {
            ref: { x: refPos.x, y: refPos.y, z: refPos.z },
            face: { x: back.x, y: back.y, z: back.z },
          }
        }
      }
      return null
    },
    place: async (ref, face) => {
      try {
        const item = bot.inventory.items().find((i) => i.name === 'crafting_table')
        if (!item) return 'failed'
        await bot.equip(item, 'hand')
        const refBlock = bot.blockAt(new Vec3(ref.x, ref.y, ref.z))
        if (!refBlock) return 'failed'
        await bot.placeBlock(refBlock, new Vec3(face.x, face.y, face.z))
        return 'placed'
      } catch (err: any) {
        log('place_throw', { error: String(err?.message ?? err) })
        return 'failed'
      }
    },
    verifyPlaced: async (name, near) => bot.blockAt(new Vec3(near.x, near.y, near.z))?.name === name,
    gotoNear: async (pos, timeoutMs) => {
      try {
        let timer: NodeJS.Timeout | undefined
        const timeout = new Promise<'failed'>((res) => {
          timer = setTimeout(() => { bot.pathfinder.stop(); res('failed') }, Math.max(1, timeoutMs))
        })
        const walk = bot.pathfinder
          .goto(new goals.GoalNear(pos.x, pos.y, pos.z, 2))
          .then(() => 'arrived' as const)
        const result = await Promise.race([walk, timeout])
        clearTimeout(timer)
        return result
      } catch { return 'failed' }
    },
    now: () => Date.now(),
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
    } as SkillPosition,
  }

  const invoke = async (label: string, fn: () => Promise<unknown>) => {
    log(`${label}_invoke`, {})
    await new Promise((r) => setTimeout(r, 4000)); const result = await fn(); await new Promise((r) => setTimeout(r, 2000))
    log(`${label}_result`, result as Record<string, unknown>)
    return result as any
  }

  // The chain. Inventory carries oak_logx4 from the U1 take.
  const planks = await invoke('craftItem_oak_planks', () =>
    craftItem(craftDeps, { name: 'oak_planks', count: 4 }, ctx))
  if (!planks.ok) return finish()

  const table = await invoke('craftItem_crafting_table', () =>
    craftItem(craftDeps, { name: 'crafting_table', count: 1 }, ctx))
  if (!table.ok) return finish()

  // Place the table two blocks ahead on solid ground.
  const p = bot.entity.position
  let targetPos: SkillPosition | null = null
  for (const [dx, dz] of [[2, 0], [0, 2], [-2, 0], [0, -2], [2, 2]] as const) {
    const gx = Math.floor(p.x) + dx
    const gz = Math.floor(p.z) + dz
    for (let gy = Math.floor(p.y) + 1; gy >= Math.floor(p.y) - 2; gy--) {
      const cell = bot.blockAt(new Vec3(gx, gy, gz))
      const below = bot.blockAt(new Vec3(gx, gy - 1, gz))
      if (cell?.name === 'air' && below && below.boundingBox === 'block') {
        targetPos = { x: gx, y: gy, z: gz }
        break
      }
    }
    if (targetPos) break
  }
  if (!targetPos) { log('no_placement_site', {}); return finish() }

  const placed = await invoke('placeItem_crafting_table', () =>
    placeItem(placeDeps, { name: 'crafting_table', position: targetPos! }, ctx))
  if (!placed.ok) return finish()

  // Cinematography: face the placed table, then orbit it so the third-person
  // camera sweeps around the new block — the world-truth this demo proves.
  const tableCenter = new Vec3(targetPos.x + 0.5, targetPos.y + 0.5, targetPos.z + 0.5)
  await bot.lookAt(tableCenter)
  await new Promise((r) => setTimeout(r, 2000))
  for (const [ox, oz] of [[3, 0], [0, 3], [-3, 0], [0, -3]] as const) {
    try {
      await bot.pathfinder.goto(new goals.GoalNear(targetPos.x + ox, targetPos.y, targetPos.z + oz, 1))
      await bot.lookAt(tableCenter)
      await new Promise((r) => setTimeout(r, 1500))
    } catch { /* orbit leg blocked — keep going */ }
  }

  const sticks = await invoke('craftItem_stick', () =>
    craftItem(craftDeps, { name: 'stick', count: 1 }, ctx))
  if (!sticks.ok) return finish()

  // Table-required recipe — proves the walk-to-table path end to end.
  await invoke('craftItem_wooden_pickaxe', () =>
    craftItem(craftDeps, { name: 'wooden_pickaxe', count: 1 }, ctx))

  finish()

  function finish() {
    log('demo_complete', { inventory: bot.inventory.items().map((i) => `${i.name}x${i.count}`) })
    setTimeout(() => { bot.quit(); process.exit(0) }, 3000)
  }
})

bot.on('kicked', (r) => { log('kicked', { reason: String(r) }); process.exit(1) })
bot.on('error', (e: any) => { log('bot_error', { error: String(e?.message ?? e) }); process.exit(1) })
