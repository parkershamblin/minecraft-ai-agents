/**
 * Map Minecraft 26.x block state IDs onto 1.21.4 IDs so prismarine-viewer
 * can mesh chunks with its 1.21.4 atlas/blockStates (26.2-only names like
 * sulfur have no model there). Port of MineBot's chunk_translator.js
 * (cc1724f / f1728d1 / 1c9834e). Lookup is built lazily and only used when
 * the POV sidecar wraps a 26.x cam bot.
 *
 * Canvas is stubbed (noop2) in this repo, so we read the shipped
 * prismarine-viewer public/blocksStates/1.21.4.json instead of regenerating
 * an atlas at runtime the way MineBot does.
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import minecraftData from 'minecraft-data'

const MAX_26_STATE_ID = 35_000
const VIEWER_TARGET_VERSION = '1.21.4'

interface BlockRange {
  name: string
  minStateId: number
  maxStateId: number
}

interface PaletteContainer {
  palette?: number[]
  value?: number
  data?: {
    get(i: number): number
    set(i: number, v: number): void
    capacity: number
    data: Uint32Array
  }
}

interface ChunkSection {
  data?: PaletteContainer
  palette?: number[]
}

export interface ChunkColumnLike {
  sections?: Array<ChunkSection | null | undefined>
}

let stateId26To21: Uint32Array | null = null

/** Exported for unit tests — pure name → fallback name heuristic. */
export function findFallbackBlockName(name26: string): string {
  if (name26.includes('short_dry_grass')) return 'short_grass'
  if (name26.includes('tall_dry_grass')) return 'tall_grass'
  if (name26.includes('dry_grass')) return 'short_grass'
  if (name26 === 'bush') return 'dead_bush'
  if (name26.includes('firefly_bush')) return 'sweet_berry_bush'
  if (name26.includes('wildflowers')) return 'dandelion'
  if (name26.includes('dandelion')) return 'dandelion'
  if (name26.includes('leaf_litter')) return 'oak_leaves'
  if (name26.includes('cactus_flower')) return 'pink_petals'
  if (name26.includes('pale_oak_leaves')) return 'oak_leaves'
  if (name26.includes('pale_oak_log')) return 'oak_log'
  if (name26.includes('pale_oak_wood')) return 'oak_wood'
  if (name26.includes('pale_oak_planks')) return 'oak_planks'
  if (name26.includes('pale_oak_sapling')) return 'oak_sapling'
  if (name26.includes('pale_oak_stairs')) return 'oak_stairs'
  if (name26.includes('pale_oak_slab')) return 'oak_slab'
  if (name26.includes('pale_oak_fence')) return 'oak_fence'
  if (name26.includes('pale_oak_door')) return 'oak_door'
  if (name26.includes('pale_oak_trapdoor')) return 'oak_trapdoor'
  if (name26.includes('pale_oak_button')) return 'oak_button'
  if (name26.includes('pale_oak_pressure_plate')) return 'oak_pressure_plate'
  if (name26.includes('pale_oak_sign')) return 'oak_sign'
  if (name26.includes('pale_oak_hanging_sign')) return 'oak_hanging_sign'
  if (name26.includes('pale_moss_carpet')) return 'moss_carpet'
  if (name26.includes('pale_moss_block')) return 'moss_block'
  if (name26.includes('pale_hanging_moss')) return 'vine'
  if (name26.includes('eyeblossom')) return 'poppy'
  if (name26.includes('shelf')) return 'bookshelf'
  if (name26.includes('copper_torch')) return 'torch'
  if (name26.includes('copper_bars')) return 'iron_bars'
  if (name26.includes('copper_chain')) return 'chain'
  if (name26.includes('copper_lantern')) return 'lantern'
  if (name26.includes('copper_chest')) return 'chest'
  if (name26.includes('copper_golem')) return 'stone'
  if (name26.includes('resin')) return 'terracotta'
  if (name26.includes('sulfur')) return 'yellow_concrete'
  if (name26.includes('cinnabar')) return 'red_concrete'
  if (name26.includes('leaves')) return 'oak_leaves'
  if (name26.includes('log')) return 'oak_log'
  if (name26.includes('wood')) return 'oak_wood'
  if (name26.includes('planks')) return 'oak_planks'
  if (name26.includes('grass')) return 'short_grass'
  if (name26.includes('flower') || name26.includes('plant')) return 'dandelion'
  return 'stone'
}

function findFallbackBlock21(name26: string, blocks21ByName: Record<string, BlockRange>): BlockRange {
  const targetName = findFallbackBlockName(name26)
  return blocks21ByName[targetName] ?? blocks21ByName.short_grass ?? blocks21ByName.stone!
}

