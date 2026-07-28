// OBS websocket 5.x recorder for the skill demo gate.
// Usage:
//   node scripts/obs-record.mjs start            — ensure scene+display capture, StartRecord
//   node scripts/obs-record.mjs stop --out <p>   — StopRecord, move the file to <p>, print it
// Creds from .env (OBS_WEBSOCKET_URL, OBS_WEBSOCKET_PASSWORD). Never drives the GUI.
import { createHash } from 'node:crypto'
import { readFileSync, renameSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
const pass = env.match(/^OBS_WEBSOCKET_PASSWORD=(.+)$/m)?.[1]?.trim()
const url = env.match(/^OBS_WEBSOCKET_URL=(.+)$/m)?.[1]?.trim() ?? 'ws://localhost:4455'
if (!pass) throw new Error('OBS_WEBSOCKET_PASSWORD missing from .env')

const SCENE = 'skill-demos'
const INPUT = 'display'

function connect() {
  return new Promise((resolveWs, reject) => {
    const ws = new WebSocket(url)
    const pending = new Map()
    let seq = 0
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.op === 0) {
        const { challenge, salt } = msg.d.authentication ?? {}
        const b64sha = (s) => createHash('sha256').update(s).digest('base64')
        const auth = challenge ? b64sha(b64sha(pass + salt) + challenge) : undefined
        ws.send(JSON.stringify({ op: 1, d: { rpcVersion: 1, authentication: auth } }))
      } else if (msg.op === 2) {
        resolveWs({
          request: (requestType, requestData = {}) =>
            new Promise((res, rej) => {
              const requestId = `r${++seq}`
              pending.set(requestId, { res, rej, requestType })
              ws.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }))
            }),
          close: () => ws.close(),
        })
      } else if (msg.op === 7) {
        const p = pending.get(msg.d.requestId)
        if (!p) return
        pending.delete(msg.d.requestId)
        if (msg.d.requestStatus.result) p.res(msg.d.responseData ?? {})
        else p.rej(new Error(`${p.requestType}: ${msg.d.requestStatus.comment ?? msg.d.requestStatus.code}`))
      }
    }
    ws.onerror = () => reject(new Error('OBS websocket connection failed'))
    setTimeout(() => reject(new Error('OBS websocket timeout')), 8000)
  })
}

async function ensureScene(obs) {
  const { scenes } = await obs.request('GetSceneList')
  if (!scenes.some((s) => s.sceneName === SCENE)) await obs.request('CreateScene', { sceneName: SCENE })
  const inputs = await obs.request('GetSceneItemList', { sceneName: SCENE })
  if (!inputs.sceneItems.some((i) => i.sourceName === INPUT)) {
    await obs.request('CreateInput', {
      sceneName: SCENE,
      inputName: INPUT,
      inputKind: 'monitor_capture',
      inputSettings: { monitor_id: 0, method: 2 }, // method 2 = DXGI (Windows 10+)
    })
  }
  await obs.request('SetCurrentProgramScene', { sceneName: SCENE })
}

const mode = process.argv[2]
const outIdx = process.argv.indexOf('--out')
const outPath = outIdx > -1 ? resolve(process.argv[outIdx + 1]) : null

const obs = await connect()
try {
  if (mode === 'start') {
    await ensureScene(obs)
    const status = await obs.request('GetRecordStatus')
    if (status.outputActive) throw new Error('already recording — stop first')
    await obs.request('StartRecord')
    console.log('RECORDING')
  } else if (mode === 'stop') {
    const { outputPath } = await obs.request('StopRecord')
    // OBS finalizes the container asynchronously; give the mux a moment.
    await new Promise((r) => setTimeout(r, 2000))
    if (outPath) {
      mkdirSync(dirname(outPath), { recursive: true })
      if (!existsSync(outputPath)) throw new Error(`OBS reported ${outputPath} but it does not exist`)
      renameSync(outputPath, outPath)
      console.log(outPath)
    } else {
      console.log(outputPath)
    }
  } else {
    throw new Error('usage: obs-record.mjs start | stop [--out <path>]')
  }
} finally {
  obs.close()
}
