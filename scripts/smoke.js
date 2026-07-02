// Version-pin canary (`task smoke`): proves the pinned mineflayer stack still
// logs into the Minecraft server. Exits 0 on spawn+chat, 1 on error/timeout.
//
// Until minecraft-service exists (CIV-4), this borrows the archived PoC's
// node_modules — exactly the empirically-proven versions (mineflayer 4.37.1).
const mineflayer = require('../experiments/pathfinder-Bot/node_modules/mineflayer')

const host = process.env.SMOKE_MC_HOST || 'localhost'
const port = Number(process.env.MC_PORT || 25565)
const version = process.env.MC_VERSION || '1.21.6'

console.log(`[smoke] connecting to ${host}:${port} (MC ${version})...`)

const bot = mineflayer.createBot({ host, port, version, username: 'smoke_bot' })

const timeout = setTimeout(() => {
  console.error('[smoke] FAIL: no spawn within 30s')
  process.exit(1)
}, 30_000)

bot.once('spawn', () => {
  console.log('[smoke] spawned OK')
  bot.chat('smoke test: the bots still get in')
  setTimeout(() => {
    bot.quit()
    clearTimeout(timeout)
    console.log('[smoke] PASS')
    process.exit(0)
  }, 2_000)
})

bot.on('kicked', (reason) => {
  console.error('[smoke] FAIL: kicked —', reason)
  process.exit(1)
})

bot.on('error', (err) => {
  console.error('[smoke] FAIL:', err.message)
  process.exit(1)
})
