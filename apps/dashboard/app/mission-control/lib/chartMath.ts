// SVG path builders — verbatim ports of the design prototype's generators so
// demo curves match the handoff bit-for-bit. Charts render into a fixed
// 600×170 viewBox stretched with preserveAspectRatio="none"; strokes stay
// crisp via vector-effect="non-scaling-stroke".

import type { TrackPoint } from './types'

export const CHART_W = 600
export const CHART_H = 170
const P = 6

export function path(vals: number[], max: number, area?: boolean): string {
  const n = vals.length
  let d = ''
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * CHART_W
    const y = CHART_H - P - Math.max(0, Math.min(1, vals[i] / max)) * (CHART_H - 2 * P)
    d += (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1)
  }
  if (area) d += 'L600 170L0 170Z'
  return d
}

export function stepPath(times: (number | null)[], T: number): string {
  const y = (l: number) => (CHART_H - P - (l / 5) * (CHART_H - 2 * P)).toFixed(1)
  let lvl = 0
  let d = 'M0 ' + y(0)
  for (const t of times) {
    if (t == null) continue
    const x = ((t / T) * 600).toFixed(1)
    d += 'L' + x + ' ' + y(lvl)
    lvl++
    d += 'L' + x + ' ' + y(lvl)
  }
  return d + 'L600 ' + y(lvl)
}

// y coordinate (in chart space) for a data value — used for threshold lines
// so they pass through the same transform as the series.
export function yFor(v: number, max: number): number {
  return CHART_H - P - Math.max(0, Math.min(1, v / max)) * (CHART_H - 2 * P)
}

export function fmtT(s: number | null | undefined): string {
  if (s == null) return 'not crossed'
  const m = Math.floor(s / 60)
  return 'T+' + m + ':' + String(Math.floor(s % 60)).padStart(2, '0')
}

// Linear position along a timestamped track at race-time t.
export function posAt(pts: TrackPoint[], t: number): { x: number; z: number } {
  if (t <= pts[0].t) return pts[0]
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].t >= t) {
      const a = pts[i - 1]
      const b = pts[i]
      const u = (t - a.t) / (b.t - a.t || 1)
      return { x: a.x + (b.x - a.x) * u, z: a.z + (b.z - a.z) * u }
    }
  }
  return pts[pts.length - 1]
}
