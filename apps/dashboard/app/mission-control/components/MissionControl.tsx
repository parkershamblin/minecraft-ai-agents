'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { buildDemoModel } from '../lib/demoData'
import { computeWindow, mergeModel } from '../lib/liveModel'
import { useDataMode, useLiveRace, useNowSec, usePositions, usePromView } from '../lib/hooks'
import { muted } from '../lib/types'
import type { Dataset, McConfig, Mode, Tab } from '../lib/types'
import { Header } from './Header'
import { RaceView } from './RaceView'
import { LlmView } from './LlmView'
import { PipelineView } from './PipelineView'

// Map replay clock: 40 ms ticks advancing 0.003 per tick sweep the race in
// ~13.3 s, exactly like the prototype. Scrubbing sets the clock and pauses.
function useReplay() {
  const [mapT, setMapT] = useState(1)
  const [playing, setPlaying] = useState(false)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  const stop = useCallback(() => {
    if (timer.current) clearInterval(timer.current)
    timer.current = null
  }, [])

  const togglePlay = useCallback(() => {
    if (playing) {
      stop()
      setPlaying(false)
      return
    }
    stop()
    setPlaying(true)
    setMapT((current) => (current >= 1 ? 0 : current))
    timer.current = setInterval(() => {
      setMapT((current) => {
        const next = current + 0.003
        if (next >= 1) {
          stop()
          setPlaying(false)
          return 1
        }
        return next
      })
    }, 40)
  }, [playing, stop])

  const scrub = useCallback(
    (value: number) => {
      stop()
      setPlaying(false)
      setMapT(value / 1000)
    },
    [stop],
  )

  useEffect(() => stop, [stop])

  return { mapT, playing, togglePlay, scrub }
}

function parseConfig(params: URLSearchParams): McConfig {
  const dataset: Dataset = params.get('dataset') === 'easy_360s' ? 'easy_360s' : 'normal_881s'
  const modeParam = params.get('mode')
  const mode: Mode = modeParam === 'live' || modeParam === 'demo' ? modeParam : 'auto'
  return {
    mode,
    dataset,
    povLive: params.get('pov') === '1',
    povBase: params.get('povBase') ?? 'http://localhost',
    showCaptions: params.get('captions') !== '0',
  }
}

const STACK_TAGS = [
  'Kafka / Redpanda',
  'Prometheus',
  'Grafana',
  'LangGraph',
  'mineflayer',
  'prismarine-viewer',
  'pgvector',
  'FastAPI',
  'Spring Boot',
  'TypeScript',
]

const STATIC_REPLAY = { mapT: 1, playing: false, togglePlay: () => {}, scrub: () => {} }

export function MissionControl() {
  const params = useSearchParams()
  const config = useMemo(() => parseConfig(params), [params])
  const [tab, setTab] = useState<Tab>('race')
  const replay = useReplay()

  const demo = useMemo(() => buildDemoModel(config.dataset), [config.dataset])

  const sources = useDataMode(config.mode)
  const { race } = useLiveRace(sources.ledger === 'live')
  const ledgerLive = sources.ledger === 'live' && race != null
  const promLive = sources.prom === 'live'
  const running = ledgerLive && race != null && race.ended == null

  const nowSec = useNowSec(running || promLive)
  const window = useMemo(
    () => computeWindow(ledgerLive ? race : null, nowSec),
    [ledgerLive, race, nowSec],
  )
  const prom = usePromView(tab, promLive, window)
  const liveTracks = usePositions(ledgerLive, race?.startSec ?? null, demo.map.tracks)

  const model = useMemo(
    () =>
      mergeModel({
        demo,
        race: ledgerLive ? race : null,
        promRace: promLive ? prom.race : null,
        promLlm: promLive ? prom.llm : null,
        promPipe: promLive ? prom.pipe : null,
        liveTracks,
        window,
        nowSec,
      }),
    [demo, ledgerLive, race, promLive, prom.race, prom.llm, prom.pipe, liveTracks, window, nowSec],
  )

  const badge = useMemo(() => {
    if (config.mode === 'demo') return undefined
    if (promLive && ledgerLive) return { label: 'live', live: true }
    if (promLive) return { label: 'live · prom only', live: true }
    if (ledgerLive) return { label: 'live · ledger only', live: true }
    if (config.mode === 'live') return { label: 'live · sources unreachable', live: false }
    return undefined
  }, [config.mode, promLive, ledgerLive])

  return (
    <div className={config.showCaptions ? undefined : 'nocap'}>
      <div style={{ maxWidth: 1460, margin: '0 auto', padding: '0 22px' }}>
        <Header tab={tab} onTab={setTab} rangeLabel={model.rangeLabel} badge={badge} />

        <p
          style={{
            margin: '12px 2px 4px',
            maxWidth: 940,
            fontSize: 12.5,
            lineHeight: 1.55,
            color: muted(72),
            textWrap: 'pretty',
          }}
        >
          Six llama3.1:8b-driven villagers in two teams race — fully unattended — to the first crafted iron pickaxe.
          Every panel below is Prometheus telemetry from an event-sourced microservice stack; the layout mirrors the
          Grafana dashboards provisioned in{' '}
          <span style={{ fontFamily: 'var(--mc-mono)', fontSize: 11.5 }}>infrastructure/grafana/</span>.
        </p>
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', margin: '8px 0 16px' }}>
          {STACK_TAGS.map((tag) => (
            <span key={tag} className="mc-tag mc-tag-neutral">
              {tag}
            </span>
          ))}
          <span className="mc-tag mc-tag-accent">llama3.1:8b · local</span>
        </div>

        {tab === 'race' && <RaceView model={model} config={config} replay={running ? STATIC_REPLAY : replay} />}
        {tab === 'llm' && <LlmView model={model} />}
        {tab === 'pipe' && <PipelineView model={model} />}

        <p style={{ margin: '18px 2px 0', fontSize: 11, lineHeight: 1.5, color: muted(42) }}>
          {ledgerLive || promLive
            ? 'Live telemetry · demo values fill any source that is unreachable'
            : 'Demo telemetry reconstructed from the 2026-07-18 attempt ledger'}{' '}
          · panel layout and PromQL mirror the provisioned dashboards in{' '}
          <span style={{ fontFamily: 'var(--mc-mono)' }}>infrastructure/grafana/provisioning/dashboards/</span> ·{' '}
          <a href="https://github.com/parkershamblin/ai-civilization-engine" target="_blank" rel="noopener noreferrer">
            parkershamblin/ai-civilization-engine
          </a>
        </p>
      </div>
    </div>
  )
}
