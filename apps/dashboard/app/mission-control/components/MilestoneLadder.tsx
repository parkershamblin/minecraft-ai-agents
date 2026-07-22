'use client'

import { fmtT } from '../lib/chartMath'
import { BLUE, RED } from '../lib/types'

const RUNGS = ['first coal', 'first iron ore', 'furnace placed', 'first ingot', 'iron pickaxe']

function chips(times: (number | null)[], color: string) {
  return RUNGS.map((label, i) => {
    const t = times[i]
    const crossed = t != null
    return {
      label: label + (i === 4 && crossed ? ' · WIN' : ''),
      time: fmtT(t),
      bg: crossed ? `color-mix(in srgb, ${color} 14%, transparent)` : 'transparent',
      bc: crossed ? `color-mix(in srgb, ${color} 45%, transparent)` : 'var(--mc-divider)',
      dash: crossed ? 'solid' : 'dashed',
      tc: crossed ? 'var(--mc-text)' : 'color-mix(in srgb, var(--mc-text) 45%, transparent)',
      timec: crossed ? color : 'color-mix(in srgb, var(--mc-text) 35%, transparent)',
    }
  })
}

function TeamRow({ team, color, times }: { team: string; color: string; times: (number | null)[] }) {
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <span style={{ width: 8, height: 8, borderRadius: 2, background: color }} />
        <span style={{ fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase' }}>{team}</span>
      </div>
      {chips(times, color).map((chip, i) => (
        <div
          key={i}
          style={{
            borderRadius: 6,
            padding: '7px 9px',
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
            background: chip.bg,
            border: `1px ${chip.dash} ${chip.bc}`,
          }}
        >
          <span style={{ fontSize: 10.5, lineHeight: 1.25, color: chip.tc }}>{chip.label}</span>
          <span style={{ fontFamily: 'var(--mc-mono)', fontSize: 11, color: chip.timec }}>{chip.time}</span>
        </div>
      ))}
    </>
  )
}

export function MilestoneLadder({ redT, blueT }: { redT: (number | null)[]; blueT: (number | null)[] }) {
  return (
    <div
      className="mc-panel"
      style={{ gridColumn: 'span 7', padding: '13px 15px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}
    >
      <div>
        <h3 className="mc-title">Milestone ladder</h3>
        <p className="mc-cap">
          Five fixed rungs (ADR-10). A crossing is a ProgressionMilestone event in the append-only ledger — the win is
          an event with a causation chain, not a screenshot.
        </p>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '84px repeat(5, 1fr)', gap: 6, alignItems: 'stretch' }}>
        <TeamRow team="Red" color={RED} times={redT} />
        <TeamRow team="Blue" color={BLUE} times={blueT} />
      </div>
    </div>
  )
}
