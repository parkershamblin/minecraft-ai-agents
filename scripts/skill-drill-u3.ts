// U3 demo drill — REAL smeltItem + useChest primitives against the live
// world. Harness reuses the proven U2 placeItem to stand up a furnace and a
// chest, then: smelt raw_iron with plank fuel -> check chest (empty) ->
// deposit ingots+pickaxe -> check (contents) -> withdraw ingots back.
// Camera: first-person + a lookAt keep-alive on the active block.
// Run: npx tsx scripts/skill-drill-u3.ts
import mineflayer from 'mineflayer'
import mineflayerPathfinder from 'mineflayer-pathfinder'
import minecraftData from 'minecraft-data'
import { Vec3 } from 'vec3'
import {
  smeltItem,
  type SmeltItemDeps,
  type FurnaceHandle,
} from '../services/minecraft-service/src/skills/primitives/smeltItem.ts'
import {
  getItemFromChest,
  depositItemIntoChest,
  checkItemInsideChest,
  type UseChestDeps,
  type ChestHandle,
} from '../services/minecraft-service/src/skills/primitives/useChest.ts'
import {
  placeItem,
  type PlaceItemDeps,
} from '../services/minecraft-service/src/skills/primitives/placeItem.ts'
import { guardedItem } from '../services/minecraft-service/src/skills/names.ts'
import type { SkillInvocationContext, SkillPosition } from '../services/minecraft-service/src/skills/types.ts'

const { pathfinder, Movements, goals } = mineflayerPathfinder

const log = (event: string, data: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data }))

const bot = mineflayer.createBot({
  host: 'localhost', port: 25565, username: 'skill_drill', version: '1.21.6', auth: 'offline',
})
bot.loadPlugin(pathfinder)

// Camera keep-alive: keeps the first-person view pointed at the action.
let lookTarget: Vec3 | null = null
setInterval(() => { if (lookTarget) bot.lookAt(lookTarget).catch(() => {}) }, 1500)

