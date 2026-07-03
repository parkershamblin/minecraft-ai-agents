import type Redis from 'ioredis'

/**
 * commandId dedupe: SET NX with a TTL covering the command topic's retention.
 * Mark-before-execute — a redelivered command (consumer rebalance, restart
 * before offset commit) is skipped entirely, so a villager never executes the
 * same command twice. Known trade, documented: a crash BETWEEN mark and
 * outcome loses that command's outcome; the agent's tick loop owns recovery
 * (a starved percept queue just means the next tick decides fresh).
 */
export class CommandDedupe {
  constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds = 24 * 60 * 60, // = commands.minecraft retention
  ) {}

  /** @return true if this commandId is fresh (and now marked), false if seen before */
  async isFresh(commandId: string): Promise<boolean> {
    const result = await this.redis.set(`civ:cmd:${commandId}`, '1', 'EX', this.ttlSeconds, 'NX')
    return result === 'OK'
  }
}
