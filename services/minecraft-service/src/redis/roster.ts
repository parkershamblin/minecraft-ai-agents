import type Redis from 'ioredis'

const KEY = 'mc:roster'

/**
 * username -> villagerId, in Redis for other services and in memory for the
 * hot path (every chat line consults it). Populated on spawn, pruned on
 * despawn — the single translation point between Minecraft identity and
 * platform identity.
 */
export class Roster {
  private byUsername = new Map<string, string>()

  constructor(private readonly redis: Redis) {}

  async load(): Promise<void> {
    this.byUsername = new Map(Object.entries(await this.redis.hgetall(KEY)))
  }

  async set(username: string, villagerId: string): Promise<void> {
    this.byUsername.set(username, villagerId)
    await this.redis.hset(KEY, username, villagerId)
  }

  async remove(username: string): Promise<void> {
    this.byUsername.delete(username)
    await this.redis.hdel(KEY, username)
  }

  villagerIdFor(username: string): string | undefined {
    return this.byUsername.get(username)
  }
}
