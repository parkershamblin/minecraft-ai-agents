'use client'

import { BLUE, muted, RED } from '../lib/types'

const TILES: { name: string; color: string; port: number }[] = [
  { name: 'Elara', color: RED, port: 3100 },
  { name: 'Bram', color: RED, port: 3101 },
  { name: 'Wren', color: RED, port: 3102 },
  { name: 'Ansel', color: BLUE, port: 3103 },
  { name: 'Petra', color: BLUE, port: 3104 },
  { name: 'Fen', color: BLUE, port: 3105 },
]

export function PovGrid({ povLive, povBase }: { povLive: boolean; povBase: string }) {
  return (
    <div
      className="mc-panel"
      style={{ gridColumn: 'span 7', padding: '13px 15px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}
    >
      <div>
        <h3 className="mc-title">POV film rig — prismarine-viewer</h3>
        <p className="mc-cap">
          One first-person viewer per racer, flag-gated on the fleet (POV_VIEWER=1, port pool :3100–:3105). Tiles idle
          offline until the stack is up — flip the povLive tweak to mount the live iframes.
        </p>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
        {TILES.map((tile) => (
          <div
            key={tile.name}
            style={{
              aspectRatio: '16 / 10',
              borderRadius: 6,
              overflow: 'hidden',
              background: 'linear-gradient(165deg, var(--mc-neutral-900), var(--mc-bg))',
              border: '1px solid var(--mc-divider)',
              borderLeft: `2px solid ${tile.color}`,
              position: 'relative',
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'space-between',
              padding: '8px 10px',
            }}
          >
            {povLive && (
              <iframe
                src={`${povBase}:${tile.port}`}
                title={tile.name}
                loading="lazy"
                style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0 }}
              />
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', position: 'relative' }}>
              <span style={{ fontSize: 12, fontWeight: 500 }}>{tile.name}</span>
              <span style={{ fontFamily: 'var(--mc-mono)', fontSize: 9.5, color: muted(45) }}>:{tile.port}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, position: 'relative' }}>
              <span
                style={{
                  width: 5,
                  height: 5,
                  borderRadius: '50%',
                  background: muted(35),
                  animation: 'mc-pulse 3s infinite',
                }}
              />
              <span style={{ fontSize: 9.5, letterSpacing: '0.06em', textTransform: 'uppercase', color: muted(42) }}>
                {povLive ? 'live' : 'offline · POV_VIEWER=1'}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
