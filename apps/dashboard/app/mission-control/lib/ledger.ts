// event-service read API client — RaceScoreboard's patterns extracted: the
// store pages ascending with no order param, so "latest" always means
// following nextCursor to the last page.

import type { CivEvent } from '@/lib/types'

export interface LedgerPage {
  data: CivEvent[]
  nextCursor: string | null
}

export async function fetchPage(params: string, cursor: string | null): Promise<LedgerPage> {
  const url = `/api/events/events?${params}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`event-service ${response.status}`)
  }
  return response.json()
}

export async function fetchLatestAttemptStarted(): Promise<CivEvent | null> {
  let started: CivEvent | null = null
  let cursor: string | null = null
  do {
    const page: LedgerPage = await fetchPage('type=AttemptStarted&limit=100', cursor)
    if (page.data.length > 0) {
      started = page.data.at(-1) ?? started
    }
    cursor = page.nextCursor
  } while (cursor)
  return started
}

export async function fetchAttemptSlice(attemptId: string, onEvent: (event: CivEvent) => void): Promise<void> {
  let cursor: string | null = null
  do {
    const page: LedgerPage = await fetchPage(`aggregate-type=Attempt&aggregate-id=${attemptId}&limit=100`, cursor)
    for (const event of page.data) {
      onEvent(event)
    }
    cursor = page.nextCursor
  } while (cursor)
}

export async function fetchVillagerNames(): Promise<Record<string, string>> {
  const table: Record<string, string> = {}
  try {
    for (const v of await (await fetch('/api/agent/villagers')).json()) {
      table[v.id] = v.name
    }
  } catch {
    // names degrade to short ids
  }
  return table
}

// ProgressionMilestone payloads carry no structured coordinates — the only
// coordinate lives in the free-text detail ("… at (-140, 52, 31)"). Parse a
// 3-tuple as (x, y, z) → take x and z; a 2-tuple as (x, z).
export function parseCoords(detail: string | null | undefined): { x: number; z: number } | null {
  if (!detail) return null
  const match = detail.match(/\((-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)(?:,\s*(-?\d+(?:\.\d+)?))?\)/)
  if (!match) return null
  const a = Number(match[1])
  const b = Number(match[2])
  const c = match[3] != null ? Number(match[3]) : null
  return c != null ? { x: a, z: c } : { x: a, z: b }
}

export async function probeLedger(): Promise<boolean> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 3000)
  try {
    const response = await fetch('/api/events/events?limit=1', { signal: controller.signal })
    return response.ok
  } finally {
    clearTimeout(timeout)
  }
}
