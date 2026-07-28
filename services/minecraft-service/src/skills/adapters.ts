// Assembly: live mineflayer adapters for the skill layer — every deps
// interface the primitives declare, implemented once, carrying every lesson
// the OBS demo gate banked (2026-07-28, demos/skills/*/RESULT.json):
//   - reach guard: GoalLookAtBlock wedges at point-blank range (hit 3×) —
//     short-circuit inside interaction reach.
//   - typed pickup counting: a bare playerCollect counter mistakes pit junk
//     (dirt, leaf litter) for ore — count by the dug block's actual drop.
//   - dig-site stand: drops pop ON the dug cell; walk there before sweeping
//     or pit terrain eats them.
//   - raced walks: every pathfinder goto is Promise.raced — an unreachable
//     target must never wedge a skill (the executor watchdog lesson).
//   - craft settle: inventory packets land async after a craft — the next
//     countInventory read is stale without a settle beat.
// The bot is expected to carry the U13 plugin set (pathfinder always;
// bot.tool / bot.pvp when the corresponding flags are on).

import type { Bot } from 'mineflayer'
import mineflayerPathfinder from 'mineflayer-pathfinder'
import { Vec3 } from 'vec3'
import type { MineBlockDeps } from './primitives/mineBlock.ts'
import type { CraftItemDeps, Recipe } from './primitives/craftItem.ts'
import type { PlaceItemDeps } from './primitives/placeItem.ts'
import type { SmeltItemDeps, FurnaceHandle } from './primitives/smeltItem.ts'
import type { UseChestDeps, ChestHandle } from './primitives/useChest.ts'
import type { KillMobDeps } from './primitives/killMob.ts'
import type { ExploreUntilDeps } from './primitives/exploreUntil.ts'
import type { GivePlacedItemBackDeps } from './primitives/givePlacedItemBack.ts'
import { guardedBlock, guardedItem, type McDataLike } from './names.ts'
import type { SkillInvocationContext, SkillPosition } from './types.ts'

const { goals } = mineflayerPathfinder

/** Interaction reach inside which a walk is a no-op (the point-blank wedge). */
export const REACH_GUARD_DISTANCE = 4

/** Post-craft inventory settle (stale-count race seen live in U9). */
export const CRAFT_SETTLE_MS = 600

/** Per-drop walk budget inside a sweep (an unreachable drop must not wedge). */
export const DROP_WALK_TIMEOUT_MS = 8_000

/** Block -> what it yields when dug with the right tool (pickup accounting). */
export const DROP_OF: Readonly<Record<string, string>> = {
  iron_ore: 'raw_iron', deepslate_iron_ore: 'raw_iron',
  copper_ore: 'raw_copper', deepslate_copper_ore: 'raw_copper',
  gold_ore: 'raw_gold', deepslate_gold_ore: 'raw_gold',
  coal_ore: 'coal', deepslate_coal_ore: 'coal',
  stone: 'cobblestone', deepslate: 'cobbled_deepslate',
  grass_block: 'dirt',
}

export interface SkillAdapters {
  mineBlockDeps: MineBlockDeps
  craftItemDeps: CraftItemDeps
  placeItemDepsFor(itemName: string): PlaceItemDeps
  smeltItemDeps: SmeltItemDeps
  useChestDeps: UseChestDeps
  killMobDeps: KillMobDeps
  exploreUntilDeps: ExploreUntilDeps
  givePlacedItemBackDeps: GivePlacedItemBackDeps
  /** Live invocation-context capture for SkillResult/stats rows. */
  captureContext(): SkillInvocationContext
  /** Recipe result yield (items per application) — items->applications math. */
  recipeYieldFor(itemId: number): number
  /** Nearest solid-air ground cell near the body (placement candidates). */
  findGroundCell(): SkillPosition | null
}

