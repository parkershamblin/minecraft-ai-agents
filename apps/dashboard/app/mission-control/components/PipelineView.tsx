'use client'

import type { DashboardModel } from '../lib/types'
import { StatCard } from './StatCard'
import { ChartPanel } from './ChartPanel'
import { Legend, MaxChip } from './Panel'
import { ServiceTable } from './ServiceTable'
import { Reflections } from './Reflections'

export function PipelineView({ model }: { model: DashboardModel }) {
  const { pipe, timeLabels } = model
  const s = pipe.stats
  return (
    <section data-screen-label="Pipeline and fleet" className="grid grid-cols-12 gap-[10px]">
      <StatCard label="Events ingested" value={s.evTotal} sub="append-only, this attempt" />
      <StatCard label="Peak throughput" value={s.evPeak} sub="events per second" />
      <StatCard label="Consumer lag, max" value={s.lagMax} sub="records, whole race" />
      <StatCard label="Services up" value={s.servicesUp} valueColor="var(--mc-accent-300)" sub="+1 mothballed by design" />
      <StatCard label="Bot sessions" value={s.botSessions} sub={s.reconnects} />
      <StatCard label="SSE clients" value={s.sseClients} sub="live feed → Next.js scoreboard" />

      <ChartPanel
        span={8}
        title="Event throughput by topic"
        caption="sum by (topic) (rate(civ_events_ingested_total[1m])) — every action is an immutable event; the stream is the seam between services."
        right={<Legend items={pipe.throughput.map(({ label, color }) => ({ label, color }))} />}
        height={158}
        max={26}
        series={pipe.throughput}
        timeLabels={timeLabels}
      />

      <ChartPanel
        span={4}
        title="Kafka consumer lag"
        caption="kafka_consumer_fetch_manager_records_lag — flat through the race."
        right={<MaxChip>max 5</MaxChip>}
        height={158}
        max={5}
        series={pipe.lag}
        timeLabels={timeLabels}
      />

      <ServiceTable services={pipe.services} scrapeCol={pipe.scrapeCol} />

      <ChartPanel
        span={5}
        title="Memory retrieval p95"
        caption="civ_memory_retrieval_seconds — pgvector similarity search feeding each tick's context."
        right={<MaxChip>max 100 ms</MaxChip>}
        height={128}
        max={100}
        series={[{ vals: pipe.mem, color: 'var(--mc-accent)', area: true }]}
        timeLabels={timeLabels}
      />

      <Reflections reflections={pipe.reflections} fleetRows={pipe.fleetRows} />

      <div
        className="mc-panel"
        style={{ gridColumn: 'span 8', padding: '13px 15px 14px', display: 'flex', flexDirection: 'column', gap: 9 }}
      >
        <div>
          <h3 className="mc-title">Append-only ledger — replay the first win</h3>
          <p className="mc-cap">
            The win is not a screenshot: it is an event with a causation chain, replayable by anyone from the read API.
          </p>
        </div>
        <div
          style={{
            fontFamily: 'var(--mc-mono)',
            fontSize: 11.5,
            lineHeight: 1.6,
            color: 'var(--mc-accent-200)',
            background: 'var(--mc-neutral-900)',
            border: '1px solid var(--mc-divider)',
            borderRadius: 6,
            padding: '9px 12px',
            overflowWrap: 'anywhere',
          }}
        >
          curl &quot;localhost:8081/events?aggregate-type=Attempt&amp;aggregate-id={pipe.curlId}&quot;
        </div>
      </div>
    </section>
  )
}
