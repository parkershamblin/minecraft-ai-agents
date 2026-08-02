import { NextResponse } from 'next/server'

import { BENCH_COMMANDS, getCommand, type BenchCommandId } from '@/lib/bench/catalog'
import { getBenchRunner } from '@/lib/bench/runner'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const runner = getBenchRunner()
  return NextResponse.json({
    catalog: BENCH_COMMANDS,
    job: runner.snapshot(),
  })
}

export async function POST(request: Request) {
  let body: { command?: string; options?: Record<string, unknown> }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }

  const command = body.command
  if (!command || !getCommand(command)) {
    return NextResponse.json(
      { error: `unknown command; choose one of: ${BENCH_COMMANDS.map((c) => c.id).join(', ')}` },
      { status: 400 },
    )
  }

  const runner = getBenchRunner()
  try {
    const job = runner.start(command as BenchCommandId, body.options ?? {})
    return NextResponse.json({ job }, { status: 202 })
  } catch (err) {
    const statusCode = (err as { statusCode?: number }).statusCode ?? 400
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: statusCode })
  }
}

export async function DELETE() {
  const runner = getBenchRunner()
  try {
    const job = runner.cancel()
    return NextResponse.json({ job })
  } catch (err) {
    const statusCode = (err as { statusCode?: number }).statusCode ?? 400
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: statusCode })
  }
}
