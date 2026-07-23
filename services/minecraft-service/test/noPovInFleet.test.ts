import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The structural half of the POV safety guarantee, as CI instead of a
 * review promise: the FLEET process (src/** minus src/pov/**) must never
 * import prismarine-viewer or anything under src/pov/. A viewer failure
 * mode simply cannot exist in the process that owns the six BotSessions.
 * (docs/demo-rb.md tells the story; the pov-rig compose service is the
 * only consumer of src/pov/.)
 */
const SRC_ROOT = fileURLToPath(new URL('../src', import.meta.url))

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    return statSync(full).isDirectory() ? walk(full) : [full]
  })

describe('fleet process viewer isolation', () => {
  const fleetFiles = walk(SRC_ROOT).filter(
    (f) => f.endsWith('.ts') && !relative(SRC_ROOT, f).split(sep).includes('pov'),
  )

  it('sees a plausible fleet source tree', () => {
    expect(fleetFiles.length).toBeGreaterThan(10)
  })

  it('no fleet source file references prismarine-viewer', () => {
    const offenders = fleetFiles.filter((f) => readFileSync(f, 'utf8').includes('prismarine-viewer'))
    expect(offenders.map((f) => relative(SRC_ROOT, f))).toEqual([])
  })

  it('no fleet source file imports from src/pov/', () => {
    const offenders = fleetFiles.filter((f) => /from\s+['"][^'"]*\/pov\//.test(readFileSync(f, 'utf8')))
    expect(offenders.map((f) => relative(SRC_ROOT, f))).toEqual([])
  })
})
