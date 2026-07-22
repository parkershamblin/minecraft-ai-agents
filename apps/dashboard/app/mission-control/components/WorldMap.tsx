'use client'

import { useMemo } from 'react'
import { posAt } from '../lib/chartMath'
import { GLYPHS, muted } from '../lib/types'
import type { MapModel } from '../lib/types'

// Isometric projection of the 240×240-block arena into a 700×430 viewBox
// (stretched to fill): sx = (x−z)·1.35 + 350, sy = (x+z)·0.68 + 215.
const project = (x: number, z: number) => ({ sx: 350 + (x - z) * 1.35, sy: 215 + (x + z) * 0.68 })
const pct = (x: number, z: number) => {
  const p = project(x, z)
  return { lx: ((p.sx / 700) * 100).toFixed(2) + '%', ly: ((p.sy / 430) * 100).toFixed(2) + '%' }
}

function staticPaths() {
  let grid = ''
  for (let g = -120; g <= 120; g += 16) {
    const a = project(g, -120)
    const b = project(g, 120)
    const c = project(-120, g)
    const d = project(120, g)
    grid +=
      'M' + a.sx.toFixed(1) + ' ' + a.sy.toFixed(1) + 'L' + b.sx.toFixed(1) + ' ' + b.sy.toFixed(1) +
      'M' + c.sx.toFixed(1) + ' ' + c.sy.toFixed(1) + 'L' + d.sx.toFixed(1) + ' ' + d.sy.toFixed(1)
  }
  const corners = [project(-120, -120), project(120, -120), project(120, 120), project(-120, 120)]
  const plane = 'M' + corners.map((p) => p.sx.toFixed(1) + ' ' + p.sy.toFixed(1)).join('L') + 'Z'
  return { grid, plane }
}

interface WorldMapProps {
  map: MapModel
  mapT: number
  playing: boolean
  togglePlay: () => void
  scrub: (value: number) => void
}

