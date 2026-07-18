import { describe, expect, it } from 'vitest'
import type { Bot } from 'mineflayer'
import { PovViewers } from '../src/bots/povViewer.ts'
import type { Config } from '../src/config.ts'

// Only the fields PovViewers reads — the flag, the pool, the ports.
const cfg = (over: Partial<Config> = {}): Config =>
  ({ POV_VIEWER: 0, POV_PORT_BASE: 3100, POV_VIEWER_COUNT: 6, POV_VIEW_DISTANCE: 4, ...over }) as Config

const fakeBot = (): Bot => {
  let closed = 0
  const bot = { viewer: { close: () => void closed++ } } as unknown as Bot
  return Object.assign(bot, { closedCount: () => closed })
}

describe('PovViewers (the RB-3 film rig)', () => {
  it('is inert with the flag off — no import, no ports, no state', async () => {
    const rig = new PovViewers(cfg())
    await rig.start('v1', 'Elara', fakeBot())
    expect(rig.activePorts()).toEqual([])
    // stop() on a never-started villager is a safe no-op
    rig.stop('v1')
    expect(rig.activePorts()).toEqual([])
  })

  it('frees the pool index on stop and closes the viewer socket', () => {
    // Exercise the pool bookkeeping without the flag (start would import the
    // real heavy dep) — stop() is the seam: seed state via the private map.
    const rig = new PovViewers(cfg({ POV_VIEWER: 1 } as Partial<Config>))
    const bot = fakeBot()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(rig as any).byVillager.set('v1', { index: 0, bot })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(rig as any).free = [1, 2, 3, 4, 5]
    expect(rig.activePorts()).toEqual([3100])
    rig.stop('v1')
    expect(rig.activePorts()).toEqual([])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((rig as any).free).toContain(0)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((bot as any).closedCount()).toBe(1)
  })

  it('double-start for one villager holds one slot', async () => {
    const rig = new PovViewers(cfg({ POV_VIEWER: 1 } as Partial<Config>))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(rig as any).byVillager.set('v1', { index: 0, bot: fakeBot() })
    await rig.start('v1', 'Elara', fakeBot()) // already tracked -> early return, no import
    expect(rig.activePorts()).toEqual([3100])
  })
})
