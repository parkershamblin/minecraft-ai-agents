import mineflayer, { type Bot } from 'mineflayer'
// CJS default-import (same ESM-lexer caveat as kafkajs)
import mineflayerPathfinder from 'mineflayer-pathfinder'
import type Redis from 'ioredis'
import type { Config } from '../config.ts'
import { logger } from '../logging.ts'
import { botSessions, hazardEscapes, reconnects } from '../metrics.ts'
import { buildEnvelope } from '../events/envelope.ts'
import {
  type BusyState,
  type HazardBot,
  type HazardPhase,
  HazardWatcher,
  hardenMovements,
  hazardPayload,
} from './hazard.ts'
import type { EventProducer } from '../kafka/producer.ts'
import { MovementTracker } from '../world/movementTracker.ts'
import { buildSnapshot, type NearbyVillager } from '../world/snapshot.ts'
import {
  RESOURCE_YIELD,
  type ResourceSighting,
  allTargetsBlacklistedMessage,
  blockNamesFor,
  gatherFailureMessage,
  gatherStartAnnouncement,
  haulAnnouncement,
  pickGatherTarget,
  planHarvest,
  scanNearbyResources,
  shouldRescan,
  targetKey,
} from '../world/resources.ts'
import { type GatherSessionResult, runGatherSession } from '../world/gatherSession.ts'
import { type Position, distance, round1 } from '../world/position.ts'

/** What a gather command reports back to the mind: the session totals plus
 *  what was asked for — the prompt renders this JSON verbatim. */
export type GatherResult = GatherSessionResult & { resource: string; requested: number }

const { pathfinder, Movements, goals } = mineflayerPathfinder

/** How long a failed gather target stays off the menu. Long enough to stop
 *  the every-tick re-pick loop, short enough that shifted world state gets
 *  its retry (a block that defeated four attempts fell on the fifth). */
const GATHER_TARGET_BLACKLIST_MS = 10 * 60_000

/** Process-global so no two spawns — across reconnects, death-respawns, OR
 *  brand-new BotSession instances for the same username — ever share a
 *  generation number (a collision would defeat the tracker's re-baseline). */
