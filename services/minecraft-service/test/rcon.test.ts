import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  RconClient,
  SERVERDATA_AUTH,
  SERVERDATA_AUTH_RESPONSE,
  SERVERDATA_RESPONSE_VALUE,
  decodePackets,
  encodePacket,
} from '../src/rcon/rcon.ts'

describe('rcon framing', () => {
  it('round-trips a packet', () => {
    const encoded = encodePacket(7, SERVERDATA_AUTH, 'civ_rcon')
    const { packets, rest } = decodePackets(encoded)
    expect(packets).toEqual([{ id: 7, type: SERVERDATA_AUTH, body: 'civ_rcon' }])
    expect(rest.length).toBe(0)
  })

  it('drains multiple packets from one buffer and keeps a partial tail', () => {
    const a = encodePacket(1, SERVERDATA_RESPONSE_VALUE, 'first')
    const b = encodePacket(2, SERVERDATA_RESPONSE_VALUE, 'second')
    const combined = Buffer.concat([a, b.subarray(0, 6)])
    const { packets, rest } = decodePackets(combined)
    expect(packets.map((p) => p.body)).toEqual(['first'])
    expect(rest.equals(b.subarray(0, 6))).toBe(true)
  })

  it('throws on a malformed frame length', () => {
    const bogus = Buffer.alloc(8)
    bogus.writeInt32LE(2, 0)
    expect(() => decodePackets(bogus)).toThrow(/malformed/)
  })
})

type FakeServer = { port: number; close: () => Promise<void> }

/** In-process RCON server: auths against `password`, echoes commands. */
function startFakeRcon(password: string, opts: { chunked?: boolean } = {}): Promise<FakeServer> {
  return new Promise((resolve) => {
    const sockets = new Set<net.Socket>()
    const server = net.createServer((socket) => {
      sockets.add(socket)
      let buffer = Buffer.alloc(0)
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk])
        const { packets, rest } = decodePackets(buffer)
        buffer = rest
        for (const packet of packets) {
          if (packet.type === SERVERDATA_AUTH) {
            const id = packet.body === password ? packet.id : -1
            socket.write(encodePacket(id, SERVERDATA_AUTH_RESPONSE, ''))
            continue
          }
          const response = encodePacket(packet.id, SERVERDATA_RESPONSE_VALUE, `echo:${packet.body}`)
          if (opts.chunked) {
            socket.write(response.subarray(0, 5))
            setTimeout(() => socket.write(response.subarray(5)), 5)
          } else {
            socket.write(response)
          }
        }
      })
      socket.on('error', () => undefined)
    })
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        close: () =>
          new Promise((done) => {
            for (const socket of sockets) {
              socket.destroy()
            }
            server.close(() => done())
          }),
      })
    })
  })
}

describe('RconClient', () => {
  let server: FakeServer | null = null
  let client: RconClient | null = null

  afterEach(async () => {
    client?.close()
    client = null
    await server?.close()
    server = null
  })

  it('authenticates and round-trips sequential commands', async () => {
    server = await startFakeRcon('civ_rcon')
    client = await RconClient.connect('127.0.0.1', server.port, 'civ_rcon', 2_000)
    expect(await client.send('list')).toBe('echo:list')
    expect(await client.send('data get entity P Inventory[0].id')).toBe('echo:data get entity P Inventory[0].id')
  })

  it('reassembles a response that arrives in TCP fragments', async () => {
    server = await startFakeRcon('civ_rcon', { chunked: true })
    client = await RconClient.connect('127.0.0.1', server.port, 'civ_rcon', 2_000)
    expect(await client.send('mspt')).toBe('echo:mspt')
  })

  it('rejects on wrong password', async () => {
    server = await startFakeRcon('civ_rcon')
    await expect(RconClient.connect('127.0.0.1', server.port, 'wrong', 2_000)).rejects.toThrow(/auth failed/)
  })

  it('destroys the socket when the auth response never arrives (no FD leak)', async () => {
    let resolveClose!: () => void
    const serverSawClose = new Promise<void>((resolve) => {
      resolveClose = resolve
    })
    const silent = net.createServer((socket) => {
      // Keep reading (and never answer): the client's FIN only surfaces to a
      // server that drains the stream — unread bytes would mask the close.
      socket.on('data', () => undefined)
      socket.on('error', () => undefined)
      socket.on('close', resolveClose)
    })
    const port = await new Promise<number>((resolve) =>
      silent.listen(0, '127.0.0.1', () => resolve((silent.address() as AddressInfo).port)),
    )
    await expect(RconClient.connect('127.0.0.1', port, 'civ_rcon', 200)).rejects.toThrow(/timeout/)
    await serverSawClose // only fires if the client tore its socket down
    await new Promise<void>((resolve) => silent.close(() => resolve()))
  })

  it('rejects pending sends when the connection drops', async () => {
    server = await startFakeRcon('civ_rcon')
    client = await RconClient.connect('127.0.0.1', server.port, 'civ_rcon', 2_000)
    const closing = server.close()
    await expect(client.send('list')).rejects.toThrow()
    await closing
  })
})
