import { describe, expect, it, vi } from 'vitest'
import { fetchHumanInventory, fetchHumanInventoryStable } from '../src/world/humanInventory.ts'

/** Scripted RCON: responses keyed by exact command, default = end of list. */
function rconWith(responses: Record<string, string>) {
  return {
    send: vi.fn(async (command: string) => responses[command] ?? 'Found no elements matching that path'),
  }
}

describe('fetchHumanInventory', () => {
  it('reads slots until the list ends and merges duplicate stacks', async () => {
    const rcon = rconWith({
      'data get entity Parker Inventory[0].id': 'Parker has the following entity data: "minecraft:iron_pickaxe"',
      'data get entity Parker Inventory[0].count': 'Parker has the following entity data: 1',
      'data get entity Parker Inventory[1].id': 'Parker has the following entity data: "minecraft:oak_log"',
      'data get entity Parker Inventory[1].count': 'Parker has the following entity data: 64',
      'data get entity Parker Inventory[2].id': 'Parker has the following entity data: "minecraft:oak_log"',
      'data get entity Parker Inventory[2].count': 'Parker has the following entity data: 32',
      'data get entity Parker Inventory[3].id': 'Found no elements matching Inventory[3]',
    })
    const inventory = await fetchHumanInventory(rcon, 'Parker')
    expect(inventory).toEqual(
      new Map([
        ['iron_pickaxe', 1],
        ['oak_log', 96],
      ]),
    )
    // stopped probing at the end marker: 3 filled slots (id+count each) + 1 end probe
    expect(rcon.send).toHaveBeenCalledTimes(7)
  })

  it('returns an empty map for an empty inventory', async () => {
    const rcon = rconWith({
      'data get entity Parker Inventory[0].id': 'Found no elements matching Inventory[0]',
    })
    expect(await fetchHumanInventory(rcon, 'Parker')).toEqual(new Map())
  })

  it('returns null when the player is offline', async () => {
    const rcon = rconWith({
      'data get entity Parker Inventory[0].id': 'No entity was found',
    })
    expect(await fetchHumanInventory(rcon, 'Parker')).toBeNull()
  })

  it('rejects names that are not legal Minecraft usernames without touching RCON', async () => {
    const rcon = rconWith({})
    expect(await fetchHumanInventory(rcon, 'Bob; kill @a')).toBeNull()
    expect(await fetchHumanInventory(rcon, '')).toBeNull()
    expect(await fetchHumanInventory(rcon, 'seventeen_chars_xx')).toBeNull()
    expect(rcon.send).not.toHaveBeenCalled()
  })

  it('skips an unparseable slot but keeps the rest of the inventory', async () => {
    const rcon = rconWith({
      'data get entity Parker Inventory[0].id': 'Parker has the following entity data: something weird',
      'data get entity Parker Inventory[0].count': 'Parker has the following entity data: 1',
      'data get entity Parker Inventory[1].id': 'Parker has the following entity data: "minecraft:bread"',
      'data get entity Parker Inventory[1].count': 'Parker has the following entity data: 7',
      'data get entity Parker Inventory[2].id': 'Found no elements matching Inventory[2]',
    })
    expect(await fetchHumanInventory(rcon, 'Parker')).toEqual(new Map([['bread', 7]]))
  })

  it('stable fetch accepts two identical passes', async () => {
    const rcon = rconWith({
      'data get entity Parker Inventory[0].id': 'Parker has the following entity data: "minecraft:stone"',
      'data get entity Parker Inventory[0].count': 'Parker has the following entity data: 12',
      'data get entity Parker Inventory[1].id': 'Found no elements matching Inventory[1]',
    })
    expect(await fetchHumanInventoryStable(rcon, 'Parker')).toEqual({
      status: 'ok',
      items: new Map([['stone', 12]]),
    })
  })

  it('stable fetch reports a torn scan as unstable', async () => {
    const countQueue = [12, 30]
    const rcon = {
      send: vi.fn(async (command: string) => {
        if (command.endsWith('Inventory[0].id')) {
          return 'Parker has the following entity data: "minecraft:stone"'
        }
        if (command.endsWith('Inventory[0].count')) {
          return `Parker has the following entity data: ${countQueue.shift()}`
        }
        return 'Found no elements matching that path'
      }),
    }
    expect(await fetchHumanInventoryStable(rcon, 'Parker')).toEqual({ status: 'unstable' })
  })

  it('stable fetch reports offline players', async () => {
    const rcon = rconWith({ 'data get entity Parker Inventory[0].id': 'No entity was found' })
    expect(await fetchHumanInventoryStable(rcon, 'Parker')).toEqual({ status: 'offline' })
  })

  it('keeps non-vanilla namespaces distinguishable (only the minecraft: prefix is stripped)', async () => {
    const rcon = rconWith({
      'data get entity Parker Inventory[0].id': 'Parker has the following entity data: "somemod:gizmo"',
      'data get entity Parker Inventory[0].count': 'Parker has the following entity data: 2',
      'data get entity Parker Inventory[1].id': 'Found no elements matching Inventory[1]',
    })
    expect(await fetchHumanInventory(rcon, 'Parker')).toEqual(new Map([['somemod:gizmo', 2]]))
  })
})
