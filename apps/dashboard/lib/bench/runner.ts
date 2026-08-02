import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

import { buildBenchArgs, getCommand, type BenchCommandId } from './catalog'
import type { BenchJobSnapshot, BenchJobStatus } from './types'

export type { BenchJobSnapshot, BenchJobStatus } from './types'

type LogListener = (line: string) => void
type StatusListener = (snap: BenchJobSnapshot) => void

const MAX_LOG_LINES = 4000
const RECENT_FOR_STATUS = 80

function findRepoRoot(): string | null {
  const candidates = [process.cwd(), path.resolve(process.cwd(), '..'), path.resolve(process.cwd(), '../..')]
  for (const dir of candidates) {
    if (existsSync(path.join(dir, 'scripts', 'civ-bench.mjs'))) return dir
  }
  return null
}

class BenchRunner {
  private child: ChildProcessWithoutNullStreams | null = null
  private status: BenchJobStatus = 'idle'
  private command: BenchCommandId | null = null
  private args: string[] = []
  private startedAt: string | null = null
  private endedAt: string | null = null
  private exitCode: number | null = null
  private error: string | null = null
  private logs: string[] = []
  private readonly logListeners = new Set<LogListener>()
  private readonly statusListeners = new Set<StatusListener>()
  private readonly repoRoot = findRepoRoot()

  snapshot(): BenchJobSnapshot {
    return {
      status: this.status,
      command: this.command,
      args: [...this.args],
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      exitCode: this.exitCode,
      pid: this.child?.pid ?? null,
      logLines: this.logs.length,
      recentLogs: this.logs.slice(-RECENT_FOR_STATUS),
      error: this.error,
      repoRoot: this.repoRoot,
    }
  }

  onLog(listener: LogListener): () => void {
    this.logListeners.add(listener)
    return () => this.logListeners.delete(listener)
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  /** Replay buffered logs to a new SSE subscriber. */
  forEachLog(fn: (line: string) => void): void {
    for (const line of this.logs) fn(line)
  }

  start(command: BenchCommandId, options: Record<string, unknown> = {}): BenchJobSnapshot {
    if (this.status === 'running') {
      throw Object.assign(new Error('a bench job is already running'), { statusCode: 409 })
    }
    if (!getCommand(command)) {
      throw Object.assign(new Error(`unknown command: ${command}`), { statusCode: 400 })
    }
    if (!this.repoRoot) {
      throw Object.assign(
        new Error('could not find repo root (scripts/civ-bench.mjs). Run the dashboard from the monorepo.'),
        { statusCode: 500 },
      )
    }

    const forwardArgs = buildBenchArgs(command, options)
    const script = path.join(this.repoRoot, 'scripts', 'civ-bench.mjs')
    const argv = [script, command, ...forwardArgs]

    this.logs = []
    this.error = null
    this.exitCode = null
    this.endedAt = null
    this.command = command
    this.args = forwardArgs
    this.startedAt = new Date().toISOString()
    this.status = 'running'
    this.emitStatus()

    this.appendLog(`→ node ${argv.map(shellQuote).join(' ')}`)
    this.appendLog(`  cwd: ${this.repoRoot}`)

    const child = spawn(process.execPath, argv, {
      cwd: this.repoRoot,
      env: { ...process.env, FORCE_COLOR: '0' },
      windowsHide: true,
    })
    this.child = child

    const onChunk = (buf: Buffer) => {
      const text = buf.toString('utf8')
      for (const line of text.split(/\r?\n/)) {
        if (line.length) this.appendLog(line)
      }
    }
    child.stdout.on('data', onChunk)
    child.stderr.on('data', onChunk)

    child.on('error', (err) => {
      this.error = err.message
      this.appendLog(`spawn error: ${err.message}`)
    })

    child.on('close', (code, signal) => {
      this.child = null
      this.endedAt = new Date().toISOString()
      this.exitCode = code
      if (this.status === 'cancelled') {
        this.appendLog(`cancelled (signal ${signal ?? 'n/a'}, code ${code})`)
      } else if (code === 0) {
        this.status = 'succeeded'
        this.appendLog(`exited 0`)
      } else {
        this.status = 'failed'
        this.error = this.error ?? `exited ${code}${signal ? ` (${signal})` : ''}`
        this.appendLog(`exited ${code}${signal ? ` signal=${signal}` : ''}`)
      }
      this.emitStatus()
    })

    return this.snapshot()
  }

  cancel(): BenchJobSnapshot {
    if (this.status !== 'running' || !this.child) {
      throw Object.assign(new Error('no running bench job'), { statusCode: 409 })
    }
    this.status = 'cancelled'
    this.appendLog('cancelling…')
    this.emitStatus()
    try {
      this.child.kill()
    } catch (err) {
      this.appendLog(`kill failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    // Windows often needs a harder stop if the tree ignores the first signal.
    const child = this.child
    setTimeout(() => {
      if (child.exitCode === null && !child.killed) {
        try {
          child.kill('SIGKILL')
        } catch {
          /* ignore */
        }
      }
    }, 4_000)
    return this.snapshot()
  }

  private appendLog(line: string): void {
    const stamped = line
    this.logs.push(stamped)
    if (this.logs.length > MAX_LOG_LINES) {
      this.logs.splice(0, this.logs.length - MAX_LOG_LINES)
    }
    for (const listener of this.logListeners) listener(stamped)
  }

  private emitStatus(): void {
    const snap = this.snapshot()
    for (const listener of this.statusListeners) listener(snap)
  }
}

function shellQuote(s: string): string {
  if (/^[\w./:@+-]+$/.test(s)) return s
  return JSON.stringify(s)
}

const globalKey = '__civBenchRunner'
const g = globalThis as typeof globalThis & { [globalKey]?: BenchRunner }

export function getBenchRunner(): BenchRunner {
  if (!g[globalKey]) g[globalKey] = new BenchRunner()
  return g[globalKey]
}
