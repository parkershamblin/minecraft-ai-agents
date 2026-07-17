// analyze.cjs — aggregate a V8 .cpuprofile: self time by category/frame,
// inclusive time per frame, dominant caller chains for the hot frames.
// Usage: node analyze.cjs <file.cpuprofile> [topN]
const fs = require('fs')

const prof = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const TOP = Number(process.argv[3] || 40)

const nodesById = new Map()
for (const n of prof.nodes) nodesById.set(n.id, n)
const parentOf = new Map()
for (const n of prof.nodes) for (const c of n.children || []) parentOf.set(c, n.id)

const selfByNode = new Map()
let totalUs = 0
for (let i = 0; i < prof.samples.length; i++) {
  const d = prof.timeDeltas[i] || 0
  totalUs += d
  const id = prof.samples[i]
  selfByNode.set(id, (selfByNode.get(id) || 0) + d)
}

function frameUrl(u) {
  if (!u) return ''
  const s = u.replace(/^file:\/\//, '').replace(/\\/g, '/')
  const nm = s.lastIndexOf('node_modules/')
  if (nm >= 0) return s.slice(nm + 'node_modules/'.length)
  const app = s.indexOf('/app/')
  if (app >= 0) return s.slice(app + 5)
  return s
}
function frameKey(n) {
  const f = n.callFrame
  const fn = f.functionName || '(anonymous)'
  const u = frameUrl(f.url)
  return u ? `${fn}  [${u}:${f.lineNumber + 1}]` : fn
}
function category(n) {
  const f = n.callFrame
  if (f.functionName === '(garbage collector)') return 'GC'
  if (f.functionName === '(program)') return '(program)'
  if (f.functionName === '(idle)') return '(idle)'
  const u = f.url || ''
  if (u.startsWith('node:')) return 'node-internal'
  if (u.includes('node_modules')) {
    const url = frameUrl(u)
    const m = url.match(/^(@[^/]+\/[^/]+|[^/]+)/)
    return m ? `dep:${m[1]}` : 'dep'
  }
  const url = frameUrl(u)
  if (url.includes('/src/') || url.startsWith('src/')) return 'app(src)'
  return url ? `other:${url.slice(0, 40)}` : '(native/unattributed)'
}

const selfByKey = new Map()
const selfByCat = new Map()
const nodesByKey = new Map()
for (const [id, us] of selfByNode) {
  const n = nodesById.get(id)
  if (!n) continue
  const k = frameKey(n)
  const c = category(n)
  selfByKey.set(k, (selfByKey.get(k) || 0) + us)
  selfByCat.set(c, (selfByCat.get(c) || 0) + us)
  if (!nodesByKey.has(k)) nodesByKey.set(k, [])
  nodesByKey.get(k).push([id, us])
}

const chainCache = new Map()
function chainKeys(id) {
  if (chainCache.has(id)) return chainCache.get(id)
  const keys = new Set()
  let cur = id
  while (cur !== undefined) {
    const n = nodesById.get(cur)
    if (n) keys.add(frameKey(n))
    cur = parentOf.get(cur)
  }
  chainCache.set(id, keys)
  return keys
}
const inclByKey = new Map()
for (const [id, us] of selfByNode) {
  for (const k of chainKeys(id)) inclByKey.set(k, (inclByKey.get(k) || 0) + us)
}

const pct = (us) => ((100 * us) / totalUs).toFixed(2).padStart(6) + '%'
const ms = (us) => (us / 1000).toFixed(0).padStart(7) + 'ms'
console.log(`total sampled: ${(totalUs / 1e6).toFixed(1)}s   samples: ${prof.samples.length}`)
console.log('\n=== SELF time by category ===')
for (const [c, us] of [...selfByCat.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25))
  console.log(`${pct(us)} ${ms(us)}  ${c}`)
console.log(`\n=== TOP ${TOP} frames by SELF ===`)
for (const [k, us] of [...selfByKey.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP))
  console.log(`${pct(us)} ${ms(us)}  ${k}`)
console.log(`\n=== TOP ${TOP} frames by INCLUSIVE ===`)
for (const [k, us] of [...inclByKey.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP))
  console.log(`${pct(us)} ${ms(us)}  ${k}`)
console.log('\n=== Dominant caller chains (top self frames) ===')
for (const [k] of [...selfByKey.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14)) {
  console.log(`\n-- ${k}`)
  const contributors = nodesByKey.get(k).sort((a, b) => b[1] - a[1]).slice(0, 2)
  for (const [id, us] of contributors) {
    const chain = []
    let cur = parentOf.get(id)
    while (cur !== undefined && chain.length < 9) {
      const n = nodesById.get(cur)
      if (n) chain.push(frameKey(n))
      cur = parentOf.get(cur)
    }
    console.log(`   ${pct(us)}  <- ${chain.join('  <- ')}`)
  }
}
