// M1-8 Paper spike smoke: proves the pinned mineflayer 4.37.1 stack talks to
// the containerized PaperMC 1.21.6 server cleanly — connect, spawn, WALK, chat,
// disconnect. This is the de-risking gate before the 20-bot fleet/soak.
//
// Mirrors scripts/smoke.js (the vanilla version-pin canary): borrows the
// archived PoC's mineflayer 4.37.1 — the exact pin minecraft-service ships —
// and connects auth:'offline' + viewDistance:'tiny' exactly like BotSession.ts,
// so a pass here is representative of the real bot's handshake against Paper.
// Adds a walk leg (raw movement packets — no pathfinder, to isolate protocol
// compatibility from terrain-load flakiness) and asserts a clean 'end' on quit.
// Exits 0 only if every leg passes; prints timing for the spike report.
const mineflayer = require('../experiments/pathfinder-Bot/node_modules/mineflayer')

const host = process.env.SMOKE_MC_HOST || 'localhost'
const port = Number(process.env.MC_PORT || 25565)
const version = process.env.MC_VERSION || '1.21.6'

const t0 = Date.now()
const ms = () => Date.now() - t0
const sleep = (n) => new Promise((r) => setTimeout(r, n))

console.log(`[spike] connecting to ${host}:${port} (MC ${version}) as offline spike_bot...`)
const bot = mineflayer.createBot({
  host,
  port,
  version,
  username: 'spike_bot',
  auth: 'offline',
  viewDistance: 'tiny',
})

let done = false
const finish = (code, msg) => {
  if (done) return
  done = true
  clearTimeout(timeout)
  console.log(msg)
  try { bot.removeAllListeners('error'); bot.quit() } catch { /* already gone */ }
  process.exit(code)
}

const timeout = setTimeout(() => finish(1, '[spike] FAIL: did not complete within 45s'), 45_000)
bot.on('kicked', (reason) => finish(1, `[spike] FAIL: kicked — ${JSON.stringify(reason)}`))
bot.on('error', (err) => finish(1, `[spike] FAIL: ${err.message}`))

bot.once('spawn', async () => {
  try {
    console.log(`[spike] spawned OK at ${ms()}ms — pos ${bot.entity.position}`)

    // --- walk leg: raw movement packets, assert the position actually moved ---
    const start = bot.entity.position.clone()
    bot.setControlState('forward', true)
    await sleep(2500)
    bot.setControlState('forward', false)
    await sleep(500)
    const moved = start.distanceTo(bot.entity.position)
    console.log(`[spike] walked ${moved.toFixed(2)} blocks -> pos ${bot.entity.position}`)
    if (moved < 0.5) return finish(1, '[spike] FAIL: bot did not move — movement packets not landing')

    // --- chat leg ---
    bot.chat('spike: paper 1.21.6 handshake good')
    await sleep(750)
    console.log(`[spike] chatted OK at ${ms()}ms`)

    // --- clean-disconnect leg: intentional quit must fire 'end' (not error) ---
    bot.removeAllListeners('error')
    bot.removeAllListeners('kicked')
    bot.on('error', () => { /* swallow post-quit socket noise */ })
    let ended = false
    bot.once('end', () => { ended = true })
    bot.quit()
    await sleep(1500)
    if (!ended) return finish(1, '[spike] FAIL: no clean end event on quit')

    console.log(`[spike] disconnected cleanly at ${ms()}ms`)
    finish(0, '[spike] PASS — connect, spawn, walk, chat, disconnect all clean')
  } catch (err) {
    finish(1, `[spike] FAIL in spawn handler: ${err.message}`)
  }
})
