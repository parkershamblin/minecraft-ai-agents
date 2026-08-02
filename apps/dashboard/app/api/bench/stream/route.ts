import { getBenchRunner } from '@/lib/bench/runner'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** SSE: replay buffered logs, then stream new lines + status changes. */
export async function GET() {
  const runner = getBenchRunner()
  const encoder = new TextEncoder()

  let cleanup: (() => void) | undefined

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
      }

      // Logs first so the client can paint the buffer, then status.
      runner.forEachLog((line) => send('log', { line }))
      send('status', runner.snapshot())

      const offLog = runner.onLog((line) => send('log', { line }))
      const offStatus = runner.onStatus((snap) => send('status', snap))

      const heartbeat = setInterval(() => {
        controller.enqueue(encoder.encode(`: ping\n\n`))
      }, 15_000)

      cleanup = () => {
        clearInterval(heartbeat)
        offLog()
        offStatus()
      }
    },
    cancel() {
      cleanup?.()
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  })
}
