// U5 demo drill — REAL exploreUntil + givePlacedItemBack primitives, live.
// Arc: place a crafting table (U2 harness), walk away 20 blocks, then
// exploreUntil BACK toward it with a "table in sight" predicate; on arrival,
// givePlacedItemBack digs the table up and recovers the item. All in the
// demo-cam's field of view.
// Run: npx tsx scripts/skill-drill-u5.ts
import mineflayer from 'mineflayer'
import mineflayerPathfinderPkg from 'mineflayer-pathfinder'
import minecraftData from 'minecraft-data'
import { Vec3 } from 'vec3'
import {
  exploreUntil,
  type ExploreUntilDeps,
} from '../services/minecraft-service/src/skills/primitives/exploreUntil.ts'
import {
  givePlacedItemBack,
  type GivePlacedItemBackDeps,
} from '../services/minecraft-service/src/skills/primitives/givePlacedItemBack.ts'
import {
  placeItem,
  type PlaceItemDeps,
} from '../services/minecraft-service/src/skills/primitives/placeItem.ts'
import { guardedItem } from '../services/minecraft-service/src/skills/names.ts'
import type { SkillInvocationContext, SkillPosition } from '../services/minecraft-service/src/skills/types.ts'

const { pathfinder, Movements, goals } = mineflayerPathfinderPkg

const log = (event: string, data: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data }))

const bot = mineflayer.createBot({
  host: 'localhost', port: 25565, username: 'skill_drill', version: '1.21.6', auth: 'offline',
})
bot.loadPlugin(pathfinder)

let collectedEvents = 0
bot.on('playerCollect', (c) => { if (c.id === bot.entity?.id) collectedEvents += 1 })

