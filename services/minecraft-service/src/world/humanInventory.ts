/**
 * Human players' inventories via RCON. mineflayer can't see other players'
 * inventories, and `data get entity <name> Inventory` output is ellipsized by
 * the server past ~150 chars (measured live 2026-07-09) — so we read per slot:
 * `Inventory[i].id` / `Inventory[i].count` are single-value responses that can
 * never hit the cap and need no SNBT parsing. Inventory is a dense list, so we
 * probe indices upward until "Found no elements".
 */

export interface RconLike {
  send(command: string): Promise<string>
}

/** Real MC usernames only — also the injection guard for the interpolated command. */
const NAME_RE = /^[A-Za-z0-9_]{1,16}$/

/** 36 main + 4 armor + offhand: the Inventory list can never be longer. */
const MAX_SLOTS = 41

const NO_SUCH_ELEMENT = 'Found no elements'
const NO_SUCH_ENTITY = 'No entity was found'

export type HumanInventoryResult =
  | { status: 'ok'; items: Map<string, number> }
  | { status: 'offline' }
  | { status: 'unstable' }

/**
 * The per-slot scan is dozens of RCON round-trips against a DENSE list that
 * reindexes whenever the player moves items, so a single pass can tear (miss a
 * stack, or pair slot i's id with the next stack's count) — and a torn read
 * that "loses" a stack for one cycle would book its reappearance as a phantom
 * haul. Scan twice and accept only two identical passes; a discarded cycle
 * costs nothing because deltas are computed against the last ACCEPTED scan.
 */
export async function fetchHumanInventoryStable(rcon: RconLike, name: string): Promise<HumanInventoryResult> {
  const first = await fetchHumanInventory(rcon, name)
  if (first === null) {
    return { status: 'offline' }
  }
  const second = await fetchHumanInventory(rcon, name)
  if (second === null) {
    return { status: 'offline' }
  }
  return mapsEqual(first, second) ? { status: 'ok', items: second } : { status: 'unstable' }
}

function mapsEqual(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): boolean {
  if (a.size !== b.size) {
    return false
  }
  for (const [key, value] of a) {
    if (b.get(key) !== value) {
      return false
    }
  }
  return true
}

/** Single pass — see fetchHumanInventoryStable. null = offline/illegal name. */
export async function fetchHumanInventory(rcon: RconLike, name: string): Promise<Map<string, number> | null> {
  if (!NAME_RE.test(name)) {
    return null
  }
  const counts = new Map<string, number>()
  for (let slot = 0; slot < MAX_SLOTS; slot++) {
    const idResponse = await rcon.send(`data get entity ${name} Inventory[${slot}].id`)
    if (idResponse.includes(NO_SUCH_ELEMENT)) {
      break
    }
    if (idResponse.includes(NO_SUCH_ENTITY)) {
      return null
    }
    const countResponse = await rcon.send(`data get entity ${name} Inventory[${slot}].count`)
    if (countResponse.includes(NO_SUCH_ENTITY)) {
      return null
    }
    // "<name> has the following entity data: \"minecraft:oak_log\"" / "…data: 64"
    const idMatch = /"([^"]+)"\s*$/.exec(idResponse.trim())
    const countMatch = /entity data:\s*(-?\d+)/.exec(countResponse)
    const item = idMatch?.[1]?.replace(/^minecraft:/, '')
    const count = countMatch?.[1] === undefined ? NaN : Number(countMatch[1])
    if (!item || !Number.isFinite(count) || count <= 0) {
      continue // unparseable or empty slot — keep the rest of the inventory honest
    }
    counts.set(item, (counts.get(item) ?? 0) + count)
  }
  return counts
}
