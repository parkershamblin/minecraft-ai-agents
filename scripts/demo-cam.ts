// Dedicated demo camera — the pov-rig pattern for the skill demo gate.
// Spawns 'demo_cam', floats it at a vantage point (RCON-teleported by the
// shell), and serves a first-person prismarine-viewer on :3101 that STARES
// at the given focus point. Decoupled from the actor bot, so window
// interactions and pathfinding can never steal the shot.
// Run: npx tsx scripts/demo-cam.ts <focusX> <focusY> <focusZ>
import mineflayer from 'mineflayer'
import { Vec3 } from 'vec3'

const [fx, fy, fz] = [Number(process.argv[2]), Number(process.argv[3]), Number(process.argv[4])]
if ([fx, fy, fz].some((n) => !Number.isFinite(n))) {
  console.error('usage: demo-cam.ts <focusX> <focusY> <focusZ>')
  process.exit(1)
}

const log = (event: string, data: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data }))

const bot = mineflayer.createBot({
  host: 'localhost', port: 25565, username: 'demo_cam', version: '1.21.6', auth: 'offline',
})

bot.once('spawn', async () => {
  log('cam_spawned', {})
  // Grounded cam: this server kicks floating players (no allow-flight), so
  // the shell tp's us to a surface vantage and physics keeps us standing.

  const { mineflayer: mineflayerViewer } = await import('prismarine-viewer')
  mineflayerViewer(bot, { port: 3101, firstPerson: true, viewDistance: 6 })
  log('cam_viewer_ready', { url: 'http://localhost:3101' })

  const focus = new Vec3(fx + 0.5, fy + 0.5, fz + 0.5)
  setInterval(() => { bot.lookAt(focus).catch(() => {}) }, 800)
})

bot.on('kicked', (r) => { log('cam_kicked', { reason: String(r) }); process.exit(1) })
bot.on('error', (e: any) => { log('cam_error', { error: String(e?.message ?? e) }); process.exit(1) })
