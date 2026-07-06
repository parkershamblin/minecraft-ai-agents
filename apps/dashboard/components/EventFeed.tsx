'use client'

import { useEffect, useRef, useState } from 'react'
import type { CivEvent } from '@/lib/types'

const FEED_CAP = 100

// One hue per topic family — the stream reads at a glance.
const TYPE_STYLES: Record<string, string> = {
  VillagerSpawned: 'text-emerald-300',
  VillagerMoved: 'text-emerald-400',
  ChatObserved: 'text-emerald-300',
  ActionCompleted: 'text-emerald-500',
  ActionFailed: 'text-red-400',
  DecisionMade: 'text-violet-300',
  MemoryFormed: 'text-violet-400',
  VillagerCreated: 'text-violet-300',
  VillagerTalked: 'text-amber-300',
  ActionRequested: 'text-sky-400',
}

function summarize(event: CivEvent): string {
  const p = event.payload as Record<string, any>
  switch (event.eventType) {
    case 'VillagerTalked':
      return `“${p.message}”`
    case 'ChatObserved':
      return `${p.speakerUsername}: “${p.message}”`
    case 'DecisionMade':
      return String(p.reasoning ?? p.decision ?? '')
    case 'ActionRequested':
      return `→ ${p.action}`
    case 'ActionCompleted':
      return `${p.action} ✓ (${p.durationMs}ms)`
    case 'ActionFailed':
      return `${p.action} ✗ ${p.errorCode}`
    case 'VillagerMoved':
      return `walked ${p.distance} blocks`
    case 'MemoryFormed':
      return String(p.content ?? '')
    default:
      return ''
  }
}

export function EventFeed() {
  const [events, setEvents] = useState<CivEvent[]>([])
  const [connected, setConnected] = useState(false)
  const sourceRef = useRef<EventSource | null>(null)

  useEffect(() => {
    // Sprint 1: EventSource straight onto event-service's SSE relay (via the
    // single-origin rewrite). dashboard-service's WebSocket replaces this at M1/M2.
    const source = new EventSource('/api/events/events/stream')
    sourceRef.current = source
    source.onopen = () => setConnected(true)
    source.onerror = () => setConnected(false)
    source.addEventListener('event', (message) => {
      const parsed: CivEvent = JSON.parse((message as MessageEvent).data)
      setEvents((current) => [parsed, ...current].slice(0, FEED_CAP))
    })
    return () => source.close()
  }, [])

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/60">
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2">
        <span className="text-xs text-zinc-500">events.live · newest first · capped at {FEED_CAP}</span>
        <span className={'flex items-center gap-1.5 text-xs ' + (connected ? 'text-emerald-400' : 'text-red-400')}>
          <span className={'h-2 w-2 rounded-full ' + (connected ? 'bg-emerald-400' : 'bg-red-400')} />
          {connected ? 'live' : 'reconnecting'}
        </span>
      </div>
      <ol className="max-h-[70vh] divide-y divide-zinc-800/60 overflow-y-auto">
        {events.length === 0 && (
          <li className="p-4 text-sm text-zinc-500">Waiting for the first event…</li>
        )}
        {events.map((event) => (
          <li key={event.eventId} className="flex gap-3 px-4 py-2 text-sm">
            <time className="shrink-0 tabular-nums text-xs leading-6 text-zinc-500">
              {new Date(event.occurredAt).toLocaleTimeString()}
            </time>
            <span className={'w-36 shrink-0 font-mono text-xs leading-6 ' + (TYPE_STYLES[event.eventType] ?? 'text-zinc-300')}>
              {event.eventType}
            </span>
            <span className="truncate leading-6 text-zinc-300">{summarize(event)}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}
