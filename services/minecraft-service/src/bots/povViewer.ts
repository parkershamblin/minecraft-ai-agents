import type { Bot } from 'mineflayer'
import type { Config } from '../config.ts'
import { logger } from '../logging.ts'

/**
 * The RB-3 film rig (ADR 10): first-person browser viewers, one fixed port
 * per racer, OFF unless POV_VIEWER=1. A viewer is a real cost (a three.js
 * worldview streamed per bot) and prismarine-viewer trails Minecraft
 * releases, so the flag is both the measurement gate and the rollback —
 * film/pov-grid.html hardcodes the port pool, which is why indices are a
 * fixed pool rather than ephemeral ports.
 */
export class PovViewers {
  private free: number[]
  private byVillager = new Map<string, { index: number; bot: Bot }>()

  constructor(private readonly config: Config) {
    this.free = Array.from({ length: config.POV_VIEWER_COUNT }, (_, i) => i)
  }

  /** Fire-and-forget from the spawn path — a rig failure must never fail a spawn. */
  async start(villagerId: string, username: string, bot: Bot): Promise<void> {
    if (this.config.POV_VIEWER !== 1 || this.byVillager.has(villagerId)) {
      return
    }
    const index = this.free.shift()
    if (index === undefined) {
      logger.warn({ username }, 'pov viewer pool exhausted — racer gets no viewer')
      return
    }
    const port = this.config.POV_PORT_BASE + index
    try {
      // Lazy: the heavy dep (three.js worldview, express) loads only with the
      // flag on. `canvas` is stubbed (noop2 alias) — the browser does the
      // rendering; the Node-side headless path is never used here.
      const viewer = (await import('prismarine-viewer')) as unknown as {
        mineflayer: (bot: Bot, opts: { port: number; firstPerson: boolean; viewDistance: number }) => void
      }
      viewer.mineflayer(bot, { port, firstPerson: true, viewDistance: this.config.POV_VIEW_DISTANCE })
      this.byVillager.set(villagerId, { index, bot })
      logger.info({ username, port }, 'pov viewer up')
    } catch (err) {
      this.free.unshift(index)
      logger.warn({ username, err: String(err) }, 'pov viewer failed to start')
    }
  }

  stop(villagerId: string): void {
    const entry = this.byVillager.get(villagerId)
    if (!entry) {
      return
    }
    this.byVillager.delete(villagerId)
    this.free.push(entry.index)
    try {
      ;(entry.bot as Bot & { viewer?: { close(): void } }).viewer?.close()
    } catch {
      // the socket may already be gone with the bot — freeing the index is what matters
    }
  }

  /** For tests and the admin surface: which ports are live. */
  activePorts(): number[] {
    return [...this.byVillager.values()].map((e) => this.config.POV_PORT_BASE + e.index).sort((a, b) => a - b)
  }
}
