// U8 demo drill — THE RACE-CRITICAL CHAIN, composed skills over live
// primitives: mineIronOre (stone-pickaxe gate) -> mineCoalOre ->
// craftFurnace (internal cobble recovery) -> smeltIronOre (coal fuel) ->
// craftIronPickaxe. Continuity: U7's stone pickaxe and sticks; U6's table.
// Camera: actor first-person (mining + furnace close-ups).
// Run: npx tsx scripts/skill-drill-u8.ts
import mineflayer from 'mineflayer'
import mineflayerPathfinderPkg from 'mineflayer-pathfinder'
import * as toolPkg from 'mineflayer-tool'
import minecraftData from 'minecraft-data'
import { Vec3 } from 'vec3'
import { mineBlock, type MineBlockDeps } from '../services/minecraft-service/src/skills/primitives/mineBlock.ts'
import { craftItem as craftItemPrimitive, type CraftItemDeps, type Recipe } from '../services/minecraft-service/src/skills/primitives/craftItem.ts'
import { placeItem as placeItemPrimitive, type PlaceItemDeps } from '../services/minecraft-service/src/skills/primitives/placeItem.ts'
import { smeltItem as smeltItemPrimitive, type SmeltItemDeps, type FurnaceHandle } from '../services/minecraft-service/src/skills/primitives/smeltItem.ts'
import { mineIronOre, type MineIronOrePrimitives } from '../services/minecraft-service/src/skills/library/mineIronOre.ts'
import { mineCoalOre } from '../services/minecraft-service/src/skills/library/mineCoalOre.ts'
import { craftFurnace, type CraftFurnacePrimitives } from '../services/minecraft-service/src/skills/library/craftFurnace.ts'
import { smeltIronOre, type SmeltIronOrePrimitives } from '../services/minecraft-service/src/skills/library/smeltIronOre.ts'
import { craftIronPickaxe, type CraftIronPickaxePrimitives } from '../services/minecraft-service/src/skills/library/craftIronPickaxe.ts'
import { guardedBlock, guardedItem } from '../services/minecraft-service/src/skills/names.ts'
import { skillOk, skillFail } from '../services/minecraft-service/src/skills/types.ts'
import type { SkillInvocationContext, SkillPosition, SkillResult } from '../services/minecraft-service/src/skills/types.ts'

const { pathfinder, Movements, goals } = mineflayerPathfinderPkg
const toolPlugin = (toolPkg as any).plugin ?? (toolPkg as any).default ?? toolPkg

const log = (event: string, data: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data }))

const bot = mineflayer.createBot({
  host: 'localhost', port: 25565, username: 'skill_drill', version: '1.21.6', auth: 'offline',
})
bot.loadPlugin(pathfinder)
bot.loadPlugin(toolPlugin)

let lastDigPos: { x: number; y: number; z: number } | null = null
let lastDigDrop: string | null = null
// Count pickups BY ITEM NAME — pit digging showers junk (dirt, leaf litter)
// that a bare counter mistakes for ore (found live in rehearsal 2).
const pickupCounts = new Map<string, number>()
bot.on('playerCollect', (c, collected: any) => {
  if (c.id !== bot.entity?.id) return
  const name = collected?.getDroppedItem?.()?.name ?? 'unknown'
  pickupCounts.set(name, (pickupCounts.get(name) ?? 0) + 1)
})
/** what a block yields when dug with the right tool */
const DROP_OF: Record<string, string> = {
  iron_ore: 'raw_iron', deepslate_iron_ore: 'raw_iron',
  coal_ore: 'coal', deepslate_coal_ore: 'coal',
  stone: 'cobblestone', grass_block: 'dirt',
}

const STAGE = { x: -383, y: 67, z: -192 }

