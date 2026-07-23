import { describe, expect, it, vi } from 'vitest'
import { createRconGate } from '../src/pov/rconGate.ts'
import type { RconClient } from '../src/rcon/rcon.ts'

const fakeClient = (send: (cmd: string) => Promise<string>) => {
  let closed = 0
  return {
    client: { send, close: () => void closed++ } as unknown as RconClient,
    closedCount: () => closed,
  }
}

const gateWith = (sends: Array<(cmd: string) => Promise<string>>) => {
  let i = 0
  const clients: ReturnType<typeof fakeClient>[] = []
  const connect = vi.fn(async () => {
    const send = sends[Math.min(i, sends.length - 1)]!
    const fc = fakeClient(send)
    clients.push(fc)
    i++
    return fc.client
  })
  const gate = createRconGate({ host: 'minecraft', port: 25575, password: 'pw', connect })
  return { gate, connect, clients }
}

describe('createRconGate', () => {
  it('ensureSpectator sends gamemode BEFORE the verify read and accepts playerGameType 3', async () => {
    const sent: string[] = []
    const { gate } = gateWith([
      async (cmd) => {
        sent.push(cmd)
        return cmd.startsWith('data get') ? 'Pov_cam_1 has the following entity data: 3' : ''
      },
    ])
    await expect(gate.ensureSpectator('pov_cam_1')).resolves.toBe(true)
    expect(sent[0]).toBe('gamemode spectator pov_cam_1')
    expect(sent[1]).toBe('data get entity pov_cam_1 playerGameType')
  })

  it('rejects a cam stuck in survival (entity data: 0) after retries', async () => {
    const { gate } = gateWith([
      async (cmd) => (cmd.startsWith('data get') ? 'Pov_cam_1 has the following entity data: 0' : ''),
    ])
    await expect(gate.ensureSpectator('pov_cam_1')).resolves.toBe(false)
  })

  it('does not confuse gamemode 3 with 30-something replies', async () => {
    const { gate } = gateWith([
      async (cmd) => (cmd.startsWith('data get') ? 'Pov_cam_1 has the following entity data: 30' : ''),
    ])
    await expect(gate.ensureSpectator('pov_cam_1')).resolves.toBe(false)
  })

  it('drops the client on a send failure and reconnects on the next call', async () => {
    const { gate, connect, clients } = gateWith([
      async () => {
        throw new Error('rcon connection closed')
      },
      async () => 'ok',
    ])
    await expect(gate.exec('list')).rejects.toThrow('rcon connection closed')
    expect(clients[0]!.closedCount()).toBe(1)
    await expect(gate.exec('list')).resolves.toBe('ok')
    expect(connect).toHaveBeenCalledTimes(2)
  })

  it('serializes concurrent calls (the underlying client is single-flight)', async () => {
    const order: string[] = []
    const { gate } = gateWith([
      async (cmd) => {
        order.push(`start:${cmd}`)
        await new Promise((r) => setTimeout(r, 5))
        order.push(`end:${cmd}`)
        return ''
      },
    ])
    await Promise.all([gate.exec('a'), gate.exec('b')])
    expect(order).toEqual(['start:a', 'end:a', 'start:b', 'end:b'])
  })
})
