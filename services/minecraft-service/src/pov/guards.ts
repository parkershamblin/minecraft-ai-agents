import { logger } from '../logging.ts'

const log = logger.child({ module: 'pov-guards' })

/**
 * Sidecar-only last-resort guards. The film-day process death was never
 * pinned to one throw site (docs/demo-rb.md), so the rig assumes ANY of its
 * components can throw asynchronously: log it, keep serving the other
 * tiles, and only exit(1) on an error storm — compose `restart: on-failure`
 * supervises from there. This is safe precisely because this process owns
 * zero fleet state; the fleet process deliberately has NO such handler
 * (its crashes must stay loud and visible in restart counts).
 */
export interface GuardOptions {
  windowMs: number
  maxErrors: number
  onFatal: () => void
  /** injected clock for tests */
  now?: () => number
}

export function installPovGuards(opts: GuardOptions): { errorCount: () => number } {
  const now = opts.now ?? Date.now
  let recent: number[] = []

  const record = (kind: string, err: unknown): void => {
    const t = now()
    recent = recent.filter((ts) => t - ts < opts.windowMs)
    recent.push(t)
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err)
    log.error({ kind, err: message, recentErrors: recent.length }, 'viewer component threw — tile may be dark, rig continues')
    if (recent.length >= opts.maxErrors) {
      log.fatal({ recentErrors: recent.length, windowMs: opts.windowMs }, 'error storm — exiting for supervised restart')
      opts.onFatal()
    }
  }

  process.on('uncaughtException', (err) => record('uncaughtException', err))
  process.on('unhandledRejection', (reason) => record('unhandledRejection', reason))

  return { errorCount: () => recent.length }
}
