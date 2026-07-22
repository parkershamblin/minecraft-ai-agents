'use client'

import { muted } from '../lib/types'

interface ReflectionsProps {
  reflections: { label: string; v: number }[]
  fleetRows: { l: string; v: string }[]
}

export function Reflections({ reflections, fleetRows }: ReflectionsProps) {
  const top = reflections[0]?.v || 1
  return (
    <div
      className="mc-panel"
      style={{ gridColumn: 'span 4', padding: '13px 15px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}
    >
      <div>
        <h3 className="mc-title">Reflections by outcome</h3>
        <p className="mc-cap">civ_reflections_total — memory-service distills episodic memory into insights.</p>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
        {reflections.map((r) => (
          <div key={r.label} style={{ display: 'grid', gridTemplateColumns: '120px 1fr 30px', gap: 9, alignItems: 'center' }}>
            <span style={{ fontSize: 11.5, color: muted(72) }}>{r.label}</span>
            <div style={{ height: 15, borderRadius: 3, background: 'var(--mc-neutral-900)', overflow: 'hidden' }}>
              <div
                style={{
                  height: '100%',
                  borderRadius: 3,
                  width: Math.round((r.v / top) * 100) + '%',
                  background:
                    'linear-gradient(90deg, color-mix(in srgb, var(--mc-accent) 30%, transparent), var(--mc-accent))',
                }}
              />
            </div>
            <span style={{ fontFamily: 'var(--mc-mono)', fontSize: 11, textAlign: 'right', color: muted(70) }}>
              {r.v}
            </span>
          </div>
        ))}
      </div>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 5,
          marginTop: 2,
          borderTop: '1px solid color-mix(in srgb, var(--mc-divider) 60%, transparent)',
          paddingTop: 9,
        }}
      >
        {fleetRows.map((f) => (
          <div key={f.l} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}>
            <span style={{ color: muted(58) }}>{f.l}</span>
            <span style={{ fontFamily: 'var(--mc-mono)', fontSize: 11 }}>{f.v}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
