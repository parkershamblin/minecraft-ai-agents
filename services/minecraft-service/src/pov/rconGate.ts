import { RconClient } from '../rcon/rcon.ts'
import { logger } from '../logging.ts'

const log = logger.child({ module: 'pov-rcon' })

/**
 * The sidecar's one RCON connection, self-healing. RconClient is
 * single-flight and permanently fails on any socket error (by design — the
 * fleet's inventory poller reconnects per cycle), so this gate drops the
 * client on failure and reconnects lazily on the next call. Spectator
 * enforcement runs through here; if RCON is down, cams stay unverified and
 * viewers stay unattached — never the other way around.
 */
export interface RconGate {
  exec(cmd: string): Promise<string>
  /** gamemode spectator + verified playerGameType==3 read-back */
  ensureSpectator(username: string): Promise<boolean>
  tp(cam: string, target: string): Promise<void>
  close(): void
}

interface RconDeps {
  host: string
  port: number
  password: string
  connect?: typeof RconClient.connect
}

export function createRconGate(deps: RconDeps): RconGate {
  const connectFn = deps.connect ?? RconClient.connect.bind(RconClient)
  let client: RconClient | null = null
  // serialize callers: the underlying client is single-flight by design
  let chain: Promise<unknown> = Promise.resolve()

  const withClient = async (cmd: string): Promise<string> => {
    if (!client) {
      client = await connectFn(deps.host, deps.port, deps.password)
      log.info({ host: deps.host, port: deps.port }, 'rcon connected')
    }
    try {
      return await client.send(cmd)
    } catch (err) {
      // drop the dead client; next call reconnects
      try {
        client.close()
      } catch {
        // already torn down
      }
      client = null
      throw err
    }
  }

  const exec = (cmd: string): Promise<string> => {
    const next = chain.then(
      () => withClient(cmd),
      () => withClient(cmd),
    )
    chain = next.catch(() => undefined)
    return next
  }

  return {
    exec,

    async ensureSpectator(username: string): Promise<boolean> {
      try {
        await exec(`gamemode spectator ${username}`)
      } catch (err) {
        log.warn({ username, err: String(err) }, 'gamemode spectator command failed')
        return false
      }
      // Verify, never trust: a survival cam body in a race is interference.
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const reply = await exec(`data get entity ${username} playerGameType`)
          // e.g. "Pov_cam_1 has the following entity data: 3"
          if (/entity data:\s*3\b/.test(reply)) {
            return true
          }
          log.warn({ username, reply, attempt }, 'cam not in spectator yet')
        } catch (err) {
          log.warn({ username, err: String(err), attempt }, 'playerGameType read failed')
        }
      }
      return false
    },

    async tp(cam: string, target: string): Promise<void> {
      await exec(`tp ${cam} ${target}`)
    },

    close(): void {
      try {
        client?.close()
      } catch {
        // teardown best-effort
      }
      client = null
    },
  }
}
