'use client'

import { muted } from '../lib/types'
import type { DashboardModel } from '../lib/types'
import { StatCard } from './StatCard'
import { ChartPanel } from './ChartPanel'
import { Legend, MaxChip } from './Panel'
import { ProviderChain } from './ProviderChain'

export function LlmView({ model }: { model: DashboardModel }) {
  const { llm, timeLabels } = model
  const s = llm.stats
  return (
    <section data-screen-label="LLM ops" className="grid grid-cols-12 gap-[10px]">
      <StatCard label="LLM decisions" value={s.llmCalls} sub="6 brains, one tick each 10–20 s" />
      <StatCard label="Decision p95" value={s.llmP95} sub="provider: ollama" />
      <StatCard label="Tokens in / out" value={s.tokTotals} sub="civ_llm_tokens_total" />
      <StatCard label="Spend (range)" value={s.spend} sub="fully local inference" />
      <StatCard
        label="Budget breaker"
        value={s.breaker}
        valueColor={s.breakerOpen ? 'oklch(0.68 0.13 25)' : 'var(--mc-accent-300)'}
        sub="civ_llm_budget_tripped = 0"
      />
      <StatCard label="Malformed replies" value={s.malformed} sub={`of ${s.normalized} normalized`} />

      <ChartPanel
        span={8}
        title="Decision latency p95 by provider"
        caption="histogram_quantile(0.95, rate(civ_llm_latency_seconds_bucket[5m])) — a local llama3.1:8b deliberates while the body keeps executing reflexes."
        right={
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexShrink: 0 }}>
            {llm.latSeries.length > 1 && <Legend items={llm.latSeries.map(({ label, color }) => ({ label, color }))} />}
            <MaxChip>max 18 s</MaxChip>
          </div>
        }
        height={158}
        max={18}
        series={llm.latSeries}
        timeLabels={timeLabels}
      />

      <ProviderChain malformed={s.malformed} normalized={s.normalized} />

      <ChartPanel
        span={6}
        title="Tokens per minute"
        caption="sum by (direction) (rate(civ_llm_tokens_total[5m])) × 60 — six brains thinking in parallel."
        right={
          <Legend
            items={[
              { label: 'in', color: 'var(--mc-accent)' },
              { label: 'out', color: muted(40) },
            ]}
          />
        }
        height={138}
        max={9000}
        series={[
          { vals: llm.tokIn, color: 'var(--mc-accent)', area: true },
          { vals: llm.tokOut, color: muted(40), width: 1.4 },
        ]}
        timeLabels={timeLabels}
      />

      <ChartPanel
        span={6}
        title="Ticks per minute by outcome"
        caption="civ_ticks_total — the perceive → deliberate → act → reflect loop, per outcome."
        right={<Legend items={llm.ticks.map(({ label, color }) => ({ label, color }))} />}
        height={138}
        max={30}
        series={llm.ticks.map(({ vals, color, width }) => ({ vals, color, width }))}
        timeLabels={timeLabels}
      />

      <ChartPanel
        span={6}
        title="Reactive tick ratio"
        caption="Reactive share of all ticks — cap arithmetic says < 0.4 sustained (dashed line)."
        right={<MaxChip>max 0.6</MaxChip>}
        height={138}
        max={0.6}
        threshold={0.4}
        series={[{ vals: llm.reactive, color: 'var(--mc-accent)', area: true }]}
        timeLabels={timeLabels}
      />

      <ChartPanel
        span={6}
        title="Cognitive tick duration p95"
        caption="civ_tick_seconds — one full tick, LLM call included. The body never waits on the brain."
        right={<MaxChip>max 18 s</MaxChip>}
        height={138}
        max={18}
        series={[{ vals: llm.tickDur, color: 'var(--mc-accent)', area: true }]}
        timeLabels={timeLabels}
      />
    </section>
  )
}
