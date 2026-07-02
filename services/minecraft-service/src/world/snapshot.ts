import { type Position, distance, round1, roundPos } from './position.ts'
import type { WorldSnapshot } from '@civ/events/ts'

/** The slice of a mineflayer Bot the snapshot needs — mockable in tests. */
export interface BotLike {
  entity: { position: Position } | undefined
  health: number
  food: number
  inventory: { items(): Array<{ name: string; count: number }> }
  time: { timeOfDay: number }
}

export interface NearbyVillager {
  villagerId: string
  name: string
  position: Position | null
}

/**
 * Builds the WorldSnapshot for Redis world:{villagerId} — the shared-state
 * contract in packages/events/schemas/state. Written every second with a TTL;
 * agent-service's perceive node reads it. Inventory is a grouped summary, not
 * the raw 36-slot grid.
 */
export function buildSnapshot(
  villagerId: string,
  bot: BotLike,
  others: NearbyVillager[],
  capturedAt: Date = new Date(),
): WorldSnapshot | null {
  if (!bot.entity) {
    return null // not spawned yet — nothing truthful to report
  }
  const position = roundPos(bot.entity.position)

  const grouped = new Map<string, number>()
  for (const item of bot.inventory.items()) {
    grouped.set(item.name, (grouped.get(item.name) ?? 0) + item.count)
  }

  return {
    villagerId,
    capturedAt: capturedAt.toISOString(),
    position,
    health: Math.max(0, Math.min(20, bot.health)),
    food: Math.max(0, Math.min(20, bot.food)),
    inventory: [...grouped.entries()].map(([item, count]) => ({ item, count })),
    nearbyVillagers: others
      .filter((o) => o.villagerId !== villagerId && o.position !== null)
      .map((o) => ({
        villagerId: o.villagerId,
        name: o.name,
        distance: round1(distance(o.position as Position, position)),
      })),
    timeOfDay: Math.max(0, Math.min(24000, Math.round(bot.time.timeOfDay))),
  } as WorldSnapshot
}