bot.once('spawn', async () => {
  const mcData = minecraftData(bot.version) as any
  log('spawned', { username: bot.username })
  bot.pathfinder.setMovements(new Movements(bot))

  const { mineflayer: mineflayerViewer } = await import('prismarine-viewer')
  mineflayerViewer(bot, { port: 3100, firstPerson: true, viewDistance: 5 })
  log('viewer_ready', {})
  await new Promise((r) => setTimeout(r, 10000))

  const ctx: SkillInvocationContext = {
    biome: null,
    timeOfDay: Math.round(bot.time.timeOfDay),
    heldTool: bot.heldItem?.name ?? null,
    hostileCount: 0,
    position: {
      x: Math.round(bot.entity.position.x),
      y: Math.round(bot.entity.position.y),
      z: Math.round(bot.entity.position.z),
    },
  }

  const gotoBlockBool = async (pos: SkillPosition, timeoutMs: number): Promise<boolean> => {
    try {
      let timer: NodeJS.Timeout | undefined
      const timeout = new Promise<boolean>((res) => {
        timer = setTimeout(() => { bot.pathfinder.stop(); res(false) }, Math.max(1, timeoutMs))
      })
      const walk = bot.pathfinder
        .goto(new goals.GoalLookAtBlock(new Vec3(pos.x, pos.y, pos.z), bot.world))
        .then(() => true)
      const result = await Promise.race([walk, timeout])
      clearTimeout(timer)
      return result
    } catch { return false }
  }

  const findBlockPos = (name: string, maxDistance: number): SkillPosition | null => {
    const b = bot.findBlock({ matching: mcData.blocksByName[name].id, maxDistance })
    return b ? { x: b.position.x, y: b.position.y, z: b.position.z } : null
  }

  const placeDepsFor = (itemName: string): PlaceItemDeps => ({
    resolveItem: (name) => guardedItem(mcData, name),
    hasItem: (itemId) => bot.inventory.count(itemId, null) > 0,
    findReferenceBlock: (near) => {
      const target = new Vec3(near.x, near.y, near.z)
      for (const face of [new Vec3(0, -1, 0), new Vec3(0, 1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]) {
        const refPos = target.plus(face)
        const refBlock = bot.blockAt(refPos)
        if (refBlock && refBlock.boundingBox === 'block') {
          const back = face.scaled(-1)
          return { ref: { x: refPos.x, y: refPos.y, z: refPos.z }, face: { x: back.x, y: back.y, z: back.z } }
        }
      }
      return null
    },
    place: async (ref, face) => {
      try {
        const item = bot.inventory.items().find((i) => i.name === itemName)
        if (!item) return 'failed'
        await bot.equip(item, 'hand')
        const refBlock = bot.blockAt(new Vec3(ref.x, ref.y, ref.z))
        if (!refBlock) return 'failed'
        await bot.placeBlock(refBlock, new Vec3(face.x, face.y, face.z))
        return 'placed'
      } catch (err: any) {
        log('place_throw', { error: String(err?.message ?? err) })
        return 'failed'
      }
    },
    verifyPlaced: async (name, near) => bot.blockAt(new Vec3(near.x, near.y, near.z))?.name === name,
    gotoNear: async (pos, timeoutMs) => {
      // Placement targets are AIR cells — GoalNear, never GoalLookAtBlock.
      try {
        let timer: NodeJS.Timeout | undefined
        const timeout = new Promise<'failed'>((res) => {
          timer = setTimeout(() => { bot.pathfinder.stop(); res('failed') }, Math.max(1, timeoutMs))
        })
        const walk = bot.pathfinder
          .goto(new goals.GoalNear(pos.x, pos.y, pos.z, 2))
          .then(() => 'arrived' as const)
        const result = await Promise.race([walk, timeout])
        clearTimeout(timer)
        return result
      } catch { return 'failed' }
    },
    now: () => Date.now(),
  })

  const smeltDeps: SmeltItemDeps = {
    resolveItem: (name) => guardedItem(mcData, name),
    findFurnace: (maxDistance) => findBlockPos('furnace', maxDistance),
    gotoBlock: gotoBlockBool,
    openFurnace: async (pos) => {
      try {
        const block = bot.blockAt(new Vec3(pos.x, pos.y, pos.z))
        if (!block) return null
        const furnace: any = await bot.openFurnace(block)
        const handle: FurnaceHandle = {
          putInput: async (itemId, count) => { await furnace.putInput(itemId, null, count) },
          putFuel: async (itemId, count) => {
            try { await furnace.putFuel(itemId, null, count) } catch (err: any) {
              // still burning — fuel slot occupied is fine
              log('putFuel_note', { note: String(err?.message ?? err) })
            }
          },
          outputCount: () => furnace.outputItem()?.count ?? 0,
          takeOutput: async () => { await furnace.takeOutput() },
          close: async () => { furnace.close() },
        }
        return handle
      } catch { return null }
    },
    countInventory: (itemId) => bot.inventory.count(itemId, null),
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  }

  const chestDeps: UseChestDeps = {
    findChest: (maxDistance) => findBlockPos('chest', maxDistance),
    gotoBlock: gotoBlockBool,
    openChest: async (pos) => {
      try {
        const block = bot.blockAt(new Vec3(pos.x, pos.y, pos.z))
        if (!block) return null
        const container: any = await bot.openContainer(block)
        const handle: ChestHandle = {
          items: () => container.containerItems().map((i: any) => ({ name: i.name, count: i.count })),
          withdraw: async (itemId, count) => {
            const avail = container.containerItems()
              .filter((i: any) => i.type === itemId)
              .reduce((s: number, i: any) => s + i.count, 0)
            const take = Math.min(count, avail)
            if (take <= 0) return 0
            await container.withdraw(itemId, null, take)
            return take
          },
          deposit: async (itemId, count) => {
            const have = bot.inventory.count(itemId, null)
            const give = Math.min(count, have)
            if (give <= 0) return 0
            await container.deposit(itemId, null, give)
            return give
          },
          close: async () => { container.close() },
        }
        return handle
      } catch { return null }
    },
    resolveItem: (name) => guardedItem(mcData, name),
    inventoryFull: () => bot.inventory.emptySlotCount() === 0,
    now: () => Date.now(),
  }

  const invoke = async (label: string, fn: () => Promise<unknown>) => {
    log(`${label}_invoke`, {})
    await new Promise((r) => setTimeout(r, 3000))
    const result = await fn()
    log(`${label}_result`, result as Record<string, unknown>)
    await new Promise((r) => setTimeout(r, 2000))
    return result as any
  }

  // Find placement cells: two ground spots near the bot.
  const p = bot.entity.position
  const groundCell = (dx: number, dz: number): SkillPosition | null => {
    const gx = Math.floor(p.x) + dx
    const gz = Math.floor(p.z) + dz
    for (let gy = Math.floor(p.y) + 1; gy >= Math.floor(p.y) - 2; gy--) {
      const cell = bot.blockAt(new Vec3(gx, gy, gz))
      const below = bot.blockAt(new Vec3(gx, gy - 1, gz))
      if (cell?.name === 'air' && below && below.boundingBox === 'block') return { x: gx, y: gy, z: gz }
    }
    return null
  }
  const candidates: Array<[number, number]> = [
    [2, 0], [0, 2], [-2, 0], [0, -2], [2, 2], [-2, 2], [2, -2], [-2, -2],
    [3, 0], [0, 3], [-3, 0], [0, -3], [3, 3], [4, 0], [0, 4], [-4, 0],
  ]
  const cells: SkillPosition[] = []
  for (const [dx, dz] of candidates) {
    const c = groundCell(dx, dz)
    if (c && !cells.some((e) => e.x === c.x && e.z === c.z)) cells.push(c)
  }
  if (cells.length < 2) { log('no_placement_site', { tried: candidates.length }); return finish() }
  log('placement_sites', { candidates: cells.length })

  // Real-caller behavior: on PLACE_FAILED, try the next candidate cell.
  const placeStation = async (itemName: string): Promise<SkillPosition | null> => {
    for (let attempt = 0; attempt < 3 && cells.length > 0; attempt++) {
      const cell = cells.shift()!
      const r = await invoke(`placeItem_${itemName}`, () =>
        placeItem(placeDepsFor(itemName), { name: itemName, position: cell }, ctx))
      if (r.ok) return cell
      if (r.failureCode !== 'PLACE_FAILED') return null
    }
    return null
  }

  // Stand up the stations (placeItem is U2's proven primitive — harness here).
  const furnaceCell = await placeStation('furnace')
  if (!furnaceCell) return finish()
  lookTarget = new Vec3(furnaceCell.x + 0.5, furnaceCell.y + 0.5, furnaceCell.z + 0.5)

  const chestCell = await placeStation('chest')
  if (!chestCell) return finish()

  // UNDER TEST: smeltItem — raw iron with plank fuel, output polled not waited.
  const smelted = await invoke('smeltItem_raw_iron', () =>
    smeltItem(smeltDeps, { itemName: 'raw_iron', fuelName: 'oak_planks', count: 3 }, ctx))
  if (!smelted.ok) return finish()

  lookTarget = new Vec3(chestCell.x + 0.5, chestCell.y + 0.5, chestCell.z + 0.5)

  // UNDER TEST: useChest triple.
  await invoke('checkChest_empty', () =>
    checkItemInsideChest(chestDeps, { chestPosition: chestCell }, ctx))
  await invoke('depositChest', () =>
    depositItemIntoChest(chestDeps, { chestPosition: chestCell, items: { iron_ingot: 3, wooden_pickaxe: 1 } }, ctx))
  await invoke('checkChest_stocked', () =>
    checkItemInsideChest(chestDeps, { chestPosition: chestCell }, ctx))
  await invoke('withdrawChest', () =>
    getItemFromChest(chestDeps, { chestPosition: chestCell, items: { iron_ingot: 3 } }, ctx))

  finish()

  function finish() {
    lookTarget = null
    log('demo_complete', { inventory: bot.inventory.items().map((i) => `${i.name}x${i.count}`) })
    setTimeout(() => { bot.quit(); process.exit(0) }, 3000)
  }
})

bot.on('kicked', (r) => { log('kicked', { reason: String(r) }); process.exit(1) })
bot.on('error', (e: any) => { log('bot_error', { error: String(e?.message ?? e) }); process.exit(1) })
