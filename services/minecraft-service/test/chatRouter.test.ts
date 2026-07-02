import { describe, expect, it, vi } from 'vitest'
import { ChatRouter, type ChatObservation, type ChatSession } from '../src/world/chatRouter.ts'

const ELARA = { villagerId: 'e1a2a', username: 'Elara', position: { x: 0, y: 64, z: 0 } }
const BRAM = { villagerId: 'b2a44', username: 'Bram', position: { x: 5, y: 64, z: 0 } }
const FARAWAY = { villagerId: 'fa4', username: 'Wren', position: { x: 500, y: 64, z: 0 } }

function router(sessions: ChatSession[], emit: (o: ChatObservation) => void, now = () => 1_000) {
  return new ChatRouter({
    rosterByUsername: (u) => sessions.find((s) => s.username === u)?.villagerId,
    activeSessions: () => sessions,
    earshotBlocks: 16,
    emit,
    now,
  })
}

describe('ChatRouter', () => {
  it('self-filter: a bot never observes its own utterance', () => {
    const emit = vi.fn()
    router([ELARA, BRAM], emit).onChat(ELARA, 'Elara', 'hello me', ELARA.position)
    expect(emit).not.toHaveBeenCalled()
  })

  it('emits exactly once when many sessions hear the same line', () => {
    const emit = vi.fn()
    const r = router([ELARA, BRAM, FARAWAY], emit)
    // three bots all report Elara's line; Elara's own report is self-filtered
    r.onChat(ELARA, 'Elara', 'good morning', ELARA.position)
    r.onChat(BRAM, 'Elara', 'good morning', ELARA.position)
    r.onChat(FARAWAY, 'Elara', 'good morning', ELARA.position)
    expect(emit).toHaveBeenCalledTimes(1)
  })

  it('resolves the speaker via the roster and earshot excludes the speaker and the distant', () => {
    const emit = vi.fn()
    router([ELARA, BRAM, FARAWAY], emit).onChat(BRAM, 'Elara', 'the oak is ready', ELARA.position)

    const obs: ChatObservation = emit.mock.calls[0]![0]
    expect(obs.speakerVillagerId).toBe('e1a2a')
    expect(obs.speakerUsername).toBe('Elara')
    expect(obs.heardByIds).toEqual(['b2a44']) // Bram in earshot; Wren 500 blocks away; Elara excluded
    expect(obs.position).toEqual(ELARA.position)
  })

  it('a human player speaking yields villagerId null but keeps the username', () => {
    const emit = vi.fn()
    router([ELARA, BRAM], emit).onChat(ELARA, 'ParkerTheCreator', 'behave, you two', { x: 2, y: 64, z: 0 })

    const obs: ChatObservation = emit.mock.calls[0]![0]
    expect(obs.speakerVillagerId).toBeNull()
    expect(obs.speakerUsername).toBe('ParkerTheCreator')
    expect(obs.heardByIds).toContain('e1a2a')
    expect(obs.heardByIds).toContain('b2a44')
  })

  it('the same text later is a new observation (dedupe window expires)', () => {
    const emit = vi.fn()
    let clock = 1_000
    const r = router([ELARA, BRAM], emit, () => clock)
    r.onChat(BRAM, 'Elara', 'hello', ELARA.position)
    clock += 10_000
    r.onChat(BRAM, 'Elara', 'hello', ELARA.position)
    expect(emit).toHaveBeenCalledTimes(2)
  })
})
