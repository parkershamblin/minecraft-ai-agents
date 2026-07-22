'use client'

import type { CSSProperties, ReactNode } from 'react'

interface PanelProps {
  span: number
  gap?: number
  padding?: string
  title: string
  caption: string
  right?: ReactNode
  children: ReactNode
}

// The shared card shell: surface + 1px ring, 12.5px w500 title, 11px caption
// at 52% (hidden by the ?captions=0 switch via .mc-cap). `right` hosts the
// "max N" chip or a series legend, baseline-aligned with the title block.
export function Panel({ span, gap = 8, padding = '13px 15px 12px', title, caption, right, children }: PanelProps) {
  const style: CSSProperties = {
    gridColumn: `span ${span}`,
    padding,
    display: 'flex',
    flexDirection: 'column',
    gap,
  }
  return (
    <div className="mc-panel" style={style}>
      {right ? (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }}>
          <div>
            <h3 className="mc-title">{title}</h3>
            <p className="mc-cap">{caption}</p>
          </div>
          {right}
        </div>
      ) : (
        <div>
          <h3 className="mc-title">{title}</h3>
          <p className="mc-cap">{caption}</p>
        </div>
      )}
      {children}
    </div>
  )
}

export function MaxChip({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        fontFamily: 'var(--mc-mono)',
        fontSize: 10,
        color: 'color-mix(in srgb, var(--mc-text) 45%, transparent)',
        flexShrink: 0,
      }}
    >
      {children}
    </span>
  )
}

export function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div style={{ display: 'flex', gap: 10, flexShrink: 0 }}>
      {items.map(({ label, color }) => (
        <span
          key={label}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            fontSize: 11,
            color: 'color-mix(in srgb, var(--mc-text) 60%, transparent)',
          }}
        >
          <span style={{ width: 8, height: 8, borderRadius: 2, background: color }} />
          {label}
        </span>
      ))}
    </div>
  )
}
