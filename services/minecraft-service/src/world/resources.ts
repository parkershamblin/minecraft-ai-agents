/**
 * Resource families → concrete block names. The contract speaks in families
 * (wood/stone/dirt); Minecraft speaks in blocks. Pure data, unit-tested, and
 * the single place M1 extends when new resources join the economy.
 */
export const RESOURCE_BLOCKS: Record<string, readonly string[]> = {
  wood: [
    'oak_log',
    'birch_log',
    'spruce_log',
    'jungle_log',
    'acacia_log',
    'dark_oak_log',
    'mangrove_log',
    'cherry_log',
  ],
  stone: ['stone', 'cobblestone', 'andesite', 'diorite', 'granite'],
  dirt: ['dirt', 'grass_block'],
} as const

export function blockNamesFor(resource: string): readonly string[] | undefined {
  return RESOURCE_BLOCKS[resource]
}

/** Which inventory item names count as yield for a family (grass_block drops dirt, stone drops cobblestone). */
export const RESOURCE_YIELD: Record<string, readonly string[]> = {
  wood: RESOURCE_BLOCKS.wood as readonly string[],
  stone: ['cobblestone', 'stone'],
  dirt: ['dirt'],
} as const
