// capture.cjs — attach to the local node inspector (opened via SIGUSR1),
// sample the CPU for N seconds, write a .cpuprofile. Runs INSIDE the
// container (node 22: global fetch + WebSocket) — no restart, the fleet
// stays up. Full flow against the live minecraft-service:
//
//   CTR=ai-civilization-engine-minecraft-service-1
//   docker cp scripts/profile/capture.cjs $CTR:/tmp/capture.cjs
//   docker cp scripts/profile/analyze.cjs $CTR:/tmp/analyze.cjs
//   # find the real node PID (PID 1 is npm; look for the tsx loader):
//   docker exec $CTR sh -c 'for p in /proc/[0-9]*; do c=$(tr "\0" " " < $p/cmdline 2>/dev/null); case "$c" in /usr/local/bin/node*) echo ${p#/proc/};; esac; done'
//   docker exec $CTR sh -c 'kill -USR1 <pid>'    # opens the inspector on :9229
//   docker exec $CTR node /tmp/capture.cjs 75 /tmp/mc.cpuprofile
//   docker exec $CTR node /tmp/analyze.cjs /tmp/mc.cpuprofile
//
// Pass "detach" as the 4th arg on the LAST capture to close the inspector.
// The .cpuprofile also loads in Chrome DevTools / speedscope.
//
// Usage: node capture.cjs <seconds> <outfile> [intervalUs] [detach]
const fs = require('fs')

const secs = Number(process.argv[2] || 60)
const out = process.argv[3] || '/tmp/mc.cpuprofile'
const interval = Number(process.argv[4] || 500)
const detach = process.argv[5] === 'detach'

async function main() {
  const res = await fetch('http://127.0.0.1:9229/json/list')
  const targets = await res.json()
  const target = targets.find((t) => t.webSocketDebuggerUrl)
  if (!target) throw new Error('no inspector target found')
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  let nextId = 0
  const pending = new Map()
  const call = (method, params = {}, timeoutMs = 0) =>
    new Promise((resolve, reject) => {
      const id = ++nextId
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
      if (timeoutMs) setTimeout(() => { if (pending.delete(id)) resolve(null) }, timeoutMs)
    })
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString())
    const p = msg.id && pending.get(msg.id)
    if (p) {
      pending.delete(msg.id)
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result)
    }
  })
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve)
    ws.addEventListener('error', () => reject(new Error('ws connect failed')))
  })
  await call('Profiler.enable')
  await call('Profiler.setSamplingInterval', { interval })
  await call('Profiler.start')
  console.log(`sampling ${secs}s at ${interval}us...`)
  await new Promise((r) => setTimeout(r, secs * 1000))
  const result = await call('Profiler.stop')
  fs.writeFileSync(out, JSON.stringify(result.profile))
  console.log(`wrote ${out} (${result.profile.samples.length} samples)`)
  if (detach) await call('Runtime.evaluate', { expression: 'process._debugEnd()' }, 2000)
  ws.close()
  process.exit(0)
}

main().catch((err) => {
  console.error('capture failed:', err.message)
  process.exit(1)
})
