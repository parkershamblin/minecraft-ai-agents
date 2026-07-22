'use client'

import { muted } from '../lib/types'
import type { CollectorRow } from '../lib/types'

export function Collectors({ collectors }: { collectors: CollectorRow[] }) {
  const top = collectors[0]?.v || 1
  return (
    <div
      className="mc-panel"
      style={{ gridColumn: 'span 5', padding: '13px 15px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}
    >
      <div>
        <h3 className="mc-title">Top collectors — items gained</h3>
        <p className="mc-cap">
          topk(6, sum by (player) (increase(civ_materials_collected_total[$__range]))) — positive inventory deltas
          between polls.
        </p>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
        {collectors.map((c) => (
          <div key={c.name} style={{ display: 'grid', gridTemplateColumns: '64px 1fr 40px', gap: 9, alignItems: 'center' }}>
            <span style={{ fontSize: 11.5 }}>{c.name}</span>
            <div style={{ height: 15, borderRadius: 3, background: 'var(--mc-neutral-900)', overflow: 'hidden' }}>
              <div
                style={{
                  height: '100%',
                  borderRadius: 3,
                  width: Math.round((c.v / top) * 100) + '%',
                  background: `linear-gradient(90deg, color-mix(in srgb, ${c.color} 30%, transparent), ${c.color})`,
                }}
              />
            </div>
            <span style={{ fontFamily: 'var(--mc-mono)', fontSize: 11, textAlign: 'right', color: muted(70) }}>
              {c.v}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
