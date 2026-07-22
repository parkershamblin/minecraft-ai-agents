'use client'

import { muted, STATUS_GREEN } from '../lib/types'
import type { ServiceRow } from '../lib/types'

const COLS = '1.3fr 1.5fr 1fr 0.9fr 0.6fr'

export function ServiceTable({ services, scrapeCol }: { services: ServiceRow[]; scrapeCol: string }) {
  return (
    <div
      className="mc-panel"
      style={{ gridColumn: 'span 7', padding: '13px 15px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}
    >
      <div>
        <h3 className="mc-title">Service fleet</h3>
        <p className="mc-cap">
          Five services, three languages, one contract package — JSON Schema events with codegen for TS, Python and
          Java.
        </p>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: COLS,
            gap: 8,
            padding: '4px 8px 7px',
            fontSize: 10,
            letterSpacing: '0.09em',
            textTransform: 'uppercase',
            color: muted(45),
          }}
        >
          <span>Service</span>
          <span>Stack</span>
          <span>Scrape target</span>
          <span>Status</span>
          <span style={{ textAlign: 'right' }}>{scrapeCol}</span>
        </div>
        {services.map((s) => (
          <div
            key={s.name}
            style={{
              display: 'grid',
              gridTemplateColumns: COLS,
              gap: 8,
              alignItems: 'center',
              padding: '7px 8px',
              borderTop: '1px solid color-mix(in srgb, var(--mc-divider) 60%, transparent)',
              fontSize: 12,
            }}
          >
            <span style={{ fontFamily: 'var(--mc-mono)', fontSize: 11.5 }}>{s.name}</span>
            <span style={{ color: muted(62) }}>{s.stack}</span>
            <span style={{ fontFamily: 'var(--mc-mono)', fontSize: 10.5, color: muted(55) }}>{s.target}</span>
            <span>
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  fontSize: 10,
                  letterSpacing: '0.07em',
                  textTransform: 'uppercase',
                  borderRadius: 4,
                  padding: '2px 7px',
                  color: s.up ? STATUS_GREEN : muted(45),
                  border: `1px solid ${s.up ? `color-mix(in srgb, ${STATUS_GREEN} 40%, transparent)` : 'var(--mc-divider)'}`,
                  background: s.up ? `color-mix(in srgb, ${STATUS_GREEN} 8%, transparent)` : 'transparent',
                }}
              >
                {s.status}
              </span>
            </span>
            <span style={{ fontFamily: 'var(--mc-mono)', fontSize: 11, textAlign: 'right', color: muted(70) }}>
              {s.p95}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
