import mineflayer, { type Bot } from 'mineflayer'
// CJS default-import (same ESM-lexer caveat as kafkajs)
import mineflayerPathfinder from 'mineflayer-pathfinder'
import type Redis from 'ioredis'
import type { Config } from '../config.ts'
import { logger } from '../logging.ts'
import { botSessions, reconnects } from '../metrics.ts'
import { buildEnvelope } from '../events/envelope.ts'
import type { EventProducer } from '../kafka/producer.ts'
import { MovementTracker } from '../world/movementTracker.ts'
import { buildSnapshot, type NearbyVillager } from '../world/snapshot.ts'
import {
  RESOURCE_YIELD,
  type ResourceSighting,
  blockNamesFor,
  gatherFailureMessage,
  planHarvest,
  scanNearbyResources,
  shouldRescan,
} from '../world/resources.ts'
import { type Position, distance, round1 } from '../world/position.ts'

const { pathfinder, Movements, goals } = mineflayerPathfinder

type SpawnReason = 'seed' | 'respawn' | 'reconnect'

interface SessionDeps {
  config: Config
  producer: EventProducer
  redis: Redis
  /** the registry routes chat lines through the ChatRouter */
  onChat: (session: BotSession, speakerUsername: string, message: string) => void
  /** positions of all other sessions, for the snapshot's nearbyVillagers */
  others: () => NearbyVillager[]
}

/**
 * One villager's body: a Mineflayer connection plus its observers. Ephemeral
 * by design — no personality, no persistence. Owns auto-reconnect with
 * exponential backoff; intentional despawn() wins over reconnection.
 */
export class BotSession {
  bot: Bot | null = null

  private despawned = false
  private nextSpawnReason: SpawnReason = 'seed'
  private reconnectDelayMs = 1_000
  private reconnectTimer: NodeJS.Timeout | null = null
  private snapshotTimer: NodeJS.Timeout | null = null
  private resourceScanTimer: NodeJS.Timeout | null = null
  /** last survey result, merged into every snapshot until the next scan (null until one runs) */
  private nearbyResources: ResourceSighting[] | null = null
  private lastScan: { position: Position; at: number } | null = null
  private movement: MovementTracker
  private spawnWaiters: Array<(reason: SpawnReason) => void> = []
  private log

  constructor(
    readonly villagerId: string,
    readonly username: string,
    private readonly deps: SessionDeps,
  ) {
    this.movement = new MovementTracker(deps.config.MOVE_THROTTLE_MS)
    this.log = logger.child({ villagerId, username })
  }

  get position(): Position | null {
    const p = this.bot?.entity?.position
    return p ? { x: p.x, y: p.y, z: p.z } : null
  }

  get active(): boolean {
    return this.bot?.entity !== undefined && !this.despawned
  }

