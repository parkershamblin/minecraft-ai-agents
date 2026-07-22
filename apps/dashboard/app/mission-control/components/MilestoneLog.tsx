'use client'

import { fmtT } from '../lib/chartMath'
import { GLYPHS, muted } from '../lib/types'
import type { MapMilestone } from '../lib/types'

// Rows ahead of the scrubber dim to 35% and fade in as the clock passes them.
export function MilestoneLog({ milestones, t }: { milestones: MapMilestone[]; t: number }) {
  return (
    <div
      className="mc-panel"
      style={{ gridColumn: 'span 4', padding: '13px 15px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}
    >
      <div>
        <h3 className="mc-title">Milestone log</h3>
        <p className="mc-cap">
          ProgressionMilestone events with the world coordinate where the crossing landed. Rows ahead of the scrubber
          stay dim.
        </p>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {milestones.map((m, i) => (
          <div
            key={`${m.label}-${m.villager}-${i}`}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 9,
              padding: '6.5px 8px',
              borderTop: '1px solid color-mix(in srgb, var(--mc-divider) 60%, transparent)',
              opacity: t >= m.mt - 0.01 ? 1 : 0.35,
              transition: 'opacity 0.4s',
            }}
          >
            <svg viewBox="0 0 10 10" style={{ width: 11, height: 11, color: m.color, flexShrink: 0 }}>
              <path
                d={GLYPHS[m.glyph]}
                style={{ stroke: 'currentColor', strokeWidth: 1.2, fill: m.glyph === 'coal' ? m.color : 'none' }}
              />
            </svg>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 11.5 }}>{m.label}</div>
              <div style={{ fontSize: 10, color: muted(52) }}>
                {m.villager} · <span style={{ color: m.color }}>{m.team}</span>
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontFamily: 'var(--mc-mono)', fontSize: 10.5 }}>{fmtT(m.mt)}</div>
              <div style={{ fontFamily: 'var(--mc-mono)', fontSize: 9.5, color: muted(45) }}>{m.coordLabel}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
