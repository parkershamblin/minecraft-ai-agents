import type Redis from 'ioredis'
import type { Config } from '../config.ts'
import { logger } from '../logging.ts'
import { threatFightsActive } from '../metrics.ts'
import { buildEnvelope } from '../events/envelope.ts'
import type { EventProducer } from '../kafka/producer.ts'
import { BotSession } from './BotSession.ts'
import { FightSlots } from './combat.ts'
import { Roster } from '../redis/roster.ts'
import { ChatRouter } from '../world/chatRouter.ts'
import type { BotInventoryView } from '../world/inventoryPoller.ts'
import type { NearbyVillager } from '../world/snapshot.ts'

/**
 * Exactly one BotSession per villagerId (a World-context invariant). Also owns
 * the process-wide chat routing: sessions report every line; the router
 * self-filters, dedupes across sessions, and emits exactly one ChatObserved.
 */
export class BotRegistry {
  private sessions = new Map<string, BotSession>()
  private chatRouter: ChatRouter
  readonly roster: Roster
  /** the FLEET-wide fight cap — one instance, shared by every session */
  private readonly fightSlots: FightSlots

  constructor(
    private readonly config: Config,
    private readonly producer: EventProducer,
    private readonly redis: Redis,
  ) {
    this.roster = new Roster(redis)
    this.fightSlots = new FightSlots(config.THREAT_MAX_CONCURRENT_FIGHTS, threatFightsActive)
    this.chatRouter = new ChatRouter({
      rosterByUsername: (username) => this.roster.villagerIdFor(username),
      activeSessions: () =>
        [...this.sessions.values()]
          .filter((s) => s.active)
          .map((s) => ({ villagerId: s.villagerId, username: s.username, position: s.position })),
      earshotBlocks: config.CHAT_EARSHOT_BLOCKS,
      emit: (obs) => {
        void this.producer.publish(
          'world.events',
          buildEnvelope({
            eventType: 'ChatObserved',
            // aggregate = the speaker when known, else the bridge attributes
            // it to the first hearer (a player spoke near villagers)
            aggregateId: obs.speakerVillagerId ?? obs.heardByIds[0] ?? '00000000-0000-0000-0000-000000000000',
            payload: {
              villagerId: obs.speakerVillagerId,
              speakerUsername: obs.speakerUsername,
              message: obs.message,
              heardByIds: obs.heardByIds,
              position: obs.position,
            },
          }),
        )
      },
    })
  }

  activeCount(): number {
    return [...this.sessions.values()].filter((s) => s.active).length
  }

  get(villagerId: string): BotSession | undefined {
    return this.sessions.get(villagerId)
  }

  othersFor(villagerId: string): NearbyVillager[] {
    return [...this.sessions.values()]
      .filter((s) => s.villagerId !== villagerId && s.active)
      .map((s) => ({ villagerId: s.villagerId, name: s.username, position: s.position }))
  }

  /** Current coordinates of every active bot for /internal/positions —
   *  sessions without a live body (inactive, or entity not yet spawned)
   *  are omitted rather than reported with null coordinates. */
  positionsSnapshot(): { username: string; x: number; y: number; z: number }[] {
    const out: { username: string; x: number; y: number; z: number }[] = []
    for (const session of this.sessions.values()) {
      const p = session.position
      if (!session.active || !p) {
        continue
      }
      out.push({ username: session.username, x: p.x, y: p.y, z: p.z })
    }
    return out
  }

  /** Live bot inventories for the metrics poller — cheap in-memory reads. */
  inventoryViews(): BotInventoryView[] {
    const views: BotInventoryView[] = []
    for (const session of this.sessions.values()) {
      const bot = session.bot
      if (!session.active || !bot) {
        continue
      }
      views.push({
        username: session.username,
        generation: session.generation,
        items: bot.inventory.items().map((item) => ({ name: item.name, count: item.count })),
      })
    }
    return views
  }

  /** Tab-list humans: everyone online minus our own bots. null = no active bot to ask. */
  humanPlayerNames(): string[] | null {
    const own = new Set([...this.sessions.values()].map((s) => s.username))
    const bot = [...this.sessions.values()].find((s) => s.active && s.bot)?.bot
    if (!bot) {
      return null
    }
    return Object.keys(bot.players).filter((name) => !own.has(name))
  }

  /** Idempotent: spawning an already-active villager is a no-op success. */
  async spawn(villagerId: string, username: string): Promise<{ alreadyActive: boolean; spawnReason: string }> {
    const existing = this.sessions.get(villagerId)
    if (existing?.active) {
      return { alreadyActive: true, spawnReason: 'seed' }
    }
    const session = new BotSession(villagerId, username, {
      config: this.config,
      producer: this.producer,
      redis: this.redis,
      onChat: (from, speakerUsername, message) => {
        const speakerEntity = from.bot?.players[speakerUsername]?.entity
        this.chatRouter.onChat(
          { villagerId: from.villagerId, username: from.username, position: from.position },
          speakerUsername,
          message,
          speakerEntity ? { x: speakerEntity.position.x, y: speakerEntity.position.y, z: speakerEntity.position.z } : null,
        )
      },
      others: () => this.othersFor(villagerId),
      fightSlots: this.fightSlots,
    })
    this.sessions.set(villagerId, session)
    session.connect()
    const spawnReason = await session.awaitSpawn(this.config.SPAWN_TIMEOUT_MS)
    await this.roster.set(username, villagerId)
    return { alreadyActive: false, spawnReason }
  }

  async despawn(villagerId: string): Promise<boolean> {
    const session = this.sessions.get(villagerId)
    if (!session) {
      return false
    }
    this.sessions.delete(villagerId)
    await session.despawn()
    await this.roster.remove(session.username)
    return true
  }

  async shutdown(): Promise<void> {
    logger.info({ sessions: this.sessions.size }, 'shutting down all bot sessions')
    for (const villagerId of [...this.sessions.keys()]) {
      await this.despawn(villagerId)
    }
  }
}
