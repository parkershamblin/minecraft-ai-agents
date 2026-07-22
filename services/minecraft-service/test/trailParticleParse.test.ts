import { describe, expect, it } from 'vitest'
import { createDeserializer, states } from 'minecraft-protocol'

/**
 * Sentinel for patches/minecraft-data+3.111.0.patch (trail particle def).
 *
 * minecraft-data 3.111.0 ships the 1.21.6 trail particle as
 * {target: vec3f64, color: u8} — the real wire format (minecraft.wiki
 * protocol docs, confirmed by live capture below) is color Int (0xRRGGBB)
 * + duration VarInt. The u8 underread left trailing bytes on every trail
 * world_particles packet: protodef logged "Chunk size is 77 but only 73
 * was read ; partial packet" and pushed a corrupt particle (color mangled,
 * duration missing) into every fleet bot — mineflayer's own particle
 * plugin subscribes world_particles unconditionally, so this bit the fleet
 * with or without the POV rig (docs/demo-rb.md's old fleet-lethal note
 * blamed prismarine-viewer; the misparse itself was fleet-wide).
 *
 * The fixture is a REAL packet captured 2026-07-22 from the containerized
 * Paper 1.21.6 server (rcon: `execute at trail_probe run particle
 * minecraft:trail{target:[10.5d,80.0d,-3.25d],color:255,duration:7}
 * ~ ~1 ~ 0 0 0 0 1 force @a`). Full-consumption assertion makes this test
 * FAIL whenever the patch is not applied (fresh checkout without
 * postinstall, image built without patches/) — it doubles as the
 * patch-application canary in CI and in the Docker image.
 *
 * A future MC_VERSION bump must re-verify the def and refresh the patch
 * (the atomic-pin-move PR; see CLAUDE.md conventions).
 */

// 77-byte framed play packet: id 0x29 (world_particles) + payload.
const CAPTURED_TRAIL_PACKET = Buffer.from(
  '290100400c0000000000004060600000000000bfe000000000000000000000000000' +
    '000000000000000000000000013040250000000000004054000000000000c00a0000' +
    '00000000000000ff07',
  'hex',
)

describe('trail particle wire format (minecraft-data patch sentinel)', () => {
  it('parses a real 1.21.6 trail world_particles packet consuming every byte', () => {
    const deserializer = createDeserializer({
      state: states.PLAY,
      isServer: false,
      version: '1.21.6',
      // runtime-optional; the nmp type declares it required
      customPackets: undefined,
    })

    const parsed = deserializer.parsePacketBuffer(CAPTURED_TRAIL_PACKET) as {
      data: {
        name: string
        params: {
          particle: { type: string; data: { target: { x: number; y: number; z: number }; color: number; duration: number } }
        }
      }
      metadata: { size: number }
    }

    expect(parsed.data.name).toBe('world_particles')
    // Full consumption is the load-bearing assertion: the unpatched u8 def
    // stops at 73 of 77 bytes ("partial packet") and never reads duration.
    expect(parsed.metadata.size).toBe(CAPTURED_TRAIL_PACKET.length)

    const trail = parsed.data.params.particle
    expect(trail.type).toBe('trail')
    expect(trail.data.target).toEqual({ x: 10.5, y: 80, z: -3.25 })
    expect(trail.data.color).toBe(255)
    expect(trail.data.duration).toBe(7)
  })
})
