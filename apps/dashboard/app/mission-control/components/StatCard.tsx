'use client'

import type { ReactNode } from 'react'
import { muted } from '../lib/types'

interface StatCardProps {
  label: string
  value: ReactNode
  valueColor?: string
  mono?: boolean
  sub: string
}

export function StatCard({ label, value, valueColor, mono, sub }: StatCardProps) {
  return (
    <div
      className="mc-panel"
      style={{ gridColumn: 'span 2', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 4 }}
    >
      <span style={{ fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: muted(50) }}>{label}</span>
      {mono ? (
        <span style={{ fontFamily: 'var(--mc-mono)', fontSize: 15, lineHeight: 1.3, paddingTop: 4 }}>{value}</span>
      ) : (
        <span style={{ fontWeight: 500, fontSize: 22, lineHeight: 1.1, color: valueColor }}>{value}</span>
      )}
      <span style={{ fontSize: 11, color: muted(52) }}>{sub}</span>
    </div>
  )
}
