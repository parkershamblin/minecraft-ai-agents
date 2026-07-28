// 1.21.6 name guard layer. Voyager's 1.19-era skills do unguarded
// mcData.itemsByName[x].id lookups that throw TypeError on renamed/absent
// keys, and hard-code pre-1.20 block lists. Every ported primitive and skill
// resolves names through this module instead — throw-free, alias-aware, and
// current for MC 1.21.6 (MC_VERSION pin in .env).

/** Voyager-era → modern minecraft-data names (their index.js patched these at runtime). */
export const NAME_ALIASES: Readonly<Record<string, string>> = {
  leather_cap: 'leather_helmet',
  leather_tunic: 'leather_chestplate',
  leather_pants: 'leather_leggings',
  leather_boots: 'leather_boots',
  lapis_lazuli_ore: 'lapis_ore',
}

/**
 * Complete log-family list for 1.21.6. Voyager's list stops at mangrove
 * (1.19); cherry_log is 1.20, pale_oak_log is 1.21.4, bamboo_block is the
 * 1.20 bamboo "log" equivalent.
 */
export const WOOD_LOGS: readonly string[] = [
  'oak_log',
  'birch_log',
  'spruce_log',
  'jungle_log',
  'acacia_log',
  'dark_oak_log',
  'mangrove_log',
  'cherry_log',
  'pale_oak_log',
  'bamboo_block',
]

/** The slice of minecraft-data the guards need — mockable in tests. */
export interface McDataLike {
  itemsByName: Record<string, { id: number; name: string } | undefined>
  blocksByName: Record<string, { id: number; name: string } | undefined>
}

export type NameLookup =
  | { ok: true; value: { id: number; name: string } }
  | { ok: false; failureCode: 'UNSUPPORTED_NAME'; detail: string }

function resolve(name: string): string {
  return NAME_ALIASES[name] ?? name
}

export function guardedItem(mcData: McDataLike, name: string): NameLookup {
  const resolved = resolve(name)
  const item = mcData.itemsByName[resolved]
  if (!item) {
    return {
      ok: false,
      failureCode: 'UNSUPPORTED_NAME',
      detail: `item "${name}"${resolved !== name ? ` (alias -> ${resolved})` : ''} not in minecraft-data for this version`,
    }
  }
  return { ok: true, value: { id: item.id, name: item.name } }
}

export function guardedBlock(mcData: McDataLike, name: string): NameLookup {
  const resolved = resolve(name)
  const block = mcData.blocksByName[resolved]
  if (!block) {
    return {
      ok: false,
      failureCode: 'UNSUPPORTED_NAME',
      detail: `block "${name}"${resolved !== name ? ` (alias -> ${resolved})` : ''} not in minecraft-data for this version`,
    }
  }
  return { ok: true, value: { id: block.id, name: block.name } }
}