function loadBlocks26Json(): BlockRange[] {
  // Prefer the vendored 26.2 registry (same source MineBot imports). Fall back
  // to minecraft-data('26.2') if the path moves under the transplant.
  const here = dirname(fileURLToPath(import.meta.url))
  const vendorPath = join(here, '../../../../vendor/minecraft-data-26.2/data/pc/26.2/blocks.json')
  try {
    return JSON.parse(readFileSync(vendorPath, 'utf8')) as BlockRange[]
  } catch {
    const md = minecraftData('26.2')
    return md.blocksArray.map((b: { name: string; minStateId: number; maxStateId: number }) => ({
      name: b.name,
      minStateId: b.minStateId,
      maxStateId: b.maxStateId,
    }))
  }
}

function loadBlockStates21(): Record<string, unknown> {
  const require = createRequire(import.meta.url)
  const publicDir = dirname(require.resolve('prismarine-viewer/public/index.html'))
  const path = join(publicDir, 'blocksStates', `${VIEWER_TARGET_VERSION}.json`)
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

function hasRenderableModel(blockStates: Record<string, unknown>, name: string): boolean {
  const state = blockStates[name]
  if (state == null) return false
  const missing = blockStates.missing_texture
  if (missing == null) return true
  // JSON round-trip loses the reference equality MineBot uses against a
  // live atlas; compare serialized shape instead.
  return JSON.stringify(state) !== JSON.stringify(missing)
}

function ensureLookup(): Uint32Array {
  if (stateId26To21) return stateId26To21

  const mcData21 = minecraftData(VIEWER_TARGET_VERSION)
  const blockStates = loadBlockStates21()
  const blocks21ByName: Record<string, BlockRange> = {}
  for (const b of mcData21.blocksArray) {
    blocks21ByName[b.name] = { name: b.name, minStateId: b.minStateId, maxStateId: b.maxStateId }
  }

  const lookup = new Uint32Array(MAX_26_STATE_ID)
  for (const b26 of loadBlocks26Json()) {
    const min26 = b26.minStateId
    const max26 = b26.maxStateId

    let b21: BlockRange | undefined = blocks21ByName[b26.name]
    if (b21 && !hasRenderableModel(blockStates, b21.name)) {
      b21 = undefined
    }
    if (!b21) {
      b21 = findFallbackBlock21(b26.name, blocks21ByName)
    }

    for (let id = min26; id <= max26; id++) {
      if (id < 0 || id >= MAX_26_STATE_ID) continue
      const offset = id - min26
      lookup[id] = Math.min(b21.minStateId + offset, b21.maxStateId)
    }
  }

  stateId26To21 = lookup
  return stateId26To21
}

/** Test seam — drop the cached lookup so the next call rebuilds. */
export function resetChunkTranslatorLookup(): void {
  stateId26To21 = null
}

/** Translate a single 26.x state ID to its 1.21.4 equivalent. */
export function translateStateId(stateId26: number): number {
  if (!Number.isFinite(stateId26) || stateId26 < 0 || stateId26 >= MAX_26_STATE_ID) return 0
  return ensureLookup()[stateId26] ?? 0
}

function translateDataContainer(container: PaletteContainer, lookup: Uint32Array): PaletteContainer {
  if (Array.isArray(container.palette)) {
    const clone = Object.assign(Object.create(Object.getPrototypeOf(container)), container) as PaletteContainer
    clone.palette = container.palette.map((id) => lookup[id] ?? 0)
    return clone
  }

  if ('value' in container && container.data === undefined) {
    const clone = Object.assign(Object.create(Object.getPrototypeOf(container)), container) as PaletteContainer
    clone.value = lookup[container.value ?? 0] ?? 0
    return clone
  }

  if (container.data && typeof container.data.get === 'function' && typeof container.data.set === 'function') {
    const clone = Object.assign(Object.create(Object.getPrototypeOf(container)), container) as PaletteContainer
    const src = container.data
    const dataClone = Object.assign(Object.create(Object.getPrototypeOf(src)), src) as typeof src
    dataClone.data = new Uint32Array(src.data)
    for (let i = 0; i < src.capacity; i++) {
      dataClone.set(i, lookup[src.get(i)] ?? 0)
    }
    clone.data = dataClone
    return clone
  }

  return container
}

/**
 * Shallow-clone a 26.x ChunkColumn so toJson() emits 1.21.4 state IDs
 * without mutating the live bot.world column.
 */
export function translateColumn26To21<T extends ChunkColumnLike | null | undefined>(col: T): T {
  if (!col?.sections) return col

  const lookup = ensureLookup()
  const clone = Object.assign(Object.create(Object.getPrototypeOf(col)), col) as ChunkColumnLike
  clone.sections = col.sections.map((sec) => {
    if (!sec?.data) return sec
    const secClone = Object.assign(Object.create(Object.getPrototypeOf(sec)), sec) as ChunkSection
    secClone.data = translateDataContainer(sec.data, lookup)
    secClone.palette = secClone.data.palette
    return secClone
  })
  return clone as T
}

export const VIEWER_SPOOF_VERSION = VIEWER_TARGET_VERSION
