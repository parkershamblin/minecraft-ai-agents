/**
 * PartialReadError suppression for Paper / 26.2 protocol survival.
 *
 * Temporary protocol data cannot decode every non-critical packet (painting
 * metadata, scoreboard, custom_payload, …). Swallowing those keeps the bot
 * alive — but also hides the main symptom of wrong vendored protocol data —
 * so every swallowed error is counted per packet name and exposed via
 * `bot.getSuppressedProtocolErrors()`. A handful of painting/scoreboard
 * entries is expected; a large or growing count (especially on gameplay
 * packets) means the protocol layer is decoding real traffic incorrectly.
 */

import type { Bot } from 'mineflayer'

export type SuppressedProtocolErrors = {
  total: number
  byPacket: Record<string, number>
}

export type BotWithProtocolErrors = Bot & {
  getSuppressedProtocolErrors: () => SuppressedProtocolErrors
}

/** Extract a packet name from a protodef PartialReadError message. */
export function packetNameFromPartialReadError(errStr: string): string {
  return (
    errStr.match(/packet_(\w+)/)?.[1] ??
    errStr.match(/\b(\w+)\.\w+\s*$/)?.[1] ??
    'unknown'
  )
}

/**
 * Install per-packet PartialReadError tally + swallow on `bot._client`.
 * Idempotent: re-wiring a reconnect replaces the prior hook via a fresh bot.
 */
export function installProtocolErrorSuppression(
  bot: Bot,
  warn?: (msg: string, detail?: string) => void,
): BotWithProtocolErrors {
  const suppressedProtocolErrors = new Map<string, number>()
  const withTally = bot as BotWithProtocolErrors
  withTally.getSuppressedProtocolErrors = () => ({
    total: [...suppressedProtocolErrors.values()].reduce((sum, count) => sum + count, 0),
    byPacket: Object.fromEntries(suppressedProtocolErrors),
  })

  const client = bot._client
  if (!client || typeof client.emit !== 'function') {
    return withTally
  }

  const originalEmit = client.emit.bind(client)
  client.emit = function (event: string | symbol, ...args: unknown[]): boolean {
    if (event === 'error' && args[0]) {
      const err = args[0]
      const errStr = err instanceof Error ? err.message : String(err)
      if (errStr.includes('PartialReadError')) {
        const packetName = packetNameFromPartialReadError(errStr)
        const seen = (suppressedProtocolErrors.get(packetName) ?? 0) + 1
        suppressedProtocolErrors.set(packetName, seen)
        // Log the first few per packet type; a decode loop would otherwise
        // bury every other message in the console.
        if (warn) {
          if (seen <= 3) {
            warn(`Suppressed PartialReadError (${packetName}, x${seen})`, errStr.slice(0, 120))
          } else if (seen === 4) {
            warn(`Further PartialReadErrors for '${packetName}' will be counted silently.`)
          }
        }
        return true // swallow
      }
    }
    return originalEmit(event, ...args)
  } as typeof client.emit

  return withTally
}
