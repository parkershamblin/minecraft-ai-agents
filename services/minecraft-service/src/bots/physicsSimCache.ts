/**
 * Turn-scoped block cache under physics simulations (profiled 2026-07-17).
 *
 * mineflayer-pathfinder gates every moving bot's control state each physics
 * tick with full player simulations — canStraightLine budgets 200 simulated
 * ticks toward the NEXT path node, and its jump fallbacks add up to 7 × 20
 * more per gate chain. Every simulated tick re-reads the same ~12 surrounding
 * blocks through prismarine-world's getBlock, which constructs a fresh Block
 * (state decode + biome + light + block-entity lookup) per call. On the
 * 20-bot fleet that redundancy was ~40% of the daytime core and ~21% of the
 * night core — more than A* itself by day.
 *
 * The cache lives for ONE synchronous event-loop turn: world mutations only
 * arrive via packet handlers, which always run in their own turns, and every
 * simulatePlayer caller (the real tick, the gate chains) runs inside a timer
 * turn — so within a turn the world is immutable and the cache is
 * semantically invisible. setImmediate clears it before the next timer phase
 * can run another simulation.
 *
 * Scoped HERE and not around bot.blockAt: pathfinder's movements.getBlock
 * mutates the blocks it returns with query-relative fields (height depends on
 * the caller's dy) — sharing instances there would corrupt A*. The physics
 * engine only reads (verified: world.getBlock is its sole world call).
 */

interface BlockPos {
  x: number
  y: number
  z: number
}

export interface SimWorld {
  getBlock(pos: BlockPos): unknown
}

export type SimulatePlayerFn = (state: unknown, world: SimWorld) => unknown

/** The slice of a mineflayer Bot the installer touches — structural, tests fake it. */
export interface SimCapableBot {
  physics: { simulatePlayer: SimulatePlayerFn }
}

/**
 * Wrap a simulatePlayer so every world read within one event-loop turn hits
 * a per-turn cache. `scheduleClear` is injectable for tests; production uses
 * setImmediate (the check phase always runs before the next timer phase, so
 * no simulation can ever see a stale entry).
 */
export function wrapSimulatePlayer(
  original: SimulatePlayerFn,
  scheduleClear: (clear: () => void) => void = (clear) => setImmediate(clear),
): SimulatePlayerFn {
  const cache = new Map<string, unknown>()
  let sourceWorld: SimWorld | null = null
  let clearScheduled = false
  const cachingWorld: SimWorld = {
    getBlock(pos) {
      // Floor the key: callers pass fractional entity offsets, but getBlock
      // resolves by floored position — one cell, one entry.
      const key = `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`
      const hit = cache.get(key)
      if (hit !== undefined) {
        return hit
      }
      const block = sourceWorld?.getBlock(pos) ?? null
      cache.set(key, block)
      return block
    },
  }
  return (state, world) => {
    if (world !== sourceWorld) {
      // The real tick and the pathfinder sims pass different world views —
      // never serve one's blocks to the other.
      cache.clear()
      sourceWorld = world
    }
    if (!clearScheduled) {
      clearScheduled = true
      scheduleClear(() => {
        cache.clear()
        sourceWorld = null
        clearScheduled = false
      })
    }
    return original(state, cachingWorld)
  }
}

/** Patch a bot's physics engine in place. bot.physics is the SAME object the
 *  real tick closes over, so both the 20Hz tick and every pathfinder gate
 *  simulation route through the cache. Install once per bot instance. */
export function installSimBlockCache(bot: SimCapableBot): void {
  bot.physics.simulatePlayer = wrapSimulatePlayer(bot.physics.simulatePlayer.bind(bot.physics))
}
