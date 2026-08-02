/**
 * Name-guard audit against a 26.2-shaped registry slice loaded from the
 * vendored minecraft-data JSON (no live server). Keeps WOOD_LOGS / aliases /
 * craft+gather names from silently drifting off a version the bots negotiate.
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  NAME_ALIASES,
  WOOD_LOGS,
  guardedBlock,
  guardedItem,
  logNameForPlanks,
  plankNameFor,
  type McDataLike,
} from '../src/skills/names.ts'
import { MEAT_NAMES } from '../src/skills/library/cookMeat.ts'
import { RESOURCE_BLOCKS } from '../src/world/resources.ts'
import { CRAFTABLE_ITEMS } from '../src/world/crafting.ts'
import { HUNT_FAMILIES, HUNT_YIELD } from '../src/world/hunting.ts'

const here = dirname(fileURLToPath(import.meta.url))
const vendorRoot = join(here, '../../../vendor/minecraft-data-26.2/data/pc/26.2')

function loadRegistrySlice(): McDataLike | null {
  const blocksPath = join(vendorRoot, 'blocks.json')
  const itemsPath = join(vendorRoot, 'items.json')
  if (!existsSync(blocksPath) || !existsSync(itemsPath)) {
    return null
  }
  const blocks = JSON.parse(readFileSync(blocksPath, 'utf8')) as Array<{ id: number; name: string }>
  const items = JSON.parse(readFileSync(itemsPath, 'utf8')) as Array<{ id: number; name: string }>
  const blocksByName: McDataLike['blocksByName'] = {}
  const itemsByName: McDataLike['itemsByName'] = {}
  for (const b of blocks) blocksByName[b.name] = { id: b.id, name: b.name }
  for (const i of items) itemsByName[i.name] = { id: i.id, name: i.name }
  return { blocksByName, itemsByName }
}

const slice = loadRegistrySlice()
const describe26 = slice ? describe : describe.skip

describe26('26.2 registry name guards', () => {
  const mc = slice!

  it('every WOOD_LOGS entry resolves as block and item', () => {
    for (const log of WOOD_LOGS) {
      expect(guardedBlock(mc, log).ok, log).toBe(true)
      expect(guardedItem(mc, log).ok, log).toBe(true)
      const planks = plankNameFor(log)
      expect(guardedItem(mc, planks).ok, planks).toBe(true)
      expect(logNameForPlanks(planks)).toBe(log)
    }
  })

  it('gather wood list is the same WOOD_LOGS (no pale_oak / bamboo drift)', () => {
    expect([...RESOURCE_BLOCKS.wood]).toEqual([...WOOD_LOGS])
  })

  it('Voyager aliases resolve on the 26.2 slice', () => {
    for (const [from, to] of Object.entries(NAME_ALIASES)) {
      if (from === 'lapis_lazuli_ore') {
        const r = guardedBlock(mc, from)
        expect(r.ok).toBe(true)
        if (r.ok) expect(r.value.name).toBe(to)
      } else {
        const r = guardedItem(mc, from)
        expect(r.ok, from).toBe(true)
        if (r.ok) expect(r.value.name).toBe(to)
      }
    }
  })

  it('craftable concrete items (minus abstract planks/sticks) resolve', () => {
    for (const item of CRAFTABLE_ITEMS) {
      if (item === 'planks' || item === 'sticks') continue
      expect(guardedItem(mc, item).ok, item).toBe(true)
    }
    expect(guardedItem(mc, 'stick').ok).toBe(true)
  })

  it('ore / stone / dirt gather blocks resolve', () => {
    for (const family of ['stone', 'dirt', 'coal', 'iron_ore'] as const) {
      for (const name of RESOURCE_BLOCKS[family] ?? []) {
        expect(guardedBlock(mc, name).ok, name).toBe(true)
      }
    }
  })

  it('hunt yield + cook meat names resolve', () => {
    for (const family of Object.keys(HUNT_FAMILIES)) {
      if (family === 'any') continue
      for (const name of HUNT_YIELD[family] ?? []) {
        expect(guardedItem(mc, name).ok, name).toBe(true)
      }
    }
    expect(guardedItem(mc, 'white_wool').ok).toBe(true)
    for (const meat of MEAT_NAMES) {
      expect(guardedItem(mc, meat).ok, meat).toBe(true)
      expect(guardedItem(mc, `cooked_${meat}`).ok, `cooked_${meat}`).toBe(true)
    }
  })
})
