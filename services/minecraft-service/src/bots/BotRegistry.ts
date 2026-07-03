import type Redis from 'ioredis'
import type { Config } from '../config.ts'
import { logger } from '../logging.ts'
import { buildEnvelope } from '../events/envelope.ts'
import type { EventProducer } from '../kafka/producer.ts'
import { BotSession } from './BotSession.ts'
import { Roster } from '../redis/roster.ts'
import { ChatRouter } from '../world/chatRouter.ts'
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

  constructor(
    private readonly config: Config,
    private readonly producer: EventProducer,
    private readonly redis: Redis,
  ) {
    this.roster = new Roster(redis)
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
