// Assembly: the skill registry — one place binding every library skill and
// primitive to the live adapters, capturing invocation context, and recording
// a SkillInvocationRecord per call (raw material for stats.ts / the mastery
// table; rides ActionCompleted.result unchanged once wired behind verbs).
// Per-tier shims bridge the batch units' independently-designed primitive
// seams (U6 name-keys, U7 items-count + tool/count/find, U8 blockName/
// itemName, U9 combat) — the exact shapes the demo-gate drills proved live.

import type { Bot } from 'mineflayer'
import { createSkillAdapters, type SkillAdapters } from './adapters.ts'
import { mineBlock } from './primitives/mineBlock.ts'
import { craftItem as craftItemPrimitive } from './primitives/craftItem.ts'
import { placeItem as placeItemPrimitive } from './primitives/placeItem.ts'
import { smeltItem as smeltItemPrimitive } from './primitives/smeltItem.ts'
import { getItemFromChest, depositItemIntoChest, checkItemInsideChest } from './primitives/useChest.ts'
import { killMob as killMobPrimitive } from './primitives/killMob.ts'
import { exploreUntil } from './primitives/exploreUntil.ts'
import { givePlacedItemBack } from './primitives/givePlacedItemBack.ts'
import { mineWoodLog, mineWoodLogSchema } from './library/mineWoodLog.ts'
import { craftPlanks, craftPlanksSchema } from './library/craftPlanks.ts'
import { craftSticks, craftSticksSchema } from './library/craftSticks.ts'
import { craftCraftingTable, craftCraftingTableSchema } from './library/craftCraftingTable.ts'
import { craftWoodenPickaxe, craftWoodenPickaxeSchema, type WoodTierPrimitives } from './library/craftWoodenPickaxe.ts'
import { collectCobblestone, collectCobblestoneSchema, type CollectCobblestonePrimitives } from './library/collectCobblestone.ts'
import { craftStonePickaxe, craftStonePickaxeSchema, type CraftStonePickaxePrimitives } from './library/craftStonePickaxe.ts'
import { craftStoneAxe, craftStoneAxeSchema } from './library/craftStoneAxe.ts'
import { craftStoneSword, craftStoneSwordSchema } from './library/craftStoneSword.ts'
import { mineIronOre, mineIronOreSchema, type MineIronOrePrimitives } from './library/mineIronOre.ts'
import { mineCoalOre, mineCoalOreSchema } from './library/mineCoalOre.ts'
import { craftFurnace, craftFurnaceSchema, type CraftFurnacePrimitives } from './library/craftFurnace.ts'
import { smeltIronOre, smeltIronOreSchema, type SmeltIronOrePrimitives } from './library/smeltIronOre.ts'
import { craftIronPickaxe, craftIronPickaxeSchema, type CraftIronPickaxePrimitives } from './library/craftIronPickaxe.ts'
import { killOnePig, killOnePigSchema, type KillOnePigPrimitives } from './library/killOnePig.ts'
import { cookMeat, cookMeatSchema, type CookMeatPrimitives } from './library/cookMeat.ts'
import { craftWoodenSword, craftWoodenSwordSchema, type CraftWoodenSwordPrimitives } from './library/craftWoodenSword.ts'
import { guardedBlock, guardedItem, type McDataLike } from './names.ts'
import { skillFail, skillOk } from './types.ts'
import type { SkillInvocationContext, SkillInvocationRecord, SkillResult, SkillSchemaStub } from './types.ts'

export interface SkillEntry {
  name: string
  /** LLM-facing stub (unit-10 doc consumes these; not wired to the contract yet). */
  schema: SkillSchemaStub | null
  invoke(params: Record<string, unknown>): Promise<SkillResult<unknown>>
}

export interface SkillRegistry {
  entries: ReadonlyMap<string, SkillEntry>
  invoke(name: string, params?: Record<string, unknown>): Promise<SkillResult<unknown>>
  /** Records accumulated since the last drain — feed to stats.foldStats or the ledger. */
  drainRecords(): SkillInvocationRecord[]
  adapters: SkillAdapters
}

