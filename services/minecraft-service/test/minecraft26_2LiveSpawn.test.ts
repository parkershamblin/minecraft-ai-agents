import { afterEach, describe, expect, it } from 'vitest'
import mineflayer from 'mineflayer'

/**
 * Gated live smoke: join a host Minecraft 26.2 server and assert the
 * transplanted compat layer (vendor data + patches) can spawn a body.
 *
 * Enable with MINECRAFT_LIVE_TEST=1. Defaults target MineBot's local
 * vanilla 26.2 on :55916 (see docs/runbooks/minecraft-26.2-local.md).
 * Skipped when the gate is unset — CI and machines without a 26.2 server
 * stay green.
 */

const enabled = process.env.MINECRAFT_LIVE_TEST === '1'
const host = process.env.MINECRAFT_TEST_HOST || '127.0.0.1'
const port = Number(process.env.MINECRAFT_TEST_PORT || 55916)
const username = process.env.MINECRAFT_TEST_USERNAME || 'civ26_smoke'

describe('minecraft 26.2 live spawn (gated)', () => {
  let bot: ReturnType<typeof mineflayer.createBot> | undefined
  let disconnectPromise: Promise<void> | undefined

  const disconnect = async () => {
    if (!bot) return
    if (disconnectPromise) return disconnectPromise
    const client = (bot as { _client?: { state?: string; socket?: { destroy: () => void } } })._client
    if (client?.state === 'disconnected') return

    disconnectPromise = new Promise((resolve) => {
      const done = () => {
        clearTimeout(forceClose)
        resolve()
      }
      const forceClose = setTimeout(() => {
        client?.socket?.destroy()
        resolve()
      }, 2000)
      bot!.once('end', done)
      bot!.quit('26.2 live smoke complete')
    })
    return disconnectPromise
  }

  afterEach(async () => {
    await disconnect()
    bot = undefined
    disconnectPromise = undefined
  })

  it.skipIf(!enabled)(
    'createBot 26.2 spawns and can read the world underfoot',
    async () => {
      bot = mineflayer.createBot({
        username,
        host,
        port,
        version: '26.2',
        auth: 'offline',
        hideErrors: true,
      })

      await new Promise<void>((resolve, reject) => {
        const fail = (error: unknown) =>
          reject(error instanceof Error ? error : new Error(String(error)))

        bot!.once('error', fail)
        bot!.once('kicked', (reason) =>
          fail(new Error(`Kicked by test server: ${JSON.stringify(reason)}`)),
        )
        bot!.once('spawn', async () => {
          try {
            await bot!.waitForChunksToLoad()
            expect(bot!.version).toBe('26.2')
            expect(bot!.entity).toBeTruthy()
            expect(bot!.inventory).toBeTruthy()
            expect(bot!.registry.blocksByName.sulfur).toBeTruthy()

            const block = bot!.blockAt(bot!.entity.position.offset(0, -1, 0))
            expect(block, 'Expected a block below the spawned bot').toBeTruthy()
            resolve()
          } catch (error) {
            reject(error)
          }
        })
      })
    },
    90_000,
  )
})
