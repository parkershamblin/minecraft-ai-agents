import type { Bot } from 'mineflayer'
import type { Vec3 } from 'vec3'
import type { CamAssignment } from './roster.ts'
import type { RconGate } from './rconGate.ts'
import { logger } from '../logging.ts'

/**
 * One spectator camera bot filming one racer, out-of-process from the fleet.
 *
 * The follow is a client-driven ghost: `physicsEnabled = false` turns off
 * only the simulation — mineflayer's 50ms tick still transmits whatever we
 * set bot.entity.{position,yaw,pitch} to (version-correct position_look)
 * and emits 'move', which is exactly what prismarine-viewer renders from
 * and what makes the server stream the racer's chunks to the cam. Vanilla
 * /spectate is NOT usable here: mineflayer ignores the set-camera packet.
 *
 * Cam order of operations is a safety contract: no viewer attaches — and no
 * cam follows — until the server has confirmed playerGameType==3. A cam
 * that can't verify spectator stays a dark tile forever (failed_spectator),
 * because an unverified body could collide, aggro mobs, or eat a hit meant
 * for a racer.
 */

export type CamState =
  | 'connecting'
  | 'verifying_spectator'
  | 'failed_spectator'
  | 'acquiring'
  | 'tracking'
  | 'idle'
  | 'stopped'

interface ViewerModule {
  mineflayer: (bot: Bot, opts: { port: number; firstPerson: boolean; viewDistance: number }) => void
}

export interface CamDeps {
  createBot: (opts: { username: string }) => Bot
  loadViewer: () => Promise<ViewerModule>
  rcon: RconGate
  viewDistance: number
  /** eye-forward camera offset in blocks (keeps the racer model behind the lens) */
  forwardOffset?: number
  followIntervalMs?: number
  rescueTpMinIntervalMs?: number
  spectatorRetryMs?: number
  reconnectBaseMs?: number
  reconnectCapMs?: number
}

const EYE_HEIGHT = 1.62

export class CamSession {
  state: CamState = 'connecting'
  lastMoveTs: string | null = null

  private bot: Bot | null = null
  private stopped = false
  private followTimer: ReturnType<typeof setInterval> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectDelayMs: number
  private lastRescueTpMs = 0
  private readonly log

  constructor(
    readonly assignment: CamAssignment,
    private readonly deps: CamDeps,
  ) {
    this.reconnectDelayMs = deps.reconnectBaseMs ?? 1_000
    this.log = logger.child({ module: 'pov-cam', cam: assignment.camName, racer: assignment.racer, port: assignment.port })
  }

  start(): void {
    if (this.stopped) {
      return
    }
    this.state = 'connecting'
    const bot = this.deps.createBot({ username: this.assignment.camName })
    this.bot = bot

    bot.on('error', (err) => this.log.warn({ err: err.message }, 'cam bot error'))
    bot.on('kicked', (reason) => this.log.warn({ reason: String(reason) }, 'cam bot kicked'))
    bot.once('spawn', () => {
      void this.onSpawn(bot)
    })
    bot.on('end', (reason) => this.onEnd(reason))
  }

  private async onSpawn(bot: Bot): Promise<void> {
    if (this.stopped || bot !== this.bot) {
      return
    }
    // Ghost mode: no simulation, but the tick keeps sending our position.
    bot.physicsEnabled = false
    this.state = 'verifying_spectator'
    const verified = await this.deps.rcon.ensureSpectator(this.assignment.camName)
    if (this.stopped || bot !== this.bot) {
      return
    }
    if (!verified) {
      this.state = 'failed_spectator'
      this.log.error('spectator gamemode NOT verified — tile stays dark, retrying')
      this.retryTimer = setTimeout(() => void this.onSpawn(bot), this.deps.spectatorRetryMs ?? 60_000)
      return
    }
    try {
      const viewer = await this.deps.loadViewer()
      if (this.stopped || bot !== this.bot) {
        return
      }
      viewer.mineflayer(bot, {
        port: this.assignment.port,
        firstPerson: true,
        viewDistance: this.deps.viewDistance,
      })
      this.log.info('pov tile up')
    } catch (err) {
      // Tile stays dark; the guards + supervised restart are the recovery.
      this.log.error({ err: String(err) }, 'viewer attach failed — tile dark')
    }
    this.state = 'acquiring'
    this.reconnectDelayMs = this.deps.reconnectBaseMs ?? 1_000
    this.followTimer = setInterval(() => this.followTick(bot), this.deps.followIntervalMs ?? 100)
  }

  /** Copy the racer's eye view onto the ghost cam; rescue-tp when out of range. */
  private followTick(bot: Bot): void {
    if (this.stopped || bot !== this.bot) {
      return
    }
    const racer = bot.players[this.assignment.racer]
    if (!racer) {
      this.state = 'idle' // racer offline — hold the last scene, no tp spam
      return
    }
    const entity = racer.entity
    if (!entity) {
      // online but out of the cam's render range — server-side rescue
      this.state = 'acquiring'
      const now = Date.now()
      if (now - this.lastRescueTpMs >= (this.deps.rescueTpMinIntervalMs ?? 5_000)) {
        this.lastRescueTpMs = now
        this.deps.rcon.tp(this.assignment.camName, this.assignment.racer).catch((err) => {
          this.log.warn({ err: String(err) }, 'rescue tp failed')
        })
      }
      return
    }
    const yaw = entity.yaw
    const pitch = entity.pitch
    const forward = this.deps.forwardOffset ?? 0.6
    // mineflayer view basis: yaw 0 faces -z after its notchian conversion
    const dirX = -Math.sin(yaw) * Math.cos(pitch)
    const dirY = Math.sin(pitch)
    const dirZ = -Math.cos(yaw) * Math.cos(pitch)
    const pos = bot.entity.position as Vec3
    pos.set(entity.position.x + dirX * forward, entity.position.y + EYE_HEIGHT + dirY * forward, entity.position.z + dirZ * forward)
    bot.entity.yaw = yaw
    bot.entity.pitch = pitch
    bot.entity.onGround = false
    this.state = 'tracking'
    this.lastMoveTs = new Date().toISOString()
  }

  private onEnd(reason: string): void {
    this.clearTimers()
    const bot = this.bot
    if (bot) {
      try {
        ;(bot as Bot & { viewer?: { close(): void } }).viewer?.close()
      } catch {
        // port may already be gone with the socket — reconnect re-attaches
      }
    }
    this.bot = null
    if (this.stopped) {
      return
    }
    this.state = 'connecting'
    this.log.warn({ reason, retryInMs: this.reconnectDelayMs }, 'cam disconnected — scheduling reconnect')
    this.reconnectTimer = setTimeout(() => this.start(), this.reconnectDelayMs)
    this.reconnectDelayMs = Math.min(this.deps.reconnectCapMs ?? 60_000, this.reconnectDelayMs * 2) + Math.floor(Math.random() * 250)
  }

  stop(): void {
    if (this.stopped) {
      return
    }
    this.stopped = true
    this.state = 'stopped'
    this.clearTimers()
    const bot = this.bot
    this.bot = null
    if (bot) {
      try {
        ;(bot as Bot & { viewer?: { close(): void } }).viewer?.close()
      } catch {
        // best-effort
      }
      try {
        bot.quit()
      } catch {
        // already gone
      }
    }
  }

  private clearTimers(): void {
    if (this.followTimer) {
      clearInterval(this.followTimer)
      this.followTimer = null
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }
}
