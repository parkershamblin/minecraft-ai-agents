/**
 * Wrap a mineflayer cam bot so prismarine-viewer sees 1.21.4-shaped chunks
 * on Minecraft 26.x. Port of MineBot browser_viewer.js getBrowserViewerBot
 * (world getColumnAt/getColumn + blockUpdate wrapping + version spoof).
 * Inactive unless bot.version starts with "26" — 1.21.6 cams pass through unchanged.
 */
import type { Bot } from 'mineflayer'
import {
  translateColumn26To21,
  translateStateId,
  VIEWER_SPOOF_VERSION,
  type ChunkColumnLike,
} from './chunkTranslator.ts'

export function needsChunkTranslation(version: string | undefined): boolean {
  return typeof version === 'string' && version.startsWith('26')
}

function chunkKeyFromArgs(prop: string | symbol, args: unknown[]): string | null {
  if (prop === 'getColumn' && args.length >= 2) {
    return `${args[0]},${args[1]}`
  }
  const pos = args[0] as { x?: number; z?: number } | undefined
  if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.z)) {
    return `${Math.floor(pos.x! / 16)},${Math.floor(pos.z! / 16)}`
  }
  return null
}

type BotListener = (...args: unknown[]) => void

/**
 * Returns the bot unchanged on non-26.x. On 26.x, returns a Proxy that
 * spoofs version to 1.21.4, translates world columns before toJson(), and
 * rewrites blockUpdate stateIds for WorldView.
 *
 * The state-ID lookup inside chunkTranslator is built lazily on first
 * translate — importing this module on a 1.21.6 path costs nothing.
 */
export function wrapBotForViewer(bot: Bot): Bot {
  if (!needsChunkTranslation(bot.version)) {
    return bot
  }

  const blockUpdateWrappers = new WeakMap<BotListener, BotListener>()
  const translatedColumnCache = new Map<string, unknown>()

  const invalidateColumn = (chunkX: number, chunkZ: number): void => {
    translatedColumnCache.delete(`${chunkX},${chunkZ}`)
  }

  bot.on('chunkColumnLoad', (pos: { x: number; z: number }) => {
    invalidateColumn(Math.floor(pos.x / 16), Math.floor(pos.z / 16))
  })
  bot.on('blockUpdate', (_oldBlock, newBlock) => {
    const p = newBlock?.position
    if (p) invalidateColumn(Math.floor(p.x / 16), Math.floor(p.z / 16))
  })

  const worldProxy = new Proxy(bot.world, {
    get(target, prop, receiver) {
      if (prop === 'getColumnAt' || prop === 'getColumn') {
        return (...args: unknown[]) => {
          const key = chunkKeyFromArgs(prop, args)
          if (key && translatedColumnCache.has(key)) {
            return translatedColumnCache.get(key)
          }
          const method = Reflect.get(target, prop, receiver) as (...a: unknown[]) => unknown
          const col = method.apply(target, args)
          const translated = translateColumn26To21(col as ChunkColumnLike | null | undefined)
          if (key && translated) {
            translatedColumnCache.set(key, translated)
          }
          return translated
        }
      }
      return Reflect.get(target, prop, receiver)
    },
  })

  return new Proxy(bot, {
    get(target, property, receiver) {
      if (property === 'version') return VIEWER_SPOOF_VERSION
      if (property === 'world') return worldProxy
      if (property === 'on' || property === 'addListener') {
        return (event: string | symbol, listener: BotListener) => {
          if (event === 'blockUpdate') {
            let wrapper = blockUpdateWrappers.get(listener)
            if (!wrapper) {
              wrapper = (oldBlock: unknown, newBlock: unknown) => {
                const nb = newBlock as { stateId?: number; type?: number; metadata?: number }
                const raw = nb.stateId ?? (((nb.type ?? 0) << 4) | (nb.metadata ?? 0))
                listener(oldBlock, Object.assign({}, nb, { stateId: translateStateId(raw) }))
              }
              blockUpdateWrappers.set(listener, wrapper)
            }
            return Reflect.apply(
              target[property as 'on'] as (e: string | symbol, l: BotListener) => Bot,
              target,
              [event, wrapper],
            )
          }
          return Reflect.apply(
            target[property as 'on'] as (e: string | symbol, l: BotListener) => Bot,
            target,
            [event, listener],
          )
        }
      }
      if (property === 'removeListener' || property === 'off') {
        return (event: string | symbol, listener: BotListener) => {
          if (event === 'blockUpdate') {
            const wrapper = blockUpdateWrappers.get(listener)
            if (wrapper) {
              blockUpdateWrappers.delete(listener)
              return Reflect.apply(
                target[property as 'off'] as (e: string | symbol, l: BotListener) => Bot,
                target,
                [event, wrapper],
              )
            }
          }
          return Reflect.apply(
            target[property as 'off'] as (e: string | symbol, l: BotListener) => Bot,
            target,
            [event, listener],
          )
        }
      }
      return Reflect.get(target, property, receiver)
    },
  }) as Bot
}