export function WorldMap({ map, mapT, playing, togglePlay, scrub }: WorldMapProps) {
  const { grid, plane } = useMemo(staticPaths, [])
  const t = mapT * map.T

  const villagers = map.tracks.map((track) => {
    const seen = track.pts.filter((p) => p.t <= t)
    const cur = posAt(track.pts, t)
    const trail = (seen.length ? seen : [track.pts[0]])
      .concat([{ t, x: cur.x, z: cur.z }])
      .map((p, k) => {
        const q = project(p.x, p.z)
        return (k ? 'L' : 'M') + q.sx.toFixed(1) + ' ' + q.sy.toFixed(1)
      })
      .join('')
    return { name: track.name, color: track.color, nx: track.nx, op: track.lead ? 0.95 : 0.55, trail, ...pct(cur.x, cur.z) }
  })

  const pins = map.milestones
    .filter((m): m is typeof m & { x: number; z: number } => m.x != null && m.z != null)
    .map((m) => ({
      ...m,
      ...pct(m.x, m.z),
      op: t >= m.mt - 0.01 ? 1 : 0,
      glyphPath: GLYPHS[m.glyph],
      fill: m.glyph === 'coal' ? m.color : 'none',
    }))

  const mm = Math.floor(t / 60)
  const ss = String(Math.floor(t % 60)).padStart(2, '0')

  return (
    <div
      className="mc-panel"
      style={{ gridColumn: 'span 8', padding: '13px 15px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }}>
        <div>
          <h3 className="mc-title">World map — villager tracks &amp; milestone drops</h3>
          <p className="mc-cap">
            {map.trailsIllustrative
              ? 'Milestone pins are real ledger events; the trails are illustrative demo tracks until the positions feed deploys. 16-block cells, Minecraft X/Z — scrub or replay the race.'
              : 'Position facts from the world executor (mineflayer), projected on the chunk grid — 16-block cells, Minecraft X/Z. Pins drop where each ProgressionMilestone landed; scrub or replay the race.'}
          </p>
        </div>
        <span style={{ fontFamily: 'var(--mc-mono)', fontSize: 10, color: muted(45), flexShrink: 0 }}>
          240 × 240 blocks
        </span>
      </div>
      <div style={{ position: 'relative', height: 420 }}>
        <svg
          viewBox="0 0 700 430"
          preserveAspectRatio="none"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }}
        >
          <path d={plane} style={{ fill: 'var(--mc-neutral-900)', opacity: 0.55 }} />
          <path
            d={grid}
            opacity={0.45}
            style={{ fill: 'none', stroke: 'var(--mc-divider)', strokeWidth: 1, vectorEffect: 'non-scaling-stroke' }}
          />
          {villagers.map((v) => (
            <path
              key={v.name}
              d={v.trail}
              opacity={v.op}
              style={{ fill: 'none', stroke: v.color, strokeWidth: 1.5, vectorEffect: 'non-scaling-stroke' }}
            />
          ))}
        </svg>
        <div style={{ position: 'absolute', inset: 0 }}>
          {map.spawns.map((sp) => {
            const at = pct(sp.x, sp.z)
            return (
              <span
                key={sp.label}
                style={{
                  position: 'absolute',
                  left: at.lx,
                  top: at.ly,
                  transform: 'translate(-50%, -50%)',
                  fontSize: 8.5,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  color: muted(45),
                  background: 'color-mix(in srgb, var(--mc-bg) 75%, transparent)',
                  border: '1px solid var(--mc-divider)',
                  borderRadius: 4,
                  padding: '1px 5px',
                  whiteSpace: 'nowrap',
                }}
              >
                {sp.label}
              </span>
            )
          })}
          {villagers.map((v) => (
            <span
              key={v.name}
              style={{
                position: 'absolute',
                left: v.lx,
                top: v.ly,
                transform: 'translate(-50%, -50%)',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 2,
                pointerEvents: 'none',
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: v.color,
                  border: '1.5px solid var(--mc-bg)',
                  boxShadow: `0 0 8px color-mix(in srgb, ${v.color} 60%, transparent)`,
                }}
              />
              <span
                style={{
                  fontSize: 9,
                  color: v.color,
                  textShadow: '0 1px 3px var(--mc-bg)',
                  marginLeft: v.nx,
                }}
              >
                {v.name}
              </span>
            </span>
          ))}
          {pins.map((m, i) => (
            <span
              key={`${m.label}-${m.villager}-${i}`}
              style={{
                position: 'absolute',
                left: m.lx,
                top: m.ly,
                transform: `translate(calc(-50% + ${m.ox}px), -100%)`,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                opacity: m.op,
                transition: 'opacity 0.4s',
                pointerEvents: 'none',
              }}
            >
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  whiteSpace: 'nowrap',
                  fontSize: 9.5,
                  background: 'color-mix(in srgb, var(--mc-bg) 88%, transparent)',
                  border: `1px solid color-mix(in srgb, ${m.color} 55%, transparent)`,
                  borderRadius: 5,
                  padding: '2.5px 7px',
                }}
              >
                <svg viewBox="0 0 10 10" style={{ width: 10, height: 10, color: m.color, flexShrink: 0 }}>
                  <path d={m.glyphPath} style={{ stroke: 'currentColor', strokeWidth: 1.2, fill: m.fill }} />
                </svg>
                <span>
                  {m.label} — {m.villager} · <span style={{ color: m.color }}>{m.team}</span>
                </span>
              </span>
              <span
                style={{ width: 1, height: m.lift, background: `color-mix(in srgb, ${m.color} 55%, transparent)` }}
              />
              <span
                style={{
                  position: 'absolute',
                  left: `calc(50% - ${m.ox}px)`,
                  bottom: -2.5,
                  transform: 'translateX(-50%)',
                  width: 5,
                  height: 5,
                  borderRadius: '50%',
                  background: m.color,
                  border: '1px solid var(--mc-bg)',
                }}
              />
            </span>
          ))}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {map.scrubEnabled ? (
          <>
            <button type="button" onClick={togglePlay} className="mc-btn" style={{ fontSize: 11, padding: '3px 10px' }}>
              {playing ? 'Pause' : 'Replay race'}
            </button>
            <input
              type="range"
              min={0}
              max={1000}
              value={Math.round(mapT * 1000)}
              onChange={(e) => scrub(Number(e.target.value))}
              style={{ flex: 1, height: 4 }}
            />
          </>
        ) : (
          <span style={{ flex: 1, fontSize: 11, color: muted(45) }}>attempt in progress — live positions</span>
        )}
        <span
          style={{
            fontFamily: 'var(--mc-mono)',
            fontSize: 10.5,
            color: muted(60),
            border: '1px solid var(--mc-divider)',
            borderRadius: 6,
            padding: '3px 8px',
            whiteSpace: 'nowrap',
          }}
        >
          {'T+' + mm + ':' + ss + ' / ' + map.clockTotal}
        </span>
      </div>
    </div>
  )
}
