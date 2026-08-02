/** Client-safe job snapshot shape (kept separate so UI never imports node:child_process). */
export type BenchJobStatus = 'idle' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export type BenchJobSnapshot = {
  status: BenchJobStatus
  command: string | null
  args: string[]
  startedAt: string | null
  endedAt: string | null
  exitCode: number | null
  pid: number | null
  logLines: number
  recentLogs: string[]
  error: string | null
  repoRoot: string | null
}