  /** Resolves with the spawn reason once the bot is standing in the world. */
  awaitSpawn(timeoutMs: number): Promise<SpawnReason> {
    if (this.active) {
      return Promise.resolve(this.nextSpawnReason)
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('spawn timeout')), timeoutMs)
      this.spawnWaiters.push((reason) => {
        clearTimeout(timer)
        resolve(reason)
      })
    })
  }

  connect(): void {
    if (this.despawned) {
      return
    }
    const { config } = this.deps
    this.log.info({ host: config.MC_HOST, version: config.MC_VERSION }, 'connecting bot')
    this.bot = mineflayer.createBot({
      host: config.MC_HOST,
      port: config.MC_PORT,
      version: config.MC_VERSION,
      username: this.username,
      auth: 'offline',
      // Bots navigate by pathfinder, not by sight — 'tiny' keeps 20 bots from
      // holding 20 copies of the world (the single biggest RAM lever).
      viewDistance: 'tiny',
    })
    this.wire(this.bot)
  }

  private wire(bot: Bot): void {
    bot.loadPlugin(pathfinder)
    bot.once('spawn', () => this.onSpawn())
    bot.on('death', () => {
      this.nextSpawnReason = 'respawn'
    })
    bot.on('end', (reason) => this.onEnd(reason))
    bot.on('error', (err) => this.log.warn({ err: err.message }, 'bot error'))
    bot.on('chat', (username, message) => this.deps.onChat(this, username, message))
    bot.on('move', () => this.onMove())
  }

  private onSpawn(): void {
    const reason = this.nextSpawnReason
    this.log.info({ reason }, 'bot spawned')
    this.reconnectDelayMs = 1_000
    botSessions.inc()
    if (this.bot) {
      this.bot.pathfinder.setMovements(new Movements(this.bot))
    }

    void this.deps.producer.publish(
      'world.events',
      buildEnvelope({
        eventType: 'VillagerSpawned',
        aggregateId: this.villagerId,
        payload: {
          villagerId: this.villagerId,
          name: this.username,
          position: this.position ?? { x: 0, y: 0, z: 0 },
          spawnReason: reason,
        },
      }),
    )

    this.nextSpawnReason = 'reconnect' // any future spawn that isn't a death is a reconnect
    this.startSnapshots()
    this.startResourceScan()

    for (const waiter of this.spawnWaiters.splice(0)) {
      waiter(reason)
    }
  }

  private onEnd(reason: string): void {
    this.stopSnapshots()
    if (this.bot?.entity) {
      botSessions.dec()
    }
    if (this.despawned) {
      return
    }
    this.log.warn({ reason, retryInMs: this.reconnectDelayMs }, 'bot disconnected — scheduling reconnect')
    reconnects.inc()
    this.nextSpawnReason = 'reconnect'
    this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelayMs)
    // Exponential backoff with jitter, capped at 60s.
    this.reconnectDelayMs = Math.min(60_000, this.reconnectDelayMs * 2) + Math.floor(Math.random() * 250)
  }

  private onMove(): void {
    const position = this.position
    if (!position) {
      return
    }
    const emission = this.movement.check(position, Date.now())
    if (!emission) {
      return
    }
    void this.deps.producer.publish(
      'world.events',
      buildEnvelope({
        eventType: 'VillagerMoved',
        aggregateId: this.villagerId,
        payload: { villagerId: this.villagerId, ...emission },
      }),
    )
  }

  private startSnapshots(): void {
    this.stopSnapshots()
    const { config, redis } = this.deps
    this.snapshotTimer = setInterval(() => {
      if (!this.bot) {
        return
      }
      const snapshot = buildSnapshot(this.villagerId, this.bot, this.deps.others(), this.nearbyResources)
      if (snapshot) {
        void redis
          .set(`world:${this.villagerId}`, JSON.stringify(snapshot), 'EX', config.SNAPSHOT_TTL_SECONDS)
          .catch((err: Error) => this.log.warn({ err: err.message }, 'snapshot write failed'))
      }
    }, config.SNAPSHOT_INTERVAL_MS)
  }

  private stopSnapshots(): void {
    if (this.snapshotTimer) {
      clearInterval(this.snapshotTimer)
      this.snapshotTimer = null
    }
    if (this.resourceScanTimer) {
      clearInterval(this.resourceScanTimer)
      this.resourceScanTimer = null
    }
    // A reconnect respawns somewhere else — don't carry a stale survey there.
    this.nearbyResources = null
    this.lastScan = null
  }

  /**
   * The nearbyResources survey (M2-2) — its own cadence, slower than the 1s
   * snapshot, because findBlocks sweeps are the cost driver. The first scan
   * waits one full interval: at spawn the surrounding chunks are still
   * streaming in, and findBlocks silently skips unloaded columns, so an
   * immediate scan would advertise an emptier world than the real one.
   */
  private startResourceScan(): void {
    const { config } = this.deps
    if (config.RESOURCE_SCAN_INTERVAL_MS === 0) {
      return // disabled — snapshots omit the field entirely
    }
    this.resourceScanTimer = setInterval(() => {
      const bot = this.bot
      const position = this.position
      if (!bot?.entity || !position) {
        return
      }
      // The interval is only the CHECK cadence; the gate decides whether the
      // (expensive) sweep runs. Idle bots settle at one sweep per max-age.
      if (
        !shouldRescan(this.lastScan, position, Date.now(), {
          moveBlocks: config.RESOURCE_SCAN_MOVE_BLOCKS,
          maxAgeMs: config.RESOURCE_SCAN_MAX_AGE_MS,
        })
      ) {
        return
      }
      try {
        this.nearbyResources = scanNearbyResources(bot, {
          maxDistance: config.RESOURCE_SCAN_DISTANCE,
          countCap: config.RESOURCE_SCAN_COUNT_CAP,
          yBand: config.RESOURCE_SCAN_Y_BAND,
        })
        this.lastScan = { position, at: Date.now() }
      } catch (err) {
        // Never let a survey hiccup (mid-chunk-unload race) kill the timer.
        this.log.warn({ err: (err as Error).message }, 'resource scan failed')
      }
    }, config.RESOURCE_SCAN_INTERVAL_MS)
  }

  /**
   * Pathfind to within `range` blocks of `to`. Resolves on arrival; the
   * executor's watchdog owns the deadline and calls stopMoving() on timeout.
   * Completion flushes the movement tracker — the catalog's "plus one
   * VillagerMoved on path completion".
   */
  async moveTo(to: Position, range: number): Promise<{ finalPosition: Position; blocksTraveled: number }> {
    if (!this.bot?.entity) {
      throw new Error('bot has no entity — not spawned')
    }
    const start = this.position as Position
    await this.bot.pathfinder.goto(new goals.GoalNear(to.x, to.y, to.z, range))
    const finalPosition = this.position as Position
    const emission = this.movement.flush(finalPosition, Date.now())
    if (emission) {
      void this.deps.producer.publish(
        'world.events',
        buildEnvelope({
          eventType: 'VillagerMoved',
          aggregateId: this.villagerId,
          payload: { villagerId: this.villagerId, ...emission },
        }),
      )
    }
    return { finalPosition, blocksTraveled: round1(distance(start, finalPosition)) }
  }

  chat(message: string): void {
    if (!this.bot) {
      throw new Error('bot is not connected')
    }
    this.bot.chat(message)
  }

  /**
   * Harvest the nearest block of a resource family — the composite verb:
   * find, plan the tool, pathfind adjacent, equip, dig, step onto the spot
   * to collect the drop, report the inventory delta. Emits ResourceGathered
   * (a world fact); the command outcome carries the same result back to the
   * requesting mind. Failures are prescriptive — the message is the next
   * tick's percept, so it must teach, not just report.
   */
  async gather(
    resource: string,
    maxDistance: number,
  ): Promise<{ resource: string; blockType: string; position: Position; collected: number }> {
    const bot = this.bot
    if (!bot?.entity) {
      throw new Error('bot has no entity — not spawned')
    }
    const names = blockNamesFor(resource)
    if (!names) {
      throw new Error(`unknown resource family '${resource}'`)
    }
    const block = bot.findBlock({
      matching: (candidate) => names.includes(candidate.name),
      maxDistance,
    })
    if (!block) {
      const err = new Error(gatherFailureMessage(resource, maxDistance, this.position))
      ;(err as Error & { code?: string }).code = 'RESOURCE_NOT_FOUND'
      throw err
    }
    // findBlock picks the 3D-nearest match with no reachability check — when
    // a gather times out, THIS line says whether the target was a fair ask.
    const target = { x: block.position.x, y: block.position.y, z: block.position.z }
    this.log.info(
      { resource, blockType: block.name, target, distance: round1(distance(this.position as Position, target)) },
      'gather target found',
    )

    // Check for a doomed dig (stone, empty hands) BEFORE walking — fail
    // fast and prescriptively, not after a hike.
    const itemNameById = (id: number) => bot.registry.items[id]?.name
    const doomed = planHarvest(block, bot.inventory.items(), itemNameById)
    if (doomed.kind === 'blocked') {
      const err = new Error(
        `digging ${block.name} bare-handed drops nothing — it needs ${doomed.toolHint} and you carry none; gather wood or dirt instead`,
      )
      ;(err as Error & { code?: string }).code = 'TOOL_REQUIRED'
      throw err
    }

    const yieldNames = RESOURCE_YIELD[resource] ?? names
    const countYield = () =>
      bot.inventory
        .items()
        .filter((item) => yieldNames.includes(item.name))
        .reduce((sum, item) => sum + item.count, 0)
    const before = countYield()

    await bot.pathfinder.goto(new goals.GoalGetToBlock(block.position.x, block.position.y, block.position.z))
    // Choose the tool AT THE DIG SITE, from the current inventory — the
    // pathfinder digs its own way through obstacles and re-equips as it
    // pleases en route, so a pre-walk choice can be stale on arrival.
    const plan = planHarvest(block, bot.inventory.items(), itemNameById)
    if (plan.kind === 'equip') {
      this.log.info({ tool: plan.item.name, blockType: block.name }, 'gather equipping tool')
      await bot.equip(plan.item, 'hand')
    }
    const blockType = block.name
    await bot.dig(block)
    // Step onto the dig site so the drop auto-collects, then give it a moment.
    await bot.pathfinder.goto(new goals.GoalNear(block.position.x, block.position.y, block.position.z, 0))
    await new Promise((resolve) => setTimeout(resolve, 1_500))

    const collected = Math.max(0, countYield() - before)
    const position = { x: block.position.x, y: block.position.y, z: block.position.z }
    void this.deps.producer.publish(
      'world.events',
      buildEnvelope({
        eventType: 'ResourceGathered',
        aggregateId: this.villagerId,
        payload: { villagerId: this.villagerId, resourceType: blockType, quantity: collected, position },
      }),
    )
    return { resource, blockType, position, collected }
  }

  stopMoving(): void {
    this.bot?.pathfinder.setGoal(null)
  }

  /** Intentional teardown — wins over auto-reconnect. */
  async despawn(): Promise<void> {
    this.despawned = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
    }
    this.stopSnapshots()
    this.bot?.quit()
    await this.deps.redis.del(`world:${this.villagerId}`)
    this.log.info('bot despawned')
  }
}