bot.once('spawn', async () => {
  const mcData = minecraftData(bot.version) as any
  log('spawned', { username: bot.username })
  bot.pathfinder.setMovements(new Movements(bot))

  const { mineflayer: mineflayerViewer } = await import('prismarine-viewer')
  mineflayerViewer(bot, { port: 3100, firstPerson: true, viewDistance: 5 })
  log('viewer_ready', {})
  await new Promise((r) => setTimeout(r, 8000))

  const ctx: SkillInvocationContext = {
    biome: null,
    timeOfDay: Math.round(bot.time.timeOfDay),
    heldTool: bot.heldItem?.name ?? null,
    hostileCount: 0,
    position: { x: STAGE.x, y: STAGE.y, z: STAGE.z },
  }

  const reachGuardGoto = async (pos: SkillPosition, timeoutMs: number): Promise<boolean> => {
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

  const mineDeps: MineBlockDeps = {
    resolveBlock: (name) => guardedBlock(mcData, name),
    findBlocks: (blockId, maxDistance, count) =>
      bot.findBlocks({ matching: blockId, maxDistance, count }).map((v) => ({ x: v.x, y: v.y, z: v.z })),
    gotoBlock: async (pos, timeoutMs) => (await reachGuardGoto(pos, timeoutMs)) ? 'arrived' : 'path_not_found',
    equipBestToolFor: async (pos) => {
      const block = bot.blockAt(new Vec3(pos.x, pos.y, pos.z))
      if (!block) return 'none_needed'
      if (!block.harvestTools) {
        try { await (bot as any).tool.equipForBlock(block) } catch { /* fine */ }
        return 'none_needed'
      }
      try { await (bot as any).tool.equipForBlock(block, { requireHarvest: true }); return 'equipped' } catch { return 'missing' }
    },
    dig: async (pos) => {
      const block = bot.blockAt(new Vec3(pos.x, pos.y, pos.z))
      if (!block || block.name === 'air') return 'blocked'
      try {
        const dropName = DROP_OF[block.name] ?? block.name
        await bot.dig(block)
        lastDigPos = { ...pos }
        lastDigDrop = dropName
        return 'dug'
      } catch { return 'blocked' }
    },
    collectNearbyDrops: async () => {
      const target = lastDigDrop
      const before = target ? (pickupCounts.get(target) ?? 0) : 0
      // Deterministic first move (the U5 lesson): stand ON the dug cell —
      // the drop pops there; in pit terrain a scan-first sweep loses it.
      if (lastDigPos) {
        try { await bot.pathfinder.goto(new goals.GoalNear(lastDigPos.x, lastDigPos.y, lastDigPos.z, 0)) } catch { /* fine */ }
      }
      await new Promise((r) => setTimeout(r, 900))
      const items = Object.values(bot.entities).filter(
        (e: any) => e?.name === 'item' && e.position.distanceTo(bot.entity.position) < 10,
      )
      for (const item of items.slice(0, 4)) {
        try { await bot.pathfinder.goto(new goals.GoalNear(item.position.x, item.position.y, item.position.z, 0)) } catch { /* gone */ }
      }
      await new Promise((r) => setTimeout(r, 1200))
      // Only pickups of the dug block's actual drop count toward the ask.
      return target ? Math.max(0, (pickupCounts.get(target) ?? 0) - before) : 0
    },
    now: () => Date.now(),
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

  const placeDepsFor = (itemName: string): PlaceItemDeps => ({
    resolveItem: (name) => guardedItem(mcData, name),
    hasItem: (itemId) => bot.inventory.count(itemId, null) > 0,
    findReferenceBlock: (near) => {
      const target = new Vec3(near.x, near.y, near.z)
      for (const face of [new Vec3(0, -1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]) {
        const refPos = target.plus(face)
        const refBlock = bot.blockAt(refPos)
        if (refBlock && refBlock.boundingBox === 'block') {
          const back = face.scaled(-1)
          return { ref: { x: refPos.x, y: refPos.y, z: refPos.z }, face: { x: back.x, y: back.y, z: back.z } }
        }
      }
      return null
    },
    place: async (ref, face) => {
      try {
        const item = bot.inventory.items().find((i) => i.name === itemName)
        if (!item) return 'failed'
        await bot.equip(item, 'hand')
        const refBlock = bot.blockAt(new Vec3(ref.x, ref.y, ref.z))
        if (!refBlock) return 'failed'
        await bot.placeBlock(refBlock, new Vec3(face.x, face.y, face.z))
        return 'placed'
      } catch { return 'failed' }
    },
    verifyPlaced: async (name, near) => bot.blockAt(new Vec3(near.x, near.y, near.z))?.name === name,
    gotoNear: async (pos, timeoutMs) => {
      try {
        let timer: NodeJS.Timeout | undefined
        const t = new Promise<'failed'>((res) => { timer = setTimeout(() => { bot.pathfinder.stop(); res('failed') }, timeoutMs) })
        const w = bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 2)).then(() => 'arrived' as const)
        const r = await Promise.race([w, t]); clearTimeout(timer); return r
      } catch { return 'failed' }
    },
    now: () => Date.now(),
  })

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

  const groundCell = (): SkillPosition | null => {
    const p = bot.entity.position
    for (const [dx, dz] of [[2, 0], [0, 2], [-2, 0], [0, -2], [2, 2], [3, 0], [0, 3], [-3, 0]] as const) {
      const gx = Math.floor(p.x) + dx, gz = Math.floor(p.z) + dz
      for (let gy = Math.floor(p.y) + 1; gy >= Math.floor(p.y) - 2; gy--) {
        const cell = bot.blockAt(new Vec3(gx, gy, gz))
        const below = bot.blockAt(new Vec3(gx, gy - 1, gz))
        if (cell?.name === 'air' && below && below.boundingBox === 'block') return { x: gx, y: gy, z: gz }
      }
    }
    return null
  }

  const recipeYieldFor = (itemId: number): number => {
    const mf = (bot as any).recipesAll(itemId, null, true)[0]
    return mf?.result?.count ?? 1
  }

  // ---- U8's seam (blockName/itemName keys, {mined}/{placed:boolean} shapes) ----
  const primitives: MineIronOrePrimitives & CraftFurnacePrimitives & SmeltIronOrePrimitives & CraftIronPickaxePrimitives = {
    mineBlock: async ({ blockName, count }) => {
      const r = await mineBlock(mineDeps, { name: blockName, count }, ctx)
      if (!r.ok) return r as SkillResult<{ mined: number }>
      return skillOk({ mined: r.outcome.collected }, r.costMs, ctx)
    },
    craftItem: async ({ itemName, count }) => {
      const lookup = guardedItem(mcData, itemName)
      if (!lookup.ok) return skillFail(lookup.failureCode, lookup.detail, 0, ctx)
      const items = Math.max(1, Math.floor(count ?? 1))
      const applications = Math.max(1, Math.ceil(items / recipeYieldFor(lookup.value.id)))
      return craftItemPrimitive(craftDeps, { name: itemName, count: applications }, ctx)
    },
    placeItem: async ({ itemName, position }) => {
      const cell = position ?? groundCell()
      if (!cell) return skillFail('PLACE_FAILED', 'no solid open cell near the body to place on', 0, ctx)
      for (let attempt = 0; attempt < 2; attempt++) {
        const r = await placeItemPrimitive(placeDepsFor(itemName), { name: itemName, position: cell }, ctx)
        if (r.ok) return skillOk({ placed: true }, r.costMs, ctx)
        if (r.failureCode !== 'PLACE_FAILED' || attempt === 1) return r as SkillResult<{ placed: boolean }>
        const next = groundCell()
        if (!next) return r as SkillResult<{ placed: boolean }>
        Object.assign(cell, next)
      }
      return skillFail('PLACE_FAILED', 'exhausted placement attempts', 0, ctx)
    },
    smeltItem: (params) => smeltItemPrimitive(smeltDeps, params, ctx),
  }

  const invoke = async (label: string, fn: () => Promise<unknown>) => {
    log(`${label}_invoke`, {})
    await new Promise((r) => setTimeout(r, 2500))
    const result = await fn()
    log(`${label}_result`, result as Record<string, unknown>)
    await new Promise((r) => setTimeout(r, 1500))
    return result as any
  }

  const resurface = async () => {
    try {
      let timer: NodeJS.Timeout | undefined
      const t = new Promise((res) => { timer = setTimeout(() => { bot.pathfinder.stop(); res(null) }, 30_000) })
      await Promise.race([bot.pathfinder.goto(new goals.GoalNear(STAGE.x, STAGE.y, STAGE.z, 2)), t])
      clearTimeout(timer)
    } catch { /* partial climb still helps */ }
    log('resurfaced', { y: Math.round(bot.entity.position.y) })
  }

  // THE CHAIN.
  const iron = await invoke('mineIronOre', () => mineIronOre(primitives, { count: 3 }, ctx))
  if (!iron.ok) return finish()
  const coal = await invoke('mineCoalOre', () => mineCoalOre(primitives, { count: 2 }, ctx))
  if (!coal.ok) return finish()
  await resurface()
  const furnace = await invoke('craftFurnace', () => craftFurnace(primitives, {}, ctx))
  if (!furnace.ok) return finish()
  const smelted = await invoke('smeltIronOre', () => smeltIronOre(primitives, { count: 3, fuelName: 'coal' }, ctx))
  if (!smelted.ok) return finish()
  await invoke('craftIronPickaxe', () => craftIronPickaxe(primitives, {}, ctx))

  finish()
  function finish() {
    log('demo_complete', { inventory: bot.inventory.items().map((i) => `${i.name}x${i.count}`) })
    setTimeout(() => { bot.quit(); process.exit(0) }, 3000)
  }
})

bot.on('kicked', (r) => { log('kicked', { reason: String(r) }); process.exit(1) })
bot.on('error', (e: any) => { log('bot_error', { error: String(e?.message ?? e) }); process.exit(1) })