let nextSpawnGeneration = 0

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

  /** Cross-cutting busy seam: the executor claims 'action' for a command's
   *  lifetime, the hazard reflex claims 'escape' for an attempt's. The reflex
   *  only starts when null; commands arriving mid-escape fast-fail. */
  busy: BusyState = null

  /** Set on every 'spawn' (connect AND death-respawn) — the inventory tracker
   *  re-baselines whenever it changes, so deltas never span a body swap. */
  private spawnGeneration = 0
  private despawned = false
  private nextSpawnReason: SpawnReason = 'seed'
  private reconnectDelayMs = 1_000
  private reconnectTimer: NodeJS.Timeout | null = null
  private snapshotTimer: NodeJS.Timeout | null = null
  private resourceScanTimer: NodeJS.Timeout | null = null
  private hazardTimer: NodeJS.Timeout | null = null
  private hazardWatcher: HazardWatcher | null = null
  /** last survey result, merged into every snapshot until the next scan (null until one runs) */
  private nearbyResources: ResourceSighting[] | null = null
  private lastScan: { position: Position; at: number } | null = null
  /** gather targets that recently defeated this bot: targetKey → expiry ms */
  private readonly gatherBlacklist = new Map<string, number>()
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

  get generation(): number {
    return this.spawnGeneration
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
    // Persistent, unlike the once() below: mineflayer re-emits 'spawn' after a
    // death-respawn on the SAME connection, and each respawn is a fresh
    // inventory state — deltas across it would book re-collected death drops
    // (and the respawn sync race) as fabricated hauls.
    bot.on('spawn', () => {
      this.spawnGeneration = ++nextSpawnGeneration
    })
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
      const movements = new Movements(this.bot)
      // Powder snow scores as walkable air to the planner — teach it otherwise.
      hardenMovements(movements, this.bot.registry)
      this.bot.pathfinder.setMovements(movements)
      // A* compute slices run synchronously on the shared event loop; the
      // default 40ms/tick budget stacks across 20 pathing bots and starves
      // everything else (Kafka heartbeats included). Smaller slices, longer
      // total think budget: same compute, spread thin enough to breathe.
      this.bot.pathfinder.tickTimeout = this.deps.config.PATHFINDER_TICK_TIMEOUT_MS
      this.bot.pathfinder.thinkTimeout = this.deps.config.PATHFINDER_THINK_TIMEOUT_MS
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
    this.startHazardWatch()

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
    if (this.hazardTimer) {
      clearInterval(this.hazardTimer)
      this.hazardTimer = null
    }
    // A reconnect respawns somewhere else — forget the trap along with the
    // survey. (An in-flight escape attempt still owns `busy` until its race
    // settles; its own finally releases it.)
    this.hazardWatcher = null
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
   * The powder-snow watch — third sibling loop after snapshots and the
   * resource scan. Each pass is two or three blockAt reads (O(1) by hard
   * rule); the escape maneuver itself runs raced-with-timeout inside the
   * watcher, never on this interval's stack.
   */
  private startHazardWatch(): void {
    const { config } = this.deps
    if (config.HAZARD_WATCH_INTERVAL_MS === 0) {
      return // disabled
    }
    this.hazardWatcher = new HazardWatcher({
      bot: () => this.hazardBot(),
      emit: (phase, position, detail) => this.emitHazard(phase, position, detail),
      stopMoving: () => this.stopMoving(),
      getBusy: () => this.busy,
      setBusy: (state) => {
        this.busy = state
      },
      log: this.log,
      config: {
        escapeRetryMs: config.HAZARD_ESCAPE_RETRY_MS,
        digBudget: config.HAZARD_DIG_BUDGET,
        escapeTimeoutMs: config.HAZARD_ESCAPE_TIMEOUT_MS,
      },
    })
    this.hazardTimer = setInterval(() => this.hazardWatcher?.check(), config.HAZARD_WATCH_INTERVAL_MS)
  }

  /** Adapt the live Bot to the reflex's narrow surface (fresh each pass —
   *  the underlying bot is swapped on reconnect). */
  private hazardBot(): HazardBot | null {
    const bot = this.bot
    if (!bot) {
      return null
    }
    return {
      get entity() {
        return bot.entity ? { position: bot.entity.position } : undefined
      },
      // blockAt needs a real Vec3 (prismarine-world calls .floored() on it);
      // mint one from the entity's own position rather than importing an
      // undeclared transitive package. Exact for the integer cells we pass.
      blockAt: (p) => {
        const origin = bot.entity?.position
        if (!origin) {
          return null // no body, no world — reads as unloaded
        }
        const base = origin.floored()
        return bot.blockAt(base.offset(p.x - base.x, p.y - base.y, p.z - base.z))
      },
      dig: (block) => bot.dig(block as unknown as Parameters<Bot['dig']>[0]),
      look: (yaw, pitch, force) => bot.look(yaw, pitch, force),
      setControlState: (control, state) => bot.setControlState(control, state),
    }
  }

  private emitHazard(phase: HazardPhase, position: Position, detail: string | null): void {
    if (phase !== 'trapped') {
      hazardEscapes.inc({ outcome: phase })
    }
    const envelope = buildEnvelope({
      eventType: 'HazardEncountered',
      aggregateId: this.villagerId,
      payload: hazardPayload(this.villagerId, phase, position, detail),
    })
    this.log.info({ phase, position, detail, eventId: envelope.eventId }, 'hazard encountered')
    void this.deps.producer
      .publish('world.events', envelope)
      .catch((err: Error) => this.log.warn({ err: err.message }, 'hazard event publish failed'))
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
   * Harvest up to `count` blocks of a resource family in one sustained
   * session (SV-2) — per block: find, plan the tool, pathfind adjacent,
   * equip, dig, step onto the spot to collect the drop, report the inventory
   * delta. Emits one ResourceGathered per attempted block (world facts
   * survive a mid-session timeout); speaks ONE departure line and ONE haul
   * line per trip. The command outcome carries the session total back to the
   * requesting mind. Failures are prescriptive — the message is the next
   * tick's percept, so it must teach, not just report.
   */
  async gather(resource: string, maxDistance: number, count: number): Promise<GatherResult> {
    const bot = this.bot
    if (!bot?.entity) {
      throw new Error('bot has no entity — not spawned')
    }
    const names = blockNamesFor(resource)
    if (!names) {
      throw new Error(`unknown resource family '${resource}'`)
    }
    const session = await runGatherSession(count, {
      harvestOne: (announceStart) => this.harvestOneBlock(bot, resource, names, maxDistance, count, announceStart),
      // The executor claims busy='action' for the command's lifetime and
      // clears it when the watchdog abandons the race — the seam doubles as
      // the session's cancellation signal, no new machinery.
      bodyStillOurs: () => this.busy === 'action',
      emitBlock: ({ blockType, position, collected }) => {
        void this.deps.producer.publish(
          'world.events',
          buildEnvelope({
            eventType: 'ResourceGathered',
            aggregateId: this.villagerId,
            payload: { villagerId: this.villagerId, resourceType: blockType, quantity: collected, position },
          }),
        )
      },
      announceHaul: (byType) => {
        const announcement = haulAnnouncement(byType)
        if (announcement) {
          bot.chat(announcement)
        }
      },
    })
    return { resource, requested: count, ...session }
  }

  /**
   * One block of a gather session: the M2-1 composite verb, minus the
   * per-trip announcements the session owns. A fresh findBlocks per block is
   * inherent (each dig changes the world), and is command-work the mind paid
   * for — the M2-2 skip gate governs the background survey, not this.
   */
  private async harvestOneBlock(
    bot: Bot,
    resource: string,
    names: readonly string[],
    maxDistance: number,
    count: number,
    announceStart: boolean,
  ): Promise<{ blockType: string; position: Position; collected: number }> {
    const now = Date.now()
    for (const [key, until] of this.gatherBlacklist) {
      if (until <= now) {
        this.gatherBlacklist.delete(key)
      }
    }
    const candidates = bot.findBlocks({
      matching: (candidate) => names.includes(candidate.name),
      maxDistance,
      count: 16,
    })
    const targetPosition = pickGatherTarget(candidates, this.position as Position, this.gatherBlacklist, now)
    const block = targetPosition ? bot.blockAt(targetPosition) : null
    if (!block) {
      const err = new Error(
        candidates.length > 0
          ? allTargetsBlacklistedMessage(resource)
          : gatherFailureMessage(resource, maxDistance, this.position),
      )
      ;(err as Error & { code?: string }).code = 'RESOURCE_NOT_FOUND'
      throw err
    }
    // The scan has no reachability check — when a gather times out, THIS
    // line says whether the target was a fair ask.
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

    // Mark before the attempt, clear on collection (the dedupe pattern): if
    // the walk/dig never settles — the watchdog abandons this promise — the
    // mark survives and the next pick (this session or the next) moves on.
    this.gatherBlacklist.set(targetKey(target), now + GATHER_TARGET_BLACKLIST_MS)
    if (announceStart) {
      bot.chat(gatherStartAnnouncement(resource, block.name, target, count))
    }
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

    if (countYield() === before) {
      // On slopes the drop rolls away from the dig spot (measured 2026-07-09:
      // 6 of 15 digs collected nothing) — chase the item entity instead of
      // trusting the spot. Best-effort: a failed chase still ends as an
      // honest completion, never a timeout.
      const drop = bot.nearestEntity(
        (entity) => entity.name === 'item' && entity.position.distanceTo(block.position) < 8,
      )
      if (drop) {
        try {
          await bot.pathfinder.goto(new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 0))
          await new Promise((resolve) => setTimeout(resolve, 700))
        } catch {
          this.log.info({ blockType }, 'drop chase failed — reporting the honest count')
        }
      }
    }

    const collected = Math.max(0, countYield() - before)
    if (collected > 0) {
      // Only a real haul clears the mark. A zero-collect completion means the
      // block won — measured live 2026-07-09: the server can silently REJECT
      // a cliff-face dig (client thinks it broke; RCON shows the log still
      // standing), and clearing on completion re-exposed that ghost target
      // to every future scan.
      this.gatherBlacklist.delete(targetKey(target))
    }
    return { blockType, position: { x: block.position.x, y: block.position.y, z: block.position.z }, collected }
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
