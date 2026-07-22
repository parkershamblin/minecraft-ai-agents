'use client'

import { stepPath } from '../lib/chartMath'
import { BLUE, muted, RED } from '../lib/types'
import type { DashboardModel, McConfig } from '../lib/types'
import { StatCard } from './StatCard'
import { ChartPanel, GridLines, TimeAxis } from './ChartPanel'
import { Legend, MaxChip } from './Panel'
import { MilestoneLadder } from './MilestoneLadder'
import { WorldMap } from './WorldMap'
import { MilestoneLog } from './MilestoneLog'
import { PovGrid } from './PovGrid'
import { Collectors } from './Collectors'

interface RaceViewProps {
  model: DashboardModel
  config: McConfig
  replay: { mapT: number; playing: boolean; togglePlay: () => void; scrub: (v: number) => void }
}

export function RaceView({ model, config, replay }: RaceViewProps) {
  const { race, map, timeLabels } = model
  const s = race.stats
  return (
    <section data-screen-label="Race telemetry" className="grid grid-cols-12 gap-[10px]">
      <StatCard label="Winner" value={s.winner} valueColor={s.winnerColor} sub={s.winnerSub} />
      <StatCard label="Time to iron pickaxe" value={s.winTime} sub={s.winTimeSub} />
      <StatCard label="Attempt" value={s.attempt} mono sub="aggregate id in the ledger" />
      <StatCard
        label="Milestones"
        value={
          <>
            <span style={{ color: RED }}>{s.redScore}</span>
            <span style={{ color: muted(40) }}> · </span>
            <span style={{ color: BLUE }}>{s.blueScore}</span>
          </>
        }
        sub="red · blue, of 5 rungs"
      />
      <StatCard label="Human input" value={s.humanInput} sub="after the starting gun" />
      <StatCard label="Honest-race assertion" value={s.honest} valueColor="var(--mc-accent-300)" sub={s.honestSub} />

      <MilestoneLadder redT={race.redT} blueT={race.blueT} />

      <div
        className="mc-panel"
        style={{ gridColumn: 'span 5', padding: '13px 15px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }}>
          <div>
            <h3 className="mc-title">Race progress — rungs crossed</h3>
            <p className="mc-cap">
              civ_progression_milestones_total by team — blue led the first two rungs; red overtook at the furnace.
            </p>
          </div>
          <Legend
            items={[
              { label: 'red', color: RED },
              { label: 'blue', color: BLUE },
            ]}
          />
        </div>
        <svg viewBox="0 0 600 170" preserveAspectRatio="none" style={{ width: '100%', height: 158, display: 'block' }}>
          <GridLines ys={[43, 85, 127]} />
          <path
            d={stepPath(race.blueT, model.T)}
            style={{ fill: 'none', stroke: BLUE, strokeWidth: 1.8, vectorEffect: 'non-scaling-stroke' }}
          />
          <path
            d={stepPath(race.redT, model.T)}
            style={{ fill: 'none', stroke: RED, strokeWidth: 1.8, vectorEffect: 'non-scaling-stroke' }}
          />
        </svg>
        <TimeAxis labels={timeLabels} />
      </div>

      <WorldMap map={map} mapT={replay.mapT} playing={replay.playing} togglePlay={replay.togglePlay} scrub={replay.scrub} />

      <MilestoneLog milestones={map.milestones} t={replay.mapT * map.T} />

      <PovGrid povLive={config.povLive} povBase={config.povBase} />

      <Collectors collectors={race.collectors} />

      <ChartPanel
        span={6}
        title="Collection rate by team"
        caption="rate(civ_materials_collected_total[2m]) × 60 — items per minute; the bursts line up with the rungs."
        right={<MaxChip>max 30/min</MaxChip>}
        height={138}
        max={30}
        series={[
          { vals: race.rateBlue, color: BLUE, area: true },
          { vals: race.rateRed, color: RED, area: true },
        ]}
        timeLabels={timeLabels}
      />

      <ChartPanel
        span={6}
        title="Command lane depth"
        caption="civ_command_lane_depth — commands admitted to per-villager lanes but unfinished. Idles at 0; sustained >6 means the world is falling behind the brains."
        right={<MaxChip>max 8</MaxChip>}
        height={138}
        max={8}
        series={[{ vals: race.lane, color: 'var(--mc-accent)', area: true }]}
        timeLabels={timeLabels}
      />
    </section>
  )
}
