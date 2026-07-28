// Skill demo drill — spawns ONE standalone bot ("skill_drill") on the live
// Paper server, loads the Tier 1 plugin set exactly as unit 13 wires it in
// BotSession (same reflexRouting flag semantics), optionally serves a
// prismarine-viewer on :3100, and runs one named demo while logging structured
// JSON lines the demo gate captures on camera.
//
// Usage: node scripts/skill-drill.mjs <demo> [--viewer] [--duration <s>]
// Demos: reflex-eat   — U13: auto-eat + armor-manager reflexes fire with zero
//                       deliberation involvement (drive hunger/armor via RCON
//                       from the shell; this script just embodies + logs)
//
// The fleet's 6 villagers are untouched — this is a 7th, throwaway player.
import mineflayer from 'mineflayer'
import mineflayerPathfinder from 'mineflayer-pathfinder'
import autoEatPkg from 'mineflayer-auto-eat'
import armorManagerPkg from 'mineflayer-armor-manager'

const { pathfinder, Movements, goals } = mineflayerPathfinder
// CJS interop: auto-eat 3.3.6 exports { plugin }; armor-manager is export=fn.
const autoEat = autoEatPkg.plugin ?? autoEatPkg.default ?? autoEatPkg
const armorManager = armorManagerPkg.default ?? armorManagerPkg

const demo = process.argv[2]
const withViewer = process.argv.includes('--viewer')
const durIdx = process.argv.indexOf('--duration')
const durationS = durIdx > -1 ? Number(process.argv[durIdx + 1]) : 90

if (!demo) {
  console.error('usage: skill-drill.mjs <demo> [--viewer] [--duration <s>]')
  process.exit(1)
}

const log = (event, data = {}) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data }))

const bot = mineflayer.createBot({
  host: 'localhost',
  port: 25565,
  username: 'skill_drill',
  version: '1.21.6',
  auth: 'offline',
})

bot.loadPlugin(pathfinder)
bot.loadPlugin(autoEat) // 3.3.6 CJS: default export IS the plugin (unit 13 wiring)
bot.loadPlugin(armorManager)

bot.once('spawn', async () => {
  log('spawned', { username: bot.username, food: bot.food, health: bot.health })

  // U13 onSpawn configuration mirror: eat by foodPoints, start at threshold.
  bot.autoEat.options = { ...bot.autoEat.options, priority: 'foodPoints', startAt: 16, bannedFood: [] }
  log('autoeat_configured', { startAt: 16, priority: 'foodPoints' })

  if (withViewer) {
    const { mineflayer: mineflayerViewer } = await import('prismarine-viewer')
    mineflayerViewer(bot, { port: 3100, firstPerson: false, viewDistance: 4 })
    log('viewer_ready', { url: 'http://localhost:3100' })
  }

  // armor-manager equips silently; poll the armor slots directly (updateSlot
  // carried null item names in take 1 — slot objects, not names).
  let lastArmor = ''
  setInterval(() => {
    const worn = [5, 6, 7, 8]
      .map((s) => bot.inventory.slots[s]?.name ?? '-')
      .join(',')
    if (worn !== lastArmor) {
      log('REFLEX_armor_state', { head: worn.split(',')[0], chest: worn.split(',')[1], legs: worn.split(',')[2], feet: worn.split(',')[3] })
      lastArmor = worn
    }
  }, 1000)

  // Visible motion: wander around spawn so the viewer shows a living bot —
  // and proves the reflexes fire below deliberation WHILE the body walks.
  // (A stationary eating bot renders as a frozen frame: no HUD, no animation.)
  const movements = new Movements(bot)
  movements.canDig = false
  movements.allow1by1towers = false
  bot.pathfinder.setMovements(movements)
  const base = bot.entity.position.clone()
  let done = false
  ;(async () => {
    while (!done) {
      const dx = Math.floor(Math.random() * 17) - 8
      const dz = Math.floor(Math.random() * 17) - 8
      try {
        log('wander_leg', { toX: Math.round(base.x + dx), toZ: Math.round(base.z + dz) })
        await bot.pathfinder.goto(new goals.GoalNearXZ(base.x + dx, base.z + dz, 2))
      } catch { /* unreachable leg — pick another */ }
      await new Promise((r) => setTimeout(r, 500))
    }
  })()

  setTimeout(() => {
    done = true
    log('demo_complete', { demo, food: bot.food, health: bot.health })
    bot.quit()
    process.exit(0)
  }, durationS * 1000)
})

// Reflex evidence stream — the camera records these lines.
bot.on('autoeat_started', (item) =>
  log('REFLEX_autoeat_started', { item: item?.name ?? String(item), food: bot.food }))
bot.on('autoeat_finished', () => log('REFLEX_autoeat_finished', { food: bot.food }))
bot.on('autoeat_error', (err) => log('autoeat_error', { error: String(err?.message ?? err) }))
bot.on('health', () => log('vitals', { food: bot.food, health: bot.health }))
bot.on('playerCollect', (collector) => {
  if (collector.username === bot.username) log('collected_item', {})
})
bot.on('kicked', (reason) => { log('kicked', { reason: String(reason) }); process.exit(1) })
bot.on('error', (err) => { log('bot_error', { error: String(err?.message ?? err) }); process.exit(1) })
