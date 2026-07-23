import { afterEach, describe, expect, it, vi } from 'vitest'
import { installPovGuards } from '../src/pov/guards.ts'

// Vitest installs its own uncaughtException machinery — drive the handlers
// directly via emit and clean them up after each test.
const cleanup: Array<() => void> = []

const install = (over: Partial<Parameters<typeof installPovGuards>[0]> = {}) => {
  const before = {
    ex: process.listeners('uncaughtException'),
    rej: process.listeners('unhandledRejection'),
  }
  const onFatal = vi.fn()
  let clock = 0
  const guards = installPovGuards({
    windowMs: 60_000,
    maxErrors: 6,
    onFatal,
    now: () => clock,
    ...over,
  })
  const added = {
    ex: process.listeners('uncaughtException').filter((l) => !before.ex.includes(l)),
    rej: process.listeners('unhandledRejection').filter((l) => !before.rej.includes(l)),
  }
  cleanup.push(() => {
    for (const l of added.ex) process.removeListener('uncaughtException', l)
    for (const l of added.rej) process.removeListener('unhandledRejection', l)
  })
  const fire = (err: unknown): void => {
    for (const l of added.ex) (l as (e: unknown, o: unknown) => void)(err, 'uncaughtException')
  }
  return { guards, onFatal, fire, setClock: (t: number) => (clock = t) }
}

afterEach(() => {
  while (cleanup.length) cleanup.pop()!()
})

describe('installPovGuards', () => {
  it('swallows a single viewer throw — rig keeps serving', () => {
    const { guards, onFatal, fire } = install()
    fire(new Error('world_particles handler blew up'))
    expect(onFatal).not.toHaveBeenCalled()
    expect(guards.errorCount()).toBe(1)
  })

  it('an error storm inside the window goes fatal for a supervised restart', () => {
    const { onFatal, fire, setClock } = install()
    for (let i = 0; i < 6; i++) {
      setClock(i * 1_000)
      fire(new Error(`throw ${i}`))
    }
    expect(onFatal).toHaveBeenCalledTimes(1)
  })

  it('errors outside the sliding window do not accumulate', () => {
    const { guards, onFatal, fire, setClock } = install()
    for (let i = 0; i < 5; i++) {
      setClock(i * 1_000)
      fire(new Error(`early ${i}`))
    }
    setClock(120_000) // window slides past all five
    fire(new Error('late one'))
    expect(onFatal).not.toHaveBeenCalled()
    expect(guards.errorCount()).toBe(1)
  })
})
