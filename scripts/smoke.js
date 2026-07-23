// Version-pin canary (`task smoke`): proves the pinned mineflayer stack still
// logs into the Minecraft server. Exits 0 on spawn+chat, 1 on error/timeout.
//
// mineflayer resolves from the npm workspace install — the SAME exact pin
// services/minecraft-service ships (populated by `npm install` at the repo
// root). Never point this at the archived PoC copies under experiments/:
// they are gitignored (absent on a fresh clone) and pinned with a caret,
// so the canary would validate a version the service doesn't run.
let mineflayer
try {
  mineflayer = require('mineflayer')
} catch {
  console.error('[smoke] FAIL: mineflayer not installed — run `npm install` at the repo root first')
  process.exit(1)
}

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
