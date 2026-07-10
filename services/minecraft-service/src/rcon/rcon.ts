import net from 'node:net'

/**
 * Minimal Source-RCON client (the ~80 lines we need, hand-rolled so the only
 * pinned boundary stays mineflayer). Single-flight by design: the inventory
 * poller is the sole caller and issues commands sequentially, and Minecraft's
 * RCON answers in order. Responses here are per-slot `data get` lines — far
 * below the 4096-byte multi-packet threshold, so one response packet per
 * command is a protocol-safe assumption for OUR commands (not in general).
 */

export const SERVERDATA_RESPONSE_VALUE = 0
export const SERVERDATA_AUTH_RESPONSE = 2 // same wire value as EXECCOMMAND — direction disambiguates
export const SERVERDATA_EXECCOMMAND = 2
export const SERVERDATA_AUTH = 3

export interface RconPacket {
  id: number
  type: number
  body: string
}

/** length-prefixed frame: int32le len, int32le id, int32le type, body, 2×NUL */
export function encodePacket(id: number, type: number, body: string): Buffer {
  const bodyBuf = Buffer.from(body, 'utf8')
  const packet = Buffer.alloc(14 + bodyBuf.length)
  packet.writeInt32LE(10 + bodyBuf.length, 0)
  packet.writeInt32LE(id, 4)
  packet.writeInt32LE(type, 8)
  bodyBuf.copy(packet, 12)
  return packet
}

/** Drains complete frames from a stream buffer; `rest` is the partial tail. */
export function decodePackets(buffer: Buffer): { packets: RconPacket[]; rest: Buffer } {
  const packets: RconPacket[] = []
  let offset = 0
  while (buffer.length - offset >= 4) {
    const length = buffer.readInt32LE(offset)
    if (length < 10) {
      throw new Error(`malformed rcon frame (length ${length})`)
    }
    if (buffer.length - offset < 4 + length) {
      break
    }
    packets.push({
      id: buffer.readInt32LE(offset + 4),
      type: buffer.readInt32LE(offset + 8),
      body: buffer.toString('utf8', offset + 12, offset + 4 + length - 2),
    })
    offset += 4 + length
  }
  return { packets, rest: buffer.subarray(offset) }
}

interface Waiter {
  matches: (packet: RconPacket) => boolean
  resolve: (packet: RconPacket) => void
  reject: (err: Error) => void
}

export class RconClient {
  private buffer = Buffer.alloc(0)
  private nextId = 1
  private waiter: Waiter | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private closed = false

  private constructor(
    private readonly socket: net.Socket,
    private readonly timeoutMs: number,
  ) {}

  static async connect(host: string, port: number, password: string, timeoutMs = 3_000): Promise<RconClient> {
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const candidate = net.connect({ host, port })
      const timer = setTimeout(() => {
        candidate.destroy()
        reject(new Error(`rcon connect timeout (${host}:${port})`))
      }, timeoutMs)
      candidate.once('connect', () => {
        clearTimeout(timer)
        resolve(candidate)
      })
      candidate.once('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })
    const client = new RconClient(socket, timeoutMs)
    socket.on('data', (chunk) => client.onData(chunk))
    socket.on('error', (err) => client.fail(err))
    socket.on('close', () => client.fail(new Error('rcon connection closed')))
    const authId = client.nextId++
    const response = client.awaitPacket((packet) => packet.type === SERVERDATA_AUTH_RESPONSE)
    socket.write(encodePacket(authId, SERVERDATA_AUTH, password))
    let auth: RconPacket
    try {
      auth = await response
    } catch (err) {
      // e.g. TCP accepted but the server never answers (GC stall, wedge):
      // without teardown here the poller would leak one socket per cycle.
      client.close()
      throw err
    }
    if (auth.id === -1) {
      client.close()
      throw new Error('rcon auth failed (wrong password?)')
    }
    return client
  }

  /** Sequential by contract: each command waits for the previous response. */
  send(command: string): Promise<string> {
    const run = this.queue.then(async () => {
      if (this.closed) {
        throw new Error('rcon client is closed')
      }
      const id = this.nextId++
      const response = this.awaitPacket((packet) => packet.id === id && packet.type === SERVERDATA_RESPONSE_VALUE)
      this.socket.write(encodePacket(id, SERVERDATA_EXECCOMMAND, command))
      return (await response).body
    })
    this.queue = run.catch(() => undefined) // keep the chain alive past failures
    return run
  }

  close(): void {
    this.closed = true
    this.socket.destroy()
  }

  private awaitPacket(matches: (packet: RconPacket) => boolean): Promise<RconPacket> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null
        reject(new Error('rcon response timeout'))
      }, this.timeoutMs)
      this.waiter = {
        matches,
        resolve: (packet) => {
          clearTimeout(timer)
          resolve(packet)
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        },
      }
    })
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    let drained: { packets: RconPacket[]; rest: Buffer }
    try {
      drained = decodePackets(this.buffer)
    } catch (err) {
      this.fail(err as Error)
      this.socket.destroy()
      return
    }
    this.buffer = drained.rest
    for (const packet of drained.packets) {
      if (this.waiter?.matches(packet)) {
        const waiter = this.waiter
        this.waiter = null
        waiter.resolve(packet)
      }
    }
  }

  private fail(err: Error): void {
    this.closed = true
    const waiter = this.waiter
    this.waiter = null
    waiter?.reject(err)
  }
}
