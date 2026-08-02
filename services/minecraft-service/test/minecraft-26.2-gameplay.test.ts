/**
 * End-to-end gameplay smoke against a live Minecraft 26.2 server.
 *
 * Exercises the same createBot options + PartialReadError suppression that
 * BotSession wires (hideErrors, checkTimeoutInterval, installProtocolError-
 * Suppression) through dig / place / inventory — the patched paths that
 * matter for body reliability. Pathfinding is deliberately out of scope
 * (no pathfinder patch port).
 *
 * Requires an offline-mode 26.2 server:
 *   MINECRAFT_LIVE_TEST=1 MINECRAFT_TEST_HOST=127.0.0.1 MINECRAFT_TEST_PORT=55916 \
 *     npm test -- minecraft-26.2-gameplay
 *
 * Skipped when MINECRAFT_LIVE_TEST is unset.
 */

import { afterAll, describe, expect, it } from 'vitest'
import mineflayer from 'mineflayer'
import {
  installProtocolErrorSuppression,
  type BotWithProtocolErrors,
} from '../src/bots/protocolErrors.ts'

const enabled = process.env.MINECRAFT_LIVE_TEST === '1'
const host = process.env.MINECRAFT_TEST_HOST || '127.0.0.1'
const port = Number(process.env.MINECRAFT_TEST_PORT || 55916)

const DIGGABLE = ['dirt', 'grass_block', 'stone', 'cobblestone', 'sand', 'gravel', 'netherrack']

const GAMEPLAY_PACKETS = [
  'map_chunk',
  'position',
  'entity_teleport',
  'block_change',
  'window_items',
]

function waitForSpawn(bot: BotWithProtocolErrors, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for bot spawn')), timeoutMs)
    bot.once('spawn', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe.skipIf(!enabled)('26.2 live gameplay smoke', () => {
  let bot: BotWithProtocolErrors | null = null

  afterAll(async () => {
    try {
      bot?.quit('gameplay test complete')
    } catch {
      /* already disconnected */
    }
    await delay(500)
  })

  it(
    'spawns, digs, places if feasible, reads inventory, keeps gameplay decode clean',
    { timeout: 180_000 },
    async () => {
      bot = installProtocolErrorSuppression(
        mineflayer.createBot({
          host,
          port,
          version: '26.2',
          username: `gp_${Date.now().toString(36).slice(-6)}`,
          auth: 'offline',
          hideErrors: true,
          checkTimeoutInterval: 60_000,
        }),
      )

      bot.once('kicked', (reason) => {
        // vitest has no t.diagnostic; surface via console for live forensics
        console.warn('[26.2-gameplay] kicked:', JSON.stringify(reason))
      })

      await waitForSpawn(bot, 60_000)
      await bot.waitForChunksToLoad()
      await delay(1000)

      expect(bot.version).toBe('26.2')
      expect(bot.entity).toBeTruthy()

      // --- inventory readable -------------------------------------------------
      const items = bot.inventory.items()
      expect(Array.isArray(items)).toBe(true)

      // --- dig one nearby soft block ----------------------------------------
      const target = bot.findBlock({
        matching: (block) => DIGGABLE.includes(block.name),
        maxDistance: 4,
      })
      expect(target, `expected a diggable block nearby (looked for ${DIGGABLE.join(', ')})`).toBeTruthy()

      const targetPosition = target!.position.clone()
      const targetName = target!.name
      await bot.dig(target!)
      await delay(500)

      const afterDig = bot.blockAt(targetPosition)
      expect(afterDig?.name).toBe('air')

      // --- place back if we collected a drop --------------------------------
      await delay(1500)
      const collected = bot.inventory.items().find((item) => item.name === targetName)
      if (collected) {
        const reference = bot.blockAt(targetPosition.offset(0, -1, 0))
        if (reference && reference.name !== 'air') {
          await bot.equip(collected, 'hand')
          // Face vector as a Vec3 without importing the transitive package
          // (same anti-pattern BotSession documents for prismarine helpers).
          const face = targetPosition.offset(0, 1, 0).minus(targetPosition)
          await bot.placeBlock(reference, face)
          await delay(500)
          const afterPlace = bot.blockAt(targetPosition)
          expect(afterPlace?.name).not.toBe('air')
        }
      }

      // --- protocol health --------------------------------------------------
      const suppressed = bot.getSuppressedProtocolErrors()
      console.warn('[26.2-gameplay] suppressed protocol errors:', JSON.stringify(suppressed))

      const criticalFailures = Object.keys(suppressed.byPacket).filter((name) =>
        GAMEPLAY_PACKETS.includes(name),
      )
      expect(
        criticalFailures,
        `gameplay packets failed to decode: ${criticalFailures.join(', ')}. ` +
          'The vendored 26.2 protocol data is wrong for these.',
      ).toEqual([])

      const threshold = Number(process.env.MAX_SUPPRESSED_PROTOCOL_ERRORS || 50)
      expect(
        suppressed.total,
        `suppressed ${suppressed.total} protocol errors (threshold ${threshold})`,
      ).toBeLessThanOrEqual(threshold)
    },
  )
})
