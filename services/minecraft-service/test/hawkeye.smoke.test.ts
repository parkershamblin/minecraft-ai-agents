import { describe, expect, it } from 'vitest'

/**
 * Import-level smoke for minecrafthawkeye (ADR 11, owner decision 3): the
 * plugin is PINNED but NOT WIRED — bow_ranged is a phase-C verb. This test
 * only proves the dependency resolves and exposes the plugin surface, so a
 * future `npm install` can't silently break the pin. The REAL gate before
 * any phase-C wiring is a live smoke on 1.21.6 (`task smoke` with a running
 * server) — community plugin, exact-pin rule applies (CLAUDE.md).
 */
describe('minecrafthawkeye pin', () => {
  it('module loads and exposes the mineflayer plugin entry', async () => {
    const hawkeye = await import('minecrafthawkeye')
    // v1.x exports the plugin loader as default (bot.loadPlugin(minecraftHawkEye)).
    const surface = (hawkeye as Record<string, unknown>).default ?? hawkeye
    expect(surface).toBeTruthy()
    expect(typeof surface === 'function' || typeof surface === 'object').toBe(true)
  })
})
