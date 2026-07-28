// U6 demo drill — REAL composed wood-tier skills over the REAL primitives:
// mineWoodLog (U6) -> craftWoodenPickaxe (U6), with U1's mineBlock and U2's
// craftItem/placeItem as the live primitive layer underneath. The full
// Voyager wood-tier arc, one composition, zero mocks.
// Run: npx tsx scripts/skill-drill-u6.ts
import mineflayer from 'mineflayer'
import mineflayerPathfinderPkg from 'mineflayer-pathfinder'
import * as toolPkg from 'mineflayer-tool'
import minecraftData from 'minecraft-data'
import { Vec3 } from 'vec3'
import { mineBlock, type MineBlockDeps } from '../services/minecraft-service/src/skills/primitives/mineBlock.ts'
import { craftItem, type CraftItemDeps, type Recipe } from '../services/minecraft-service/src/skills/primitives/craftItem.ts'
import { placeItem, type PlaceItemDeps } from '../services/minecraft-service/src/skills/primitives/placeItem.ts'
import { mineWoodLog } from '../services/minecraft-service/src/skills/library/mineWoodLog.ts'
import { craftWoodenPickaxe, type WoodTierPrimitives } from '../services/minecraft-service/src/skills/library/craftWoodenPickaxe.ts'
import { guardedBlock, guardedItem } from '../services/minecraft-service/src/skills/names.ts'
import type { SkillInvocationContext, SkillPosition } from '../services/minecraft-service/src/skills/types.ts'

const { pathfinder, Movements, goals } = mineflayerPathfinderPkg
const toolPlugin = (toolPkg as any).plugin ?? (toolPkg as any).default ?? toolPkg

const log = (event: string, data: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data }))

const bot = mineflayer.createBot({
  host: 'localhost', port: 25565, username: 'skill_drill', version: '1.21.6', auth: 'offline',
})
bot.loadPlugin(pathfinder)
bot.loadPlugin(toolPlugin)

let collectedEvents = 0
bot.on('playerCollect', (c) => { if (c.id === bot.entity?.id) collectedEvents += 1 })

bot.once('spawn', async () => {
  const mcData = minecraftData(bot.version) as any
  log('spawned', { username: bot.username })
  bot.pathfinder.setMovements(new Movements(bot))

  // Camera decision (U6 = roaming demo): actor first-person follow-cam —
  // mineBlock's GoalLookAtBlock keeps the view on every dig target, and the
  // craft phase shows the table place directly (the U2-proven recipe).
  const { mineflayer: mineflayerViewer } = await import('prismarine-viewer')
  mineflayerViewer(bot, { port: 3100, firstPerson: true, viewDistance: 5 })
  log('viewer_ready', { url: 'http://localhost:3100' })
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

  // --- U1 mineBlock deps (live) ---
  const mineDeps: MineBlockDeps = {
    resolveBlock: (name) => guardedBlock(mcData, name),
    findBlocks: (blockId, maxDistance, count) =>
      bot.findBlocks({ matching: blockId, maxDistance, count }).map((v) => ({ x: v.x, y: v.y, z: v.z })),
    gotoBlock: async (pos, timeoutMs) => {
      try {
        let timer: NodeJS.Timeout | undefined
        const t = new Promise<'timeout'>((res) => { timer = setTimeout(() => { bot.pathfinder.stop(); res('timeout') }, Math.max(1, timeoutMs)) })
        const w = bot.pathfinder.goto(new goals.GoalLookAtBlock(new Vec3(pos.x, pos.y, pos.z), bot.world)).then(() => 'arrived' as const)
        const r = await Promise.race([w, t]); clearTimeout(timer); return r
      } catch { return 'path_not_found' }
    },
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
      try { await bot.dig(block); return 'dug' } catch { return 'blocked' }
    },
    collectNearbyDrops: async () => {
      const before = collectedEvents
      await new Promise((r) => setTimeout(r, 700))
      const items = Object.values(bot.entities).filter(
        (e: any) => e?.name === 'item' && e.position.distanceTo(bot.entity.position) < 10,
      )
      for (const item of items.slice(0, 4)) {
        try { await bot.pathfinder.goto(new goals.GoalNear(item.position.x, item.position.y, item.position.z, 0)) } catch { /* gone */ }
      }
      await new Promise((r) => setTimeout(r, 1200))
      return collectedEvents - before
    },
    now: () => Date.now(),
  }

  // --- U2 craftItem deps (live) ---
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
    gotoBlock: async (pos, timeoutMs) => {
      try {
        let timer: NodeJS.Timeout | undefined
        const t = new Promise<'failed'>((res) => { timer = setTimeout(() => { bot.pathfinder.stop(); res('failed') }, Math.max(1, timeoutMs)) })
        const w = bot.pathfinder.goto(new goals.GoalLookAtBlock(new Vec3(pos.x, pos.y, pos.z), bot.world)).then(() => 'arrived' as const)
        const r = await Promise.race([w, t]); clearTimeout(timer); return r
      } catch { return 'failed' }
    },
    now: () => Date.now(),
  }

  // --- U2 placeItem deps (live), parameterized per item ---
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

  // --- The composed primitive layer the U6 skills consume ---
  const primitives: WoodTierPrimitives = {
    mineBlock: (params) => mineBlock(mineDeps, params, ctx),
    craftItem: (params) => craftItem(craftDeps, params, ctx),
    placeItem: (params) =>
      placeItem(placeDepsFor(params.name), params, ctx) as Promise<any>,
  }

  const invoke = async (label: string, fn: () => Promise<unknown>) => {
    log(`${label}_invoke`, {})
    await new Promise((r) => setTimeout(r, 2500))
    const result = await fn()
    log(`${label}_result`, result as Record<string, unknown>)
    await new Promise((r) => setTimeout(r, 1500))
    return result as any
  }

  // UNDER TEST: the composed skills.
  const logs = await invoke('mineWoodLog', () => mineWoodLog(primitives, { count: 4 }, ctx))
  if (!logs.ok) return finish()

  const pick = await invoke('craftWoodenPickaxe', () => craftWoodenPickaxe(primitives, {}, ctx))
  if (!pick.ok) return finish()

  finish()
  function finish() {
    log('demo_complete', { inventory: bot.inventory.items().map((i) => `${i.name}x${i.count}`) })
    setTimeout(() => { bot.quit(); process.exit(0) }, 3000)
  }
})

bot.on('kicked', (r) => { log('kicked', { reason: String(r) }); process.exit(1) })
bot.on('error', (e: any) => { log('bot_error', { error: String(e?.message ?? e) }); process.exit(1) })
