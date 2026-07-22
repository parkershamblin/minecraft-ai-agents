'use client'

import type { ReactNode } from 'react'
import { path, yFor } from '../lib/chartMath'
import { FAIL_RED, muted } from '../lib/types'

export interface ChartSeriesSpec {
  vals: number[]
  color: string
  width?: number
  area?: boolean
}

interface ChartPanelProps {
  span: number
  title: string
  caption: string
  right?: ReactNode
  height: 158 | 138 | 128
  max: number
  series: ChartSeriesSpec[]
  threshold?: number
  timeLabels: string[]
}

export function TimeAxis({ labels }: { labels: string[] }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        fontFamily: 'var(--mc-mono)',
        fontSize: 10,
        color: muted(45),
      }}
    >
      {labels.map((label, i) => (
        <span key={i}>{label}</span>
      ))}
    </div>
  )
}

export function GridLines({ ys }: { ys: number[] }) {
  return (
    <>
      {ys.map((y) => (
        <line
          key={y}
          x1={0}
          x2={600}
          y1={y}
          y2={y}
          opacity={0.5}
          style={{ stroke: 'var(--mc-divider)', strokeWidth: 1, vectorEffect: 'non-scaling-stroke' }}
        />
      ))}
    </>
  )
}

// One timeseries panel: 600×170 viewBox stretched to the pixel height the
// prototype gives each chart (its gridline rows shift with that height —
// 43/85/127 for the tall charts, 47/88/129 for the short ones).
export function ChartPanel({ span, title, caption, right, height, max, series, threshold, timeLabels }: ChartPanelProps) {
  const grid = height >= 158 ? [43, 85, 127] : [47, 88, 129]
  return (
    <div
      className="mc-panel"
      style={{ gridColumn: `span ${span}`, padding: '13px 15px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }}>
        <div>
          <h3 className="mc-title">{title}</h3>
          <p className="mc-cap">{caption}</p>
        </div>
        {right}
      </div>
      <svg viewBox="0 0 600 170" preserveAspectRatio="none" style={{ width: '100%', height, display: 'block' }}>
        <GridLines ys={grid} />
        {threshold != null && (
          <line
            x1={0}
            x2={600}
            y1={yFor(threshold, max).toFixed(1)}
            y2={yFor(threshold, max).toFixed(1)}
            opacity={0.7}
            style={{ stroke: FAIL_RED, strokeWidth: 1.2, strokeDasharray: '6 5', vectorEffect: 'non-scaling-stroke' }}
          />
        )}
        {series
          .filter((s) => s.area)
          .map((s, i) => (
            <path key={`a${i}`} d={path(s.vals, max, true)} style={{ fill: s.color, opacity: 0.1 }} />
          ))}
        {series.map((s, i) => (
          <path
            key={`l${i}`}
            d={path(s.vals, max)}
            style={{ fill: 'none', stroke: s.color, strokeWidth: s.width ?? 1.6, vectorEffect: 'non-scaling-stroke' }}
          />
        ))}
      </svg>
      <TimeAxis labels={timeLabels} />
    </div>
  )
}
