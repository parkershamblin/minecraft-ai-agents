import mineflayer from 'mineflayer'
import { loadConfig } from '../config.ts'
import { logger } from '../logging.ts'
import { buildRoster } from './roster.ts'
import { createRconGate } from './rconGate.ts'
import { installPovGuards } from './guards.ts'
import { startHealthServer } from './health.ts'
import { CamSession } from './camSession.ts'

/**
 * The POV film rig as a supervised sidecar (compose service `pov-rig`,
 * profile `pov`). Owns its own spectator cam connections and the
 * prismarine-viewer servers on :3100-3105 — the fleet process never loads
 * any of this, so no viewer failure mode (throw, OOM, parse storm) can
 * touch a racer. Kill this container mid-race and the only casualty is the
 * tiles; `restart: on-failure` brings them back.
 */
const log = logger.child({ module: 'pov-sidecar' })

const config = loadConfig()

if (config.POV_VIEWER !== 1) {
  // Profile activation is the operator switch; this gate just makes a stray
  // `tsx src/pov/sidecar.ts` on a fleet host exit clean and quiet.
  log.info('POV_VIEWER != 1 — pov sidecar has nothing to do, exiting')
  process.exit(0)
}

if (!config.RCON_HOST) {
  // Spectator enforcement is mandatory: without RCON we cannot verify cams
  // are non-interfering, so refuse loudly (vanilla-host fallback unsupported).
  log.fatal('RCON_HOST is empty — cannot enforce spectator cams; pov sidecar refusing to start')
  process.exit(1)
}

installPovGuards({
  windowMs: 60_000,
  maxErrors: 6,
  onFatal: () => process.exit(1),
})

const rcon = createRconGate({
  host: config.RCON_HOST,
  port: config.RCON_PORT,
  password: config.RCON_PASSWORD,
})

const roster = buildRoster(config)
const cams = roster.map(
  (assignment) =>
    new CamSession(assignment, {
      createBot: ({ username }) =>
        mineflayer.createBot({
          host: config.MC_HOST,
          port: config.MC_PORT,
          version: config.MC_VERSION,
          username,
          auth: 'offline',
          viewDistance: config.POV_VIEW_DISTANCE,
        }),
      // Lazy: the heavy dep (three.js worldview, express) loads only here,
      // in the sidecar process. `canvas` stays stubbed (noop2) — browsers render.
      loadViewer: () =>
        import('prismarine-viewer') as unknown as Promise<{
          mineflayer: (bot: import('mineflayer').Bot, opts: { port: number; firstPerson: boolean; viewDistance: number }) => void
        }>,
      rcon,
      viewDistance: config.POV_VIEW_DISTANCE,
    }),
)

const health = startHealthServer(config.POV_HEALTH_PORT, () =>
  cams.map((cam) => ({
    cam: cam.assignment.camName,
    racer: cam.assignment.racer,
    port: cam.assignment.port,
    state: cam.state,
    lastMoveTs: cam.lastMoveTs,
  })),
)

// Staggered starts: post-nuke servers have the default per-IP
// connection-throttle back, and six instant logins from one IP would herd.
cams.forEach((cam, i) => setTimeout(() => cam.start(), i * 750))
log.info({ tiles: roster.map((r) => `${r.racer}:${r.port}`) }, 'pov sidecar starting cams')

const shutdown = (signal: string): void => {
  log.info({ signal }, 'pov sidecar shutting down')
  for (const cam of cams) {
    cam.stop()
  }
  rcon.close()
  health.close(() => process.exit(0))
  // health server close can hang on open SSE-ish sockets; hard floor:
  setTimeout(() => process.exit(0), 3_000).unref()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