export function createSkillRegistry(
  bot: Bot,
  mcData: McDataLike & Record<string, any>,
  onRecord?: (record: SkillInvocationRecord) => void,
): SkillRegistry {
  const a = createSkillAdapters(bot, mcData)
  const records: SkillInvocationRecord[] = []

  const ctx = (): SkillInvocationContext => a.captureContext()

  // ---- tier shims (proven live by the U6-U9 drills) ----

  const woodPrimitives: WoodTierPrimitives = {
    mineBlock: (p) => mineBlock(a.mineBlockDeps, p, ctx()),
    craftItem: (p) => craftItemPrimitive(a.craftItemDeps, p, ctx()),
    placeItem: (p) => placeItemPrimitive(a.placeItemDepsFor(p.name), p, ctx()) as never,
  }

  const itemsToApplications = (name: string, items: number | undefined): SkillResult<never> | number => {
    const lookup = guardedItem(mcData, name)
    if (!lookup.ok) return skillFail(lookup.failureCode, lookup.detail, 0, ctx()) as SkillResult<never>
    const wanted = Math.max(1, Math.floor(items ?? 1))
    return Math.max(1, Math.ceil(wanted / a.recipeYieldFor(lookup.value.id)))
  }

  const craftItemsCount = async (name: string, count?: number): Promise<SkillResult<{ crafted: number }>> => {
    const applications = itemsToApplications(name, count)
    if (typeof applications !== 'number') return applications
    return craftItemPrimitive(a.craftItemDeps, { name, count: applications }, ctx())
  }

  const stonePrimitives: CollectCobblestonePrimitives & CraftStonePickaxePrimitives = {
    equipBestTool: async ({ block }) => {
      const lookup = guardedBlock(mcData, block)
      if (!lookup.ok) return skillFail(lookup.failureCode, lookup.detail, 0, ctx()) as never
      const sample = bot.findBlock({ matching: lookup.value.id, maxDistance: 32 })
      if (!sample) return skillFail('RESOURCE_NOT_FOUND', `no ${block} within 32 blocks to gauge a tool against`, 0, ctx()) as never
      const tool = (bot as any).tool
      if (!tool) return skillFail('TOOL_REQUIRED', 'tool plugin unavailable (PLUGIN_TOOL off)', 0, ctx()) as never
      try {
        await tool.equipForBlock(sample, { requireHarvest: true })
        return skillOk({ tool: bot.heldItem?.name ?? 'hand' }, 0, ctx()) as never
      } catch {
        return skillFail('TOOL_REQUIRED', `${block} needs a harvest tool the pack lacks (e.g. a pickaxe)`, 0, ctx()) as never
      }
    },
    mineBlock: (p) => mineBlock(a.mineBlockDeps, p, ctx()),
    craftItem: ({ name, count }) => craftItemsCount(name, count),
    countItem: async ({ name }) => {
      const lookup = guardedItem(mcData, name)
      if (!lookup.ok) return skillFail(lookup.failureCode, lookup.detail, 0, ctx()) as never
      return skillOk({ count: bot.inventory.count(lookup.value.id, null) }, 0, ctx()) as never
    },
    findBlock: async ({ name, maxDistance }) => {
      const lookup = guardedBlock(mcData, name)
      if (!lookup.ok) return skillFail(lookup.failureCode, lookup.detail, 0, ctx()) as never
      const b = bot.findBlock({ matching: lookup.value.id, maxDistance: maxDistance ?? 32 })
      if (!b) return skillFail('TARGET_NOT_FOUND', `no ${name} within ${maxDistance ?? 32} blocks`, 0, ctx()) as never
      return skillOk({ position: { x: b.position.x, y: b.position.y, z: b.position.z } }, 0, ctx()) as never
    },
    placeItem: async ({ name }) => {
      const cell = a.findGroundCell()
      if (!cell) return skillFail('PLACE_FAILED', 'no solid open cell near the body to place on', 0, ctx()) as never
      const r = await placeItemPrimitive(a.placeItemDepsFor(name), { name, position: cell }, ctx())
      if (!r.ok) return r as never
      return skillOk({ position: cell }, r.costMs, ctx()) as never
    },
  }

  const orePrimitives: MineIronOrePrimitives & CraftFurnacePrimitives & SmeltIronOrePrimitives & CraftIronPickaxePrimitives = {
    mineBlock: async ({ blockName, count }) => {
      const r = await mineBlock(a.mineBlockDeps, { name: blockName, count }, ctx())
      if (!r.ok) return r as never
      return skillOk({ mined: r.outcome.collected }, r.costMs, ctx()) as never
    },
    craftItem: ({ itemName, count }) => craftItemsCount(itemName, count),
    placeItem: async ({ itemName, position }) => {
      const cell = position ?? a.findGroundCell()
      if (!cell) return skillFail('PLACE_FAILED', 'no solid open cell near the body to place on', 0, ctx()) as never
      // One retry on the blockUpdate flake (live PLACE_FAILED rate ~1 in 6).
      for (let attempt = 0; attempt < 2; attempt++) {
        const r = await placeItemPrimitive(a.placeItemDepsFor(itemName), { name: itemName, position: cell }, ctx())
        if (r.ok) return skillOk({ placed: true }, r.costMs, ctx()) as never
        if (r.failureCode !== 'PLACE_FAILED' || attempt === 1) return r as never
        const next = a.findGroundCell()
        if (!next) return r as never
        Object.assign(cell, next)
      }
      return skillFail('PLACE_FAILED', 'exhausted placement attempts', 0, ctx()) as never
    },
    smeltItem: (p) => smeltItemPrimitive(a.smeltItemDeps, p, ctx()),
  }

  const combatPrimitives: KillOnePigPrimitives & CookMeatPrimitives & CraftWoodenSwordPrimitives = {
    killMob: (p) => killMobPrimitive(a.killMobDeps, p, ctx()),
    smeltItem: ({ itemName, count, fuelName }) =>
      smeltItemPrimitive(a.smeltItemDeps, { itemName, fuelName: fuelName ?? 'oak_planks', count }, ctx()),
    craftItem: ({ itemName, count }) => craftItemsCount(itemName, count),
  }

  // ---- the registry surface ----
  const entries = new Map<string, SkillEntry>()
  const register = (name: string, schema: SkillSchemaStub | null, run: (params: Record<string, unknown>) => Promise<SkillResult<unknown>>) => {
    entries.set(name, { name, schema, invoke: run })
  }

  // primitives (schema exposure decided by the unit-10 doc; stubs null here)
  register('mineBlock', null, (p) => mineBlock(a.mineBlockDeps, p as never, ctx()))
  register('craftItem', null, (p) => craftItemPrimitive(a.craftItemDeps, p as never, ctx()))
  register('placeItem', null, (p: any) => placeItemPrimitive(a.placeItemDepsFor(p.name), p, ctx()))
  register('smeltItem', null, (p) => smeltItemPrimitive(a.smeltItemDeps, p as never, ctx()))
  register('getItemFromChest', null, (p) => getItemFromChest(a.useChestDeps, p as never, ctx()))
  register('depositItemIntoChest', null, (p) => depositItemIntoChest(a.useChestDeps, p as never, ctx()))
  register('checkItemInsideChest', null, (p) => checkItemInsideChest(a.useChestDeps, p as never, ctx()))
  register('killMob', null, (p) => killMobPrimitive(a.killMobDeps, p as never, ctx()))
  register('exploreUntil', null, (p: any) => exploreUntil(a.exploreUntilDeps, p, p.predicate ?? (() => null), ctx()))
  register('givePlacedItemBack', null, (p) => givePlacedItemBack(a.givePlacedItemBackDeps, p as never, ctx()))

  // library skills (wood)
  register('mineWoodLog', mineWoodLogSchema, (p) => mineWoodLog(woodPrimitives, p as never, ctx()))
  register('craftPlanks', craftPlanksSchema, (p) => craftPlanks(woodPrimitives, p as never, ctx()))
  register('craftSticks', craftSticksSchema, (p) => craftSticks(woodPrimitives, p as never, ctx()))
  register('craftCraftingTable', craftCraftingTableSchema, (p) => craftCraftingTable(woodPrimitives, p as never, ctx()))
  register('craftWoodenPickaxe', craftWoodenPickaxeSchema, (p) => craftWoodenPickaxe(woodPrimitives, p as never, ctx()))
  // stone
  register('collectCobblestone', collectCobblestoneSchema, (p) => collectCobblestone(stonePrimitives, p as never, ctx()))
  register('craftStonePickaxe', craftStonePickaxeSchema, (p) => craftStonePickaxe(stonePrimitives, p as never, ctx()))
  register('craftStoneAxe', craftStoneAxeSchema, (p) => craftStoneAxe(stonePrimitives, p as never, ctx()))
  register('craftStoneSword', craftStoneSwordSchema, (p) => craftStoneSword(stonePrimitives, p as never, ctx()))
  // ore + smelt
  register('mineIronOre', mineIronOreSchema, (p) => mineIronOre(orePrimitives, p as never, ctx()))
  register('mineCoalOre', mineCoalOreSchema, (p) => mineCoalOre(orePrimitives, p as never, ctx()))
  register('craftFurnace', craftFurnaceSchema, (p) => craftFurnace(orePrimitives, p as never, ctx()))
  register('smeltIronOre', smeltIronOreSchema, (p) => smeltIronOre(orePrimitives, p as never, ctx()))
  register('craftIronPickaxe', craftIronPickaxeSchema, (p) => craftIronPickaxe(orePrimitives, p as never, ctx()))
  // food + combat
  register('killOnePig', killOnePigSchema, (p) => killOnePig(combatPrimitives, p as never, ctx()))
  register('cookMeat', cookMeatSchema, (p) => cookMeat(combatPrimitives, p as never, ctx()))
  register('craftWoodenSword', craftWoodenSwordSchema, (p) => craftWoodenSword(combatPrimitives, p as never, ctx()))

  const invoke = async (name: string, params: Record<string, unknown> = {}): Promise<SkillResult<unknown>> => {
    const entry = entries.get(name)
    if (!entry) {
      return skillFail('UNSUPPORTED_NAME', `no skill named "${name}" in the registry`, 0, ctx())
    }
    const result = await entry.invoke(params)
    const record: SkillInvocationRecord = {
      skill: name,
      at: new Date().toISOString(),
      ok: result.ok,
      failureCode: result.ok ? null : result.failureCode,
      costMs: result.costMs,
      context: result.context,
    }
    records.push(record)
    onRecord?.(record)
    return result
  }

  return {
    entries,
    invoke,
    drainRecords: () => records.splice(0, records.length),
    adapters: a,
  }
}
