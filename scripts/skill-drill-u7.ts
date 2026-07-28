// U7 demo drill — REAL stone-tier composed skills over live adapters.
// Continuity: the bot carries U6's wooden pickaxe; U6's crafting table still
// stands. Arc: collectCobblestone (tool-gated stone mining) ->
// craftStonePickaxe -> craftStoneSword. Camera: actor first-person (mining
// demo — the view faces every dig).
// Run: npx tsx scripts/skill-drill-u7.ts
import mineflayer from 'mineflayer'
import mineflayerPathfinderPkg from 'mineflayer-pathfinder'
import * as toolPkg from 'mineflayer-tool'
import minecraftData from 'minecraft-data'
import { Vec3 } from 'vec3'
import { mineBlock, type MineBlockDeps } from '../services/minecraft-service/src/skills/primitives/mineBlock.ts'
import { craftItem as craftItemPrimitive, type CraftItemDeps, type Recipe } from '../services/minecraft-service/src/skills/primitives/craftItem.ts'
import { placeItem as placeItemPrimitive, type PlaceItemDeps } from '../services/minecraft-service/src/skills/primitives/placeItem.ts'
import { collectCobblestone, type CollectCobblestonePrimitives } from '../services/minecraft-service/src/skills/library/collectCobblestone.ts'
import { craftStonePickaxe, type CraftStonePickaxePrimitives } from '../services/minecraft-service/src/skills/library/craftStonePickaxe.ts'
import { craftStoneSword } from '../services/minecraft-service/src/skills/library/craftStoneSword.ts'
import { guardedBlock, guardedItem } from '../services/minecraft-service/src/skills/names.ts'
import { skillOk, skillFail } from '../services/minecraft-service/src/skills/types.ts'
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

  const { mineflayer: mineflayerViewer } = await import('prismarine-viewer')
  mineflayerViewer(bot, { port: 3100, firstPerson: true, viewDistance: 5 })
  log('viewer_ready', {})
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

  // ---- live low-level deps (U1/U2 adapters, proven in U6) ----
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
      // Point-blank wedge guard: GoalLookAtBlock can time out when the body
      // already stands in reach — look and declare arrival instead.
      const center = new Vec3(pos.x + 0.5, pos.y + 0.5, pos.z + 0.5)
      if (bot.entity.position.distanceTo(center) <= 4) {
        try { await bot.lookAt(center) } catch { /* fine */ }
        return 'arrived'
      }
      try {
        let timer: NodeJS.Timeout | undefined
        const t = new Promise<'failed'>((res) => { timer = setTimeout(() => { bot.pathfinder.stop(); res('failed') }, Math.max(1, timeoutMs)) })
        const w = bot.pathfinder.goto(new goals.GoalLookAtBlock(new Vec3(pos.x, pos.y, pos.z), bot.world)).then(() => 'arrived' as const)
        const r = await Promise.race([w, t]); clearTimeout(timer); return r
      } catch { return 'failed' }
    },
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

  // ---- U7's primitives seam (items-count craftItem: adapter converts) ----
  const recipeYieldFor = (itemId: number): number => {
    const mf = (bot as any).recipesAll(itemId, null, true)[0]
    return mf?.result?.count ?? 1
  }
  const groundCell = (): SkillPosition | null => {
    const p = bot.entity.position
    for (const [dx, dz] of [[2, 0], [0, 2], [-2, 0], [0, -2], [2, 2], [3, 0], [0, 3]] as const) {
      const gx = Math.floor(p.x) + dx, gz = Math.floor(p.z) + dz
      for (let gy = Math.floor(p.y) + 1; gy >= Math.floor(p.y) - 2; gy--) {
        const cell = bot.blockAt(new Vec3(gx, gy, gz))
        const below = bot.blockAt(new Vec3(gx, gy - 1, gz))
        if (cell?.name === 'air' && below && below.boundingBox === 'block') return { x: gx, y: gy, z: gz }
      }
    }
    return null
  }

  const primitives: CollectCobblestonePrimitives & CraftStonePickaxePrimitives = {
    equipBestTool: async ({ block }) => {
      const lookup = guardedBlock(mcData, block)
      if (!lookup.ok) return skillFail(lookup.failureCode, lookup.detail, 0, ctx) as any
      const sample = bot.findBlock({ matching: lookup.value.id, maxDistance: 32 })
      if (!sample) return skillFail('RESOURCE_NOT_FOUND', `no ${block} within 32 blocks to gauge a tool against`, 0, ctx) as any
      try {
        await (bot as any).tool.equipForBlock(sample, { requireHarvest: true })
        return skillOk({ tool: bot.heldItem?.name ?? 'hand' }, 0, ctx) as any
      } catch {
        return skillFail('TOOL_REQUIRED', `${block} needs a harvest tool the pack lacks (e.g. a pickaxe)`, 0, ctx) as any
      }
    },
    mineBlock: (params) => mineBlock(mineDeps, params, ctx),
    craftItem: async (params) => {
      // U7 contract: count = ITEMS wanted; convert to recipe applications here.
      const lookup = guardedItem(mcData, params.name)
      if (!lookup.ok) return skillFail(lookup.failureCode, lookup.detail, 0, ctx) as any
      const items = Math.max(1, Math.floor(params.count ?? 1))
      const applications = Math.max(1, Math.ceil(items / recipeYieldFor(lookup.value.id)))
      return craftItemPrimitive(craftDeps, { name: params.name, count: applications }, ctx) as any
    },
    countItem: async ({ name }) => {
      const lookup = guardedItem(mcData, name)
      if (!lookup.ok) return skillFail(lookup.failureCode, lookup.detail, 0, ctx) as any
      return skillOk({ count: bot.inventory.count(lookup.value.id, null) }, 0, ctx) as any
    },
    findBlock: async ({ name, maxDistance }) => {
      const lookup = guardedBlock(mcData, name)
      if (!lookup.ok) return skillFail(lookup.failureCode, lookup.detail, 0, ctx) as any
      const b = bot.findBlock({ matching: lookup.value.id, maxDistance: maxDistance ?? 32 })
      if (!b) return skillFail('TARGET_NOT_FOUND', `no ${name} within ${maxDistance ?? 32} blocks`, 0, ctx) as any
      return skillOk({ position: { x: b.position.x, y: b.position.y, z: b.position.z } }, 0, ctx) as any
    },
    placeItem: async ({ name }) => {
      const cell = groundCell()
      if (!cell) return skillFail('PLACE_FAILED', 'no solid open cell near the body to place on', 0, ctx) as any
      const r = await placeItemPrimitive(placeDepsFor(name), { name, position: cell }, ctx)
      if (!r.ok) return r as any
      return skillOk({ position: cell }, r.costMs, ctx) as any
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

  const cobble = await invoke('collectCobblestone', () =>
    collectCobblestone(primitives, { count: 8 }, ctx))
  if (!cobble.ok) return finish()

  // Mining can dig the body into a pit; climb back to the staging surface
  // before the craft phase (craftItem's table walk budget is a tight 20s).
  try {
    let timer: NodeJS.Timeout | undefined
    const t = new Promise((res) => { timer = setTimeout(() => { bot.pathfinder.stop(); res(null) }, 30_000) })
    await Promise.race([bot.pathfinder.goto(new goals.GoalNear(-383, 67, -192, 2)), t])
    clearTimeout(timer)
  } catch { /* partial climb still helps */ }
  log('resurfaced', { y: Math.round(bot.entity.position.y) })

  const pick = await invoke('craftStonePickaxe', () => craftStonePickaxe(primitives, {}, ctx))
  if (!pick.ok) return finish()

  await invoke('craftStoneSword', () => craftStoneSword(primitives, {}, ctx))

  finish()
  function finish() {
    log('demo_complete', { inventory: bot.inventory.items().map((i) => `${i.name}x${i.count}`) })
    setTimeout(() => { bot.quit(); process.exit(0) }, 3000)
  }
})

bot.on('kicked', (r) => { log('kicked', { reason: String(r) }); process.exit(1) })
bot.on('error', (e: any) => { log('bot_error', { error: String(e?.message ?? e) }); process.exit(1) })