bot.once('spawn', async () => {
  const mcData = minecraftData(bot.version) as any
  log('spawned', { username: bot.username })
  const movements = new Movements(bot)
  movements.canDig = false
  bot.pathfinder.setMovements(movements)
  await new Promise((r) => setTimeout(r, 8000))

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

  const invoke = async (label: string, fn: () => Promise<unknown>) => {
    log(`${label}_invoke`, {})
    await new Promise((r) => setTimeout(r, 2500))
    const result = await fn()
    log(`${label}_result`, result as Record<string, unknown>)
    await new Promise((r) => setTimeout(r, 1500))
    return result as any
  }

  // --- harness: place a crafting table on solid ground nearby (U2 primitive)
  const placeDeps: PlaceItemDeps = {
    resolveItem: (name) => guardedItem(mcData, name),
    hasItem: (itemId) => bot.inventory.count(itemId, null) > 0,
    findReferenceBlock: (near) => {
      const target = new Vec3(near.x, near.y, near.z)
      for (const face of [new Vec3(0, -1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]) {
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
        const item = bot.inventory.items().find((i) => i.name === 'crafting_table')
        if (!item) return 'failed'
        await bot.equip(item, 'hand')
        const refBlock = bot.blockAt(new Vec3(ref.x, ref.y, ref.z))
        if (!refBlock) return 'failed'
        await bot.placeBlock(refBlock, new Vec3(face.x, face.y, face.z))
        return 'placed'
      } catch { return 'failed' }
    },
    verifyPlaced: async (name, near) => bot.blockAt(new Vec3(near.x, near.y, near.z))?.name === name,
    gotoNear: async (pos, timeoutMs) => {
      try {
        let timer: NodeJS.Timeout | undefined
        const t = new Promise<'failed'>((res) => { timer = setTimeout(() => { bot.pathfinder.stop(); res('failed') }, timeoutMs) })
        const w = bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 2)).then(() => 'arrived' as const)
        const r = await Promise.race([w, t]); clearTimeout(timer); return r
      } catch { return 'failed' }
    },
    now: () => Date.now(),
  }

  // Find candidate table cells near the bot; retry on PLACE_FAILED (flake).
  const p0 = bot.entity.position
  const tableCells: SkillPosition[] = []
  for (const [dx, dz] of [[2, 0], [0, 2], [-2, 0], [0, -2], [3, 1], [1, 3], [-3, 1], [2, -2]] as const) {
    const gx = Math.floor(p0.x) + dx, gz = Math.floor(p0.z) + dz
    for (let gy = Math.floor(p0.y) + 1; gy >= Math.floor(p0.y) - 2; gy--) {
      const cell = bot.blockAt(new Vec3(gx, gy, gz))
      const below = bot.blockAt(new Vec3(gx, gy - 1, gz))
      if (cell?.name === 'air' && below && below.boundingBox === 'block') { tableCells.push({ x: gx, y: gy, z: gz }); break }
    }
  }
  if (tableCells.length === 0) { log('no_table_cell', {}); return finish() }
  let tableCell: SkillPosition | null = null
  for (const cell of tableCells.slice(0, 3)) {
    const placed = await invoke('harness_placeTable', () =>
      placeItem(placeDeps, { name: 'crafting_table', position: cell }, ctx))
    if (placed.ok) { tableCell = cell; break }
    if (placed.failureCode !== 'PLACE_FAILED') return finish()
  }
  if (!tableCell) return finish()

  // Walk away ~20 blocks EAST (inland — west is water) so exploreUntil has
  // ground to cover coming back westward.
  try { await bot.pathfinder.goto(new goals.GoalNearXZ(tableCell.x + 20, tableCell.z + 4, 3)) } catch { /* partial walk fine */ }
  const awayDist = Math.round(bot.entity.position.distanceTo(new Vec3(tableCell.x, tableCell.y, tableCell.z)))
  log('walked_away', { from: tableCell, distance: awayDist })

  // --- UNDER TEST: exploreUntil west, predicate = the table is within 12 blocks
  const exploreDeps: ExploreUntilDeps = {
    moveInDirection: async (direction, distance, timeoutMs) => {
      const target = bot.entity.position.offset(direction.x * distance, 0, direction.z * distance)
      const before = bot.entity.position.clone()
      try {
        let timer: NodeJS.Timeout | undefined
        const t = new Promise<'timeout'>((res) => { timer = setTimeout(() => { bot.pathfinder.stop(); res('timeout') }, timeoutMs) })
        const w = bot.pathfinder.goto(new goals.GoalNearXZ(target.x, target.z, 2)).then(() => 'done' as const)
        await Promise.race([w, t]); clearTimeout(timer)
      } catch { /* fall through to progress check */ }
      return bot.entity.position.distanceTo(before) >= 2 ? 'moved' : 'blocked'
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  }
  const tableVec = new Vec3(tableCell.x, tableCell.y, tableCell.z)
  const explored = await invoke('exploreUntil_findTable', () =>
    exploreUntil(
      exploreDeps,
      { direction: { x: -1, y: 0, z: 0 }, maxTimeMs: 90_000 },
      () => {
        const d = bot.entity.position.distanceTo(tableVec)
        return d <= 12 ? { tableSighted: true, distance: Math.round(d) } : null
      },
      ctx,
    ))
  if (!explored.ok) return finish()

  // --- UNDER TEST: givePlacedItemBack — dig the table back up, recover it.
  const gbDeps: GivePlacedItemBackDeps = {
    mcData,
    blockAt: (pos) => bot.blockAt(new Vec3(pos.x, pos.y, pos.z))?.name ?? null,
    dig: async (pos) => {
      const block = bot.blockAt(new Vec3(pos.x, pos.y, pos.z))
      if (!block || block.name === 'air') return 'blocked'
      try { await bot.dig(block); return 'dug' } catch { return 'blocked' }
    },
    collectNearbyDrops: async () => {
      const before = collectedEvents
      // Deterministic first move: stand ON the dug cell — the drop pops there
      // and proximity pickup grabs it without any entity-scan race.
      if (tableCell) {
        try { await bot.pathfinder.goto(new goals.GoalNear(tableCell.x, tableCell.y, tableCell.z, 0)) } catch { /* fine */ }
      }
      await new Promise((r) => setTimeout(r, 900))
      const items = Object.values(bot.entities).filter(
        (e: any) => e?.name === 'item' && e.position.distanceTo(bot.entity.position) < 12,
      )
      for (const item of items.slice(0, 3)) {
        try { await bot.pathfinder.goto(new goals.GoalNear(item.position.x, item.position.y, item.position.z, 1)) } catch { /* gone */ }
      }
      await new Promise((r) => setTimeout(r, 2000))
      return collectedEvents - before
    },
    gotoBlock: async (pos, timeoutMs) => {
      try {
        let timer: NodeJS.Timeout | undefined
        const t = new Promise<'blocked'>((res) => { timer = setTimeout(() => { bot.pathfinder.stop(); res('blocked') }, timeoutMs) })
        const w = bot.pathfinder.goto(new goals.GoalLookAtBlock(new Vec3(pos.x, pos.y, pos.z), bot.world)).then(() => 'arrived' as const)
        const r = await Promise.race([w, t]); clearTimeout(timer); return r
      } catch { return 'blocked' }
    },
    now: () => Date.now(),
  }
  await invoke('givePlacedItemBack_table', () =>
    givePlacedItemBack(gbDeps, { name: 'crafting_table', position: tableCell! }, ctx))

  finish()

  function finish() {
    log('demo_complete', { inventory: bot.inventory.items().map((i) => `${i.name}x${i.count}`) })
    setTimeout(() => { bot.quit(); process.exit(0) }, 3000)
  }
})

bot.on('kicked', (r) => { log('kicked', { reason: String(r) }); process.exit(1) })
bot.on('error', (e: any) => { log('bot_error', { error: String(e?.message ?? e) }); process.exit(1) })