export function createSkillAdapters(bot: Bot, mcData: McDataLike & Record<string, any>): SkillAdapters {
  let lastDigPos: SkillPosition | null = null
  let lastDigDrop: string | null = null
  const pickupCounts = new Map<string, number>()

  bot.on('playerCollect', (collector: any, collected: any) => {
    if (collector?.id !== bot.entity?.id) return
    const name = collected?.getDroppedItem?.()?.name ?? 'unknown'
    pickupCounts.set(name, (pickupCounts.get(name) ?? 0) + 1)
  })

  const racedGoto = async (goal: any, timeoutMs: number): Promise<boolean> => {
    try {
      let timer: NodeJS.Timeout | undefined
      const t = new Promise<boolean>((res) => {
        timer = setTimeout(() => { (bot as any).pathfinder.stop(); res(false) }, Math.max(1, timeoutMs))
      })
      const w = (bot as any).pathfinder.goto(goal).then(() => true)
      const r = await Promise.race([w, t])
      clearTimeout(timer)
      return r
    } catch { return false }
  }

  const gotoBlockGuarded = async (pos: SkillPosition, timeoutMs: number): Promise<boolean> => {
    const center = new Vec3(pos.x + 0.5, pos.y + 0.5, pos.z + 0.5)
    if (bot.entity.position.distanceTo(center) <= REACH_GUARD_DISTANCE) {
      try { await bot.lookAt(center) } catch { /* fine */ }
      return true
    }
    return racedGoto(new goals.GoalLookAtBlock(new Vec3(pos.x, pos.y, pos.z), bot.world), timeoutMs)
  }

  const gotoNear = async (pos: SkillPosition, range: number, timeoutMs: number): Promise<boolean> =>
    racedGoto(new goals.GoalNear(pos.x, pos.y, pos.z, range), timeoutMs)

  const collectNearbyDrops = async (): Promise<number> => {
    const target = lastDigDrop
    const before = target ? (pickupCounts.get(target) ?? 0) : 0
    if (lastDigPos) await gotoNear(lastDigPos, 0, DROP_WALK_TIMEOUT_MS)
    await sleep(900)
    const items = Object.values(bot.entities).filter(
      (e: any) => e?.name === 'item' && e.position.distanceTo(bot.entity.position) < 10,
    ) as any[]
    for (const item of items.slice(0, 4)) {
      await gotoNear({ x: item.position.x, y: item.position.y, z: item.position.z }, 0, DROP_WALK_TIMEOUT_MS)
    }
    await sleep(1200)
    return target ? Math.max(0, (pickupCounts.get(target) ?? 0) - before) : 0
  }

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

  const mineBlockDeps: MineBlockDeps = {
    resolveBlock: (name) => guardedBlock(mcData, name),
    findBlocks: (blockId, maxDistance, count) =>
      bot.findBlocks({ matching: blockId, maxDistance, count }).map((v) => ({ x: v.x, y: v.y, z: v.z })),
    gotoBlock: async (pos, timeoutMs) => (await gotoBlockGuarded(pos, timeoutMs)) ? 'arrived' : 'path_not_found',
    equipBestToolFor: async (pos) => {
      const block = bot.blockAt(new Vec3(pos.x, pos.y, pos.z))
      if (!block) return 'none_needed'
      const tool = (bot as any).tool
      if (!block.harvestTools) {
        if (tool) { try { await tool.equipForBlock(block) } catch { /* fine */ } }
        return 'none_needed'
      }
      if (!tool) return 'missing'
      try { await tool.equipForBlock(block, { requireHarvest: true }); return 'equipped' } catch { return 'missing' }
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
    collectNearbyDrops,
    now: () => Date.now(),
  }

  const recipeMap = new Map<Recipe, any>()
  const tableId = (mcData as any).blocksByName.crafting_table.id
  const findTableBlock = (maxDistance: number) => bot.findBlock({ matching: tableId, maxDistance }) ?? null

  const craftItemDeps: CraftItemDeps = {
    resolveItem: (name) => guardedItem(mcData, name),
    recipesFor: (itemId, tableNearby) => {
      const mfRecipes = (bot as any).recipesAll(itemId, null, tableNearby ? true : null)
      return mfRecipes.map((mf: any) => {
        const ingredients = (mf.delta as Array<{ id: number; count: number }>)
          .filter((d) => d.count < 0)
          .map((d) => ({ itemId: d.id, name: (mcData as any).items[d.id]?.name ?? String(d.id), count: -d.count }))
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
        await sleep(CRAFT_SETTLE_MS)
        return 'crafted'
      } catch { return 'failed' }
    },
    countInventory: (itemId) => bot.inventory.count(itemId, null),
    findCraftingTable: (maxDistance) => {
      const b = findTableBlock(maxDistance)
      return b ? { x: b.position.x, y: b.position.y, z: b.position.z } : null
    },
    gotoBlock: async (pos, timeoutMs) => (await gotoBlockGuarded(pos, timeoutMs)) ? 'arrived' : 'failed',
    now: () => Date.now(),
  }

  const placeItemDepsFor = (itemName: string): PlaceItemDeps => ({
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
    gotoNear: async (pos, timeoutMs) => (await gotoNear(pos, 2, timeoutMs)) ? 'arrived' : 'failed',
    now: () => Date.now(),
  })

  const smeltItemDeps: SmeltItemDeps = {
    resolveItem: (name) => guardedItem(mcData, name),
    findFurnace: (maxDistance) => {
      const b = bot.findBlock({ matching: (mcData as any).blocksByName.furnace.id, maxDistance })
      return b ? { x: b.position.x, y: b.position.y, z: b.position.z } : null
    },
    gotoBlock: gotoBlockGuarded,
    openFurnace: async (pos) => {
      try {
        const block = bot.blockAt(new Vec3(pos.x, pos.y, pos.z))
        if (!block) return null
        const furnace: any = await bot.openFurnace(block)
        const handle: FurnaceHandle = {
          putInput: async (itemId, count) => { await furnace.putInput(itemId, null, count) },
          // A burning furnace refuses fuel — that is fuel economy, not failure.
          putFuel: async (itemId, count) => { try { await furnace.putFuel(itemId, null, count) } catch { /* burning */ } },
          outputCount: () => furnace.outputItem()?.count ?? 0,
          takeOutput: async () => { await furnace.takeOutput() },
          close: async () => { furnace.close() },
        }
        return handle
      } catch { return null }
    },
    countInventory: (itemId) => bot.inventory.count(itemId, null),
    now: () => Date.now(),
    sleep,
  }

  const useChestDeps: UseChestDeps = {
    findChest: (maxDistance) => {
      const b = bot.findBlock({ matching: (mcData as any).blocksByName.chest.id, maxDistance })
      return b ? { x: b.position.x, y: b.position.y, z: b.position.z } : null
    },
    gotoBlock: gotoBlockGuarded,
    openChest: async (pos) => {
      try {
        const block = bot.blockAt(new Vec3(pos.x, pos.y, pos.z))
        if (!block) return null
        const container: any = await (bot as any).openContainer(block)
        const handle: ChestHandle = {
          items: () => container.containerItems().map((i: any) => ({ name: i.name, count: i.count })),
          withdraw: async (itemId, count) => {
            const avail = container.containerItems()
              .filter((i: any) => i.type === itemId)
              .reduce((s: number, i: any) => s + i.count, 0)
            const take = Math.min(count, avail)
            if (take <= 0) return 0
            await container.withdraw(itemId, null, take)
            return take
          },
          deposit: async (itemId, count) => {
            const have = bot.inventory.count(itemId, null)
            const give = Math.min(count, have)
            if (give <= 0) return 0
            await container.deposit(itemId, null, give)
            return give
          },
          close: async () => { container.close() },
        }
        return handle
      } catch { return null }
    },
    resolveItem: (name) => guardedItem(mcData, name),
    inventoryFull: () => bot.inventory.emptySlotCount() === 0,
    now: () => Date.now(),
  }

  const killMobDeps: KillMobDeps = {
    findNearestMob: (name, maxDistance) => {
      const e = bot.nearestEntity(
        (ent: any) => ent?.name === name && ent.position.distanceTo(bot.entity.position) <= maxDistance,
      )
      return e ? { id: e.id, position: { x: e.position.x, y: e.position.y, z: e.position.z } } : null
    },
    pvpAttack: async (mobId) => {
      const pvp = (bot as any).pvp
      if (!pvp) throw new Error('bot.pvp missing — PLUGIN_PVP off or plugin not loaded')
      const e = bot.entities[mobId]
      if (!e) throw new Error('mob vanished before engagement')
      pvp.attack(e)
    },
    pvpStop: async () => { await (bot as any).pvp?.stop() },
    mobGone: (mobId) => !bot.entities[mobId],
    collectNearbyDrops,
    now: () => Date.now(),
    sleep,
  }

  const exploreUntilDeps: ExploreUntilDeps = {
    moveInDirection: async (direction, distance, timeoutMs) => {
      const target = bot.entity.position.offset(direction.x * distance, 0, direction.z * distance)
      const before = bot.entity.position.clone()
      await racedGoto(new goals.GoalNearXZ(target.x, target.z, 2), timeoutMs)
      return bot.entity.position.distanceTo(before) >= 2 ? 'moved' : 'blocked'
    },
    now: () => Date.now(),
    sleep,
  }

  const givePlacedItemBackDeps: GivePlacedItemBackDeps = {
    mcData,
    blockAt: (pos) => bot.blockAt(new Vec3(pos.x, pos.y, pos.z))?.name ?? null,
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
    collectNearbyDrops,
    gotoBlock: async (pos, timeoutMs) => (await gotoBlockGuarded(pos, timeoutMs)) ? 'arrived' : 'blocked',
    now: () => Date.now(),
  }

  const captureContext = (): SkillInvocationContext => ({
    // block.biome carries no name on this mineflayer build (U1 finding) —
    // resolve through the registry when biome data is present.
    biome: (() => {
      try {
        const b: any = bot.blockAt(bot.entity.position)
        const id = b?.biome?.id
        return (mcData as any).biomes?.[id]?.name ?? null
      } catch { return null }
    })(),
    timeOfDay: Math.max(0, Math.min(24000, Math.round(bot.time.timeOfDay))),
    heldTool: bot.heldItem?.name ?? null,
    hostileCount: Object.values(bot.entities).filter((e: any) => e?.kind === 'Hostile mobs').length,
    position: {
      x: Math.round(bot.entity.position.x),
      y: Math.round(bot.entity.position.y),
      z: Math.round(bot.entity.position.z),
    },
  })

  const recipeYieldFor = (itemId: number): number => {
    const mf = (bot as any).recipesAll(itemId, null, true)[0]
    return mf?.result?.count ?? 1
  }

  const findGroundCell = (): SkillPosition | null => {
    const p = bot.entity.position
    for (const [dx, dz] of [[2, 0], [0, 2], [-2, 0], [0, -2], [2, 2], [-2, 2], [3, 0], [0, 3], [-3, 0], [0, -3]] as const) {
      const gx = Math.floor(p.x) + dx
      const gz = Math.floor(p.z) + dz
      for (let gy = Math.floor(p.y) + 1; gy >= Math.floor(p.y) - 2; gy--) {
        const cell = bot.blockAt(new Vec3(gx, gy, gz))
        const below = bot.blockAt(new Vec3(gx, gy - 1, gz))
        if (cell?.name === 'air' && below && below.boundingBox === 'block') return { x: gx, y: gy, z: gz }
      }
    }
    return null
  }

  return {
    mineBlockDeps,
    craftItemDeps,
    placeItemDepsFor,
    smeltItemDeps,
    useChestDeps,
    killMobDeps,
    exploreUntilDeps,
    givePlacedItemBackDeps,
    captureContext,
    recipeYieldFor,
    findGroundCell,
  }
}
