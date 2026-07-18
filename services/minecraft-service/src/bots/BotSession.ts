import mineflayer, { type Bot } from 'mineflayer'
// CJS default-import (same ESM-lexer caveat as kafkajs)
import mineflayerPathfinder from 'mineflayer-pathfinder'
import type Redis from 'ioredis'
import type { Config } from '../config.ts'
import { logger } from '../logging.ts'
import {
  armorEquips,
  botSessions,
  eatReflex,
  hazardEscapes,
  hunts,
  reconnects,
  threatEpisodes,
  threatResponses,
} from '../metrics.ts'
import { buildEnvelope } from '../events/envelope.ts'
import {
  type BusyState,
  type HazardBot,
  type HazardPhase,
  HazardWatcher,
  hardenMovements,
  hazardPayload,
} from './hazard.ts'
import { type EatBot, EatWatcher } from './eat.ts'
import { ArmorWatcher } from './armor.ts'
import { GuardTether } from './guardTether.ts'
import {
  THREAT_ALERT_RADIUS,
  type ThreatBot,
  type ThreatPhase,
  type ThreatResponse,
  ThreatWatcher,
  type TrackedHostile,
} from './threat.ts'
import { type CombatBot, FightDriver, type FightSlots } from './combat.ts'
import { type SimCapableBot, installSimBlockCache } from './physicsSimCache.ts'
import {
  HUNT_BLACKLIST_MS,
  HUNT_FAMILIES,
  type HuntBot,
  type HuntResult,
  type HuntableEntity,
  PRIMARY_MEAT,
  allHuntTargetsBlacklistedMessage,
  groupAnimalSightings,
  huntNotFoundMessage,
  huntStartAnnouncement,
  huntSuccessAnnouncement,
  isHuntYield,
  pickHuntTarget,
  runKillLoop,
  targetEscapedMessage,
} from '../world/hunting.ts'
import type { EventProducer } from '../kafka/producer.ts'
import { MovementTracker } from '../world/movementTracker.ts'
import { buildSnapshot, type NearbyVillager } from '../world/snapshot.ts'
import {
  RESOURCE_YIELD,
  type ResourceSighting,
  allTargetsBlacklistedMessage,
  blockNamesFor,
  blockedDigError,
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
import {
  CRAFT_TABLE_SEARCH_DISTANCE,
  type CraftResult,
  type SmeltStep,
  cheapestGaps,
  craftError,
  noPlacementMessage,
  pickTableSpot,
  runCraftFlow,
} from '../world/crafting.ts'
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
  /** the fleet-wide fight cap — ONE instance per process (combat.ts) */
  fightSlots: FightSlots
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
  private eatTimer: NodeJS.Timeout | null = null
  private eatWatcher: EatWatcher | null = null
  private threatTimer: NodeJS.Timeout | null = null
  private threatWatcher: ThreatWatcher | null = null
  private guardTether: GuardTether | null = null
  private armorTimer: NodeJS.Timeout | null = null
  private armorWatcher: ArmorWatcher | null = null
  /** the guard tether's post — captured on every 'spawn' */
  private anchor: Position | null = null
  /** Action planner (digs) and reflex planner (canDig=false) — rebuilt per
   *  bot instance in onSpawn; maneuvers swap in reflex, clearGoal restores. */
  private defaultMovements: InstanceType<typeof Movements> | null = null
  private reflexMovements: InstanceType<typeof Movements> | null = null
  /** hunt targets that recently escaped this bot: entity id → expiry ms */
  private readonly huntBlacklist = new Map<number, number>()
  /** the in-flight hunt's abandonment flag — stopMoving() (the watchdog's
   *  cancel lever) flips it so the kill loop goes silent within one poll */
  private huntAbandon: { abandoned: boolean } | null = null
  /** last snapshot actually written to Redis (dedupe body + wall time) —
   *  the write-skip gate in startSnapshots reads and stamps it */
  private lastSnapshotWrite: { body: string; at: number } | null = null
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
      // Guard-arc anchor: every spawn (connect AND death-respawn) re-posts
      // the tether where the body stands — the race harness anchors
      // spawnpoints at team posts, so a respawn re-anchors correctly.
      const at = bot.entity?.position
      this.anchor = at ? { x: at.x, y: at.y, z: at.z } : null
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
      // Reflex paths (flee/fight/chase) never stop to mine: canDig=false
      // skips the per-neighbor break pricing (digTime + bestHarvestTool
      // looping the whole inventory per candidate block — ~8% of the pinned
      // core during the night siege) and shrinks the A* frontier. Actions
      // keep the digging planner; every maneuver clearGoal restores it.
      const reflex = new Movements(this.bot)
      hardenMovements(reflex, this.bot.registry)
      reflex.canDig = false
      this.defaultMovements = movements
      this.reflexMovements = reflex
      this.bot.pathfinder.setMovements(movements)
      // A* compute slices run synchronously on the shared event loop; the
      // default 40ms/tick budget stacks across 20 pathing bots and starves
      // everything else (Kafka heartbeats included). Smaller slices, longer
      // total think budget: same compute, spread thin enough to breathe.
      this.bot.pathfinder.tickTimeout = this.deps.config.PATHFINDER_TICK_TIMEOUT_MS
      this.bot.pathfinder.thinkTimeout = this.deps.config.PATHFINDER_THINK_TIMEOUT_MS
      // Bound the frontier so an unreachable goal concedes without touring
      // the loaded world (same best-effort partial path out, sooner).
      // (Runtime knob since pathfinder 2.x — index.js:41 — absent from its d.ts.)
      ;(this.bot.pathfinder as unknown as { searchRadius: number }).searchRadius =
        this.deps.config.PATHFINDER_SEARCH_RADIUS
      if (this.deps.config.PHYSICS_SIM_BLOCK_CACHE === 1) {
        // bot.physics's runtime engine isn't on mineflayer's Bot type.
        installSimBlockCache(this.bot as unknown as SimCapableBot)
      }
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
    this.startThreatWatch()
    this.startEatWatch()
    this.startArmorWatch()

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
      // Animals ride the 1s pass UNGATED — one entities-map filter, ~1000x
      // cheaper than a findBlocks sweep, and animals move while bots stand
      // still. Hostiles come from the threat watcher's cached pass.
      const animals = groupAnimalSightings(this.huntableEntities(), 48)
      const hostiles = this.threatWatcher ? this.threatWatcher.nearbyHostiles() : null
      const snapshot = buildSnapshot(this.villagerId, this.bot, this.deps.others(), this.nearbyResources, animals, hostiles)
      if (snapshot) {
        // Write-skip gate: build + stringify every pass (cheap), but only SET
        // when the world actually changed. capturedAt and timeOfDay advance
        // every pass by clock alone, so they're masked out of the comparison
        // — a skipped write leaves them at most one force period stale, noise
        // at deliberation cadence (30s+ ticks). INVARIANT: the key's EX TTL
        // is the ONLY downstream staleness signal (agent-service's
        // WorldGateway reads the key blind), so an unchanged snapshot is
        // still force-written every TTL/2 — the key can never expire under a
        // live, merely-idle bot.
        const body = JSON.stringify({ ...snapshot, capturedAt: '', timeOfDay: 0 })
        const now = Date.now()
        const forceAfterMs = (config.SNAPSHOT_TTL_SECONDS * 1_000) / 2
        const last = this.lastSnapshotWrite
        if (last && last.body === body && now - last.at < forceAfterMs) {
          return
        }
        this.lastSnapshotWrite = { body, at: now }
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
    if (this.eatTimer) {
      clearInterval(this.eatTimer)
      this.eatTimer = null
    }
    if (this.threatTimer) {
      clearInterval(this.threatTimer)
      this.threatTimer = null
    }
    if (this.armorTimer) {
      clearInterval(this.armorTimer)
      this.armorTimer = null
    }
    // A reconnect respawns somewhere else — forget the trap along with the
    // survey. (An in-flight escape attempt still owns `busy` until its race
    // settles; its own finally releases it.) Same for the hunger crisis and
    // any threat episode: the new body reads fresh state next pass.
    this.hazardWatcher = null
    this.eatWatcher = null
    this.threatWatcher = null
    this.guardTether = null
    this.armorWatcher = null
    // A reconnect respawns somewhere else — don't carry a stale survey there.
    this.nearbyResources = null
    this.lastScan = null
    // …and despawn() deletes the Redis key: the write-skip gate must never
    // dedupe the next body's first snapshot against a key that's gone.
    this.lastSnapshotWrite = null
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
      // A busy body (command, escape, combat, eating) isn't deliberating, and
      // the survey exists FOR deliberation — refresh on the next calm pass
      // instead of sweeping mid-maneuver (14% of the pinned core at night was
      // fleeing bots re-surveying ground they were running across).
      if (this.busy !== null || this.threatWatcher?.episodeOpen || this.hazardWatcher?.trapped) {
        return
      }
      // The interval is only the CHECK cadence; the gate decides whether the
      // (expensive) sweep runs. Idle bots settle at one sweep per max-age.
      if (
        !shouldRescan(this.lastScan, position, Date.now(), {
          moveBlocks: config.RESOURCE_SCAN_MOVE_BLOCKS,
          maxAgeMs: config.RESOURCE_SCAN_MAX_AGE_MS,
          minSweepMs: config.RESOURCE_SCAN_MIN_SWEEP_MS,
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

  /**
   * The hunger watch (SV-6) — a 4th sibling loop. Each pass is two scalar
   * reads; the inventory scan runs only when a threshold trips. Gated on the
   * busy seam AND both open-episode getters (priority: escape > combat > eat).
   */
  private startEatWatch(): void {
    const { config } = this.deps
    if (config.EAT_CHECK_INTERVAL_MS === 0) {
      return // disabled
    }
    this.eatWatcher = new EatWatcher({
      bot: () => this.eatBot(),
      getBusy: () => this.busy,
      setBusy: (state) => {
        this.busy = state
      },
      hazardOpen: () => this.hazardWatcher?.trapped ?? false,
      threatOpen: () => this.threatWatcher?.episodeOpen ?? false,
      emitCrisis: (phase, position, detail) => this.emitStarvation(phase, position, detail),
      record: (outcome) => eatReflex.inc({ outcome }),
      generation: () => this.spawnGeneration,
      log: this.log,
      config: {
        foodThreshold: config.EAT_FOOD_THRESHOLD,
        criticalFood: config.EAT_CRITICAL_FOOD,
        recoverFood: config.EAT_RECOVER_FOOD,
        hurtHealthThreshold: config.EAT_HURT_HEALTH_THRESHOLD,
        eatTimeoutMs: config.EAT_TIMEOUT_MS,
        retryMs: config.EAT_RETRY_MS,
        bannedFoods: new Set(config.EAT_BANNED_FOODS.split(',').map((s) => s.trim()).filter(Boolean)),
        desperationFoods: new Set(config.EAT_DESPERATION_FOODS.split(',').map((s) => s.trim()).filter(Boolean)),
      },
    })
    this.eatTimer = setInterval(() => this.eatWatcher?.check(), config.EAT_CHECK_INTERVAL_MS)
  }

  /**
   * The threat watch (SV-12a) — the 5th sibling loop. One entities-map
   * filter per pass; the maneuvers (combat.ts) run raced-with-deadline
   * inside the watcher, never on this interval's stack.
   */
  private startThreatWatch(): void {
    const { config } = this.deps
    if (config.THREAT_WATCH_INTERVAL_MS === 0) {
      return // disabled — snapshots omit nearbyHostiles entirely
    }
    const driver = new FightDriver(() => this.combatBot(), this.deps.fightSlots, this.log, {
      fightTimeoutMs: config.THREAT_FIGHT_TIMEOUT_MS,
      fleeTimeoutMs: config.THREAT_FLEE_TIMEOUT_MS,
      buddyRadius: config.THREAT_FLEE_BUDDY_RADIUS,
    })
    this.threatWatcher = new ThreatWatcher({
      bot: () => this.threatBot(),
      getBusy: () => this.busy,
      setBusy: (state) => {
        this.busy = state
      },
      hazardOpen: () => this.hazardWatcher?.trapped ?? false,
      emit: (phase, threatType, response, count, dist, position, detail) =>
        this.emitThreat(phase, threatType, response, count, dist, position, detail),
      driver,
      stance: () => config.THREAT_DEFAULT_STANCE,
      cry: (line) => {
        try {
          this.bot?.chat(line)
        } catch {
          // a dead connection can reject chat — the cry is color, never load-bearing
        }
      },
      recordEpisode: (outcome) => threatEpisodes.inc({ outcome }),
      recordResponse: (response, outcome) => threatResponses.inc({ response, outcome }),
      generation: () => this.spawnGeneration,
      log: this.log,
      config: { alertRadius: THREAT_ALERT_RADIUS, maneuverCooldownMs: config.THREAT_MANEUVER_COOLDOWN_MS },
    })
    // The guard tether rides the threat interval (no timer of its own): the
    // watcher senses, then the tether walks an idle displaced guard home.
    this.guardTether = new GuardTether({
      bot: () => {
        const bot = this.bot
        if (!bot?.entity) {
          return null
        }
        return {
          alive: true,
          position: () => this.position,
          setGoalNear: (pos, range) => {
            this.engageReflexMovements()
            bot.pathfinder.setGoal(new goals.GoalNear(pos.x, pos.y, pos.z, range))
          },
          clearGoal: () => {
            bot.pathfinder.setGoal(null)
            this.restoreDefaultMovements()
          },
        }
      },
      anchor: () => this.anchor,
      stance: () => config.THREAT_DEFAULT_STANCE,
      getBusy: () => this.busy,
      threatOpen: () => this.threatWatcher?.episodeOpen ?? false,
      hazardOpen: () => this.hazardWatcher?.trapped ?? false,
      config: {
        postRadius: config.THREAT_GUARD_POST_RADIUS,
        repathMs: config.THREAT_GUARD_REPATH_MS,
      },
    })
    this.threatTimer = setInterval(() => {
      this.threatWatcher?.check()
      this.guardTether?.check()
    }, config.THREAT_WATCH_INTERVAL_MS)
  }

  /** Armor auto-equip reflex (SV-14-lite) — the 6th sibling interval. */
  private startArmorWatch(): void {
    const { config } = this.deps
    if (config.ARMOR_CHECK_INTERVAL_MS === 0) {
      return // disabled entirely
    }
    this.armorWatcher = new ArmorWatcher({
      bot: () => {
        const bot = this.bot
        if (!bot?.entity) {
          return null
        }
        return {
          alive: true,
          carried: () => bot.inventory.items().map((item) => item.name),
          equipped: (slot) => bot.inventory.slots[bot.getEquipmentDestSlot(slot)]?.name ?? null,
          equip: async (item, destination) => {
            const stack = bot.inventory.items().find((s) => s.name === item)
            if (!stack) {
              throw new Error(`${item} vanished from the pack before the equip`)
            }
            await bot.equip(stack, destination)
          },
        }
      },
      getBusy: () => this.busy,
      threatOpen: () => this.threatWatcher?.episodeOpen ?? false,
      hazardOpen: () => this.hazardWatcher?.trapped ?? false,
      generation: () => this.spawnGeneration,
      recordEquip: (slot, outcome) => armorEquips.inc({ slot, outcome }),
      log: this.log,
      config: { equipTimeoutMs: config.ARMOR_EQUIP_TIMEOUT_MS },
    })
    this.armorTimer = setInterval(() => this.armorWatcher?.check(), config.ARMOR_CHECK_INTERVAL_MS)
  }

  /** How far above/below a hostile still counts as a threat. The alert
   *  radius is a 3D sphere with no line-of-sight check, and the village
   *  sits over inhabited caves — without the band, every surface villager
   *  lives in a PERMANENT phantom episode against mobs 12 blocks below
   *  solid rock (measured 2026-07-17: the whole fleet perpetually fleeing
   *  ghosts, event loop pinned; the resource scan's yBand precedent).
   *  Damage promotion (threat.ts) is the safety net for what the band
   *  hides — a cliff skeleton that actually lands a hit still opens an
   *  episode. */
  private static readonly HOSTILE_Y_BAND = 8

  /** One filter over the client's entity map: every tracked hostile within
   *  the vertical band, with its live distance, nearest first. */
  private trackedHostiles(): TrackedHostile[] {
    return this.scanHostiles(BotSession.HOSTILE_Y_BAND)
  }

  private scanHostiles(yBand: number | null): TrackedHostile[] {
    const bot = this.bot
    const origin = this.position
    if (!bot?.entity || !origin) {
      return []
    }
    const out: TrackedHostile[] = []
    for (const entity of Object.values(bot.entities)) {
      if (entity === bot.entity || entity.kind !== 'Hostile mobs' || !entity.position) {
        continue
      }
      if (yBand !== null && Math.abs(entity.position.y - origin.y) > yBand) {
        continue
      }
      out.push({
        id: entity.id,
        name: entity.name ?? 'unknown',
        distance: distance(origin, entity.position),
        position: { x: entity.position.x, y: entity.position.y, z: entity.position.z },
      })
    }
    return out.sort((a, b) => a.distance - b.distance)
  }

  /** Huntable passive mobs with the ageable baby flag (metadata index 16 on
   *  1.21.6 — heights never rescale, so metadata is the only working
   *  exclusion; spike-pinned). */
  private huntableEntities(): HuntableEntity[] {
    const bot = this.bot
    const origin = this.position
    if (!bot?.entity || !origin) {
      return []
    }
    const names = HUNT_FAMILIES.any as readonly string[]
    const out: HuntableEntity[] = []
    for (const entity of Object.values(bot.entities)) {
      if (!entity.name || !names.includes(entity.name) || !entity.position) {
        continue
      }
      out.push({
        id: entity.id,
        name: entity.name,
        position: { x: entity.position.x, y: entity.position.y, z: entity.position.z },
        distance: distance(origin, entity.position),
        baby: (entity.metadata as unknown[] | undefined)?.[16] === true,
      })
    }
    return out
  }

  private eatBot(): EatBot | null {
    const bot = this.bot
    if (!bot) {
      return null
    }
    const registry = bot.registry as unknown as { foods?: Record<number, { foodPoints?: number }> }
    return {
      alive: Boolean(bot.entity),
      health: () => bot.health,
      food: () => bot.food,
      position: () => this.position,
      carriedFood: () =>
        bot.inventory.items().flatMap((item) => {
          const foodPoints = registry.foods?.[item.type]?.foodPoints
          return foodPoints ? [{ name: item.name, foodPoints }] : []
        }),
      equipFood: async (name) => {
        const stack = bot.inventory.items().find((item) => item.name === name)
        if (!stack) {
          throw new Error(`no ${name} left in the pack`)
        }
        await bot.equip(stack, 'hand')
      },
      consume: () => bot.consume(),
    }
  }

  private threatBot(): ThreatBot | null {
    const bot = this.bot
    if (!bot) {
      return null
    }
    return {
      alive: Boolean(bot.entity),
      health: () => bot.health,
      position: () => this.position,
      hostiles: () => this.trackedHostiles(),
      allHostiles: () => this.scanHostiles(null),
      armed: () => bot.inventory.items().some((item) => item.name.endsWith('_sword') || item.name.endsWith('_axe')),
    }
  }

  private combatBot(): CombatBot | null {
    const bot = this.bot
    if (!bot) {
      return null
    }
    return {
      alive: Boolean(bot.entity),
      food: () => bot.food,
      position: () => this.position,
      hostileById: (id) => this.trackedHostiles().find((h) => h.id === id) ?? null,
      hostiles: () => this.trackedHostiles(),
      villagers: () => this.deps.others().flatMap((o) => (o.position ? [o.position] : [])),
      equipWeapon: async (name) => {
        const stack = bot.inventory.items().find((item) => item.name === name)
        if (stack) {
          await bot.equip(stack, 'hand')
        }
      },
      carried: () => bot.inventory.items().map((item) => item.name),
      setGoalFollow: (targetId, range) => {
        const entity = bot.entities[targetId]
        if (entity) {
          this.engageReflexMovements()
          bot.pathfinder.setGoal(new goals.GoalFollow(entity, range), true)
        }
      },
      setGoalXZ: (x, z) => {
        this.engageReflexMovements()
        bot.pathfinder.setGoal(new goals.GoalXZ(x, z))
      },
      clearGoal: () => {
        bot.pathfinder.setGoal(null)
        this.restoreDefaultMovements()
      },
      lookAt: (p) => {
        void bot.lookAt(this.vecAt(p), true).catch(() => {})
      },
      attack: (targetId) => {
        const entity = bot.entities[targetId]
        if (entity) {
          bot.attack(entity)
        }
      },
      setSprint: (state) => bot.setControlState('sprint', state),
    }
  }

  private huntBot(): HuntBot {
    const bot = this.bot as Bot
    return {
      alive: Boolean(bot.entity),
      position: () => this.position,
      targetById: (id) => {
        const entity = bot.entities[id]
        const origin = this.position
        if (!entity?.position || !origin) {
          return null
        }
        return {
          position: { x: entity.position.x, y: entity.position.y, z: entity.position.z },
          distance: distance(origin, entity.position),
        }
      },
      setGoalFollow: (targetId, range) => {
        const entity = bot.entities[targetId]
        if (entity) {
          // The chase is a reflex-grade pursuit: never stop to mine.
          this.engageReflexMovements()
          bot.pathfinder.setGoal(new goals.GoalFollow(entity, range), true)
        }
      },
      clearGoal: () => {
        bot.pathfinder.setGoal(null)
        this.restoreDefaultMovements()
      },
      lookAt: (p) => {
        void bot.lookAt(this.vecAt(p), true).catch(() => {})
      },
      attack: (targetId) => {
        const entity = bot.entities[targetId]
        if (entity) {
          bot.attack(entity)
        }
      },
      goTo: async (p) => {
        await bot.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, 0))
      },
      generation: () => this.spawnGeneration,
    }
  }

  /** Mint a real Vec3 from the entity's own position (prismarine methods
   *  need one; importing the transitive package is the recorded anti-pattern). */
  private vecAt(p: Position) {
    const base = (this.bot as Bot).entity.position.floored()
    return base.offset(p.x - base.x, p.y - base.y, p.z - base.z)
  }

  private emitStarvation(phase: 'trapped' | 'escaped', position: Position, detail: string | null): void {
    if (phase === 'escaped') {
      hazardEscapes.inc({ outcome: 'escaped' })
    }
    const envelope = buildEnvelope({
      eventType: 'HazardEncountered',
      aggregateId: this.villagerId,
      payload: { villagerId: this.villagerId, hazardType: 'starvation', phase, position, detail },
    })
    this.log.warn({ phase, detail, eventId: envelope.eventId }, 'starvation crisis event')
    void this.deps.producer
      .publish('world.events', envelope)
      .catch((err: Error) => this.log.warn({ err: err.message }, 'starvation event publish failed'))
  }

  private emitThreat(
    phase: ThreatPhase,
    threatType: string,
    response: ThreatResponse | null,
    count: number,
    dist: number,
    position: Position,
    detail: string | null,
  ): void {
    const envelope = buildEnvelope({
      eventType: 'ThreatEncountered',
      aggregateId: this.villagerId,
      payload: { villagerId: this.villagerId, threatType, phase, response, count, distance: dist, position, detail },
    })
    this.log.info({ phase, threatType, response, count, distance: dist }, 'threat encountered')
    void this.deps.producer
      .publish('world.events', envelope)
      .catch((err: Error) => this.log.warn({ err: err.message }, 'threat event publish failed'))
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
      const blocked = blockedDigError(resource, block.name, doomed.toolHint)
      const err = new Error(blocked.message)
      ;(err as Error & { code?: string }).code = blocked.code
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

  /**
   * Craft one recipe application of a contract item (SV-3) — resolve the
   * wood-abstract families against the pack, acquire a crafting table when
   * the recipe needs the 3x3 grid (walk to a standing one, else place a
   * carried one), craft, and report the honest inventory delta. All control
   * flow lives in runCraftFlow (unit-tested botless); this method is only
   * the world touches.
   */
  async craft(item: string): Promise<CraftResult> {
    const bot = this.bot
    if (!bot?.entity) {
      throw new Error('bot has no entity — not spawned')
    }
    const itemId = (name: string) => bot.registry.itemsByName[name]?.id
    // blockAt/placeBlock need real Vec3s (prismarine calls their methods) —
    // mint them from the entity's own position rather than importing an
    // undeclared transitive package (the hazardBot precedent).
    const vecAt = (p: Position) => {
      const base = bot.entity.position.floored()
      return base.offset(p.x - base.x, p.y - base.y, p.z - base.z)
    }
    // Shared by the table and furnace flows — placing a carried block beside
    // the bot is one skill; only the block differs. Interactive blocks are
    // OFF the ground list: right-clicking a crafting table to place against
    // it opens the table instead (no sneak in placeBlock) — the RB-1 drill
    // watched a furnace try to stack onto the just-placed table and fail
    // with "the spot reads air" three times.
    const INTERACTIVE_GROUND = new Set(['crafting_table', 'furnace', 'blast_furnace', 'smoker', 'chest', 'barrel', 'anvil'])
    const placeCarried = async (blockName: string): Promise<Position> => {
      const spot = pickTableSpot(this.position as Position, (p) => {
        const block = bot.blockAt(vecAt(p))
        return block
          ? {
              air: block.name === 'air' || block.name === 'cave_air',
              solid: block.boundingBox === 'block' && !INTERACTIVE_GROUND.has(block.name),
            }
          : null
      })
      if (!spot) {
        throw craftError('PATH_NOT_FOUND', noPlacementMessage(), true)
      }
      const stack = bot.inventory.items().find((s) => s.name === blockName)
      if (!stack) {
        throw new Error(`${blockName} vanished from the pack before placement`)
      }
      await bot.equip(stack, 'hand')
      const ground = bot.blockAt(vecAt(spot.ground))
      if (!ground) {
        throw craftError('PATH_NOT_FOUND', noPlacementMessage(), true)
      }
      try {
        await bot.placeBlock(ground, ground.position.offset(0, 1, 0).minus(ground.position))
      } catch (err) {
        // placeBlock's blockUpdate wait is flaky on Paper, and a stale
        // client cell can make the reference block a phantom (RB-1 drill:
        // "blockUpdate did not fire within 5000ms" while the block HAD
        // placed). Don't trust the throw either way — give the update a
        // beat, then let the world verdict below decide.
        this.log.info({ err: err instanceof Error ? err.message : String(err), blockName }, 'placeBlock threw — verifying the world')
        await new Promise((resolve) => setTimeout(resolve, 1_000))
      }
      const placed = bot.blockAt(vecAt(spot.spot))
      if (placed?.name !== blockName) {
        // The server can silently reject a placement (the ghost-dig lesson
        // in reverse) — never work against a block that isn't really there.
        throw craftError(
          'PATH_NOT_FOUND',
          `the ${blockName.replace(/_/g, ' ')} would not set here (the spot reads ${placed?.name ?? 'unloaded'}) — move to open ground and try again`,
          true,
        )
      }
      return spot.spot
    }
    return await runCraftFlow(item, {
      carried: () => bot.inventory.items().map((stack) => ({ name: stack.name, count: stack.count })),
      craftableNow: (name, allowTable) => {
        const id = itemId(name)
        // recipesFor reads the table param only as availability at filter
        // time (mineflayer craft.js) — `true` answers the hypothetical
        // "standing at a table, could I?" honestly, no Block needed.
        return id !== undefined && bot.recipesFor(id, null, 1, allowTable).length > 0
      },
      ingredientGaps: (name) => {
        const id = itemId(name)
        if (id === undefined) {
          return []
        }
        return cheapestGaps(
          bot.recipesAll(id, null, true).map((recipe) =>
            recipe.delta
              .filter((d) => d.count < 0)
              .map((d) => ({
                name: bot.registry.items[d.id]?.name ?? `item ${d.id}`,
                required: -d.count,
                have: bot.inventory.count(d.id, null),
              })),
          ),
          bot.inventory.items().map((stack) => ({ name: stack.name, count: stack.count })),
        )
      },
      findTable: () => {
        const found = bot.findBlock({
          matching: (candidate) => candidate.name === 'crafting_table',
          maxDistance: CRAFT_TABLE_SEARCH_DISTANCE,
        })
        return found ? { x: found.position.x, y: found.position.y, z: found.position.z } : null
      },
      walkTo: async (p) => {
        // Range 2 keeps the table within interaction reach for bot.craft's
        // activateBlock; the executor's watchdog owns the deadline.
        await bot.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, 2))
      },
      placeTable: () => placeCarried('crafting_table'),
      findFurnace: () => {
        const found = bot.findBlock({
          matching: (candidate) => candidate.name === 'furnace',
          maxDistance: CRAFT_TABLE_SEARCH_DISTANCE,
        })
        return found ? { x: found.position.x, y: found.position.y, z: found.position.z } : null
      },
      placeFurnace: () => placeCarried('furnace'),
      smelt: async (step: SmeltStep, furnaceAt: Position) => {
        const furnaceBlock = bot.blockAt(vecAt(furnaceAt))
        if (!furnaceBlock) {
          throw new Error('the furnace is out of loaded range')
        }
        const idOf = (name: string) => {
          const id = bot.registry.itemsByName[name]?.id
          if (id === undefined) {
            throw new Error(`unknown item '${name}' in this world's registry`)
          }
          return id
        }
        const furnace = await bot.openFurnace(furnaceBlock)
        try {
          // Fuel first: a fed furnace lights the moment input lands, so the
          // batch starts burning during the second put.
          await furnace.putFuel(idOf(step.fuel.name), null, step.fuel.count)
          await furnace.putInput(idOf(step.input), null, step.count)
          // ~10s per smelt; the deadline is a local guard — the command
          // watchdog still owns the real budget, and the busy seam doubles
          // as the abandonment signal (a zombie smelt must stop polling).
          const deadline = Date.now() + step.count * 10_500 + 5_000
          while (Date.now() < deadline && this.busy === 'action') {
            const out = furnace.outputItem()
            if (out && out.count >= step.count) {
              break
            }
            await new Promise((resolve) => setTimeout(resolve, 1_000))
          }
          const out = furnace.outputItem()
          let took = 0
          if (out) {
            took = out.count
            await furnace.takeOutput()
          }
          // Reclaim leftovers — an interrupted batch strands nothing in the
          // furnace for the next villager to mystery-loot.
          if (furnace.inputItem()) {
            await furnace.takeInput()
          }
          if (furnace.fuelItem()) {
            await furnace.takeFuel()
          }
          return took
        } finally {
          furnace.close()
        }
      },
      craft: async (name, tableAt) => {
        const id = itemId(name)
        if (id === undefined) {
          throw new Error(`unknown item '${name}' in this world's registry`)
        }
        const tableBlock = tableAt ? bot.blockAt(vecAt(tableAt)) : null
        if (tableAt && !tableBlock) {
          throw new Error('the crafting table is out of loaded range')
        }
        const recipes = bot.recipesFor(id, null, 1, tableBlock ?? false)
        if (recipes.length === 0) {
          throw new Error(`the ${name} recipe stopped matching your pack mid-craft`)
        }
        await bot.craft(recipes[0]!, 1, tableBlock ?? undefined)
      },
      countItem: (name) =>
        bot.inventory
          .items()
          .filter((stack) => stack.name === name)
          .reduce((sum, stack) => sum + stack.count, 0),
      // The executor claims busy='action' for the command's lifetime and
      // clears it when the watchdog abandons the race — the same seam SV-2's
      // gather session reads, no new machinery.
      bodyStillOurs: () => this.busy === 'action',
      announce: (line) => bot.chat(line),
      position: () => this.position as Position,
    })
  }

  /**
   * Hunt one animal (SV-8): pick the nearest huntable adult, chase it with
   * the kill loop (dynamic follow, fire-and-forget swings, leash + deadline),
   * collect the drops, report the honest inventory delta. One animal per
   * action — a wounded escapee keeps its damage. Failures are coded and
   * prescriptive; the blacklist keeps yesterday's escapee off today's menu.
   */
  async hunt(animal: string, maxDistance: number): Promise<HuntResult> {
    const bot = this.bot
    if (!bot?.entity) {
      throw new Error('bot has no entity — not spawned')
    }
    const coded = (code: string, message: string, retryable: boolean): Error => {
      const err = new Error(message) as Error & { code?: string; retryable?: boolean }
      err.code = code
      err.retryable = retryable
      return err
    }
    if (!HUNT_FAMILIES[animal]) {
      throw coded('INVALID_PARAMS', `'${animal}' is not huntable — hunt one of: cow, pig, sheep, chicken, any`, false)
    }
    const now = Date.now()
    for (const [id, until] of this.huntBlacklist) {
      if (until <= now) {
        this.huntBlacklist.delete(id)
      }
    }
    const candidates = this.huntableEntities()
    const target = pickHuntTarget(candidates, animal, maxDistance, this.huntBlacklist, now)
    if (!target) {
      const families = HUNT_FAMILIES[animal] as readonly string[]
      const anyEligible = candidates.some((c) => families.includes(c.name) && !c.baby && c.distance <= maxDistance)
      hunts.inc({ family: animal, outcome: 'not_found' })
      throw coded(
        'RESOURCE_NOT_FOUND',
        anyEligible ? allHuntTargetsBlacklistedMessage(animal) : huntNotFoundMessage(animal, maxDistance),
        true,
      )
    }

    // Yield counting: snapshot the relevant stacks before the chase — deltas
    // keep the kill presumption honest (the ghost-dig lesson).
    const yieldCounts = (): Map<string, number> => {
      const counts = new Map<string, number>()
      for (const item of bot.inventory.items()) {
        if (isHuntYield(target.name, item.name)) {
          counts.set(item.name, (counts.get(item.name) ?? 0) + item.count)
        }
      }
      return counts
    }
    const before = yieldCounts()

    // Mark before the attempt (the dedupe pattern) — clear only on a real
    // haul, so an escapee stays off the menu for the blacklist TTL.
    this.huntBlacklist.set(target.id, now + HUNT_BLACKLIST_MS)
    bot.chat(huntStartAnnouncement(target))

    const ctx = { abandoned: false }
    this.huntAbandon = ctx
    let outcome
    try {
      outcome = await runKillLoop(this.huntBot(), target.id, {
        chaseTimeoutMs: this.deps.config.HUNT_CHASE_TIMEOUT_MS,
        leashBlocks: maxDistance + 16,
        ctx,
      })
    } finally {
      this.huntAbandon = null
    }

    if (outcome.kind === 'abandoned') {
      hunts.inc({ family: animal, outcome: 'aborted' })
      // The watchdog already settled the command — the latch suppresses this.
      throw new Error('hunt abandoned by the watchdog')
    }
    if (outcome.kind === 'escaped') {
      hunts.inc({ family: animal, outcome: 'escaped' })
      throw coded('TARGET_ESCAPED', targetEscapedMessage(target.name, outcome.chaseSeconds), true)
    }

    // Presumed kill: walk onto the drop site, chase stray item entities —
    // best-effort, a failed collection still ends as an honest completion.
    try {
      await bot.pathfinder.goto(new goals.GoalNear(outcome.lastPosition.x, outcome.lastPosition.y, outcome.lastPosition.z, 0))
      await new Promise((resolve) => setTimeout(resolve, 700))
      if (sumCounts(yieldCounts()) === sumCounts(before)) {
        const lastPos = outcome.lastPosition
        const drop = bot.nearestEntity(
          (entity) => entity.name === 'item' && entity.position.distanceTo(this.vecAt(lastPos)) < 8,
        )
        if (drop) {
          await bot.pathfinder.goto(new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 0))
          await new Promise((resolve) => setTimeout(resolve, 700))
        }
      }
    } catch {
      this.log.info({ target: target.name }, 'hunt drop collection fell short — reporting the honest count')
    }

    const after = yieldCounts()
    const drops: Record<string, number> = {}
    let collected = 0
    for (const [name, count] of after) {
      const gained = count - (before.get(name) ?? 0)
      if (gained > 0) {
        drops[name] = gained
        collected += gained
      }
    }
    // Ruling 6: hunt emits ResourceGathered per drop type — the economy
    // primitive the ledger already carries. An empty kill emits one honest
    // zero on the primary meat (the ghost-block precedent: the record keeps
    // what the world refused to yield).
    const emissions =
      collected > 0
        ? Object.entries(drops)
        : ([[PRIMARY_MEAT[target.name] ?? 'meat', 0]] as Array<[string, number]>)
    for (const [resourceType, quantity] of emissions) {
      void this.deps.producer.publish(
        'world.events',
        buildEnvelope({
          eventType: 'ResourceGathered',
          aggregateId: this.villagerId,
          payload: { villagerId: this.villagerId, resourceType, quantity, position: outcome.lastPosition },
        }),
      )
    }
    if (collected > 0) {
      this.huntBlacklist.delete(target.id)
      if (this.busy === 'action') {
        const line = huntSuccessAnnouncement(target.name, drops)
        if (line) {
          bot.chat(line)
        }
      }
    }
    hunts.inc({ family: animal, outcome: collected > 0 || outcome.kind === 'killed' ? 'killed' : 'empty' })
    const meat = PRIMARY_MEAT[target.name] ?? 'meat'
    return {
      animal,
      target: target.name,
      killed: true,
      collected,
      drops,
      position: outcome.lastPosition,
      chaseSeconds: outcome.chaseSeconds,
      note:
        collected > 0
          ? `raw ${meat} sates hunger, if poorly — your body eats from the pack by itself when hungry`
          : 'the kill left nothing to carry — drops sometimes roll away or burn',
    }
  }

  stopMoving(): void {
    if (this.huntAbandon) {
      this.huntAbandon.abandoned = true // the kill loop goes silent within one poll
    }
    this.bot?.pathfinder.setGoal(null)
    // Whatever interrupted the body, the next path must plan with the action
    // (digging) planner — an abandoned maneuver must not leave reflex rules on.
    this.restoreDefaultMovements()
  }

  /** Maneuver paths plan with the reflex movements (canDig=false); idempotent
   *  so per-poll callers don't churn resetPath. */
  private engageReflexMovements(): void {
    const bot = this.bot
    if (bot && this.reflexMovements && bot.pathfinder.movements !== this.reflexMovements) {
      bot.pathfinder.setMovements(this.reflexMovements)
    }
  }

  private restoreDefaultMovements(): void {
    const bot = this.bot
    if (bot && this.defaultMovements && bot.pathfinder.movements !== this.defaultMovements) {
      bot.pathfinder.setMovements(this.defaultMovements)
    }
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

function sumCounts(counts: ReadonlyMap<string, number>): number {
  let total = 0
  for (const count of counts.values()) {
    total += count
  }
  return total
}
