import { describe, expect, it } from 'vitest'
import minecraftData from 'minecraft-data'
import {
  findFallbackBlockName,
  translateColumn26To21,
  translateStateId,
  resetChunkTranslatorLookup,
} from '../src/pov/chunkTranslator.ts'
import { needsChunkTranslation, wrapBotForViewer } from '../src/pov/viewerBot.ts'
import { EventEmitter } from 'node:events'
import type { Bot } from 'mineflayer'

describe('findFallbackBlockName (26.x → 1.21.4 heuristics)', () => {
  it('maps 26.2-only sulfur / cinnabar families to concrete stand-ins', () => {
    expect(findFallbackBlockName('sulfur')).toBe('yellow_concrete')
    expect(findFallbackBlockName('potent_sulfur')).toBe('yellow_concrete')
    expect(findFallbackBlockName('sulfur_bricks')).toBe('yellow_concrete')
    expect(findFallbackBlockName('cinnabar')).toBe('red_concrete')
    expect(findFallbackBlockName('polished_cinnabar')).toBe('red_concrete')
  })

  it('maps pale oak / copper / resin stand-ins', () => {
    expect(findFallbackBlockName('pale_oak_log')).toBe('oak_log')
    expect(findFallbackBlockName('copper_torch')).toBe('torch')
    expect(findFallbackBlockName('resin_block')).toBe('terracotta')
  })
})

describe('needsChunkTranslation', () => {
  it('is active only when version starts with 26', () => {
    expect(needsChunkTranslation('26.2')).toBe(true)
    expect(needsChunkTranslation('26.1')).toBe(true)
    expect(needsChunkTranslation('1.21.6')).toBe(false)
    expect(needsChunkTranslation('1.21.4')).toBe(false)
    expect(needsChunkTranslation(undefined)).toBe(false)
  })
})

describe('translateStateId (vendored 26.2 registry)', () => {
  it('maps sulfur state IDs onto yellow_concrete in 1.21.4', () => {
    const md26 = minecraftData('26.2')
    const md21 = minecraftData('1.21.4')
    const sulfur = md26.blocksByName.sulfur
    const yellow = md21.blocksByName.yellow_concrete
    expect(sulfur).toBeDefined()
    expect(yellow).toBeDefined()

    resetChunkTranslatorLookup()
    expect(translateStateId(sulfur!.minStateId)).toBe(yellow!.minStateId)
  })

  it('maps cinnabar onto red_concrete when present in 26.2 data', () => {
    const md26 = minecraftData('26.2')
    const md21 = minecraftData('1.21.4')
    const cinnabar = md26.blocksByName.cinnabar
    if (!cinnabar) {
      // Data slice without cinnabar — heuristic still covered above.
      return
    }
    const red = md21.blocksByName.red_concrete
    expect(red).toBeDefined()
    resetChunkTranslatorLookup()
    expect(translateStateId(cinnabar.minStateId)).toBe(red!.minStateId)
  })

  it('keeps same-named blocks on their 1.21.4 state range (stone)', () => {
    const md26 = minecraftData('26.2')
    const md21 = minecraftData('1.21.4')
    const stone26 = md26.blocksByName.stone!
    const stone21 = md21.blocksByName.stone!
    resetChunkTranslatorLookup()
    expect(translateStateId(stone26.minStateId)).toBe(stone21.minStateId)
  })
})

describe('translateColumn26To21', () => {
  it('rewrites Indirect palettes without mutating the source column', () => {
    const md26 = minecraftData('26.2')
    const md21 = minecraftData('1.21.4')
    const sulfurId = md26.blocksByName.sulfur!.minStateId
    const yellowId = md21.blocksByName.yellow_concrete!.minStateId

    resetChunkTranslatorLookup()
    const section = {
      data: { palette: [sulfurId, 0] },
      palette: [sulfurId, 0],
    }
    const col = { sections: [section] }
    const translated = translateColumn26To21(col)

    expect(translated).not.toBe(col)
    expect(translated!.sections![0]).not.toBe(section)
    expect(translated!.sections![0]!.data!.palette).toEqual([yellowId, translateStateId(0)])
    // source untouched
    expect(section.data.palette).toEqual([sulfurId, 0])
  })

  it('rewrites SingleValue containers', () => {
    const md26 = minecraftData('26.2')
    const md21 = minecraftData('1.21.4')
    const sulfurId = md26.blocksByName.sulfur!.minStateId
    const yellowId = md21.blocksByName.yellow_concrete!.minStateId

    resetChunkTranslatorLookup()
    const col = { sections: [{ data: { value: sulfurId } }] }
    const translated = translateColumn26To21(col)
    expect(translated!.sections![0]!.data!.value).toBe(yellowId)
    expect(col.sections[0]!.data.value).toBe(sulfurId)
  })
})

describe('wrapBotForViewer', () => {
  it('is a no-op for 1.21.6 bots (same reference)', () => {
    const bot = Object.assign(new EventEmitter(), { version: '1.21.6', world: {} }) as unknown as Bot
    expect(wrapBotForViewer(bot)).toBe(bot)
  })

  it('spoofs version and translates getColumnAt on 26.2', () => {
    const md26 = minecraftData('26.2')
    const md21 = minecraftData('1.21.4')
    const sulfurId = md26.blocksByName.sulfur!.minStateId
    const yellowId = md21.blocksByName.yellow_concrete!.minStateId

    resetChunkTranslatorLookup()
    const rawCol = { sections: [{ data: { palette: [sulfurId] }, palette: [sulfurId] }] }
    const world = {
      getColumnAt: () => rawCol,
      getColumn: () => rawCol,
    }
    const bot = Object.assign(new EventEmitter(), { version: '26.2', world }) as unknown as Bot
    const wrapped = wrapBotForViewer(bot)

    expect(wrapped).not.toBe(bot)
    expect(wrapped.version).toBe('1.21.4')
    const col = wrapped.world.getColumnAt({ x: 0, y: 64, z: 0 } as never) as unknown as typeof rawCol
    expect(col.sections[0]!.data.palette).toEqual([yellowId])
    expect(rawCol.sections[0]!.data.palette).toEqual([sulfurId])
  })
})
