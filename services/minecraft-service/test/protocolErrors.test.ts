import { describe, expect, it, vi } from 'vitest'
import {
  installProtocolErrorSuppression,
  packetNameFromPartialReadError,
  type BotWithProtocolErrors,
} from '../src/bots/protocolErrors.ts'
import type { Bot } from 'mineflayer'

function fakeBot() {
  const listeners = new Map<string | symbol, Set<(...args: unknown[]) => void>>()
  const client = {
    emit(event: string | symbol, ...args: unknown[]): boolean {
      // After install wraps emit, this original body is what gets called for
      // non-PartialReadError events — keep a real listener table so we can
      // assert non-suppressed errors still propagate.
      const set = listeners.get(event)
      if (!set) return false
      for (const fn of set) fn(...args)
      return true
    },
    on(event: string | symbol, fn: (...args: unknown[]) => void) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)!.add(fn)
      return client
    },
  }
  return { _client: client } as unknown as Bot
}

describe('packetNameFromPartialReadError', () => {
  it('prefers the packet_<name> form protodef emits', () => {
    expect(
      packetNameFromPartialReadError(
        'PartialReadError: Unexpected buffer end while reading packet_scoreboard_objective.value',
      ),
    ).toBe('scoreboard_objective')
  })

  it('falls back to a trailing field path', () => {
    expect(packetNameFromPartialReadError('PartialReadError: foo.bar')).toBe('foo')
  })

  it('returns unknown when nothing matches', () => {
    expect(packetNameFromPartialReadError('PartialReadError: ???')).toBe('unknown')
  })
})

describe('installProtocolErrorSuppression', () => {
  it('swallows PartialReadError, tallies by packet, and exposes the tally', () => {
    const bot = fakeBot()
    const warn = vi.fn()
    const withTally = installProtocolErrorSuppression(bot, warn)

    bot._client.emit('error', new Error('PartialReadError: while reading packet_map_chunk.chunkData'))
    bot._client.emit('error', new Error('PartialReadError: while reading packet_map_chunk.chunkData'))
    bot._client.emit(
      'error',
      new Error('PartialReadError: Unexpected buffer end while reading packet_scoreboard_objective.value'),
    )

    const tally = withTally.getSuppressedProtocolErrors()
    expect(tally).toEqual({
      total: 3,
      byPacket: { map_chunk: 2, scoreboard_objective: 1 },
    })
    expect(warn).toHaveBeenCalled()
  })

  it('does not swallow unrelated client errors', () => {
    const bot = fakeBot()
    const withTally = installProtocolErrorSuppression(bot)
    const onError = vi.fn()
    bot._client.on('error', onError)

    bot._client.emit('error', new Error('ECONNRESET'))

    expect(onError).toHaveBeenCalledOnce()
    expect(withTally.getSuppressedProtocolErrors()).toEqual({ total: 0, byPacket: {} })
  })

  it('survives a bot with no _client (structural fakes / early wiring)', () => {
    const bot = {} as Bot
    const withTally = installProtocolErrorSuppression(bot) as BotWithProtocolErrors
    expect(withTally.getSuppressedProtocolErrors()).toEqual({ total: 0, byPacket: {} })
  })
})
